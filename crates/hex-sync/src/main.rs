//! `hex-sync`: moves filed Documents from the Outbox into the Archive (ADR 0001).

mod config;
mod journal;
mod sync;

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use clap::{Args, Parser, Subcommand};

use crate::config::Config;
use crate::journal::Journal;

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

/// Exit codes: 0 all done, 1 some files failed, 2 nothing done (`Err`: config error or abort).
fn run(args: &RunArgs) -> Result<ExitCode, String> {
    let config = Config::load(&config::expand_home(&args.config))?;
    let mut journal = if args.dry_run {
        Journal::dry_run()
    } else {
        Journal::open(&config.log)
            .map_err(|e| format!("cannot open log {}: {e}", config.log.display()))?
    };
    let min_age = Duration::from_secs(config.min_age_secs);
    let failures =
        sync::run(&config.outbox, &config.archive, min_age, &mut journal).map_err(|reason| {
            if !journal.is_dry_run() {
                journal.record("abort", Path::new("-"), None, &reason);
            }
            format!("aborted, nothing touched: {reason}")
        })?;
    if failures > 0 || journal.write_failed() {
        eprintln!("hex-sync: finished with {failures} failure(s)");
        return Ok(ExitCode::FAILURE);
    }
    Ok(ExitCode::SUCCESS)
}
