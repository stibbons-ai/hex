use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::time::SystemTime;

/// What a log line is about.
#[derive(Clone, Copy)]
pub enum Action {
    /// Copied to the same relative path in the Archive; source removed.
    Copy,
    /// Copied beside a different Archive file as `name (n).ext`; source removed.
    CopyRenamed,
    /// A byte-identical Archive file already existed; source removed.
    RemoveIdentical,
    /// A claimed source was renamed back into place in the Outbox.
    RestoreClaim,
    /// Renaming a source to its claim name.
    Claim,
    Rmdir,
    SkipSymlink,
    SkipSpecial,
    /// The mtime is in the future or unreadable, so the age cannot be judged.
    SkipBadMtime,
    /// A `.hex-sync-<n>.tmp` already in the Archive (left by a crash, or another run's);
    /// never deleted.
    StaleTemp,
    ReadDir,
    Stat,
    Plan,
    Abort,
}

impl Action {
    fn as_str(self) -> &'static str {
        match self {
            Self::Copy => "copy",
            Self::CopyRenamed => "copy-renamed",
            Self::RemoveIdentical => "remove-identical",
            Self::RestoreClaim => "restore-claim",
            Self::Claim => "claim",
            Self::Rmdir => "rmdir",
            Self::SkipSymlink => "skip-symlink",
            Self::SkipSpecial => "skip-special",
            Self::SkipBadMtime => "skip-bad-mtime",
            Self::StaleTemp => "stale-temp",
            Self::ReadDir => "read-dir",
            Self::Stat => "stat",
            Self::Plan => "plan",
            Self::Abort => "abort",
        }
    }
}

pub enum Outcome {
    Ok,
    Planned,
    Skipped,
    /// Left in place for a later run.
    Kept,
    Failed(String),
}

impl fmt::Display for Outcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ok => f.write_str("ok"),
            Self::Planned => f.write_str("planned"),
            Self::Skipped => f.write_str("skipped"),
            Self::Kept => f.write_str("kept"),
            Self::Failed(reason) => write!(f, "failed: {reason}"),
        }
    }
}

/// Records every action: appended to the log file and echoed to stdout on a real run,
/// printed as a plan (and nothing written) on a dry run.
pub struct Journal {
    log: Option<File>,
    write_failed: bool,
}

impl Journal {
    /// Opens the log in append mode, creating its parent directory if missing.
    pub fn open(path: &Path) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let log = OpenOptions::new().append(true).create(true).open(path)?;
        Ok(Self {
            log: Some(log),
            write_failed: false,
        })
    }

    pub fn dry_run() -> Self {
        Self {
            log: None,
            write_failed: false,
        }
    }

    pub fn is_dry_run(&self) -> bool {
        self.log.is_none()
    }

    /// True once a line could not be written (the log, or stdout on a dry run); the pass
    /// must then stop and exit non-zero.
    pub fn write_failed(&self) -> bool {
        self.write_failed
    }

    /// `path` is relative to the Outbox; `target`, if the action has one, to the Archive
    /// (or to the Outbox for `RestoreClaim`). The log line is written before the stdout
    /// echo, and echo errors (a closed pipe) are ignored, so no action goes unlogged.
    pub fn record(&mut self, action: Action, path: &Path, target: Option<&Path>, outcome: Outcome) {
        let action = action.as_str();
        let path = path.display();
        let Some(log) = self.log.as_mut() else {
            let target = target.map_or(String::new(), |t| format!(" -> {}", t.display()));
            let outcome = match outcome {
                Outcome::Planned => String::new(),
                other => format!(" [{other}]"),
            };
            let line = format!("dry-run: {action} {path}{target}{outcome}\n");
            if io::stdout().write_all(line.as_bytes()).is_err() {
                self.write_failed = true;
            }
            return;
        };
        let timestamp = humantime::format_rfc3339_seconds(SystemTime::now());
        let target = target.unwrap_or(Path::new("-")).display();
        let line = format!("{timestamp}\t{action}\t{path}\t{target}\t{outcome}\n");
        // One write per line, so an append never interleaves half lines.
        if let Err(e) = log.write_all(line.as_bytes()) {
            // stdout may be /dev/null under a scheduler: keep the lost line on stderr.
            let _ = write!(io::stderr(), "hex-sync: cannot write log: {e}: {line}");
            self.write_failed = true;
        }
        let _ = io::stdout().write_all(line.as_bytes());
    }
}
