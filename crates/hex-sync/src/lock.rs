//! Run lock: one real `run` at a time, via `flock` on `<log>.lock`.

use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use crate::fsio::create_dir_all_durable;

/// Why [`lock_run`] did not return the lock.
pub enum LockError {
    /// Another process holds the lock.
    Busy(PathBuf),
    /// The log's folder, the lock file or the lock itself failed; the message says which.
    Io(String),
}

/// `<log>.lock`, next to the log (`sync.log` → `sync.log.lock`).
fn lock_path(log: &Path) -> PathBuf {
    let mut path = OsString::from(log);
    path.push(".lock");
    PathBuf::from(path)
}

/// Takes an exclusive, non-blocking `flock` on `<log>.lock`, creating the log's folder and
/// the lock file if missing. The lock lasts as long as the returned file is open, so it is
/// released when the process exits, however it exits; a lock file left behind is harmless.
pub fn lock_run(log: &Path) -> Result<File, LockError> {
    let path = lock_path(log);
    if let Some(parent) = log.parent() {
        create_dir_all_durable(parent).map_err(|e| {
            LockError::Io(format!(
                "cannot create log folder {}: {e}",
                parent.display()
            ))
        })?;
    }
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|e| LockError::Io(format!("cannot open lock {}: {e}", path.display())))?;
    // SAFETY: `file` owns a valid open descriptor for the duration of the call.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(file);
    }
    match io::Error::last_os_error() {
        e if e.kind() == io::ErrorKind::WouldBlock => Err(LockError::Busy(path)),
        e => Err(LockError::Io(format!(
            "cannot lock {}: {e}",
            path.display()
        ))),
    }
}
