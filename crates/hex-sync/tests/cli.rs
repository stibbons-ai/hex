//! Seam tests: run the real `hex-sync` binary against temporary Outbox/Archive folders.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use filetime::FileTime;
use tempfile::TempDir;

/// Held while a child is spawned, and while a descriptor no child may inherit is opened or
/// closed. A child that another test thread forks in the meantime holds every open
/// descriptor until it execs: `run_with_closed_stdout`'s pipe read end (the write the test
/// expects to fail could then succeed), a just-written script (its exec fails with
/// ETXTBSY), a released run lock (still held). `spawn` returns only after the exec.
static SPAWN: Mutex<()> = Mutex::new(());

fn spawn_locked<T>(f: impl FnOnce() -> T) -> T {
    let _guard = SPAWN.lock().unwrap_or_else(PoisonError::into_inner);
    f()
}

const BIN: &str = env!("CARGO_BIN_EXE_hex-sync");

struct Env {
    _tmp: TempDir,
    /// Holds `outbox/`, `archive/`, the config and the default log; nothing outside it.
    root: PathBuf,
    outbox: PathBuf,
    archive: PathBuf,
    log: PathBuf,
    config: PathBuf,
}

/// Every regular file under a folder with its bytes, keyed by relative path.
type Snapshot = BTreeMap<PathBuf, Vec<u8>>;

/// Every regular Archive file with its bytes, inode and mtime: an overwrite in place or a
/// replacement shows up even when the bytes match.
type ArchiveState = BTreeMap<PathBuf, (Vec<u8>, u64, i64)>;

impl Env {
    /// Outbox and Archive exist; `min_age_secs = 0` so freshly written files are eligible.
    fn new() -> Self {
        Self::with_config_tail("min_age_secs = 0\n")
    }

    /// Config with the three path keys plus `tail` appended verbatim.
    fn with_config_tail(tail: &str) -> Self {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let env = Self {
            outbox: root.join("outbox"),
            archive: root.join("archive"),
            log: root.join("logs/nested/sync.log"),
            config: root.join("sync.toml"),
            root,
            _tmp: tmp,
        };
        fs::create_dir_all(&env.outbox).unwrap();
        fs::create_dir_all(&env.archive).unwrap();
        env.write_config(&config_text(&env.outbox, &env.archive, &env.log, tail));
        env
    }

    fn write_config(&self, text: &str) {
        fs::write(&self.config, text).unwrap();
    }

    /// Points the config at other paths, with `min_age_secs = 0`.
    fn set_paths(&self, outbox: &Path, archive: &Path, log: &Path) {
        self.write_config(&config_text(outbox, archive, log, "min_age_secs = 0\n"));
    }

    /// Runs the binary with `args` and `--config`, asserting the Archive never loses or
    /// changes a file.
    fn run(&self, args: &[&str]) -> Output {
        self.run_command(&mut self.command(args))
    }

    /// Like `run`, with stdout a pipe whose read end is already closed.
    fn run_with_closed_stdout(&self, args: &[&str]) -> Output {
        self.run_spawned(|| {
            let (reader, writer) = std::io::pipe().unwrap();
            drop(reader);
            self.command(args).stdout(writer).spawn().unwrap()
        })
    }

    /// Like `run`, with any file write past 512 bytes failing (EFBIG; SIGXFSZ ignored).
    fn run_with_file_size_limit(&self) -> Output {
        let mut command = Command::new("sh");
        command
            .args(["-c", "trap '' XFSZ; ulimit -f 1; exec \"$0\" \"$@\"", BIN])
            .arg("--config")
            .arg(&self.config)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        self.run_command(&mut command)
    }

    fn run_command(&self, command: &mut Command) -> Output {
        self.run_spawned(|| command.spawn().unwrap())
    }

    fn run_spawned(&self, spawn: impl FnOnce() -> Child) -> Output {
        let before = self.archive_state();
        let output = spawn_locked(spawn).wait_with_output().unwrap();
        self.assert_archive_kept(&before);
        output
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(BIN);
        command
            .args(args)
            .arg("--config")
            .arg(&self.config)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    /// Backdates every Archive file to a fixed mtime, then records it.
    fn archive_state(&self) -> ArchiveState {
        let fixed = FileTime::from_unix_time(1_000_000_000, 0);
        for rel in snapshot(&self.archive).keys() {
            filetime::set_file_mtime(self.archive.join(rel), fixed).unwrap();
        }
        self.current_archive_state()
    }

    fn current_archive_state(&self) -> ArchiveState {
        snapshot(&self.archive)
            .into_iter()
            .map(|(rel, bytes)| {
                let meta = fs::symlink_metadata(self.archive.join(&rel)).unwrap();
                (rel, (bytes, meta.ino(), meta.mtime()))
            })
            .collect()
    }

    fn assert_archive_kept(&self, before: &ArchiveState) {
        let after = self.current_archive_state();
        for (path, state) in before {
            assert_eq!(
                after.get(path),
                Some(state),
                "Archive file {} was removed, replaced or changed",
                path.display()
            );
        }
    }

    fn log_text(&self) -> String {
        fs::read_to_string(&self.log).unwrap()
    }

    /// Runs and asserts an abort: exit 2, "aborted" on stderr, and neither tree changed.
    /// `logged`: the log's folder exists beforehand (an abort never creates one) and the
    /// abort must be in the log; otherwise the log must not exist afterwards.
    fn run_expecting_abort(&self, logged: bool) -> Output {
        if logged {
            fs::create_dir_all(self.log.parent().unwrap()).unwrap();
        }
        let (outbox, archive) = (snapshot(&self.outbox), snapshot(&self.archive));
        let output = self.run(&[]);
        assert_exit(&output, 2, "aborted");
        assert_eq!(snapshot(&self.outbox), outbox);
        assert_eq!(snapshot(&self.archive), archive);
        if logged {
            assert!(self.log_text().contains("\tabort\t"));
        } else {
            assert!(!self.log.exists());
        }
        output
    }
}

fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn snapshot(dir: &Path) -> Snapshot {
    fn walk(root: &Path, dir: &Path, out: &mut Snapshot) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries {
            let path = entry.unwrap().path();
            let meta = fs::symlink_metadata(&path).unwrap();
            if meta.is_dir() {
                walk(root, &path, out);
            } else if meta.is_file() {
                let rel = path.strip_prefix(root).unwrap().to_path_buf();
                out.insert(rel, fs::read(&path).unwrap());
            }
        }
    }
    let mut out = Snapshot::new();
    walk(dir, dir, &mut out);
    out
}

fn set_age(path: &Path, age: Duration) {
    let mtime = FileTime::from_system_time(SystemTime::now() - age);
    filetime::set_file_mtime(path, mtime).unwrap();
}

fn chmod(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn config_text(outbox: &Path, archive: &Path, log: &Path, tail: &str) -> String {
    format!("outbox = {outbox:?}\narchive = {archive:?}\nlog = {log:?}\n{tail}")
}

fn assert_success(output: &Output) {
    assert!(output.status.success(), "stderr: {}", stderr(output));
}

/// Exit 1 (some files failed) with a readable stderr on mismatch.
fn assert_partial_failure(output: &Output) {
    assert_eq!(output.status.code(), Some(1), "stderr: {}", stderr(output));
}

/// Exit `code` with `needle` in stderr.
fn assert_exit(output: &Output, code: i32, needle: &str) {
    assert_eq!(
        output.status.code(),
        Some(code),
        "stderr: {}",
        stderr(output)
    );
    assert!(stderr(output).contains(needle), "{}", stderr(output));
}

/// Spawns `command` (under `SPAWN`) and collects its output.
fn output(mut command: Command) -> Output {
    spawn_locked(|| command.spawn().unwrap())
        .wait_with_output()
        .unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn outbox_entries(env: &Env) -> usize {
    fs::read_dir(&env.outbox).unwrap().count()
}

// Moving files

#[test]
fn absent_file_is_copied_verified_and_source_removed() {
    let env = Env::new();
    let rel = Path::new("2026-01/ER/invoice.pdf");
    write(&env.outbox.join(rel), b"generated document bytes");

    let output = env.run(&["run"]);

    assert_success(&output);
    assert_eq!(
        fs::read(env.archive.join(rel)).unwrap(),
        b"generated document bytes"
    );
    assert!(!env.outbox.join(rel).exists());
    assert_eq!(snapshot(&env.archive).len(), 1, "no temp files left behind");
    assert!(
        env.log_text()
            .contains("\tcopy\t2026-01/ER/invoice.pdf\t2026-01/ER/invoice.pdf\tok")
    );
}

#[test]
fn identical_file_only_removes_source() {
    let env = Env::new();
    write(&env.outbox.join("2026-01/a.pdf"), b"same bytes");
    write(&env.archive.join("2026-01/a.pdf"), b"same bytes");
    let archive_before = snapshot(&env.archive);

    let output = env.run(&[]);

    assert_success(&output);
    assert!(!env.outbox.join("2026-01/a.pdf").exists());
    assert_eq!(snapshot(&env.archive), archive_before);
    assert!(
        env.log_text()
            .contains("\tremove-identical\t2026-01/a.pdf\t")
    );
}

#[test]
fn different_file_is_copied_under_lowest_free_suffix() {
    let env = Env::new();
    // Same size, different bytes: the hash decides, not the size.
    write(&env.archive.join("a.pdf"), b"archived-1");
    write(&env.outbox.join("a.pdf"), b"incoming-1");

    let output = env.run(&[]);

    assert_success(&output);
    assert_eq!(
        fs::read(env.archive.join("a (1).pdf")).unwrap(),
        b"incoming-1"
    );
    assert!(!env.outbox.join("a.pdf").exists());

    write(&env.outbox.join("a.pdf"), b"incoming number two");
    let output = env.run(&[]);

    assert_success(&output);
    assert_eq!(
        fs::read(env.archive.join("a (2).pdf")).unwrap(),
        b"incoming number two"
    );
    assert_eq!(fs::read(env.archive.join("a.pdf")).unwrap(), b"archived-1");
    assert_eq!(
        fs::read(env.archive.join("a (1).pdf")).unwrap(),
        b"incoming-1"
    );
    assert!(!env.outbox.join("a.pdf").exists());
    assert!(
        env.log_text()
            .contains("\tcopy-renamed\ta.pdf\ta (2).pdf\tok")
    );
}

#[test]
fn collision_without_extension_appends_suffix_to_name() {
    let env = Env::new();
    write(&env.archive.join("docs/README"), b"old");
    write(&env.outbox.join("docs/README"), b"new");

    let output = env.run(&[]);

    assert_success(&output);
    assert_eq!(
        fs::read(env.archive.join("docs/README (1)")).unwrap(),
        b"new"
    );
    assert!(!env.outbox.join("docs/README").exists());
}

#[test]
fn identical_numbered_copy_counts_as_archived() {
    let env = Env::new();
    write(&env.archive.join("x.pdf"), b"different");
    write(&env.archive.join("x (1).pdf"), b"incoming");
    write(&env.outbox.join("x.pdf"), b"incoming");

    let output = env.run(&[]);

    assert_success(&output);
    assert!(!env.outbox.join("x.pdf").exists());
    assert!(!env.archive.join("x (2).pdf").exists());
    assert!(
        env.log_text()
            .contains("\tremove-identical\tx.pdf\tx (1).pdf\tok")
    );
}

#[test]
fn archive_symlink_at_target_is_never_identical() {
    let env = Env::new();
    let elsewhere = env.root.join("elsewhere/a.pdf");
    // As long as the symlink's own size (its target path), so only the file-type check
    // can tell them apart.
    let bytes = elsewhere.as_os_str().as_bytes();
    write(&elsewhere, bytes);
    symlink(&elsewhere, env.archive.join("a.pdf")).unwrap();
    write(&env.outbox.join("a.pdf"), bytes);

    let output = env.run(&[]);

    assert_success(&output);
    assert_eq!(fs::read(env.archive.join("a (1).pdf")).unwrap(), bytes);
    assert!(
        fs::symlink_metadata(env.archive.join("a.pdf"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[test]
fn long_file_name_is_archived() {
    let env = Env::new();
    let name = format!("{}.pdf", "n".repeat(240));
    write(&env.outbox.join(&name), b"long");

    let output = env.run(&[]);

    assert_success(&output);
    assert_eq!(fs::read(env.archive.join(&name)).unwrap(), b"long");
}

#[test]
fn document_named_like_a_temp_file_is_archived() {
    let env = Env::new();
    write(&env.outbox.join(".hex-sync-0.tmp"), b"a real document");

    let output = env.run(&[]);

    assert_success(&output);
    assert_eq!(
        fs::read(env.archive.join(".hex-sync-0.tmp")).unwrap(),
        b"a real document"
    );
    assert_eq!(snapshot(&env.archive).len(), 1, "no temp left behind");
}

#[test]
fn existing_file_with_temp_name_survives_and_is_reported() {
    let env = Env::new();
    write(&env.archive.join("sub/.hex-sync-0.tmp"), b"not ours");
    write(&env.outbox.join("sub/a.pdf"), b"incoming");

    let output = env.run(&[]);

    assert_success(&output);
    assert_eq!(
        fs::read(env.archive.join("sub/.hex-sync-0.tmp")).unwrap(),
        b"not ours"
    );
    assert_eq!(
        fs::read(env.archive.join("sub/a.pdf")).unwrap(),
        b"incoming"
    );
    assert_eq!(snapshot(&env.archive).len(), 2, "no temp left behind");
    assert!(
        env.log_text()
            .contains("\tstale-temp\tsub/.hex-sync-0.tmp\t-\tkept")
    );
}

#[test]
fn failed_copy_keeps_source_continues_and_exits_non_zero() {
    let env = Env::new();
    write(&env.outbox.join("locked/a.pdf"), b"cannot land");
    write(&env.outbox.join("open/b.pdf"), b"lands");
    fs::create_dir_all(env.archive.join("locked")).unwrap();
    chmod(&env.archive.join("locked"), 0o555);

    let output = env.run(&[]);
    chmod(&env.archive.join("locked"), 0o755);

    assert_partial_failure(&output);
    assert_eq!(
        fs::read(env.outbox.join("locked/a.pdf")).unwrap(),
        b"cannot land"
    );
    assert_eq!(fs::read(env.archive.join("open/b.pdf")).unwrap(), b"lands");
    assert!(!env.outbox.join("open").exists());
    let log = env.log_text();
    assert!(log.contains("\tcopy\tlocked/a.pdf\tlocked/a.pdf\tfailed: "));
    assert!(log.contains("\trestore-claim\tlocked/.hex-sync.a.pdf\tlocked/a.pdf\tok"));
    assert!(!env.outbox.join("locked/.hex-sync.a.pdf").exists());
}

// Same-file protection

#[test]
fn archive_folder_symlinked_into_outbox_keeps_source() {
    let env = Env::new();
    write(&env.outbox.join("sub/x.pdf"), b"only copy");
    symlink(env.outbox.join("sub"), env.archive.join("sub")).unwrap();

    let dry = env.run(&["--dry-run"]);
    let output = env.run(&[]);

    assert!(
        stdout(&dry).contains("dry-run: plan sub/x.pdf [failed: Archive folder "),
        "{}",
        stdout(&dry)
    );
    assert_partial_failure(&output);
    assert_eq!(
        fs::read(env.outbox.join("sub/x.pdf")).unwrap(),
        b"only copy"
    );
    assert!(
        env.log_text()
            .contains("\tplan\tsub/x.pdf\t-\tfailed: Archive folder ")
    );
}

#[test]
fn hard_linked_archive_file_keeps_source() {
    let env = Env::new();
    write(&env.archive.join("x.pdf"), b"one file, two names");
    fs::hard_link(env.archive.join("x.pdf"), env.outbox.join("x.pdf")).unwrap();

    let output = env.run(&[]);

    assert_partial_failure(&output);
    assert_eq!(
        fs::read(env.outbox.join("x.pdf")).unwrap(),
        b"one file, two names"
    );
    assert!(
        env.log_text()
            .contains("\tplan\tx.pdf\t-\tfailed: source and Archive file are the same file")
    );
}

// Claims

#[test]
fn crash_left_claim_is_restored_then_archived() {
    let env = Env::with_config_tail("");
    let claim = env.outbox.join("2026-01/.hex-sync.x.pdf");
    write(&claim, b"claimed before a crash");
    set_age(&claim, Duration::from_secs(120));

    let output = env.run(&[]);

    assert_success(&output);
    assert_eq!(
        fs::read(env.archive.join("2026-01/x.pdf")).unwrap(),
        b"claimed before a crash"
    );
    assert_eq!(outbox_entries(&env), 0);
    let log = env.log_text();
    assert!(log.contains("\trestore-claim\t2026-01/.hex-sync.x.pdf\t2026-01/x.pdf\tok"));
    assert!(log.contains("\tcopy\t2026-01/x.pdf\t2026-01/x.pdf\tok"));
}

#[test]
fn claim_whose_name_was_taken_is_restored_beside_it() {
    let env = Env::new();
    write(&env.outbox.join(".hex-sync.x.pdf"), b"older, claimed");
    write(&env.outbox.join("x.pdf"), b"newer");

    let output = env.run(&[]);

    assert_success(&output);
    assert!(
        env.log_text()
            .contains("\trestore-claim\t.hex-sync.x.pdf\tx (1).pdf\tok")
    );
    let archived: Vec<Vec<u8>> = snapshot(&env.archive).into_values().collect();
    assert!(archived.contains(&b"older, claimed".to_vec()));
    assert!(archived.contains(&b"newer".to_vec()));
    assert_eq!(outbox_entries(&env), 0);
}

#[test]
fn claim_that_cannot_be_restored_fails_the_run() {
    let env = Env::new();
    write(&env.outbox.join("d/.hex-sync.x.pdf"), b"claimed");
    chmod(&env.outbox.join("d"), 0o555);

    let output = env.run(&[]);
    chmod(&env.outbox.join("d"), 0o755);

    assert_partial_failure(&output);
    assert_eq!(
        fs::read(env.outbox.join("d/.hex-sync.x.pdf")).unwrap(),
        b"claimed"
    );
    let log = env.log_text();
    assert!(log.contains("\trestore-claim\td/.hex-sync.x.pdf\td/x.pdf\tfailed: "));
    // A claim left in place is never claimed again.
    assert!(!log.contains("\tclaim\t"), "{log}");
}

#[test]
fn unrelated_entry_holding_the_claim_name_is_left_alone() {
    let env = Env::new();
    write(&env.outbox.join(".hex-sync.A/keep.partial"), b"user data");
    write(&env.outbox.join("A"), b"document");

    let output = env.run(&[]);

    assert_partial_failure(&output);
    assert_eq!(
        fs::read(env.outbox.join(".hex-sync.A/keep.partial")).unwrap(),
        b"user data"
    );
    assert_eq!(fs::read(env.outbox.join("A")).unwrap(), b"document");
    assert!(snapshot(&env.archive).is_empty());
    let log = env.log_text();
    assert!(log.contains("\tclaim\tA\t-\tfailed: "), "{log}");
    assert!(!log.contains("restore-claim"), "{log}");
}

// Skipping

#[test]
fn partial_files_are_ignored_and_keep_their_folder() {
    let env = Env::new();
    write(&env.outbox.join("2026-01/upload.pdf.partial"), b"half");

    let output = env.run(&[]);

    assert_success(&output);
    assert!(env.outbox.join("2026-01/upload.pdf.partial").exists());
    assert!(snapshot(&env.archive).is_empty());
}

#[test]
fn os_metadata_files_are_ignored_but_look_alike_documents_move() {
    let env = Env::new();
    let metadata: [(&str, &[u8]); 3] = [
        ("2026-01/.DS_Store", b"Bud1"),
        ("2026-01/._invoice.pdf", b"\x00\x05\x16\x07\x00\x02\x00\x00"),
        ("2026-01/Thumbs.db", b"thumbnails"),
    ];
    for (rel, bytes) in metadata {
        write(&env.outbox.join(rel), bytes);
    }
    let documents = [
        "2026-01/invoice.pdf",
        "2026-01/._Rechnung.pdf",
        "2026-01/.DS_Store.pdf",
        "2026-01/Thumbs.db.pdf",
    ];
    for rel in documents {
        write(&env.outbox.join(rel), b"%PDF-1.7 document");
    }

    let output = env.run(&[]);

    assert_success(&output);
    for (rel, bytes) in metadata {
        assert_eq!(fs::read(env.outbox.join(rel)).unwrap(), bytes, "{rel}");
    }
    let mut expected: Vec<PathBuf> = documents.iter().map(PathBuf::from).collect();
    expected.sort();
    assert_eq!(
        snapshot(&env.archive).into_keys().collect::<Vec<_>>(),
        expected
    );
}

#[cfg(target_os = "linux")]
#[test]
fn non_utf8_partial_is_ignored() {
    use std::os::unix::ffi::OsStrExt;
    let env = Env::new();
    let name = std::ffi::OsStr::from_bytes(b"scan-\xff.pdf.partial");
    write(&env.outbox.join(name), b"half");

    let output = env.run(&[]);

    assert_success(&output);
    assert!(env.outbox.join(name).exists());
    assert!(snapshot(&env.archive).is_empty());
}

#[test]
fn files_younger_than_min_age_are_ignored() {
    let env = Env::with_config_tail("min_age_secs = 3600\n");
    write(&env.outbox.join("fresh.pdf"), b"fresh");
    write(&env.outbox.join("old.pdf"), b"old");
    set_age(&env.outbox.join("old.pdf"), Duration::from_secs(7200));

    let output = env.run(&[]);

    assert_success(&output);
    assert!(env.outbox.join("fresh.pdf").exists());
    assert!(!env.archive.join("fresh.pdf").exists());
    assert_eq!(fs::read(env.archive.join("old.pdf")).unwrap(), b"old");
    assert!(!env.outbox.join("old.pdf").exists());
}

#[test]
fn future_mtime_is_skipped_and_logged_even_without_min_age() {
    let env = Env::new();
    let future = env.outbox.join("future.pdf");
    write(&future, b"from the future");
    let mtime = FileTime::from_system_time(SystemTime::now() + Duration::from_secs(3600));
    filetime::set_file_mtime(&future, mtime).unwrap();

    let output = env.run(&[]);

    assert_success(&output);
    assert!(future.exists());
    assert!(snapshot(&env.archive).is_empty());
    assert!(
        env.log_text()
            .contains("\tskip-bad-mtime\tfuture.pdf\t-\tskipped")
    );
}

#[test]
fn empty_outbox_folders_are_removed_but_root_kept() {
    let env = Env::new();
    fs::create_dir_all(env.outbox.join("empty/deeper/deepest")).unwrap();
    write(&env.outbox.join("2026-02/ER/b.pdf"), b"b");
    fs::create_dir_all(env.archive.join("unrelated-empty")).unwrap();

    let output = env.run(&[]);

    assert_success(&output);
    assert!(env.outbox.is_dir());
    assert_eq!(outbox_entries(&env), 0);
    assert!(env.archive.join("unrelated-empty").is_dir());
    assert!(env.log_text().contains("\trmdir\tempty/deeper/deepest\t"));
}

#[test]
fn symlinks_are_skipped_logged_and_not_followed() {
    let env = Env::new();
    let elsewhere = env.root.join("elsewhere");
    write(&elsewhere.join("target.pdf"), b"outside");
    symlink(elsewhere.join("target.pdf"), env.outbox.join("link.pdf")).unwrap();
    symlink(&elsewhere, env.outbox.join("linked-dir")).unwrap();

    let output = env.run(&[]);

    assert_success(&output);
    assert!(fs::symlink_metadata(env.outbox.join("link.pdf")).is_ok());
    assert!(fs::symlink_metadata(env.outbox.join("linked-dir")).is_ok());
    assert_eq!(fs::read(elsewhere.join("target.pdf")).unwrap(), b"outside");
    assert!(snapshot(&env.archive).is_empty());
    let log = env.log_text();
    assert!(log.contains("\tskip-symlink\tlink.pdf\t"));
    assert!(log.contains("\tskip-symlink\tlinked-dir\t"));
}

// Aborts

#[test]
fn aborts_when_outbox_missing() {
    let env = Env::new();
    write(&env.archive.join("kept.pdf"), b"kept");
    fs::remove_dir(&env.outbox).unwrap();

    env.run_expecting_abort(true);

    assert!(!env.outbox.exists());
}

#[test]
fn aborts_when_archive_missing_without_touching_outbox() {
    let env = Env::new();
    write(&env.outbox.join("2026-01/a.pdf"), b"stays");
    fs::create_dir_all(env.outbox.join("empty")).unwrap();
    fs::remove_dir(&env.archive).unwrap();

    env.run_expecting_abort(true);

    assert!(env.outbox.join("empty").is_dir());
    assert!(!env.archive.exists());
}

#[test]
fn aborts_when_root_is_not_a_directory() {
    let env = Env::new();
    write(&env.outbox.join("a.pdf"), b"stays");
    fs::remove_dir(&env.archive).unwrap();
    write(&env.archive, b"a file, not a folder");

    env.run_expecting_abort(true);
}

#[test]
fn aborts_when_root_is_unreadable() {
    let env = Env::new();
    write(&env.outbox.join("a.pdf"), b"stays");
    write(&env.archive.join("kept.pdf"), b"kept");
    fs::create_dir_all(env.log.parent().unwrap()).unwrap();
    chmod(&env.outbox, 0o311);

    let output = env.run(&[]);
    chmod(&env.outbox, 0o755);

    assert_exit(&output, 2, "aborted");
    assert!(env.log_text().contains("\tabort\t"));
    assert!(env.outbox.join("a.pdf").exists());
    assert_eq!(snapshot(&env.archive).len(), 1);
}

#[test]
fn aborts_when_archive_is_inside_outbox() {
    let env = Env::new();
    let nested_archive = env.outbox.join("a/b/archive");
    write(&nested_archive.join("a.pdf"), b"same");
    env.set_paths(&env.outbox, &nested_archive, &env.log);

    env.run_expecting_abort(true);
}

#[test]
fn aborts_when_outbox_is_inside_archive() {
    let env = Env::new();
    let nested_outbox = env.archive.join("outbox");
    write(&nested_outbox.join("a.pdf"), b"in the archive");
    env.set_paths(&nested_outbox, &env.archive, &env.log);

    env.run_expecting_abort(true);
}

#[test]
fn aborts_when_roots_are_one_folder_reached_through_a_symlinked_parent() {
    let env = Env::new();
    symlink(&env.root, env.root.join("alias")).unwrap();
    write(&env.outbox.join("a.pdf"), b"only copy");
    env.set_paths(&env.outbox, &env.root.join("alias/outbox"), &env.log);

    env.run_expecting_abort(true);
}

/// macOS firmlinks reach the same folder under a second path that `canonicalize` keeps.
#[cfg(target_os = "macos")]
#[test]
fn aborts_when_archive_is_the_outbox_through_a_firmlink() {
    let env = Env::new();
    let alias = Path::new("/System/Volumes/Data").join(env.outbox.strip_prefix("/").unwrap());
    if !alias.is_dir() {
        return; // Not on the data volume; nothing to alias.
    }
    write(&env.outbox.join("a.pdf"), b"only copy");
    env.set_paths(&env.outbox, &alias, &env.log);

    env.run_expecting_abort(true);
}

#[test]
fn aborts_when_log_is_inside_a_root() {
    for inside in ["outbox", "archive"] {
        // With the log's folder missing (the root is the nearest existing folder) and
        // present.
        for logs_present in [false, true] {
            let env = Env::new();
            write(&env.outbox.join("a.pdf"), b"stays");
            let log = env.root.join(inside).join("logs/sync.log");
            if logs_present {
                fs::create_dir(log.parent().unwrap()).unwrap();
            }
            env.set_paths(&env.outbox, &env.archive, &log);

            let output = env.run(&[]);

            assert_exit(&output, 2, "inside");
            assert!(!log.exists(), "{inside}");
            assert_eq!(log.parent().unwrap().exists(), logs_present, "{inside}");
            assert!(env.outbox.join("a.pdf").exists());
        }
    }
}

#[test]
fn aborts_without_writing_a_log_inside_an_unreadable_root() {
    for inside in ["outbox", "archive"] {
        let env = Env::new();
        write(&env.outbox.join("a.pdf"), b"stays");
        let root = env.root.join(inside);
        let log = root.join("hex.log");
        env.set_paths(&env.outbox, &env.archive, &log);
        let (outbox, archive) = (snapshot(&env.outbox), snapshot(&env.archive));
        chmod(&root, 0o311);

        let output = env.run(&[]);
        chmod(&root, 0o755);

        assert_exit(&output, 2, "inside");
        assert!(!log.exists(), "{inside}");
        assert_eq!(snapshot(&env.outbox), outbox);
        assert_eq!(snapshot(&env.archive), archive);
    }
}

#[test]
fn dry_run_abort_writes_no_log() {
    let env = Env::new();
    fs::remove_dir(&env.archive).unwrap();
    fs::create_dir_all(env.log.parent().unwrap()).unwrap();

    let output = env.run(&["--dry-run"]);

    assert_exit(&output, 2, "aborted");
    assert!(!env.log.exists());
}

#[test]
fn abort_never_creates_a_missing_root_that_holds_the_log() {
    // Spelled plainly, and through `..`: no path comparison can catch every alias.
    for log in ["archive/.logs/sync.log", "x/../archive/sync.log"] {
        let env = Env::new();
        fs::create_dir(env.root.join("x")).unwrap();
        write(&env.outbox.join("a.pdf"), b"stays");
        fs::remove_dir(&env.archive).unwrap();
        env.set_paths(&env.outbox, &env.archive, &env.root.join(log));

        let output = env.run(&[]);

        assert_exit(&output, 2, "not logged");
        assert!(!env.archive.exists(), "{log}");
        assert!(env.outbox.join("a.pdf").exists());
    }
}

#[test]
fn aborts_when_log_is_a_symlink() {
    let env = Env::new();
    write(&env.outbox.join("a.pdf"), b"stays");
    fs::create_dir_all(env.root.join("logs")).unwrap();
    let link = env.root.join("logs/link.tsv");
    symlink(env.outbox.join("log.tsv"), &link).unwrap();
    env.set_paths(&env.outbox, &env.archive, &link);

    let output = env.run(&[]);

    assert_exit(&output, 2, "symlink");
    assert!(!env.outbox.join("log.tsv").exists());
    assert!(env.outbox.join("a.pdf").exists());
}

#[test]
fn abort_reason_survives_a_log_that_cannot_be_opened() {
    let env = Env::new();
    fs::remove_dir(&env.archive).unwrap();
    write(&env.root.join("not-a-folder"), b"file");
    env.set_paths(
        &env.outbox,
        &env.archive,
        &env.root.join("not-a-folder/sync.log"),
    );

    let output = env.run(&[]);

    assert_exit(&output, 2, "cannot open log");
    assert!(stderr(&output).contains("Archive"), "{}", stderr(&output));
    assert!(!env.archive.exists());
}

// Dry run

#[test]
fn dry_run_prints_plans_and_changes_nothing() {
    let env = Env::new();
    write(&env.outbox.join("2026-01/new.pdf"), b"new");
    write(&env.outbox.join("2026-01/same.pdf"), b"same");
    write(&env.archive.join("2026-01/same.pdf"), b"same");
    write(&env.outbox.join("2026-01/clash.pdf"), b"clash-in");
    write(&env.archive.join("2026-01/clash.pdf"), b"clash-old");
    fs::create_dir_all(env.outbox.join("empty")).unwrap();
    write(
        &env.outbox.join("2026-02/.hex-sync.claimed.pdf"),
        b"left by a crash",
    );
    let outbox_before = snapshot(&env.outbox);
    let archive_before = snapshot(&env.archive);

    let output = env.run(&["--dry-run"]);

    assert_success(&output);
    let out = stdout(&output);
    for planned in [
        "copy 2026-01/new.pdf -> 2026-01/new.pdf",
        "remove-identical 2026-01/same.pdf -> 2026-01/same.pdf",
        "copy-renamed 2026-01/clash.pdf -> 2026-01/clash (1).pdf",
        "rmdir empty",
        "rmdir 2026-01",
        "restore-claim 2026-02/.hex-sync.claimed.pdf -> 2026-02/claimed.pdf",
        "copy 2026-02/claimed.pdf -> 2026-02/claimed.pdf",
        "rmdir 2026-02",
    ] {
        assert!(
            out.contains(&format!("dry-run: {planned}\n")),
            "{planned}: {out}"
        );
    }
    assert_eq!(out.matches(".hex-sync.claimed.pdf").count(), 1, "{out}");
    assert_eq!(snapshot(&env.outbox), outbox_before);
    assert!(env.outbox.join("empty").is_dir());
    assert_eq!(snapshot(&env.archive), archive_before);
    assert!(!env.log.exists());
    assert!(!env.log.parent().unwrap().exists());
}

#[test]
fn dry_run_plans_match_the_real_run() {
    let env = Env::new();
    write(&env.archive.join("a.pdf"), b"archived");
    write(&env.outbox.join("a.pdf"), b"incoming one");
    write(&env.outbox.join("a (1).pdf"), b"incoming two");
    write(&env.outbox.join(".hex-sync.b.pdf"), b"claimed");
    write(&env.outbox.join("b.pdf"), b"newer b");

    let dry = env.run(&["--dry-run"]);
    let real = env.run(&[]);

    assert_success(&dry);
    assert_success(&real);
    // (action, path, target) of every line that has a target.
    let planned: BTreeSet<(String, String, String)> = stdout(&dry)
        .lines()
        .filter_map(|line| {
            let (action, rest) = line.strip_prefix("dry-run: ")?.split_once(' ')?;
            let (path, target) = rest.split_once(" -> ")?;
            Some((action.into(), path.into(), target.into()))
        })
        .collect();
    let done: BTreeSet<(String, String, String)> = env
        .log_text()
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('\t').collect();
            (fields[3] != "-").then(|| (fields[1].into(), fields[2].into(), fields[3].into()))
        })
        .collect();
    assert_eq!(planned.len(), 5, "{planned:?}");
    assert_eq!(planned, done);
}

#[test]
fn dry_run_fails_when_the_plan_cannot_be_written() {
    let env = Env::new();
    write(&env.outbox.join("a.pdf"), b"a");

    let output = env.run_with_closed_stdout(&["--dry-run"]);

    assert_partial_failure(&output);
    assert!(stderr(&output).contains("cannot write the plan"));
    assert!(env.outbox.join("a.pdf").exists());
}

// Log

#[test]
fn log_is_appended_across_runs() {
    let env = Env::new();
    write(&env.outbox.join("first.pdf"), b"1");
    assert_success(&env.run(&[]));
    write(&env.outbox.join("second.pdf"), b"2");
    assert_success(&env.run(&["run"]));

    let log = env.log_text();
    let lines: Vec<&str> = log.lines().collect();
    assert_eq!(lines.len(), 2, "{log}");
    assert!(lines[0].contains("\tcopy\tfirst.pdf\tfirst.pdf\tok"));
    assert!(lines[1].contains("\tcopy\tsecond.pdf\tsecond.pdf\tok"));
}

#[test]
fn closed_stdout_neither_panics_nor_loses_log_lines() {
    let env = Env::new();
    for n in 1..=5 {
        write(
            &env.outbox.join(format!("f{n}.pdf")),
            format!("{n}").as_bytes(),
        );
    }

    let output = env.run_with_closed_stdout(&[]);

    assert_success(&output);
    assert_eq!(outbox_entries(&env), 0);
    let log = env.log_text();
    assert_eq!(log.matches("\tcopy\t").count(), 5, "{log}");
}

#[test]
fn log_write_failure_stops_the_pass() {
    let env = Env::new();
    for name in ["a.pdf", "b.pdf", "c.pdf", "d.pdf"] {
        write(&env.outbox.join(name), name.as_bytes());
    }
    // Past the 512-byte limit (macOS still lets one append through).
    write(&env.log, &[b'#'; 4096]);

    let output = env.run_with_file_size_limit();

    assert_partial_failure(&output);
    let err = stderr(&output);
    // Exactly one lost line, kept on stderr: the pass stopped right after it.
    assert_eq!(err.matches("cannot write log: ").count(), 1, "{err}");
    assert!(err.contains("\tcopy\t"), "{err}");
    assert!(outbox_entries(&env) >= 2, "{err}");
}

// Config

#[test]
fn missing_required_key_is_a_config_error() {
    let env = Env::new();
    write(&env.outbox.join("a.pdf"), b"stays");
    env.write_config(&format!("outbox = {:?}\nlog = {:?}\n", env.outbox, env.log));

    let output = env.run(&[]);

    assert_exit(&output, 2, "archive");
    assert!(env.outbox.join("a.pdf").exists());
    assert!(!env.log.exists());
}

#[test]
fn unknown_key_is_a_config_error() {
    let env = Env::with_config_tail("min_age_secs = 0\npassword = \"nope\"\n");
    write(&env.outbox.join("a.pdf"), b"stays");

    let output = env.run(&[]);

    assert_exit(&output, 2, "password");
    assert!(env.outbox.join("a.pdf").exists());
}

#[test]
fn zero_interval_is_a_config_error() {
    let env = Env::with_config_tail("interval_secs = 0\n");

    assert_exit(&env.run(&[]), 2, "interval_secs");
}

#[test]
fn relative_path_is_a_config_error() {
    let env = Env::new();
    env.set_paths(Path::new("outbox"), &env.archive, &env.log);

    assert_exit(&env.run(&[]), 2, "absolute");
}

#[test]
fn min_age_defaults_to_sixty_seconds() {
    let env = Env::with_config_tail("");
    write(&env.outbox.join("fresh.pdf"), b"fresh");
    write(&env.outbox.join("almost.pdf"), b"almost");
    set_age(&env.outbox.join("almost.pdf"), Duration::from_secs(55));
    write(&env.outbox.join("settled.pdf"), b"settled");
    set_age(&env.outbox.join("settled.pdf"), Duration::from_secs(61));

    let output = env.run(&[]);

    assert_success(&output);
    assert!(env.outbox.join("fresh.pdf").exists());
    assert!(env.outbox.join("almost.pdf").exists());
    assert!(!env.outbox.join("settled.pdf").exists());
    assert!(env.archive.join("settled.pdf").exists());
}

#[test]
fn home_relative_paths_and_default_config_location() {
    let env = Env::new();
    let config = env.root.join(".config/hex/sync.toml");
    write(
        &config,
        b"outbox = \"~/outbox\"\narchive = \"~/archive\"\nlog = \"~/logs/sync.log\"\nmin_age_secs = 0\n",
    );
    write(&env.outbox.join("a.pdf"), b"via home");
    let before = env.archive_state();

    let output = spawn_locked(|| {
        Command::new(BIN)
            .env("HOME", &env.root)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    })
    .wait_with_output()
    .unwrap();

    env.assert_archive_kept(&before);
    assert_success(&output);
    assert_eq!(fs::read(env.archive.join("a.pdf")).unwrap(), b"via home");
    assert!(
        fs::read_to_string(env.root.join("logs/sync.log"))
            .unwrap()
            .contains("\tcopy\ta.pdf\ta.pdf\tok")
    );
}

#[test]
fn claim_that_is_a_second_link_is_dropped_not_duplicated() {
    let env = Env::new();
    write(&env.outbox.join("x.pdf"), b"one file");
    fs::hard_link(env.outbox.join("x.pdf"), env.outbox.join(".hex-sync.x.pdf")).unwrap();

    let dry = env.run(&["--dry-run"]);
    let output = env.run(&[]);

    assert_success(&dry);
    assert_success(&output);
    assert_eq!(
        snapshot(&env.archive),
        Snapshot::from([(PathBuf::from("x.pdf"), b"one file".to_vec())])
    );
    assert_eq!(outbox_entries(&env), 0);
    // The dry run plans what the real run did: restore onto x.pdf, then one copy.
    let planned = stdout(&dry);
    let planned: Vec<&str> = planned.lines().collect();
    assert_eq!(
        planned,
        [
            "dry-run: restore-claim .hex-sync.x.pdf -> x.pdf",
            "dry-run: copy x.pdf -> x.pdf",
        ]
    );
    let log = env.log_text();
    assert!(
        log.contains("\trestore-claim\t.hex-sync.x.pdf\tx.pdf\tok"),
        "{log}"
    );
    assert_eq!(log.matches("\tcopy\t").count(), 1, "{log}");
}

#[test]
fn failed_temp_write_leaves_nothing_in_the_archive() {
    let env = Env::new();
    write(&env.outbox.join("big.pdf"), &[b'x'; 8192]);

    let output = env.run_with_file_size_limit();

    assert_partial_failure(&output);
    assert_eq!(fs::read(env.outbox.join("big.pdf")).unwrap().len(), 8192);
    assert!(
        snapshot(&env.archive).is_empty(),
        "{:?}",
        snapshot(&env.archive).keys()
    );
}

#[test]
fn dry_run_keeps_the_folder_of_a_young_claim() {
    let env = Env::with_config_tail("min_age_secs = 3600\n");
    write(&env.outbox.join("d/.hex-sync.x.pdf"), b"young claim");

    let dry = env.run(&["--dry-run"]);

    assert_success(&dry);
    assert!(!stdout(&dry).contains("rmdir d"), "{}", stdout(&dry));
}

#[test]
fn dry_run_restores_two_claims_to_distinct_names() {
    let env = Env::new();
    write(&env.outbox.join("x.pdf"), b"x");
    write(&env.outbox.join(".hex-sync.x.pdf"), b"claim x");
    write(&env.outbox.join(".hex-sync.x (1).pdf"), b"claim x1");

    let dry = stdout(&env.run(&["--dry-run"]));

    let targets: BTreeSet<&str> = dry
        .lines()
        .filter(|l| l.starts_with("dry-run: restore-claim "))
        .filter_map(|l| l.split_once(" -> ").map(|(_, t)| t))
        .collect();
    assert_eq!(targets.len(), 2, "{dry}");
}

// Scheduling (install / uninstall)

const LABEL: &str = "ai.stibbons.hex-sync";

/// Exit statuses of the fake launchctl.
const OK: i32 = 0;
const BOOTOUT_NOT_LOADED: i32 = 3;
const BOOTOUT_NO_SUCH_SERVICE: i32 = 113;
const UNEXPECTED_FAILURE: i32 = 1;
const BOOTSTRAP_IO_ERROR: i32 = 5;

/// A `launchctl` stand-in plus the LaunchAgents folder it pairs with, both under the Env's
/// root, which is also `HOME`: tests never reach the real launchd or
/// `~/Library/LaunchAgents`.
struct Launchd {
    home: PathBuf,
    /// `$HOME/Library/LaunchAgents`, the default `--launch-agents-dir`.
    dir: PathBuf,
    plist: PathBuf,
    calls: PathBuf,
    script: PathBuf,
}

impl Launchd {
    /// The fake appends its arguments as one line to `calls`, writes a line to stderr, and
    /// exits with `$FAKE_BOOTOUT_EXIT` / `$FAKE_BOOTSTRAP_EXIT` (default 0).
    fn new(env: &Env) -> Self {
        let dir = env.root.join("Library/LaunchAgents");
        let launchd = Self {
            home: env.root.clone(),
            plist: dir.join(format!("{LABEL}.plist")),
            dir,
            calls: env.root.join("launchctl.calls"),
            script: env.root.join("launchctl"),
        };
        spawn_locked(|| {
            fs::write(
                &launchd.script,
                "#!/bin/sh\n\
                 echo \"$@\" >> \"$FAKE_LAUNCHCTL_CALLS\"\n\
                 case \"$1\" in\n\
                 bootout) echo 'Boot-out failed: 3: No such process' >&2; exit \"${FAKE_BOOTOUT_EXIT:-0}\" ;;\n\
                 bootstrap) echo 'Bootstrap failed: 5: Input/output error' >&2; exit \"${FAKE_BOOTSTRAP_EXIT:-0}\" ;;\n\
                 esac\n",
            )
            .unwrap();
        });
        chmod(&launchd.script, 0o755);
        launchd
    }

    /// `hex-sync <args>` with `HOME` at the Env's root, against the fake launchctl, which
    /// exits `bootout_exit` for `bootout` and `bootstrap_exit` for `bootstrap`.
    fn command(&self, args: &[&OsStr], bootout_exit: i32, bootstrap_exit: i32) -> Command {
        let mut command = Command::new(BIN);
        command
            .args(args)
            .env("HOME", &self.home)
            .env("HEX_SYNC_LAUNCHCTL", &self.script)
            .env("FAKE_LAUNCHCTL_CALLS", &self.calls)
            .env("FAKE_BOOTOUT_EXIT", bootout_exit.to_string())
            .env("FAKE_BOOTSTRAP_EXIT", bootstrap_exit.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn install_command(&self, config: &Path, bootout_exit: i32, bootstrap_exit: i32) -> Command {
        let args = [
            OsStr::new("install"),
            OsStr::new("--config"),
            config.as_os_str(),
            OsStr::new("--launch-agents-dir"),
            self.dir.as_os_str(),
        ];
        self.command(&args, bootout_exit, bootstrap_exit)
    }

    fn install(&self, config: &Path, bootout_exit: i32, bootstrap_exit: i32) -> Output {
        output(self.install_command(config, bootout_exit, bootstrap_exit))
    }

    fn uninstall_command(&self, bootout_exit: i32) -> Command {
        let args = [
            OsStr::new("uninstall"),
            OsStr::new("--launch-agents-dir"),
            self.dir.as_os_str(),
        ];
        self.command(&args, bootout_exit, OK)
    }

    fn uninstall(&self, bootout_exit: i32) -> Output {
        output(self.uninstall_command(bootout_exit))
    }

    /// One line per launchctl call, its arguments space-separated.
    fn calls(&self) -> Vec<String> {
        match fs::read_to_string(&self.calls) {
            Ok(text) => text.lines().map(str::to_owned).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn plist_text(&self) -> String {
        fs::read_to_string(&self.plist).unwrap()
    }
}

fn gui_domain() -> String {
    // SAFETY: getuid has no preconditions and cannot fail.
    format!("gui/{}", unsafe { libc::getuid() })
}

#[test]
fn install_writes_the_plist_and_loads_the_agent() {
    let env = Env::with_config_tail("interval_secs = 1234\n");
    // A config name that needs XML escaping.
    let config = env.root.join("a&b <c> \"d\" 'e'.toml");
    fs::rename(&env.config, &config).unwrap();
    let launchd = Launchd::new(&env);

    let output = launchd.install(&config, BOOTOUT_NOT_LOADED, OK);

    assert_success(&output);
    let program = fs::canonicalize(BIN).unwrap();
    let escaped_config = env
        .root
        .join("a&amp;b &lt;c&gt; &quot;d&quot; &apos;e&apos;.toml");
    let stderr_log = env.root.join("Library/Logs/hex-sync.stderr.log");
    assert_eq!(
        launchd.plist_text(),
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>ai.stibbons.hex-sync</string>
	<key>ProgramArguments</key>
	<array>
		<string>{}</string>
		<string>run</string>
		<string>--config</string>
		<string>{}</string>
	</array>
	<key>StartInterval</key>
	<integer>1234</integer>
	<key>RunAtLoad</key>
	<false/>
	<key>StandardOutPath</key>
	<string>/dev/null</string>
	<key>StandardErrorPath</key>
	<string>{}</string>
</dict>
</plist>
"#,
            program.display(),
            escaped_config.display(),
            stderr_log.display()
        )
    );
    let domain = gui_domain();
    assert_eq!(
        launchd.calls(),
        [
            format!("bootout {domain}/{LABEL}"),
            format!("bootstrap {domain} {}", launchd.plist.display()),
        ]
    );
}

#[test]
fn install_again_replaces_the_plist_and_reloads() {
    let env = Env::with_config_tail("interval_secs = 1234\n");
    let launchd = Launchd::new(&env);
    assert_success(&launchd.install(&env.config, BOOTOUT_NOT_LOADED, OK));
    env.write_config(&config_text(
        &env.outbox,
        &env.archive,
        &env.log,
        "interval_secs = 60\n",
    ));

    let output = launchd.install(&env.config, OK, OK);

    assert_success(&output);
    assert!(
        stdout(&output).contains("unloaded the previous"),
        "{}",
        stdout(&output)
    );
    let plist = launchd.plist_text();
    assert!(plist.contains("<integer>60</integer>"), "{plist}");
    assert!(!plist.contains("1234"), "{plist}");
    let entries: Vec<_> = fs::read_dir(&launchd.dir).unwrap().collect();
    assert_eq!(entries.len(), 1, "{entries:?}");
    let calls = launchd.calls();
    assert_eq!(calls.len(), 4, "{calls:?}");
    assert!(calls[2].starts_with("bootout ") && calls[3].starts_with("bootstrap "));
}

#[test]
fn install_with_an_invalid_config_writes_and_loads_nothing() {
    let env = Env::new();
    env.write_config("outbox = \"/tmp\"\n");
    let launchd = Launchd::new(&env);

    let output = launchd.install(&env.config, OK, OK);

    assert_exit(&output, 1, "invalid config");
    assert!(!launchd.dir.exists());
    assert!(launchd.calls().is_empty());
}

#[test]
fn install_fails_when_bootstrap_fails_and_keeps_the_plist() {
    let env = Env::new();
    let launchd = Launchd::new(&env);

    let output = launchd.install(&env.config, BOOTOUT_NOT_LOADED, BOOTSTRAP_IO_ERROR);

    assert_exit(&output, 1, "Input/output error");
    let err = stderr(&output);
    assert!(
        err.contains(&format!("bootstrap {}", gui_domain())),
        "{err}"
    );
    assert!(
        err.contains(
            "ai.stibbons.hex-sync is not loaded; fix the cause and rerun hex-sync install"
        ),
        "{err}"
    );
    assert!(launchd.plist.exists());
}

#[test]
fn install_fails_on_an_unexpected_bootout_error_without_bootstrapping() {
    let env = Env::new();
    let launchd = Launchd::new(&env);

    let output = launchd.install(&env.config, UNEXPECTED_FAILURE, OK);

    assert_exit(&output, 1, "bootout");
    assert_eq!(launchd.calls().len(), 1, "{:?}", launchd.calls());
}

#[test]
fn uninstall_unloads_and_removes_the_plist_and_is_idempotent() {
    let env = Env::new();
    let launchd = Launchd::new(&env);
    assert_success(&launchd.install(&env.config, BOOTOUT_NOT_LOADED, OK));

    let first = launchd.uninstall(OK);
    let second = launchd.uninstall(BOOTOUT_NO_SUCH_SERVICE);

    assert_success(&first);
    assert!(
        stdout(&first).contains(&format!("unloaded {LABEL}")),
        "{}",
        stdout(&first)
    );
    assert!(stdout(&first).contains("removed "), "{}", stdout(&first));
    assert!(!launchd.plist.exists());
    assert_success(&second);
    assert!(
        stdout(&second).contains("was not loaded"),
        "{}",
        stdout(&second)
    );
    assert!(
        stdout(&second).contains("no plist at"),
        "{}",
        stdout(&second)
    );
    let target = format!("bootout {}/{LABEL}", gui_domain());
    assert_eq!(launchd.calls()[2..], [target.clone(), target]);
}

#[test]
fn install_writes_a_relative_config_path_as_absolute_without_resolving_symlinks() {
    let env = Env::new();
    fs::create_dir(env.root.join("real")).unwrap();
    fs::rename(&env.config, env.root.join("real/sync.toml")).unwrap();
    symlink(env.root.join("real"), env.root.join("link")).unwrap();
    let launchd = Launchd::new(&env);
    let mut command = launchd.install_command(Path::new("link/sync.toml"), OK, OK);
    command.current_dir(&env.root);

    let output = output(command);

    assert_success(&output);
    let expected = format!(
        "<string>{}</string>",
        env.root.join("link/sync.toml").display()
    );
    assert!(
        launchd.plist_text().contains(&expected),
        "{}",
        launchd.plist_text()
    );
}

#[test]
fn install_and_uninstall_default_to_paths_under_home() {
    let env = Env::new();
    let config = env.root.join(".config/hex/sync.toml");
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::rename(&env.config, &config).unwrap();
    let launchd = Launchd::new(&env);

    let installed = output(launchd.command(&[OsStr::new("install")], OK, OK));

    assert_success(&installed);
    let expected = format!("<string>{}</string>", config.display());
    assert!(
        launchd.plist_text().contains(&expected),
        "{}",
        launchd.plist_text()
    );

    let removed = output(launchd.command(&[OsStr::new("uninstall")], OK, OK));

    assert_success(&removed);
    assert!(!launchd.plist.exists());
}

/// Makes `command` run with umask 0, so only the mode the binary asks for limits the files
/// it creates.
fn with_umask_0(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: umask is async-signal-safe and touches no memory.
    unsafe {
        command.pre_exec(|| {
            libc::umask(0);
            Ok(())
        });
    }
}

#[test]
fn install_creates_a_plist_launchd_accepts_whatever_the_umask() {
    let env = Env::new();
    let launchd = Launchd::new(&env);
    let mut command = launchd.install_command(&env.config, OK, OK);
    with_umask_0(&mut command);

    assert_success(&output(command));

    let mode = fs::metadata(&launchd.plist).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o644);
}

#[test]
fn install_replaces_a_temp_left_by_a_crashed_install() {
    let env = Env::new();
    let launchd = Launchd::new(&env);
    let temp = launchd.dir.join(format!(".{LABEL}.plist.tmp"));
    write(&temp, b"half a plist");
    chmod(&temp, 0o666);
    let mut command = launchd.install_command(&env.config, OK, OK);
    with_umask_0(&mut command);

    assert_success(&output(command));

    let mode = fs::metadata(&launchd.plist).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o644);
    assert!(launchd.plist_text().starts_with("<?xml"));
    let entries: Vec<_> = fs::read_dir(&launchd.dir).unwrap().collect();
    assert_eq!(entries.len(), 1, "{entries:?}");
}

#[test]
fn install_refuses_a_log_inside_a_root() {
    for root in ["outbox", "archive"] {
        let env = Env::new();
        let root = env.root.join(root);
        env.set_paths(&env.outbox, &env.archive, &root.join("logs/sync.log"));
        let launchd = Launchd::new(&env);

        let output = launchd.install(&env.config, OK, OK);

        assert_exit(&output, 1, "not installed: log");
        assert!(!launchd.dir.exists());
        assert!(launchd.calls().is_empty());
        assert!(!root.join("logs").exists());
    }
}

#[test]
fn install_fails_without_home_before_writing_anything() {
    let env = Env::new();
    let launchd = Launchd::new(&env);
    let mut command = launchd.install_command(&env.config, OK, OK);
    command.env_remove("HOME");

    let output = output(command);

    assert_exit(&output, 1, "HOME is not set or not absolute");
    assert!(!launchd.dir.exists());
    assert!(launchd.calls().is_empty());
}

#[test]
fn uninstall_fails_without_home_before_unloading() {
    let env = Env::new();
    let launchd = Launchd::new(&env);
    assert_success(&launchd.install(&env.config, BOOTOUT_NOT_LOADED, OK));
    let calls = launchd.calls();
    let mut command = launchd.command(&[OsStr::new("uninstall")], OK, OK);
    command.env_remove("HOME").current_dir(&env.root);

    let output = output(command);

    assert_exit(&output, 1, "HOME is not set or not absolute");
    assert_eq!(launchd.calls(), calls);
    assert!(launchd.plist.exists());
}

#[test]
fn install_resolves_a_relative_launch_agents_dir() {
    let env = Env::new();
    let launchd = Launchd::new(&env);
    let args = [
        OsStr::new("install"),
        OsStr::new("--config"),
        env.config.as_os_str(),
        OsStr::new("--launch-agents-dir"),
        OsStr::new("agents/new"),
    ];
    let mut command = launchd.command(&args, BOOTOUT_NOT_LOADED, OK);
    command.current_dir(&env.root);

    let output = output(command);

    assert_success(&output);
    let plist = env.root.join(format!("agents/new/{LABEL}.plist"));
    assert!(plist.exists());
    let bootstrap = format!("bootstrap {} {}", gui_domain(), plist.display());
    assert_eq!(launchd.calls().last(), Some(&bootstrap));
}

#[test]
fn install_accepts_a_missing_root() {
    let env = Env::new();
    fs::remove_dir(&env.archive).unwrap();
    let launchd = Launchd::new(&env);

    assert_success(&launchd.install(&env.config, OK, OK));

    assert!(launchd.plist.exists());
    assert!(!env.archive.exists());
}

#[test]
fn uninstall_fails_on_an_unexpected_bootout_error_and_keeps_the_plist() {
    let env = Env::new();
    let launchd = Launchd::new(&env);
    assert_success(&launchd.install(&env.config, BOOTOUT_NOT_LOADED, OK));

    let output = launchd.uninstall(UNEXPECTED_FAILURE);

    assert_exit(&output, 1, "bootout");
    assert!(launchd.plist.exists());
}

#[test]
fn uninstall_fails_when_launchctl_cannot_run() {
    let env = Env::new();
    let launchd = Launchd::new(&env);
    let mut command = launchd.uninstall_command(OK);
    command.env("HEX_SYNC_LAUNCHCTL", env.root.join("missing-launchctl"));

    let output = output(command);

    assert_exit(&output, 1, "cannot run");
    assert!(
        !stdout(&output).contains("not loaded"),
        "{}",
        stdout(&output)
    );
}

// Run lock

impl Env {
    fn lock_path(&self) -> PathBuf {
        self.log.with_file_name("sync.log.lock")
    }

    /// Holds an exclusive `flock` on the run lock, as a concurrent run would, until passed to
    /// `release`.
    fn hold_lock(&self) -> File {
        let path = self.lock_path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let file = spawn_locked(|| File::create(&path).unwrap());
        // SAFETY: `file` owns a valid open descriptor for the duration of the call.
        let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        assert_eq!(locked, 0, "{}", std::io::Error::last_os_error());
        file
    }
}

fn release(lock: File) {
    spawn_locked(|| drop(lock));
}

#[test]
fn a_run_holds_the_lock_for_its_whole_pass() {
    // Each file logs a line of over 400 bytes, echoed to a stdout pipe nobody reads: more
    // than the 64 KiB pipe buffer, so run A blocks mid-pass until the pipe is drained.
    const FILES: usize = 400;
    let env = Env::new();
    let padding = "n".repeat(200);
    for n in 0..FILES {
        write(&env.outbox.join(format!("{padding}{n:03}.pdf")), b"x");
    }
    let mut command = env.command(&["run"]);
    command.stderr(Stdio::null());
    let first = spawn_locked(|| command.spawn().unwrap());
    let deadline = SystemTime::now() + Duration::from_secs(30);
    while fs::read(&env.log).map_or(true, |log| log.is_empty()) {
        assert!(SystemTime::now() < deadline, "run A never logged");
        std::thread::sleep(Duration::from_millis(10));
    }

    // Not `env.run`: its Archive bookkeeping would race run A's writes.
    let refused = output(env.command(&["run"]));

    assert_exit(&refused, 3, "another run is in progress");
    let first = first.wait_with_output().unwrap();
    assert_success(&first);
    assert_eq!(snapshot(&env.archive).len(), FILES);
    assert_eq!(outbox_entries(&env), 0);
}

#[test]
fn run_fails_when_the_log_folder_cannot_be_created() {
    let env = Env::new();
    write(&env.outbox.join("a.pdf"), b"stays");
    let read_only = env.root.join("read-only");
    fs::create_dir(&read_only).unwrap();
    chmod(&read_only, 0o555);
    let log = read_only.join("logs/sync.log");
    env.set_paths(&env.outbox, &env.archive, &log);

    let output = env.run(&["run"]);

    assert_exit(&output, 2, "cannot create log folder");
    assert!(env.outbox.join("a.pdf").exists());
    assert!(snapshot(&env.archive).is_empty());
}

#[test]
fn run_aborts_when_the_lock_file_is_a_symlink() {
    let env = Env::new();
    write(&env.outbox.join("a.pdf"), b"stays");
    fs::create_dir_all(env.log.parent().unwrap()).unwrap();
    let target = env.root.join("elsewhere.lock");
    symlink(&target, env.lock_path()).unwrap();
    let (outbox, archive) = (snapshot(&env.outbox), snapshot(&env.archive));

    let output = env.run(&["run"]);

    assert_exit(&output, 2, "cannot open lock");
    assert!(!target.exists());
    assert_eq!(snapshot(&env.outbox), outbox);
    assert_eq!(snapshot(&env.archive), archive);
    assert!(!env.log.exists());
}

#[test]
fn run_is_refused_while_another_run_holds_the_lock() {
    let env = Env::new();
    write(&env.outbox.join("a.pdf"), b"a");
    let lock = env.hold_lock();
    let (outbox, archive) = (snapshot(&env.outbox), snapshot(&env.archive));

    let refused = env.run(&["run"]);

    assert_eq!(refused.status.code(), Some(3), "{}", stderr(&refused));
    assert_eq!(
        stderr(&refused),
        format!(
            "hex-sync: another run is in progress (lock {})\n",
            env.lock_path().display()
        )
    );
    assert_eq!(stdout(&refused), "");
    assert_eq!(snapshot(&env.outbox), outbox);
    assert_eq!(snapshot(&env.archive), archive);
    assert!(!env.log.exists());

    release(lock);
    let output = env.run(&["run"]);

    assert_success(&output);
    assert_eq!(fs::read(env.archive.join("a.pdf")).unwrap(), b"a");
    assert!(
        env.log_text().contains("\tcopy\ta.pdf"),
        "{}",
        env.log_text()
    );
}

#[test]
fn dry_run_works_while_the_lock_is_held() {
    let env = Env::new();
    write(&env.outbox.join("a.pdf"), b"a");
    let lock = env.hold_lock();
    let outbox = snapshot(&env.outbox);

    let output = env.run(&["--dry-run"]);

    assert_success(&output);
    assert_eq!(stdout(&output), "dry-run: copy a.pdf -> a.pdf\n");
    assert_eq!(snapshot(&env.outbox), outbox);
    assert!(snapshot(&env.archive).is_empty());
    assert!(!env.log.exists());
    release(lock);
}

#[test]
fn dry_run_creates_no_lock_file() {
    let env = Env::new();
    write(&env.outbox.join("a.pdf"), b"a");

    assert_success(&env.run(&["--dry-run"]));

    assert!(!env.log.parent().unwrap().exists());
}
