//! Seam tests: run the real `hex-sync` binary against temporary Outbox/Archive folders.

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, SystemTime};

use filetime::FileTime;
use tempfile::TempDir;

struct Env {
    _tmp: TempDir,
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

    /// Runs the binary with `--config` and `args`, asserting the Archive never loses
    /// or changes a file.
    fn run(&self, args: &[&str]) -> Output {
        let before = self.archive_state();
        let output = self.command(args).output().unwrap();
        self.assert_archive_kept(&before);
        output
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hex-sync"));
        command.args(args).arg("--config").arg(&self.config);
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

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

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
fn partial_files_are_ignored_and_keep_their_folder() {
    let env = Env::new();
    write(&env.outbox.join("2026-01/upload.pdf.partial"), b"half");

    let output = env.run(&[]);

    assert_success(&output);
    assert!(env.outbox.join("2026-01/upload.pdf.partial").exists());
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
fn empty_outbox_folders_are_removed_but_root_kept() {
    let env = Env::new();
    fs::create_dir_all(env.outbox.join("empty/deeper/deepest")).unwrap();
    write(&env.outbox.join("2026-02/ER/b.pdf"), b"b");
    fs::create_dir_all(env.archive.join("unrelated-empty")).unwrap();

    let output = env.run(&[]);

    assert_success(&output);
    assert!(env.outbox.is_dir());
    assert_eq!(fs::read_dir(&env.outbox).unwrap().count(), 0);
    assert!(env.archive.join("unrelated-empty").is_dir());
    assert!(env.log_text().contains("\trmdir\tempty/deeper/deepest\t"));
}

#[test]
fn symlinks_are_skipped_logged_and_not_followed() {
    let env = Env::new();
    let elsewhere = env.outbox.parent().unwrap().join("elsewhere");
    write(&elsewhere.join("target.pdf"), b"outside");
    std::os::unix::fs::symlink(elsewhere.join("target.pdf"), env.outbox.join("link.pdf")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, env.outbox.join("linked-dir")).unwrap();

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

#[test]
fn failed_copy_keeps_source_continues_and_exits_non_zero() {
    let env = Env::new();
    write(&env.outbox.join("locked/a.pdf"), b"cannot land");
    write(&env.outbox.join("open/b.pdf"), b"lands");
    fs::create_dir_all(env.archive.join("locked")).unwrap();
    chmod(&env.archive.join("locked"), 0o555);

    let output = env.run(&[]);
    chmod(&env.archive.join("locked"), 0o755);

    assert!(!output.status.success());
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

fn assert_aborted_untouched(env: &Env, output: &Output) {
    assert_eq!(output.status.code(), Some(2), "stderr: {}", stderr(output));
    assert!(stderr(output).contains("aborted"));
    assert!(env.log_text().contains("\tabort\t"));
}

#[test]
fn aborts_when_outbox_missing() {
    let env = Env::new();
    write(&env.archive.join("kept.pdf"), b"kept");
    fs::remove_dir(&env.outbox).unwrap();

    let output = env.run(&[]);

    assert_aborted_untouched(&env, &output);
    assert!(!env.outbox.exists());
}

#[test]
fn aborts_when_archive_missing_without_touching_outbox() {
    let env = Env::new();
    write(&env.outbox.join("2026-01/a.pdf"), b"stays");
    fs::create_dir_all(env.outbox.join("empty")).unwrap();
    fs::remove_dir(&env.archive).unwrap();

    let output = env.run(&[]);

    assert_aborted_untouched(&env, &output);
    assert_eq!(
        fs::read(env.outbox.join("2026-01/a.pdf")).unwrap(),
        b"stays"
    );
    assert!(env.outbox.join("empty").is_dir());
    assert!(!env.archive.exists());
}

#[test]
fn aborts_when_root_is_not_a_directory() {
    let env = Env::new();
    write(&env.outbox.join("a.pdf"), b"stays");
    fs::remove_dir(&env.archive).unwrap();
    write(&env.archive, b"a file, not a folder");

    let output = env.run(&[]);

    assert_aborted_untouched(&env, &output);
    assert!(env.outbox.join("a.pdf").exists());
}

#[test]
fn aborts_when_root_is_unreadable() {
    let env = Env::new();
    write(&env.outbox.join("a.pdf"), b"stays");
    chmod(&env.outbox, 0o311);

    let output = env.run(&[]);
    chmod(&env.outbox, 0o755);

    assert_aborted_untouched(&env, &output);
    assert!(env.outbox.join("a.pdf").exists());
    assert!(snapshot(&env.archive).is_empty());
}

#[test]
fn aborts_when_archive_is_inside_outbox() {
    let env = Env::new();
    let nested_archive = env.outbox.join("archive");
    write(&nested_archive.join("a.pdf"), b"same");
    env.write_config(&config_text(
        &env.outbox,
        &nested_archive,
        &env.log,
        "min_age_secs = 0\n",
    ));

    let output = env.run(&[]);

    assert_aborted_untouched(&env, &output);
    assert_eq!(fs::read(nested_archive.join("a.pdf")).unwrap(), b"same");
}

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
    assert!(
        out.contains("copy 2026-01/new.pdf -> 2026-01/new.pdf"),
        "{out}"
    );
    assert!(out.contains("remove-identical 2026-01/same.pdf"), "{out}");
    assert!(
        out.contains("copy-renamed 2026-01/clash.pdf -> 2026-01/clash (1).pdf"),
        "{out}"
    );
    assert!(out.contains("rmdir empty"), "{out}");
    assert!(out.contains("rmdir 2026-01"), "{out}");
    assert!(
        out.contains("restore-claim 2026-02/.hex-sync.claimed.pdf -> 2026-02/claimed.pdf"),
        "{out}"
    );
    assert_eq!(snapshot(&env.outbox), outbox_before);
    assert!(env.outbox.join("empty").is_dir());
    assert_eq!(snapshot(&env.archive), archive_before);
    assert!(!env.log.exists());
    assert!(!env.log.parent().unwrap().exists());
}

#[test]
fn log_is_appended_across_runs() {
    let env = Env::new();
    write(&env.outbox.join("first.pdf"), b"1");
    assert!(env.run(&[]).status.success());
    write(&env.outbox.join("second.pdf"), b"2");
    assert!(env.run(&["run"]).status.success());

    let log = env.log_text();
    let lines: Vec<&str> = log.lines().collect();
    assert_eq!(lines.len(), 2, "{log}");
    assert!(lines[0].contains("\tcopy\tfirst.pdf\tfirst.pdf\tok"));
    assert!(lines[1].contains("\tcopy\tsecond.pdf\tsecond.pdf\tok"));
}

#[test]
fn missing_required_key_is_a_config_error() {
    let env = Env::new();
    write(&env.outbox.join("a.pdf"), b"stays");
    env.write_config(&format!("outbox = {:?}\nlog = {:?}\n", env.outbox, env.log));

    let output = env.run(&[]);

    assert_eq!(output.status.code(), Some(2));
    assert!(stderr(&output).contains("archive"), "{}", stderr(&output));
    assert!(env.outbox.join("a.pdf").exists());
    assert!(!env.log.exists());
}

#[test]
fn unknown_key_is_a_config_error() {
    let env = Env::with_config_tail("min_age_secs = 0\npassword = \"nope\"\n");
    write(&env.outbox.join("a.pdf"), b"stays");

    let output = env.run(&[]);

    assert_eq!(output.status.code(), Some(2));
    assert!(stderr(&output).contains("password"), "{}", stderr(&output));
    assert!(env.outbox.join("a.pdf").exists());
}

#[test]
fn min_age_defaults_to_sixty_seconds() {
    let env = Env::with_config_tail("");
    write(&env.outbox.join("fresh.pdf"), b"fresh");
    write(&env.outbox.join("half-minute.pdf"), b"half");
    set_age(&env.outbox.join("half-minute.pdf"), Duration::from_secs(30));
    write(&env.outbox.join("settled.pdf"), b"settled");
    set_age(&env.outbox.join("settled.pdf"), Duration::from_secs(61));

    let output = env.run(&[]);

    assert_success(&output);
    assert!(env.outbox.join("fresh.pdf").exists());
    assert!(env.outbox.join("half-minute.pdf").exists());
    assert!(!env.outbox.join("settled.pdf").exists());
    assert!(env.archive.join("settled.pdf").exists());
}

#[test]
fn aborts_when_outbox_is_inside_archive() {
    let env = Env::new();
    let nested_outbox = env.archive.join("outbox");
    write(&nested_outbox.join("a.pdf"), b"in the archive");
    env.write_config(&config_text(
        &nested_outbox,
        &env.archive,
        &env.log,
        "min_age_secs = 0\n",
    ));

    let output = env.run(&[]);

    assert_aborted_untouched(&env, &output);
    assert_eq!(
        fs::read(nested_outbox.join("a.pdf")).unwrap(),
        b"in the archive"
    );
}

#[test]
fn aborts_when_roots_are_one_folder_reached_through_a_symlinked_parent() {
    let env = Env::new();
    let root = env.outbox.parent().unwrap();
    std::os::unix::fs::symlink(root, root.join("alias")).unwrap();
    write(&env.outbox.join("a.pdf"), b"only copy");
    env.write_config(&config_text(
        &env.outbox,
        &root.join("alias/outbox"),
        &env.log,
        "min_age_secs = 0\n",
    ));

    let output = env.run(&[]);

    assert_aborted_untouched(&env, &output);
    assert_eq!(fs::read(env.outbox.join("a.pdf")).unwrap(), b"only copy");
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
    env.write_config(&config_text(
        &env.outbox,
        &alias,
        &env.log,
        "min_age_secs = 0\n",
    ));

    let output = env.run(&[]);

    assert_aborted_untouched(&env, &output);
    assert_eq!(fs::read(env.outbox.join("a.pdf")).unwrap(), b"only copy");
}

#[test]
fn archive_folder_symlinked_into_outbox_keeps_source() {
    let env = Env::new();
    write(&env.outbox.join("sub/x.pdf"), b"only copy");
    std::os::unix::fs::symlink(env.outbox.join("sub"), env.archive.join("sub")).unwrap();

    let output = env.run(&[]);

    assert_eq!(output.status.code(), Some(1), "stderr: {}", stderr(&output));
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
    assert_eq!(fs::read_dir(&env.outbox).unwrap().count(), 0);
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
    assert_eq!(fs::read_dir(&env.outbox).unwrap().count(), 0);
}

#[test]
fn existing_file_with_temp_name_survives() {
    let env = Env::new();
    write(&env.archive.join(".hex-sync-0.tmp"), b"not ours");
    write(&env.outbox.join("a.pdf"), b"incoming");

    let output = env.run(&[]);

    assert_success(&output);
    assert_eq!(
        fs::read(env.archive.join(".hex-sync-0.tmp")).unwrap(),
        b"not ours"
    );
    assert_eq!(fs::read(env.archive.join("a.pdf")).unwrap(), b"incoming");
    assert_eq!(snapshot(&env.archive).len(), 2, "no temp left behind");
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
    let before = env.archive_state();

    let mut child = env
        .command(&[])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    drop(child.stdout.take());
    let output = child.wait_with_output().unwrap();
    env.assert_archive_kept(&before);

    assert_success(&output);
    assert_eq!(fs::read_dir(&env.outbox).unwrap().count(), 0);
    let log = env.log_text();
    assert_eq!(log.matches("\tcopy\t").count(), 5, "{log}");
}

#[cfg(target_os = "linux")]
#[test]
fn log_write_failure_stops_the_pass() {
    let env = Env::new();
    write(&env.outbox.join("a.pdf"), b"a");
    write(&env.outbox.join("b.pdf"), b"b");
    env.write_config(&config_text(
        &env.outbox,
        &env.archive,
        Path::new("/dev/full"),
        "min_age_secs = 0\n",
    ));

    let output = env.run(&[]);

    assert_eq!(output.status.code(), Some(1), "stderr: {}", stderr(&output));
    assert!(stderr(&output).contains("cannot write log"));
    // The first move happens before its log line fails; nothing after it.
    assert_eq!(fs::read_dir(&env.outbox).unwrap().count(), 1);
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
fn future_mtime_counts_as_young_and_is_logged() {
    let env = Env::with_config_tail("");
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
            .contains("\tskip-future-mtime\tfuture.pdf\t-\tskipped")
    );
}

#[test]
fn zero_interval_is_a_config_error() {
    let env = Env::with_config_tail("interval_secs = 0\n");

    let output = env.run(&[]);

    assert_eq!(output.status.code(), Some(2));
    assert!(
        stderr(&output).contains("interval_secs"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn relative_path_is_a_config_error() {
    let env = Env::new();
    env.write_config(&config_text(
        Path::new("outbox"),
        &env.archive,
        &env.log,
        "",
    ));

    let output = env.run(&[]);

    assert_eq!(output.status.code(), Some(2));
    assert!(stderr(&output).contains("absolute"), "{}", stderr(&output));
}

#[test]
fn archive_symlink_at_target_is_never_identical() {
    let env = Env::new();
    let elsewhere = env.outbox.parent().unwrap().join("elsewhere/a.pdf");
    write(&elsewhere, b"same bytes");
    std::os::unix::fs::symlink(&elsewhere, env.archive.join("a.pdf")).unwrap();
    write(&env.outbox.join("a.pdf"), b"same bytes");

    let output = env.run(&[]);

    assert_success(&output);
    assert_eq!(
        fs::read(env.archive.join("a (1).pdf")).unwrap(),
        b"same bytes"
    );
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
fn aborts_when_log_is_inside_a_root() {
    for inside in ["outbox", "archive"] {
        let env = Env::new();
        write(&env.outbox.join("a.pdf"), b"stays");
        let log = env
            .outbox
            .parent()
            .unwrap()
            .join(inside)
            .join("logs/sync.log");
        env.write_config(&config_text(
            &env.outbox,
            &env.archive,
            &log,
            "min_age_secs = 0\n",
        ));

        let output = env.run(&[]);

        assert_eq!(output.status.code(), Some(2), "{inside}");
        assert!(stderr(&output).contains("inside"), "{}", stderr(&output));
        assert!(!log.parent().unwrap().exists(), "{inside}");
        assert!(env.outbox.join("a.pdf").exists());
    }
}

#[test]
fn dry_run_plans_match_the_real_run() {
    let env = Env::new();
    write(&env.archive.join("a.pdf"), b"archived");
    write(&env.outbox.join("a.pdf"), b"incoming one");
    write(&env.outbox.join("a (1).pdf"), b"incoming two");

    let dry = env.run(&["--dry-run"]);
    let real = env.run(&[]);

    assert_success(&dry);
    assert_success(&real);
    let planned: std::collections::BTreeSet<String> = stdout(&dry)
        .lines()
        .filter_map(|line| line.split_once(" -> ").map(|(_, t)| t.to_string()))
        .collect();
    let done: std::collections::BTreeSet<String> = env
        .log_text()
        .lines()
        .filter_map(|line| line.split('\t').nth(3).map(str::to_string))
        .collect();
    assert_eq!(planned.len(), 2, "{planned:?}");
    assert_eq!(planned, done);
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
