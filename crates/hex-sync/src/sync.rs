//! One sync pass: moves every eligible Outbox file into the Archive (ADR 0001).
//!
//! Safety invariants:
//! - nothing in the Archive is ever deleted or overwritten, and nothing is reached through a
//!   symlinked Archive folder;
//! - a source is first renamed to a private claim name (`.hex-sync.<name>`) in its own
//!   folder, so a file that replaces it mid-run is never touched; the claim is removed only
//!   after it was re-hashed equal to a regular Archive file that is not the claim itself, and
//!   restored to its name on any failure. Claims left by a crash are restored before the scan.

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::fmt::Display;
use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::fsio::{
    Digest256, FileId, file_id, hash_file, hash_stream, rename_noreplace, same_file, sync_dir,
};
use crate::journal::{Action, Journal, Outcome};

const PARTIAL_SUFFIX: &[u8] = b".partial";
/// Prefix of a claimed source in the Outbox; the rest of the name is the original name.
const CLAIM_PREFIX: &str = ".hex-sync.";
/// Temp files in the Archive are `.hex-sync-<n>.tmp`.
const TEMP_PREFIX: &str = ".hex-sync-";

/// Why a run stopped before touching anything.
pub struct Abort {
    pub reason: String,
    /// False when the log itself is misplaced, so the abort must not be written to it.
    pub loggable: bool,
}

/// Outbox and Archive, resolved and checked to be readable, distinct, non-nested folders.
pub struct Roots {
    outbox: PathBuf,
    archive: PathBuf,
}

/// Checks both roots and the log location before any action.
pub fn check_roots(outbox: &Path, archive: &Path, log: &Path) -> Result<Roots, Abort> {
    let outbox = check_root(outbox, "Outbox");
    let archive = check_root(archive, "Archive");
    for root in [&outbox, &archive].into_iter().flatten() {
        if log_inside(log, root).map_err(|reason| Abort {
            reason,
            loggable: false,
        })? {
            return Err(Abort {
                reason: format!(
                    "log {} is inside {}; move it out of the Outbox and Archive",
                    log.display(),
                    root.path.display()
                ),
                loggable: false,
            });
        }
    }
    let loggable = |reason| Abort {
        reason,
        loggable: true,
    };
    let (outbox, archive) = (outbox.map_err(loggable)?, archive.map_err(loggable)?);
    // By (device, inode), so firmlinks and bind mounts can't hide an overlap.
    if outbox.chain.contains(&archive.chain[0]) || archive.chain.contains(&outbox.chain[0]) {
        return Err(loggable(format!(
            "Outbox {} and Archive {} overlap",
            outbox.path.display(),
            archive.path.display()
        )));
    }
    Ok(Roots {
        outbox: outbox.path,
        archive: archive.path,
    })
}

struct Root {
    path: PathBuf,
    /// Identities of the folder and all its ancestors, the folder first.
    chain: Vec<FileId>,
}

/// Resolves a root, failing if it is missing, not a directory, or unreadable.
fn check_root(path: &Path, label: &str) -> Result<Root, String> {
    let root = format!("{label} {}", path.display());
    let meta = fs::metadata(path).map_err(|e| format!("{root} is not accessible: {e}"))?;
    if !meta.is_dir() {
        return Err(format!("{root} is not a directory"));
    }
    fs::read_dir(path).map_err(|e| format!("{root} is not readable: {e}"))?;
    let path = fs::canonicalize(path).map_err(|e| format!("{root} cannot be resolved: {e}"))?;
    let chain = identity_chain(&path).map_err(|e| format!("{root} cannot be resolved: {e}"))?;
    Ok(Root { path, chain })
}

fn identity_chain(path: &Path) -> io::Result<Vec<FileId>> {
    path.ancestors()
        .map(|p| fs::metadata(p).map(|m| file_id(&m)))
        .collect()
}

/// True when the log (or the nearest existing folder it would be created in) lies in `root`.
fn log_inside(log: &Path, root: &Root) -> Result<bool, String> {
    let Some(existing) = log.ancestors().find(|p| fs::metadata(p).is_ok()) else {
        return Ok(false);
    };
    let chain = fs::canonicalize(existing)
        .and_then(|p| identity_chain(&p))
        .map_err(|e| format!("log {} cannot be resolved: {e}", log.display()))?;
    Ok(chain.contains(&root.chain[0]))
}

/// Runs one pass; returns the number of files or folders that could not be handled.
pub fn run(roots: &Roots, min_age: Duration, journal: &mut Journal) -> usize {
    let mut pass = Pass {
        outbox: &roots.outbox,
        archive: &roots.archive,
        min_age,
        now: SystemTime::now(),
        journal,
        failures: 0,
        planned: HashSet::new(),
    };
    pass.recover_claims(Path::new(""));
    pass.visit_dir(Path::new(""));
    pass.failures
}

struct Pass<'a> {
    outbox: &'a Path,
    archive: &'a Path,
    min_age: Duration,
    now: SystemTime,
    journal: &'a mut Journal,
    failures: usize,
    /// Archive paths a dry run has planned to create, so later plans avoid them like a
    /// real run would.
    planned: HashSet<PathBuf>,
}

/// Where a source file goes in the Archive.
enum Plan {
    /// Nothing at the same relative path: copy there.
    Copy,
    /// Something different is there: copy beside it under this free `name (n).ext`.
    CopyRenamed(PathBuf),
    /// This regular Archive file (same path or a `name (n).ext`) already holds the same
    /// bytes: only remove the source.
    Identical { target: PathBuf, digest: Digest256 },
}

impl Plan {
    fn action(&self) -> Action {
        match self {
            Self::Copy => Action::Copy,
            Self::CopyRenamed(_) => Action::CopyRenamed,
            Self::Identical { .. } => Action::RemoveIdentical,
        }
    }

    /// Archive path relative to the Archive root.
    fn target<'a>(&'a self, rel: &'a Path) -> &'a Path {
        match self {
            Self::Copy => rel,
            Self::CopyRenamed(target) | Self::Identical { target, .. } => target,
        }
    }
}

enum ArchiveEntry {
    Absent,
    /// Absent on disk, but a dry run already planned a copy there.
    Planned,
    Present(fs::Metadata),
}

enum Age {
    Old,
    Young,
    /// Future or unreadable mtime.
    Unknown,
}

impl Pass<'_> {
    /// Restores claims left by an interrupted run, depth-first, before anything is scanned.
    fn recover_claims(&mut self, rel: &Path) {
        // Unreadable folders are reported by the scan that follows.
        let Ok(entries) = fs::read_dir(self.outbox.join(rel)) else {
            return;
        };
        for entry in entries.flatten() {
            let child = rel.join(entry.file_name());
            match entry.file_type() {
                Ok(t) if t.is_dir() => self.recover_claims(&child),
                Ok(t) if t.is_file() => {
                    if let Some(original) = claimed_name(&entry.file_name()) {
                        let original = rel.join(original);
                        self.restore_claim(&child, &original);
                    }
                }
                _ => {}
            }
        }
    }

    /// Processes a folder (relative to the Outbox); returns true when it ends up empty.
    fn visit_dir(&mut self, rel: &Path) -> bool {
        // Listed up front: claiming renames entries in this folder while it is processed.
        let entries: Vec<_> = match fs::read_dir(self.outbox.join(rel)) {
            Ok(entries) => entries.collect(),
            Err(e) => {
                self.fail(Action::ReadDir, rel, None, e);
                return false;
            }
        };
        let mut empty = true;
        for entry in entries {
            if self.journal.write_failed() {
                // Without a log, nothing more is moved.
                return false;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) => {
                    self.fail(Action::ReadDir, rel, None, e);
                    empty = false;
                    continue;
                }
            };
            let child = rel.join(entry.file_name());
            let removed = match entry.file_type() {
                Ok(t) if t.is_symlink() => {
                    self.journal
                        .record(Action::SkipSymlink, &child, None, Outcome::Skipped);
                    false
                }
                Ok(t) if t.is_dir() => self.visit_dir(&child) && self.remove_empty_dir(&child),
                Ok(t) if t.is_file() => self.visit_file(&child),
                Ok(_) => {
                    self.journal
                        .record(Action::SkipSpecial, &child, None, Outcome::Skipped);
                    false
                }
                Err(e) => {
                    self.fail(Action::Stat, &child, None, e);
                    false
                }
            };
            empty &= removed;
        }
        empty
    }

    /// Removes an empty Outbox subfolder; returns true when it is gone (or would be).
    fn remove_empty_dir(&mut self, rel: &Path) -> bool {
        if self.journal.is_dry_run() {
            self.journal
                .record(Action::Rmdir, rel, None, Outcome::Planned);
            return true;
        }
        match fs::remove_dir(self.outbox.join(rel)) {
            Ok(()) => {
                self.journal.record(Action::Rmdir, rel, None, Outcome::Ok);
                true
            }
            // A file arrived since the scan; it is picked up next run.
            Err(e) if e.kind() == ErrorKind::DirectoryNotEmpty => {
                self.journal.record(Action::Rmdir, rel, None, Outcome::Kept);
                false
            }
            Err(e) => {
                self.fail(Action::Rmdir, rel, None, e);
                false
            }
        }
    }

    /// Processes one regular file; returns true when the source is removed (or would be).
    fn visit_file(&mut self, rel: &Path) -> bool {
        let Some(name) = rel.file_name() else {
            return false;
        };
        if name.as_bytes().ends_with(PARTIAL_SUFFIX) || claimed_name(name).is_some() {
            return false;
        }
        let source = self.outbox.join(rel);
        let meta = match fs::symlink_metadata(&source) {
            Ok(meta) => meta,
            Err(e) => {
                self.fail(Action::Stat, rel, None, e);
                return false;
            }
        };
        match self.age(&meta) {
            Age::Old => {}
            Age::Young => return false,
            Age::Unknown => {
                self.journal
                    .record(Action::SkipFutureMtime, rel, None, Outcome::Skipped);
                return false;
            }
        }
        if let Err(e) = self.check_archive_dirs(rel) {
            self.fail(Action::Plan, rel, None, e);
            return false;
        }
        if self.journal.is_dry_run() {
            return self.plan_only(rel, &source, &meta);
        }

        let claim_rel = rel.with_file_name(claim_name(name));
        let claim = self.outbox.join(&claim_rel);
        if let Err(e) = rename_noreplace(&source, &claim) {
            self.fail(Action::Claim, rel, None, e);
            if fs::symlink_metadata(&claim).is_ok() {
                // The hard-link fallback linked the claim but kept the source name.
                self.restore_claim(&claim_rel, rel);
            }
            return false;
        }
        let (action, target, result) = match self.plan(rel, &claim, &meta) {
            Ok(plan) => {
                let target = plan.target(rel);
                let result = self.execute(&plan, target, &claim);
                (plan.action(), Some(target.to_path_buf()), result)
            }
            Err(e) => (Action::Plan, None, Err(e)),
        };
        match result {
            Ok(()) => {
                self.journal
                    .record(action, rel, target.as_deref(), Outcome::Ok);
                true
            }
            Err(e) => {
                self.fail(action, rel, target.as_deref(), e);
                self.restore_claim(&claim_rel, rel);
                false
            }
        }
    }

    fn plan_only(&mut self, rel: &Path, source: &Path, meta: &fs::Metadata) -> bool {
        match self.plan(rel, source, meta) {
            Ok(plan) => {
                let target = plan.target(rel);
                self.journal
                    .record(plan.action(), rel, Some(target), Outcome::Planned);
                if !matches!(plan, Plan::Identical { .. }) {
                    self.planned.insert(target.to_path_buf());
                }
                true
            }
            Err(e) => {
                self.fail(Action::Plan, rel, None, e);
                false
            }
        }
    }

    fn age(&self, meta: &fs::Metadata) -> Age {
        if self.min_age.is_zero() {
            return Age::Old;
        }
        let Some(age) = meta
            .modified()
            .ok()
            .and_then(|mtime| self.now.duration_since(mtime).ok())
        else {
            return Age::Unknown;
        };
        if age < self.min_age {
            Age::Young
        } else {
            Age::Old
        }
    }

    /// Fails if a folder on the way to the Archive target is a symlink: it could lead back
    /// into the Outbox, making the source its own "Archive copy".
    fn check_archive_dirs(&self, rel: &Path) -> Result<(), String> {
        let mut dir = self.archive.to_path_buf();
        for component in rel.parent().into_iter().flat_map(Path::components) {
            dir.push(component);
            match fs::symlink_metadata(&dir) {
                Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
                Err(e) => return Err(format!("cannot inspect {}: {e}", dir.display())),
                Ok(m) if m.file_type().is_symlink() => {
                    return Err(format!("Archive folder {} is a symlink", dir.display()));
                }
                Ok(_) => {}
            }
        }
        Ok(())
    }

    /// Decides where `file` (the source or its claim, described by `meta`) goes.
    fn plan(&self, rel: &Path, file: &Path, meta: &fs::Metadata) -> Result<Plan, String> {
        let mut file_digest = None;
        let mut candidate = rel.to_path_buf();
        for n in 1u32.. {
            match self.archive_entry(&candidate).map_err(|e| e.to_string())? {
                ArchiveEntry::Absent if n == 1 => return Ok(Plan::Copy),
                ArchiveEntry::Absent => return Ok(Plan::CopyRenamed(candidate)),
                ArchiveEntry::Planned => {}
                // Only a regular file can count as identical; never follow an Archive symlink.
                ArchiveEntry::Present(existing)
                    if existing.is_file() && existing.len() == meta.len() =>
                {
                    if file_id(&existing) == file_id(meta) {
                        return Err(SAME_FILE.into());
                    }
                    let read = |e: io::Error| format!("cannot hash: {e}");
                    let digest = hash_file(&self.archive.join(&candidate)).map_err(read)?;
                    let source_digest = match file_digest {
                        Some(d) => d,
                        None => *file_digest.insert(hash_file(file).map_err(read)?),
                    };
                    if source_digest == digest {
                        return Ok(Plan::Identical {
                            target: candidate,
                            digest,
                        });
                    }
                }
                ArchiveEntry::Present(_) => {}
            }
            candidate = with_suffix(rel, n);
        }
        unreachable!("u32 range exhausted looking for a free name")
    }

    fn archive_entry(&self, rel: &Path) -> io::Result<ArchiveEntry> {
        if self.planned.contains(rel) {
            return Ok(ArchiveEntry::Planned);
        }
        match fs::symlink_metadata(self.archive.join(rel)) {
            Ok(meta) => Ok(ArchiveEntry::Present(meta)),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(ArchiveEntry::Absent),
            Err(e) => Err(e),
        }
    }

    /// Carries out a plan for a claimed source: copy if needed, then remove the claim.
    fn execute(&self, plan: &Plan, target_rel: &Path, claim: &Path) -> Result<(), String> {
        let target = self.archive.join(target_rel);
        let digest = match plan {
            Plan::Identical { digest, .. } => *digest,
            Plan::Copy | Plan::CopyRenamed(_) => copy_verified(claim, &target)?,
        };
        remove_claim(claim, &target, &digest)
    }

    /// Renames a claim back to `original_rel` without replacing anything; if that name was
    /// taken meanwhile, to the lowest free `name (n).ext` in the Outbox.
    fn restore_claim(&mut self, claim_rel: &Path, original_rel: &Path) {
        if self.journal.is_dry_run() {
            self.journal.record(
                Action::RestoreClaim,
                claim_rel,
                Some(original_rel),
                Outcome::Planned,
            );
            return;
        }
        match put_back(self.outbox, claim_rel, original_rel) {
            Ok(restored) => self.journal.record(
                Action::RestoreClaim,
                claim_rel,
                Some(&restored),
                Outcome::Ok,
            ),
            Err(e) => self.fail(Action::RestoreClaim, claim_rel, Some(original_rel), e),
        }
    }

    fn fail(&mut self, action: Action, rel: &Path, target: Option<&Path>, error: impl Display) {
        self.failures += 1;
        self.journal
            .record(action, rel, target, Outcome::Failed(error.to_string()));
    }
}

const SAME_FILE: &str = "source and Archive file are the same file";

fn claim_name(name: &OsStr) -> OsString {
    let mut claim = OsString::from(CLAIM_PREFIX);
    claim.push(name);
    claim
}

/// The original name encoded in a claim name, if `name` is one.
fn claimed_name(name: &OsStr) -> Option<&OsStr> {
    let original = name.as_bytes().strip_prefix(CLAIM_PREFIX.as_bytes())?;
    (!original.is_empty()).then(|| OsStr::from_bytes(original))
}

/// `name (n).ext`, or `name (n)` without an extension, in the same folder as `rel`.
fn with_suffix(rel: &Path, n: u32) -> PathBuf {
    let mut name = OsString::from(rel.file_stem().unwrap_or_default());
    name.push(format!(" ({n})"));
    if let Some(extension) = rel.extension() {
        name.push(".");
        name.push(extension);
    }
    rel.with_file_name(name)
}

/// See [`Pass::restore_claim`]; returns the name the file got back.
fn put_back(outbox: &Path, claim_rel: &Path, original_rel: &Path) -> io::Result<PathBuf> {
    let claim = outbox.join(claim_rel);
    let mut target = original_rel.to_path_buf();
    let mut n = 0;
    loop {
        let dest = outbox.join(&target);
        match rename_noreplace(&claim, &dest) {
            Ok(()) => return Ok(target),
            // Both names hold the same file (a hard-link fallback that could not finish):
            // the claim is a redundant link.
            Err(_) if same_file(&claim, &dest).unwrap_or(false) => {
                fs::remove_file(&claim)?;
                return Ok(target);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                n += 1;
                target = with_suffix(original_rel, n);
            }
            Err(e) => return Err(e),
        }
    }
}

/// Copies `source` to `target` without ever exposing a partial file under `target` or
/// replacing an existing one, makes the new name durable, then re-reads `target` and
/// returns its digest.
fn copy_verified(source: &Path, target: &Path) -> Result<Digest256, String> {
    let dir = target.parent().ok_or("target has no parent folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let (temp, source_digest) = write_temp(source, dir).map_err(|e| format!("copy failed: {e}"))?;
    if let Err(e) = rename_noreplace(&temp, target) {
        if same_file(&temp, target).unwrap_or(false) {
            return Err(format!(
                "Archive copy placed, but temp link {} left: {e}",
                temp.display()
            ));
        }
        // `write_temp` created this temp file, so removing it touches nothing else.
        return Err(match fs::remove_file(&temp) {
            Ok(()) => format!("copy failed: {e}"),
            Err(re) => format!("copy failed: {e}; temp {} left: {re}", temp.display()),
        });
    }
    sync_dir(dir).map_err(|e| format!("cannot sync {}: {e}", dir.display()))?;
    let target_digest =
        hash_file(target).map_err(|e| format!("cannot re-read Archive copy: {e}"))?;
    if source_digest != target_digest {
        return Err("verification failed: Archive copy differs from source".into());
    }
    Ok(target_digest)
}

/// Copies `source` into a new `.hex-sync-<n>.tmp` in `dir` (lowest `n` not taken), synced
/// to disk; returns its path and the digest of the bytes read.
fn write_temp(source: &Path, dir: &Path) -> io::Result<(PathBuf, Digest256)> {
    let mut input = fs::File::open(source)?;
    for n in 0u32.. {
        let temp = dir.join(format!("{TEMP_PREFIX}{n}.tmp"));
        let mut output = match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(output) => output,
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        let written = hash_stream(&mut input, |chunk| output.write_all(chunk))
            .and_then(|digest| output.sync_all().map(|()| digest));
        return match written {
            Ok(digest) => Ok((temp, digest)),
            Err(e) => {
                // Created by this call above, so it is this run's own scratch file.
                if let Err(re) = fs::remove_file(&temp) {
                    return Err(io::Error::other(format!(
                        "{e}; temp {} left: {re}",
                        temp.display()
                    )));
                }
                Err(e)
            }
        };
    }
    unreachable!("u32 range exhausted looking for a free temp name")
}

/// Removes the claim only if it still hashes to `expected` (the Archive copy's digest) and
/// is not itself the Archive file.
fn remove_claim(claim: &Path, target: &Path, expected: &Digest256) -> Result<(), String> {
    let digest = hash_file(claim).map_err(|e| format!("cannot re-read source: {e}"))?;
    if &digest != expected {
        return Err("source changed during sync; kept for next run".into());
    }
    if same_file(claim, target).map_err(|e| format!("cannot compare with Archive file: {e}"))? {
        return Err(SAME_FILE.into());
    }
    fs::remove_file(claim).map_err(|e| format!("cannot remove source: {e}"))
}
