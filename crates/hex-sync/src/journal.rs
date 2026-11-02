use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::time::SystemTime;

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

    /// True once a log line could not be written; the run must then exit non-zero.
    pub fn write_failed(&self) -> bool {
        self.write_failed
    }

    pub fn record(&mut self, action: &str, path: &Path, target: &str, outcome: &str) {
        let Some(log) = self.log.as_mut() else {
            match target {
                "-" => println!("dry-run: {action} {}", path.display()),
                _ => println!("dry-run: {action} {} -> {target}", path.display()),
            }
            return;
        };
        let timestamp = humantime::format_rfc3339_seconds(SystemTime::now());
        let line = format!(
            "{timestamp}\t{action}\t{}\t{target}\t{outcome}",
            path.display()
        );
        println!("{line}");
        if let Err(e) = writeln!(log, "{line}") {
            eprintln!("hex-sync: cannot write log: {e}");
            self.write_failed = true;
        }
    }
}
