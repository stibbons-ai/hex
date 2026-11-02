//! One sync pass: moves every eligible Outbox file into the Archive (ADR 0001).
//!
//! Safety invariants:
//! - nothing in the Archive is ever deleted or overwritten;
//! - a source is removed only after its bytes were hashed equal to a regular Archive file,
//!   re-hashing the source right before removal.

use std::ffi::OsString;
use std::fmt::Display;
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};

use crate::journal::Journal;

const PARTIAL_SUFFIX: &str = ".partial";
const BUFFER_SIZE: usize = 64 * 1024;

type Digest256 = sha2::digest::Output<Sha256>;

/// Runs one pass; returns the number of files or directories that could not be handled,
/// or the reason it aborted before touching anything.
pub fn run(
    outbox: &Path,
    archive: &Path,
    min_age: Duration,
    journal: &mut Journal,
) -> Result<usize, String> {
    let outbox = check_root(outbox, "Outbox")?;
    let archive = check_root(archive, "Archive")?;
    if outbox.starts_with(&archive) || archive.starts_with(&outbox) {
        return Err(format!(
            "Outbox {} and Archive {} overlap",
            outbox.display(),
            archive.display()
        ));
    }
    let mut pass = Pass {
        outbox,
        archive,
        min_age,
        now: SystemTime::now(),
        journal,
        failures: 0,
    };
    pass.visit_dir(Path::new(""));
    Ok(pass.failures)
}

/// Resolves a root, failing if it is missing, not a directory, or unreadable.
fn check_root(path: &Path, label: &str) -> Result<PathBuf, String> {
    let root = format!("{label} {}", path.display());
    let meta = fs::metadata(path).map_err(|e| format!("{root} is not accessible: {e}"))?;
    if !meta.is_dir() {
        return Err(format!("{root} is not a directory"));
    }
    fs::read_dir(path).map_err(|e| format!("{root} is not readable: {e}"))?;
    fs::canonicalize(path).map_err(|e| format!("{root} cannot be resolved: {e}"))
}

struct Pass<'a> {
    outbox: PathBuf,
    archive: PathBuf,
    min_age: Duration,
    now: SystemTime,
    journal: &'a mut Journal,
    failures: usize,
}

/// Where a source file goes in the Archive.
enum Plan {
    /// Nothing at the same path: copy there.
    Copy(PathBuf),
    /// A byte-identical regular file is already there: only remove the source.
    Identical { digest: Digest256 },
    /// Something different is there: copy beside it under a free `name (n).ext`.
    CopyRenamed(PathBuf),
}

impl Pass<'_> {
    /// Processes a directory (relative to the Outbox); returns true when it ends up empty.
    fn visit_dir(&mut self, rel: &Path) -> bool {
        let entries = match fs::read_dir(self.outbox.join(rel)) {
            Ok(entries) => entries,
            Err(e) => {
                self.fail("read-dir", rel, None, e);
                return false;
            }
        };
        let mut empty = true;
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) => {
                    self.fail("read-dir", rel, None, e);
                    empty = false;
                    continue;
                }
            };
            let child = rel.join(entry.file_name());
            let removed = match entry.file_type() {
                Ok(t) if t.is_symlink() => {
                    self.journal.record("skip-symlink", &child, None, "skipped");
                    false
                }
                Ok(t) if t.is_dir() => self.visit_dir(&child) && self.remove_empty_dir(&child),
                Ok(t) if t.is_file() => self.visit_file(&child),
                Ok(_) => {
                    self.journal.record("skip-special", &child, None, "skipped");
                    false
                }
                Err(e) => {
                    self.fail("stat", &child, None, e);
                    false
                }
            };
            empty &= removed;
        }
        empty
    }

    /// Removes an empty Outbox subdirectory; returns true when it is gone (or would be).
    fn remove_empty_dir(&mut self, rel: &Path) -> bool {
        if self.journal.is_dry_run() {
            self.journal.record("rmdir", rel, None, "planned");
            return true;
        }
        match fs::remove_dir(self.outbox.join(rel)) {
            Ok(()) => {
                self.journal.record("rmdir", rel, None, "ok");
                true
            }
            // A file arrived since it was scanned; it is picked up next run.
            Err(e) if e.kind() == ErrorKind::DirectoryNotEmpty => false,
            Err(e) => {
                self.fail("rmdir", rel, None, e);
                false
            }
        }
    }

    /// Processes one regular file; returns true when the source is removed (or would be).
    fn visit_file(&mut self, rel: &Path) -> bool {
        if is_partial(rel) {
            return false;
        }
        let source = self.outbox.join(rel);
        let meta = match fs::symlink_metadata(&source) {
            Ok(meta) => meta,
            Err(e) => {
                self.fail("stat", rel, None, e);
                return false;
            }
        };
        if self.too_young(&meta) {
            return false;
        }
        let plan = match self.plan(rel, &source, meta.len()) {
            Ok(plan) => plan,
            Err(e) => {
                self.fail("plan", rel, None, e);
                return false;
            }
        };
        let (action, target) = match &plan {
            Plan::Copy(target) => ("copy", target.as_path()),
            Plan::Identical { .. } => ("remove-identical", rel),
            Plan::CopyRenamed(target) => ("copy-renamed", target.as_path()),
        };
        if self.journal.is_dry_run() {
            self.journal.record(action, rel, Some(target), "planned");
            return true;
        }
        let result = match &plan {
            Plan::Copy(_) | Plan::CopyRenamed(_) => {
                copy_verified(&source, &self.archive.join(target))
            }
            Plan::Identical { digest } => Ok(*digest),
        }
        .and_then(|digest| remove_source(&source, &digest));
        match result {
            Ok(()) => {
                self.journal.record(action, rel, Some(target), "ok");
                true
            }
            Err(e) => {
                self.fail(action, rel, Some(target), e);
                false
            }
        }
    }

    fn too_young(&self, meta: &fs::Metadata) -> bool {
        if self.min_age.is_zero() {
            return false;
        }
        // An unreadable or future mtime counts as young: wait rather than move early.
        meta.modified()
            .ok()
            .and_then(|mtime| self.now.duration_since(mtime).ok())
            .is_none_or(|age| age < self.min_age)
    }

    fn plan(&self, rel: &Path, source: &Path, source_len: u64) -> io::Result<Plan> {
        let target = self.archive.join(rel);
        let existing = match fs::symlink_metadata(&target) {
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Plan::Copy(rel.to_path_buf())),
            other => other?,
        };
        // Only a regular file can count as identical; never follow an Archive symlink.
        if existing.is_file() && existing.len() == source_len {
            let digest = hash_file(&target)?;
            if hash_file(source)? == digest {
                return Ok(Plan::Identical { digest });
            }
        }
        Ok(Plan::CopyRenamed(self.free_name(rel)?))
    }

    /// Lowest `name (n).ext` (n >= 1) not present in the Archive.
    fn free_name(&self, rel: &Path) -> io::Result<PathBuf> {
        let stem = rel.file_stem().unwrap_or_default();
        let extension = rel.extension();
        for n in 1u32.. {
            let mut name = OsString::from(stem);
            name.push(format!(" ({n})"));
            if let Some(extension) = extension {
                name.push(".");
                name.push(extension);
            }
            let candidate = rel.with_file_name(name);
            match fs::symlink_metadata(self.archive.join(&candidate)) {
                Err(e) if e.kind() == ErrorKind::NotFound => return Ok(candidate),
                Err(e) => return Err(e),
                Ok(_) => {}
            }
        }
        unreachable!("u32 range exhausted looking for a free name")
    }

    fn fail(&mut self, action: &str, rel: &Path, target: Option<&Path>, error: impl Display) {
        self.failures += 1;
        self.journal
            .record(action, rel, target, &format!("failed: {error}"));
    }
}

fn is_partial(rel: &Path) -> bool {
    rel.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(PARTIAL_SUFFIX))
}

/// Copies `source` to `target` without ever exposing a partial file under `target` or
/// replacing an existing one, then re-reads `target` and returns its digest.
fn copy_verified(source: &Path, target: &Path) -> Result<Digest256, String> {
    let dir = target.parent().ok_or("target has no parent directory")?;
    fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let name = target.file_name().ok_or("target has no file name")?;
    let mut temp_name = OsString::from(".");
    temp_name.push(name);
    temp_name.push(format!(".hex-sync-{}.tmp", std::process::id()));
    let temp = dir.join(temp_name);

    let placed = write_temp(source, &temp)
        .and_then(|digest| rename_noreplace(&temp, target).map(|()| digest));
    let source_digest = match placed {
        Ok(digest) => digest,
        Err(e) => {
            // The temp file is this run's own scratch file, never an Archive Document.
            let _ = fs::remove_file(&temp);
            return Err(format!("copy failed: {e}"));
        }
    };
    let target_digest =
        hash_file(target).map_err(|e| format!("cannot re-read Archive copy: {e}"))?;
    if source_digest != target_digest {
        return Err("verification failed: Archive copy differs from source".into());
    }
    Ok(target_digest)
}

/// Copies `source` into a new file `temp`, synced to disk; returns the digest of the bytes read.
fn write_temp(source: &Path, temp: &Path) -> io::Result<Digest256> {
    let mut input = File::open(source)?;
    let mut output = OpenOptions::new().write(true).create_new(true).open(temp)?;
    let digest = hash_stream(&mut input, |chunk| output.write_all(chunk))?;
    output.sync_all()?;
    Ok(digest)
}

/// Removes the source only if it still hashes to `expected` (the Archive copy's digest).
fn remove_source(source: &Path, expected: &Digest256) -> Result<(), String> {
    let digest = hash_file(source).map_err(|e| format!("cannot re-read source: {e}"))?;
    if &digest != expected {
        return Err("source changed during sync; kept for next run".into());
    }
    fs::remove_file(source).map_err(|e| format!("cannot remove source: {e}"))
}

fn hash_file(path: &Path) -> io::Result<Digest256> {
    hash_stream(&mut File::open(path)?, |_| Ok(()))
}

/// Reads `input` to the end, handing each chunk to `sink`; returns the SHA-256 of all bytes.
fn hash_stream(
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

/// Atomic rename that fails with `AlreadyExists` instead of replacing `to`.
fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    match rename_exclusive(from, to) {
        Err(e)
            if matches!(
                e.raw_os_error(),
                Some(libc::EINVAL | libc::ENOTSUP | libc::ENOSYS)
            ) =>
        {
            // The filesystem lacks an exclusive rename: a hard link also refuses to replace.
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
