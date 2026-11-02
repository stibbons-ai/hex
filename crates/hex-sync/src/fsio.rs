//! Filesystem primitives the sync relies on for its safety guarantees.

use std::fs::{self, File};
use std::io::{self, ErrorKind, Read};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use sha2::{Digest, Sha256};

const BUFFER_SIZE: usize = 64 * 1024;

pub type Digest256 = sha2::digest::Output<Sha256>;

/// (device, inode): identifies a file or directory regardless of the path used to reach it
/// (symlinks, macOS firmlinks, bind mounts).
pub type FileId = (u64, u64);

pub fn file_id(meta: &fs::Metadata) -> FileId {
    (meta.dev(), meta.ino())
}

/// True when both paths name the same inode (symlinks not followed).
pub fn same_file(a: &Path, b: &Path) -> io::Result<bool> {
    Ok(file_id(&fs::symlink_metadata(a)?) == file_id(&fs::symlink_metadata(b)?))
}

pub fn hash_file(path: &Path) -> io::Result<Digest256> {
    hash_stream(&mut File::open(path)?, |_| Ok(()))
}

/// Reads `input` to the end, handing each chunk to `sink`; returns the SHA-256 of all bytes.
pub fn hash_stream(
    input: &mut File,
    mut sink: impl FnMut(&[u8]) -> io::Result<()>,
) -> io::Result<Digest256> {
    let mut hasher = Sha256::new();
    let mut buffer = [0; BUFFER_SIZE];
    loop {
        let read = match input.read(&mut buffer) {
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            other => other?,
        };
        if read == 0 {
            return Ok(hasher.finalize());
        }
        hasher.update(&buffer[..read]);
        sink(&buffer[..read])?;
    }
}

/// Flushes a directory's entries (a rename or link inside it) to stable storage.
pub fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

/// Atomic rename that fails with `AlreadyExists` instead of replacing `to`.
///
/// Where the filesystem lacks an exclusive rename it falls back to `hard_link` (which also
/// refuses to replace) plus removing `from`. If only that removal fails, the error is
/// returned with both names still linked to the same file; callers check with `same_file`.
pub fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    match rename_exclusive(from, to) {
        Err(e)
            if matches!(
                e.raw_os_error(),
                Some(libc::EINVAL | libc::ENOTSUP | libc::ENOSYS)
            ) =>
        {
            fs::hard_link(from, to)?;
            fs::remove_file(from)
        }
        other => other,
    }
}

#[cfg(target_os = "macos")]
fn rename_exclusive(from: &Path, to: &Path) -> io::Result<()> {
    let (from, to) = (c_path(from)?, c_path(to)?);
    // SAFETY: both pointers are valid NUL-terminated strings for the duration of the call.
    check_rc(unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) })
}

#[cfg(target_os = "linux")]
fn rename_exclusive(from: &Path, to: &Path) -> io::Result<()> {
    let (from, to) = (c_path(from)?, c_path(to)?);
    // SAFETY: both pointers are valid NUL-terminated strings for the duration of the call.
    check_rc(unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rename_exclusive(_from: &Path, _to: &Path) -> io::Result<()> {
    Err(io::Error::from_raw_os_error(libc::ENOSYS))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn c_path(path: &Path) -> io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    Ok(std::ffi::CString::new(path.as_os_str().as_bytes())?)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn check_rc(rc: libc::c_int) -> io::Result<()> {
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
