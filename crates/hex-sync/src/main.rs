//! `hex-sync`: moves filed Documents from the Outbox into the Archive (ADR 0001).

mod config;
mod fsio;
mod journal;
mod sync;

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use clap::{Args, Parser, Subcommand};

use crate::config::Config;
use crate::journal::{Action, Journal, Outcome};

const DEFAULT_CONFIG: &str = "~/.config/hex/sync.toml";

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

fn main() -> ExitCode {
    let cli = Cli::parse();
    let args = match cli.command {
        Some(Command::Run(args)) => args,
        None => cli.run,
    };
    match run(&args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("hex-sync: {e}");
            ExitCode::from(2)
        }
    }
}

/// Exit codes: 0 all done; 1 some files failed, or a log line (on a dry run, a plan line)
/// could not be written, which stops the pass; 2 nothing done (`Err`: config error, log
/// cannot be opened, is a symlink or lies inside a root, or a root check failed).
fn run(args: &RunArgs) -> Result<ExitCode, String> {
    let config = Config::load(&config::expand_home(&args.config))?;
    let aborted = |reason| format!("aborted, nothing touched: {reason}");
    let roots = match sync::check_roots(&config.outbox, &config.archive, &config.log) {
        Err(abort) if !abort.loggable => return Err(aborted(abort.reason)),
        roots => roots,
    };
    let mut journal = if args.dry_run {
        Journal::dry_run()
    } else {
        Journal::open(&config.log).map_err(|e| {
            let cannot_open = format!("cannot open log {}: {e}", config.log.display());
            match &roots {
                Err(abort) => aborted(format!("{}; {cannot_open}", abort.reason)),
                Ok(_) => cannot_open,
            }
        })?
    };
    let roots = roots.map_err(|abort| {
        if !journal.is_dry_run() {
            let outcome = Outcome::Failed(abort.reason.clone());
            journal.record(Action::Abort, Path::new("-"), None, outcome);
        }
        aborted(abort.reason)
    })?;
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
