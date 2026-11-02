use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Contents of `sync.toml`. Holds paths and timings only, never secrets.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub outbox: PathBuf,
    pub archive: PathBuf,
    /// Files whose mtime is younger than this are left for a later run.
    #[serde(default = "default_min_age_secs")]
    pub min_age_secs: u64,
    /// Seconds between runs once scheduled; validated here, used by the scheduler.
    #[serde(default = "default_interval_secs")]
    #[allow(dead_code)]
    pub interval_secs: u64,
    pub log: PathBuf,
}

fn default_min_age_secs() -> u64 {
    60
}

fn default_interval_secs() -> u64 {
    900
}

impl Config {
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = fs::read_to_string(path)
            .map_err(|e| format!("cannot read config {}: {e}", path.display()))?;
        let mut config: Config =
            toml::from_str(&text).map_err(|e| format!("invalid config {}: {e}", path.display()))?;
        if config.interval_secs == 0 {
            return Err(format!(
                "invalid config {}: interval_secs must be greater than 0",
                path.display()
            ));
        }
        for (key, value) in [
            ("outbox", &mut config.outbox),
            ("archive", &mut config.archive),
            ("log", &mut config.log),
        ] {
            *value = expand_home(value);
            if !value.is_absolute() {
                return Err(format!(
                    "invalid config {}: {key} must be an absolute path (or start with ~/), got {}",
                    path.display(),
                    value.display()
                ));
            }
        }
        Ok(config)
    }
}

/// Replaces a leading `~` component with `$HOME`; other paths are returned unchanged.
pub fn expand_home(path: &Path) -> PathBuf {
    match (path.strip_prefix("~"), std::env::var_os("HOME")) {
        (Ok(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => path.to_path_buf(),
    }
}
