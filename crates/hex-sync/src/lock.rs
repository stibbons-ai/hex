//! Run lock: one real `run` at a time, via `flock` on `<log>.lock`.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

/// Why [`lock_run`] did not return the lock.
pub enum LockError {
    /// Another process holds the lock.
    Busy(PathBuf),
    Io(PathBuf, io::Error),
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
    let io_error = |e| LockError::Io(path.clone(), e);
    if let Some(parent) = log.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .map_err(io_error)?;
    // SAFETY: `file` owns a valid open descriptor for the duration of the call.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(file);
    }
    match io::Error::last_os_error() {
        e if e.kind() == io::ErrorKind::WouldBlock => Err(LockError::Busy(path)),
        e => Err(io_error(e)),
    }
}
