//! `hex-sync`: moves filed Documents from the Outbox into the Archive (ADR 0001).

mod config;
mod fsio;
mod journal;
mod launchd;
mod lock;
mod sync;

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use clap::{Args, Parser, Subcommand};

use crate::config::Config;
use crate::journal::{Action, Journal, Outcome};
use crate::lock::LockError;

const DEFAULT_CONFIG: &str = "~/.config/hex/sync.toml";
const DEFAULT_LAUNCH_AGENTS_DIR: &str = "~/Library/LaunchAgents";

#[derive(Parser)]
#[command(
    name = "hex-sync",
    version,
    about,
    args_conflicts_with_subcommands = true
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[command(flatten)]
    run: RunArgs,
}

#[derive(Subcommand)]
enum Command {
    /// Move eligible Outbox files into the Archive once (the default).
    Run(RunArgs),
    /// Schedule `run` every `interval_secs` as the launchd agent ai.stibbons.hex-sync.
    Install(InstallArgs),
    /// Unload the launchd agent and remove its plist.
    Uninstall(UninstallArgs),
}

#[derive(Args)]
struct RunArgs {
    /// Print the planned actions without changing anything on disk.
    #[arg(long)]
    dry_run: bool,
    /// Config file.
    #[arg(long, value_name = "PATH", default_value = DEFAULT_CONFIG)]
    config: PathBuf,
}

#[derive(Args)]
struct InstallArgs {
    /// Config file; the agent runs with this path.
    #[arg(long, value_name = "PATH", default_value = DEFAULT_CONFIG)]
    config: PathBuf,
    #[command(flatten)]
    launch_agents: LaunchAgentsArg,
}

#[derive(Args)]
struct UninstallArgs {
    #[command(flatten)]
    launch_agents: LaunchAgentsArg,
}

#[derive(Args)]
struct LaunchAgentsArg {
    /// Folder holding the agent's plist.
    #[arg(long, value_name = "PATH", default_value = DEFAULT_LAUNCH_AGENTS_DIR)]
    launch_agents_dir: PathBuf,
}

impl LaunchAgentsArg {
    fn dir(&self) -> PathBuf {
        config::expand_home(&self.launch_agents_dir)
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let args = match cli.command {
        Some(Command::Run(args)) => args,
        None => cli.run,
        Some(Command::Install(args)) => {
            let config = config::expand_home(&args.config);
            return report(launchd::install(&config, &args.launch_agents.dir()));
        }
        Some(Command::Uninstall(args)) => {
            return report(launchd::uninstall(&args.launch_agents.dir()));
        }
    };
    match run(&args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("hex-sync: {e}");
            ExitCode::from(2)
        }
    }
}

/// Exit codes of `install` and `uninstall`: 0 done, 1 failed.
fn report(result: Result<(), String>) -> ExitCode {
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("hex-sync: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Exit codes: 0 all done; 1 some files failed, or a log line (on a dry run, a plan line)
/// could not be written, which stops the pass; 2 nothing done (`Err`: config error, log
/// cannot be opened, is a symlink or lies inside a root, the lock file cannot be opened, or
/// a root check failed); 3 nothing done because another run holds the lock.
fn run(args: &RunArgs) -> Result<ExitCode, String> {
    let config = Config::load(&config::expand_home(&args.config))?;
    let roots = match sync::check_roots(&config.outbox, &config.archive, &config.log) {
        Ok(roots) => roots,
        Err(abort) => {
            let mut reason = abort.reason;
            if abort.loggable && !args.dry_run {
                // Never create a folder here: a missing root may be an unmounted drive the
                // log lies under, however its path is spelled.
                match Journal::open(&config.log) {
                    Ok(mut journal) => {
                        let outcome = Outcome::Failed(reason.clone());
                        journal.record(Action::Abort, Path::new("-"), None, outcome);
                    }
                    Err(e) => {
                        let log = config.log.display();
                        reason = format!("{reason} (not logged: cannot open log {log}: {e})");
                    }
                }
            }
            return Err(format!("aborted, nothing touched: {reason}"));
        }
    };
    // The lock comes after the root checks, which only read, and before anything is written,
    // the log included: a refused run leaves no trace but the lock file. An aborting run
    // takes no lock (it may not create the log's folder) and only appends its abort line.
    let _lock = if args.dry_run {
        None
    } else {
        match lock::lock_run(&config.log) {
            Ok(lock) => Some(lock),
            Err(LockError::Busy(path)) => {
                let path = path.display();
                eprintln!("hex-sync: another run is in progress (lock {path})");
                return Ok(ExitCode::from(3));
            }
            Err(LockError::Io(path, e)) => {
                return Err(format!("cannot open lock {}: {e}", path.display()));
            }
        }
    };
    let mut journal = if args.dry_run {
        Journal::dry_run()
    } else {
        // `lock_run` has created the log's folder.
        Journal::open(&config.log)
            .map_err(|e| format!("cannot open log {}: {e}", config.log.display()))?
    };
    let failures = sync::run(
        &roots,
        Duration::from_secs(config.min_age_secs),
        &mut journal,
    );
    if journal.write_failed() {
        if args.dry_run {
            eprintln!("hex-sync: stopped early: cannot write the plan to stdout");
        } else {
            let log = config.log.display();
            eprintln!("hex-sync: stopped early: cannot write log {log}");
        }
        return Ok(ExitCode::FAILURE);
    }
    if failures > 0 {
        eprintln!("hex-sync: finished with {failures} failure(s)");
        return Ok(ExitCode::FAILURE);
    }
    Ok(ExitCode::SUCCESS)
}
