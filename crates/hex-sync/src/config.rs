use std::fs;
use std::num::NonZeroU64;
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
    /// Seconds between scheduled runs: the launchd agent's `StartInterval` (`install`).
    #[serde(default = "default_interval_secs")]
    pub interval_secs: NonZeroU64,
    pub log: PathBuf,
}

fn default_min_age_secs() -> u64 {
    60
}

fn default_interval_secs() -> NonZeroU64 {
    NonZeroU64::new(900).expect("non-zero literal")
}

impl Config {
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = fs::read_to_string(path)
            .map_err(|e| format!("cannot read config {}: {e}", path.display()))?;
        Self::parse(&text).map_err(|e| format!("invalid config {}: {e}", path.display()))
    }

    fn parse(text: &str) -> Result<Self, String> {
        let mut config: Config = toml::from_str(text).map_err(|e| e.to_string())?;
        for (key, value) in [
            ("outbox", &mut config.outbox),
            ("archive", &mut config.archive),
            ("log", &mut config.log),
        ] {
            *value = expand_home(value);
            if !value.is_absolute() {
                return Err(format!(
                    "{key} must be an absolute path (or start with ~/), got {}",
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
