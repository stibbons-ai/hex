//! One sync pass: moves every eligible Outbox file into the Archive (ADR 0001).
//!
//! Safety invariants:
//! - nothing in the Archive is ever deleted or overwritten, and nothing is reached through a
//!   symlinked Archive folder;
//! - a source is first renamed to a private claim name (`.hex-sync.<name>`) in its own
//!   folder, so a file that replaces it mid-run is never touched; the claim is removed only
//!   after it was re-hashed equal to a regular Archive file that is not the claim itself, and
//!   whose folder entry was synced to disk; on any failure it is restored to its name (or
//!   `name (n).ext` if that was taken meanwhile). Claims left by a crash are restored before
//!   the scan.

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fmt::Display;
use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::fsio::{
    Digest256, FileId, RenameError, create_dir_all_durable, hash_file, hash_stream, is_same,
    lineage, rename_noreplace, same_file, sync_dir,
};
use crate::journal::{Action, Journal, Outcome};

const PARTIAL_SUFFIX: &[u8] = b".partial";
/// Folder metadata written by Finder and Explorer; never a Document.
const OS_METADATA_NAMES: [&[u8]; 2] = [b".DS_Store", b"Thumbs.db"];
/// AppleDouble resource-fork companions written on non-HFS volumes: `._<name>`, starting
/// with this magic number. The name alone is not enough, since a Document may start with `._`.
const APPLE_DOUBLE_PREFIX: &[u8] = b"._";
const APPLE_DOUBLE_MAGIC: [u8; 4] = [0x00, 0x05, 0x16, 0x07];
/// Prefix of a claimed source in the Outbox; the rest of the name is the original name.
const CLAIM_PREFIX: &str = ".hex-sync.";
/// Temp files in the Archive are `.hex-sync-<n>.tmp`.
const TEMP_PREFIX: &str = ".hex-sync-";
const SAME_FILE: &str = "source and Archive file are the same file";
const ENDLESS: &str = "an unbounded name sequence always reaches a free name";

/// Why a run stopped before touching anything.
pub struct Abort {
    pub reason: String,
    /// True when the abort may be appended to the log (it is, only if the log's folder
    /// already exists). False when the log lies inside a root, is a symlink, or cannot be
    /// resolved, so the abort goes to stderr only.
    pub loggable: bool,
}

/// Outbox and Archive, resolved and checked to be readable, distinct, non-nested folders.
pub struct Roots {
    outbox: PathBuf,
    archive: PathBuf,
}

/// Checks both roots and the log location before any action.
pub fn check_roots(outbox: &Path, archive: &Path, log: &Path) -> Result<Roots, Abort> {
    let outbox_identity = identify(outbox);
    let archive_identity = identify(archive);
    check_log_location(log, [&outbox_identity, &archive_identity]).map_err(|reason| Abort {
        reason,
        loggable: false,
    })?;
    let loggable = |reason| Abort {
        reason,
        loggable: true,
    };
    let (outbox, archive) = (
        check_root(outbox, "Outbox", outbox_identity).map_err(loggable)?,
        check_root(archive, "Archive", archive_identity).map_err(loggable)?,
    );
    // By (device, inode), so firmlinks and bind mounts can't hide an overlap.
    if outbox.is_within(archive.id()) || archive.is_within(outbox.id()) {
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

/// Checks only the log location: not a symlink, not inside an Outbox or Archive that
/// resolves. A root that doesn't resolve (missing, or an unreadable ancestor) passes: it may
/// be an unmounted drive.
pub fn check_log(outbox: &Path, archive: &Path, log: &Path) -> Result<(), String> {
    check_log_location(log, [&identify(outbox), &identify(archive)])
}

fn check_log_location(log: &Path, roots: [&io::Result<Root>; 2]) -> Result<(), String> {
    if fs::symlink_metadata(log).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!(
            "log {} is a symlink; point the config at its target",
            log.display()
        ));
    }
    // Every root that resolves counts, readable or not. One that doesn't is not looked at:
    // in `run`, `check_root` then aborts without creating a folder, so a log under a missing
    // root stays unwritten whatever its spelling.
    for root in roots.into_iter().flatten() {
        if log_inside(log, root)? {
            return Err(format!(
                "log {} is inside {}; move it out of the Outbox and Archive",
                log.display(),
                root.path.display()
            ));
        }
    }
    Ok(())
}

struct Root {
    path: PathBuf,
    /// Identities of the folder and all its ancestors, the folder first (never empty).
    lineage: Vec<FileId>,
}

impl Root {
    fn id(&self) -> FileId {
        self.lineage[0]
    }

    /// True when this root is the folder `id` or lies inside it.
    fn is_within(&self, id: FileId) -> bool {
        self.lineage.contains(&id)
    }
}

/// Canonical path and lineage of an existing folder, whether or not it is readable.
fn identify(path: &Path) -> io::Result<Root> {
    let path = fs::canonicalize(path)?;
    let lineage = lineage(&path)?;
    Ok(Root { path, lineage })
}

/// Fails if the root is missing, not a directory, or unreadable; otherwise returns its
/// `identity`.
fn check_root(path: &Path, label: &str, identity: io::Result<Root>) -> Result<Root, String> {
    let root = format!("{label} {}", path.display());
    let meta = fs::metadata(path).map_err(|e| format!("{root} is not accessible: {e}"))?;
    if !meta.is_dir() {
        return Err(format!("{root} is not a directory"));
    }
    fs::read_dir(path).map_err(|e| format!("{root} is not readable: {e}"))?;
    identity.map_err(|e| format!("{root} cannot be resolved: {e}"))
}

/// True when the log (or the nearest existing folder it would be created in) lies in `root`.
fn log_inside(log: &Path, root: &Root) -> Result<bool, String> {
    let Some(existing) = log.ancestors().find(|p| fs::metadata(p).is_ok()) else {
        return Ok(false);
    };
    let log_lineage = fs::canonicalize(existing)
        .and_then(|p| lineage(&p))
        .map_err(|e| format!("log {} cannot be resolved: {e}", log.display()))?;
    Ok(log_lineage.contains(&root.id()))
}

/// Runs one pass; returns the number of files or folders that could not be handled.
pub fn run(roots: &Roots, min_age: Duration, journal: &mut Journal) -> usize {
    let mut pass = Pass {
        outbox: &roots.outbox,
        archive: &roots.archive,
        min_age,
        journal,
        failures: 0,
        planned: HashSet::new(),
        planned_restores: HashSet::new(),
        planned_claims: HashMap::new(),
    };
    pass.recover_claims(Path::new(""));
    pass.visit_dir(Path::new(""));
    pass.failures
}

struct Pass<'a> {
    outbox: &'a Path,
    archive: &'a Path,
    min_age: Duration,
    journal: &'a mut Journal,
    failures: usize,
    /// Dry run: Archive paths planned to be created, so later plans avoid them like a real
    /// run would.
    planned: HashSet<PathBuf>,
    /// Dry run: Outbox names claims are planned to be restored to.
    planned_restores: HashSet<PathBuf>,
    /// Dry run: claim (relative path) → whether its restored file would leave the Outbox.
    planned_claims: HashMap<PathBuf, bool>,
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
                        if self.journal.is_dry_run() {
                            self.plan_recovery(&child, &original);
                        } else {
                            self.restore_claim(&child, &original);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    /// Dry run: plans a claim's restore under the name the real run would pick, then plans
    /// the restored file like the scan would.
    fn plan_recovery(&mut self, claim_rel: &Path, original_rel: &Path) {
        let claim = self.outbox.join(claim_rel);
        let found = fs::symlink_metadata(&claim).and_then(|claim_meta| {
            restore_target(
                self.outbox,
                &claim_meta,
                original_rel,
                &self.planned_restores,
            )
        });
        let (target, redundant) = match found {
            Ok(found) => found,
            Err(e) => {
                self.fail(Action::RestoreClaim, claim_rel, None, e);
                return;
            }
        };
        self.journal.record(
            Action::RestoreClaim,
            claim_rel,
            Some(&target),
            Outcome::Planned,
        );
        // A redundant claim is just dropped; the scan plans the file under its own name.
        let removed = redundant || self.visit_file_at(&target, &claim);
        self.planned_restores.insert(target);
        self.planned_claims.insert(claim_rel.to_path_buf(), removed);
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
                Ok(t) if t.is_file() => match self.planned_claims.get(&child) {
                    // Dry run: already planned by `plan_recovery`.
                    Some(&removed) => removed,
                    None => self.visit_file_at(&child, &self.outbox.join(&child)),
                },
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

    /// Processes the regular file at `source`, known in the Outbox as `rel` (on a dry run a
    /// claim's file under its restored name); returns true when the source is removed (or
    /// would be).
    fn visit_file_at(&mut self, rel: &Path, source: &Path) -> bool {
        let Some(name) = rel.file_name() else {
            return false;
        };
        if is_ignored(name) || claimed_name(name).is_some() {
            return false;
        }
        let meta = match fs::symlink_metadata(source) {
            Ok(meta) => meta,
            Err(e) => {
                self.fail(Action::Stat, rel, None, e);
                return false;
            }
        };
        if name.as_bytes().starts_with(APPLE_DOUBLE_PREFIX) && is_apple_double(source) {
            return false;
        }
        match self.age(&meta) {
            Age::Old => {}
            Age::Young => return false,
            Age::Unknown => {
                self.journal
                    .record(Action::SkipBadMtime, rel, None, Outcome::Skipped);
                return false;
            }
        }
        if let Err(e) = self.check_archive_dirs(rel) {
            self.fail(Action::Plan, rel, None, e);
            return false;
        }
        if self.journal.is_dry_run() {
            return self.plan_only(rel, source, &meta);
        }

        let claim_rel = rel.with_file_name(claim_name(name));
        let claim = self.outbox.join(&claim_rel);
        if let Err(e) = rename_noreplace(source, &claim) {
            let both_linked = matches!(e, RenameError::BothLinked(_));
            self.fail(Action::Claim, rel, None, e);
            if both_linked {
                // The claim may be a second link to the source, which keeps the bytes.
                match same_file(source, &claim) {
                    Ok(true) => {
                        if let Err(e) = fs::remove_file(&claim) {
                            self.fail(Action::Claim, &claim_rel, None, e);
                        }
                    }
                    Ok(false) => {}
                    Err(e) => {
                        let error = format!("cannot compare with source: {e}");
                        self.fail(Action::Claim, &claim_rel, None, error);
                    }
                }
            }
            return false;
        }
        // Whatever was renamed must be the regular file that was scanned.
        match fs::symlink_metadata(&claim) {
            Ok(claimed) if claimed.is_file() && is_same(&claimed, &meta) => {}
            claimed => {
                let detail = claimed.err().map(|e| format!(": {e}")).unwrap_or_default();
                let error = format!("source changed before it was claimed{detail}");
                self.fail(Action::Claim, rel, None, error);
                self.restore_claim(&claim_rel, rel);
                return false;
            }
        }
        let (action, target, result) = match self.plan(rel, &claim, &meta) {
            Ok(plan) => {
                let target = plan.target(rel).to_path_buf();
                let result = self.execute(&plan, &target, &claim);
                (plan.action(), Some(target), result)
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

    /// A future or unreadable mtime is never old enough, whatever `min_age_secs` says. The
    /// clock is read per file, so a file arriving mid-run is merely young.
    fn age(&self, meta: &fs::Metadata) -> Age {
        let Some(age) = meta
            .modified()
            .ok()
            .and_then(|mtime| SystemTime::now().duration_since(mtime).ok())
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
        for (n, candidate) in candidates(rel).enumerate() {
            match self.archive_entry(&candidate).map_err(|e| e.to_string())? {
                ArchiveEntry::Absent if n == 0 => return Ok(Plan::Copy),
                ArchiveEntry::Absent => return Ok(Plan::CopyRenamed(candidate)),
                ArchiveEntry::Planned => {}
                // Only a regular file can count as identical; never follow an Archive symlink.
                ArchiveEntry::Present(existing)
                    if existing.is_file() && existing.len() == meta.len() =>
                {
                    if is_same(&existing, meta) {
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
        }
        unreachable!("{ENDLESS}")
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

    /// Carries out a plan for a claimed source: copy if needed, make the Archive entry
    /// durable, then remove the claim.
    fn execute(&mut self, plan: &Plan, target_rel: &Path, claim: &Path) -> Result<(), String> {
        let target = self.archive.join(target_rel);
        let digest = match plan {
            Plan::Identical { digest, .. } => *digest,
            Plan::Copy | Plan::CopyRenamed(_) => self.copy_verified(claim, &target)?,
        };
        let dir = parent_dir(&target)?;
        sync_dir(dir).map_err(|e| format!("cannot sync {}: {e}", dir.display()))?;
        remove_claim(claim, &target, &digest)
    }

    /// Copies `source` to `target` without ever exposing a partial file under `target` or
    /// replacing an existing one, then re-reads `target` and returns its digest.
    fn copy_verified(&mut self, source: &Path, target: &Path) -> Result<Digest256, String> {
        let dir = parent_dir(target)?;
        create_dir_all_durable(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        let (temp, source_digest) = self
            .write_temp(source, dir, target)
            .map_err(|e| format!("copy failed: {e}"))?;
        match rename_noreplace(&temp, target) {
            Ok(()) => {}
            Err(e @ RenameError::BothLinked(_)) => {
                return Err(format!(
                    "Archive copy placed, but temp {} left: {e}",
                    temp.display()
                ));
            }
            // `write_temp` created this temp file, so removing it touches nothing else.
            Err(RenameError::Failed(e)) => {
                return Err(format!("copy failed: {}", discard_temp(&temp, e)));
            }
        }
        let target_digest =
            hash_file(target).map_err(|e| format!("cannot re-read Archive copy: {e}"))?;
        if source_digest != target_digest {
            return Err("verification failed: Archive copy differs from source".into());
        }
        Ok(target_digest)
    }

    /// Copies `source` into a new `.hex-sync-<n>.tmp` in `dir` (lowest `n` not taken and not
    /// `target` itself), synced to disk; returns its path and the digest of the bytes read.
    /// Temps already there are logged as `stale-temp` and left alone.
    fn write_temp(
        &mut self,
        source: &Path,
        dir: &Path,
        target: &Path,
    ) -> io::Result<(PathBuf, Digest256)> {
        let mut input = fs::File::open(source)?;
        for n in 0u32.. {
            let temp = dir.join(format!("{TEMP_PREFIX}{n}.tmp"));
            if temp == target {
                continue;
            }
            let mut output = match OpenOptions::new().write(true).create_new(true).open(&temp) {
                Ok(output) => output,
                Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                    let stale = temp.strip_prefix(self.archive).unwrap_or(&temp);
                    self.journal
                        .record(Action::StaleTemp, stale, None, Outcome::Kept);
                    continue;
                }
                Err(e) => return Err(e),
            };
            let written = hash_stream(&mut input, |chunk| output.write_all(chunk))
                .and_then(|digest| output.sync_all().map(|()| digest));
            return match written {
                Ok(digest) => Ok((temp, digest)),
                // Created by this call above, so it is this run's own scratch file.
                Err(e) => Err(io::Error::other(discard_temp(&temp, e))),
            };
        }
        unreachable!("{ENDLESS}")
    }

    /// Renames a claim back to `original_rel` without replacing anything; if that name was
    /// taken meanwhile, to the lowest free `name (n).ext` in the Outbox.
    fn restore_claim(&mut self, claim_rel: &Path, original_rel: &Path) {
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

/// Names the sync never moves: Filing's in-progress `*.partial` files and folder metadata.
fn is_ignored(name: &OsStr) -> bool {
    let name = name.as_bytes();
    name.ends_with(PARTIAL_SUFFIX) || OS_METADATA_NAMES.contains(&name)
}

/// Whether the file at `path` starts with the AppleDouble magic number. Opened without
/// following a symlink or blocking on a FIFO swapped in since the scan. An unreadable file
/// counts as not AppleDouble, so it goes on to the normal path, which reports the error.
fn is_apple_double(path: &Path) -> bool {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let mut magic = [0u8; 4];
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .is_ok_and(|()| magic == APPLE_DOUBLE_MAGIC)
}

/// `rel`, then `name (1).ext`, `name (2).ext`, … (`name (n)` without an extension) in the
/// same folder.
fn candidates(rel: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    std::iter::once(rel.to_path_buf()).chain((1u32..).map(move |n| {
        let mut name = OsString::from(rel.file_stem().unwrap_or_default());
        name.push(format!(" ({n})"));
        if let Some(extension) = rel.extension() {
            name.push(".");
            name.push(extension);
        }
        rel.with_file_name(name)
    }))
}

/// The folder holding an Archive target.
fn parent_dir(target: &Path) -> Result<&Path, String> {
    target
        .parent()
        .ok_or_else(|| "target has no parent folder".into())
}

/// Removes a temp file this run created after `error`; the message notes a failed removal.
fn discard_temp(temp: &Path, error: impl Display) -> String {
    match fs::remove_file(temp) {
        Ok(()) => error.to_string(),
        Err(e) => format!("{error}; temp {} left: {e}", temp.display()),
    }
}

/// Where a claim goes back to: the first of `original_rel`, `name (1).ext`, … (skipping
/// `taken`) that is free, or that already holds the claim's file, in which case the claim is
/// a redundant second link (`true`). Shared by the restore and its dry-run plan.
fn restore_target(
    outbox: &Path,
    claim_meta: &fs::Metadata,
    original_rel: &Path,
    taken: &HashSet<PathBuf>,
) -> io::Result<(PathBuf, bool)> {
    for candidate in candidates(original_rel) {
        if taken.contains(&candidate) {
            continue;
        }
        match fs::symlink_metadata(outbox.join(&candidate)) {
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok((candidate, false)),
            Ok(existing) if is_same(&existing, claim_meta) => return Ok((candidate, true)),
            Ok(_) => {}
            Err(e) => return Err(e),
        }
    }
    unreachable!("{ENDLESS}")
}

/// See [`Pass::restore_claim`]; returns the name the file got back.
fn put_back(outbox: &Path, claim_rel: &Path, original_rel: &Path) -> Result<PathBuf, String> {
    let claim = outbox.join(claim_rel);
    let claim_meta = fs::symlink_metadata(&claim).map_err(|e| e.to_string())?;
    loop {
        let (target, redundant) =
            restore_target(outbox, &claim_meta, original_rel, &HashSet::new())
                .map_err(|e| e.to_string())?;
        if !redundant {
            match rename_noreplace(&claim, &outbox.join(&target)) {
                Ok(()) => return Ok(target),
                // Both names now hold the file: the claim link is dropped below.
                Err(RenameError::BothLinked(_)) => {}
                // Taken since it was checked: look again.
                Err(RenameError::Failed(e)) if e.kind() == ErrorKind::AlreadyExists => continue,
                Err(RenameError::Failed(e)) => return Err(e.to_string()),
            }
        }
        return match fs::remove_file(&claim) {
            Ok(()) => Ok(target),
            Err(e) => Err(format!(
                "restored as {}, but cannot remove the claim link: {e}",
                target.display()
            )),
        };
    }
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
