//! Seam tests: run the real `hex-sync` binary against temporary Outbox/Archive folders.

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
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

/// Every regular file under `dir` with its bytes, keyed by relative path.
type Snapshot = BTreeMap<PathBuf, Vec<u8>>;

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
        env.write_config(&format!(
            "outbox = {:?}\narchive = {:?}\nlog = {:?}\n{tail}",
            env.outbox, env.archive, env.log
        ));
        env
    }

    fn write_config(&self, text: &str) {
        fs::write(&self.config, text).unwrap();
    }

    /// Runs the binary with `--config` and `args`, asserting the Archive never loses
    /// or changes a file.
    fn run(&self, args: &[&str]) -> Output {
        let before = snapshot(&self.archive);
        let output = Command::new(env!("CARGO_BIN_EXE_hex-sync"))
            .args(args)
            .arg("--config")
            .arg(&self.config)
            .output()
            .unwrap();
        let after = snapshot(&self.archive);
        for (path, bytes) in &before {
            assert_eq!(
                after.get(path),
                Some(bytes),
                "Archive file {} was removed or changed",
                path.display()
            );
        }
        output
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

    assert!(output.status.success(), "stderr: {}", stderr(&output));
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

    assert!(output.status.success(), "stderr: {}", stderr(&output));
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

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    assert_eq!(
        fs::read(env.archive.join("a (1).pdf")).unwrap(),
        b"incoming-1"
    );
    assert!(!env.outbox.join("a.pdf").exists());

    write(&env.outbox.join("a.pdf"), b"incoming number two");
    let output = env.run(&[]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
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

    assert!(output.status.success(), "stderr: {}", stderr(&output));
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

    assert!(output.status.success(), "stderr: {}", stderr(&output));
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

    assert!(output.status.success(), "stderr: {}", stderr(&output));
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

    assert!(output.status.success(), "stderr: {}", stderr(&output));
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

    assert!(output.status.success(), "stderr: {}", stderr(&output));
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
    fs::set_permissions(
        env.archive.join("locked"),
        fs::Permissions::from_mode(0o555),
    )
    .unwrap();

    let output = env.run(&[]);
    fs::set_permissions(
        env.archive.join("locked"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();

    assert!(!output.status.success());
    assert_eq!(
        fs::read(env.outbox.join("locked/a.pdf")).unwrap(),
        b"cannot land"
    );
    assert_eq!(fs::read(env.archive.join("open/b.pdf")).unwrap(), b"lands");
    assert!(!env.outbox.join("open").exists());
    assert!(
        env.log_text()
            .contains("\tcopy\tlocked/a.pdf\tlocked/a.pdf\tfailed: ")
    );
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
    fs::set_permissions(&env.outbox, fs::Permissions::from_mode(0o311)).unwrap();

    let output = env.run(&[]);
    fs::set_permissions(&env.outbox, fs::Permissions::from_mode(0o755)).unwrap();

    assert_aborted_untouched(&env, &output);
    assert!(env.outbox.join("a.pdf").exists());
    assert!(snapshot(&env.archive).is_empty());
}

#[test]
fn aborts_when_archive_is_inside_outbox() {
    let env = Env::new();
    let nested_archive = env.outbox.join("archive");
    write(&nested_archive.join("a.pdf"), b"same");
    env.write_config(&format!(
        "outbox = {:?}\narchive = {:?}\nlog = {:?}\nmin_age_secs = 0\n",
        env.outbox, nested_archive, env.log
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
    let outbox_before = snapshot(&env.outbox);
    let archive_before = snapshot(&env.archive);

    let output = env.run(&["--dry-run"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
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
    write(&env.outbox.join("settled.pdf"), b"settled");
    set_age(&env.outbox.join("settled.pdf"), Duration::from_secs(61));

    let output = env.run(&[]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    assert!(env.outbox.join("fresh.pdf").exists());
    assert!(!env.outbox.join("settled.pdf").exists());
    assert!(env.archive.join("settled.pdf").exists());
}
