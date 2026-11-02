//! `install`/`uninstall`: schedules `hex-sync run` as a per-user launchd agent.

use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::config::Config;
use crate::fsio::{create_dir_all_durable, sync_dir};

const LABEL: &str = "ai.stibbons.hex-sync";

/// Overrides the `launchctl` program (tests point it at a fake).
const LAUNCHCTL_ENV: &str = "HEX_SYNC_LAUNCHCTL";
const LAUNCHCTL: &str = "/bin/launchctl";

/// Exit statuses of `launchctl bootout` for a service that isn't loaded: 3 (ESRCH, "No such
/// process") and 113 ("Could not find specified service").
const NOT_LOADED: [i32; 2] = [3, 113];

/// Writes the agent's plist into `launch_agents_dir` (created if missing) and (re)loads it,
/// so the latest config always wins.
pub fn install(config_path: &Path, launch_agents_dir: &Path) -> Result<(), String> {
    let config = Config::load(config_path)?;
    let config_path = std::path::absolute(config_path)
        .map_err(|e| format!("cannot resolve {}: {e}", config_path.display()))?;
    let program = std::env::current_exe()
        .and_then(fs::canonicalize)
        .map_err(|e| format!("cannot locate the hex-sync binary: {e}"))?;
    let stderr_log = stderr_log_path(&config.log);
    let interval = config.interval_secs.get();
    let plist = plist(&program, &config_path, interval, &stderr_log)?;

    create_dir_all_durable(launch_agents_dir)
        .map_err(|e| format!("cannot create {}: {e}", launch_agents_dir.display()))?;
    let plist_path = plist_path(launch_agents_dir);
    write_atomically(launch_agents_dir, &plist_path, plist.as_bytes())
        .map_err(|e| format!("cannot write {}: {e}", plist_path.display()))?;
    println!("wrote {}", plist_path.display());

    let domain = gui_domain();
    if bootout(&domain)? {
        println!("unloaded the previous {LABEL}");
    }
    let bootstrap = [
        OsStr::new("bootstrap"),
        domain.as_ref(),
        plist_path.as_ref(),
    ];
    launchctl(&bootstrap).map_err(|e| e.message)?;
    println!(
        "loaded {LABEL}: runs `{} run --config {}` every {interval}s; errors go to {}",
        program.display(),
        config_path.display(),
        stderr_log.display()
    );
    Ok(())
}

/// Unloads the agent and removes its plist; either being absent already is fine.
pub fn uninstall(launch_agents_dir: &Path) -> Result<(), String> {
    if bootout(&gui_domain())? {
        println!("unloaded {LABEL}");
    } else {
        println!("{LABEL} was not loaded");
    }
    let plist_path = plist_path(launch_agents_dir);
    match fs::remove_file(&plist_path) {
        Ok(()) => {
            println!("removed {}", plist_path.display());
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            println!("no plist at {}", plist_path.display());
            Ok(())
        }
        Err(e) => Err(format!("cannot remove {}: {e}", plist_path.display())),
    }
}

fn plist_path(launch_agents_dir: &Path) -> PathBuf {
    launch_agents_dir.join(format!("{LABEL}.plist"))
}

/// Where launchd sends the agent's stderr: `hex-sync.stderr.log` in the log's folder.
fn stderr_log_path(log: &Path) -> PathBuf {
    log.with_file_name("hex-sync.stderr.log")
}

fn gui_domain() -> String {
    // SAFETY: getuid has no preconditions and cannot fail.
    format!("gui/{}", unsafe { libc::getuid() })
}

/// Stdout goes to `/dev/null`: it only echoes what the log already holds.
fn plist(
    program: &Path,
    config: &Path,
    interval: u64,
    stderr_log: &Path,
) -> Result<String, String> {
    let program = xml_path(program)?;
    let config = xml_path(config)?;
    let stderr_log = xml_path(stderr_log)?;
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{program}</string>
		<string>run</string>
		<string>--config</string>
		<string>{config}</string>
	</array>
	<key>StartInterval</key>
	<integer>{interval}</integer>
	<key>RunAtLoad</key>
	<false/>
	<key>StandardOutPath</key>
	<string>/dev/null</string>
	<key>StandardErrorPath</key>
	<string>{stderr_log}</string>
</dict>
</plist>
"#
    ))
}

fn xml_path(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(xml_escape)
        .ok_or_else(|| format!("path is not valid UTF-8: {}", path.display()))
}

fn xml_escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            c => escaped.push(c),
        }
    }
    escaped
}

/// Writes `.<LABEL>.plist.tmp` in `dir`, then renames it over `path`.
fn write_atomically(dir: &Path, path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temp = dir.join(format!(".{LABEL}.plist.tmp"));
    let result = File::create(&temp)
        .and_then(|mut file| {
            file.write_all(bytes)?;
            file.sync_all()
        })
        .and_then(|()| fs::rename(&temp, path));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result?;
    sync_dir(dir)
}

/// `launchctl bootout <domain>/<label>`: true if the agent was loaded, false if it wasn't.
fn bootout(domain: &str) -> Result<bool, String> {
    let target = format!("{domain}/{LABEL}");
    match launchctl(&[OsStr::new("bootout"), target.as_ref()]) {
        Ok(()) => Ok(true),
        Err(e) if e.code.is_some_and(|code| NOT_LOADED.contains(&code)) => Ok(false),
        Err(e) => Err(e.message),
    }
}

/// A failed launchctl call: its exit status (none if it couldn't run or was killed) and a
/// message naming the command and carrying its stderr.
struct LaunchctlError {
    code: Option<i32>,
    message: String,
}

fn launchctl(args: &[&OsStr]) -> Result<(), LaunchctlError> {
    let program = std::env::var_os(LAUNCHCTL_ENV).unwrap_or_else(|| LAUNCHCTL.into());
    let describe = || {
        let mut command = Path::new(&program).display().to_string();
        for arg in args {
            command.push(' ');
            command.push_str(&arg.to_string_lossy());
        }
        command
    };
    let output = Command::new(&program)
        .args(args)
        .output()
        .map_err(|e| LaunchctlError {
            code: None,
            message: format!("cannot run `{}`: {e}", describe()),
        })?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(LaunchctlError {
        code: output.status.code(),
        message: format!(
            "`{}` failed ({}): {}",
            describe(),
            output.status,
            stderr.trim()
        ),
    })
}
