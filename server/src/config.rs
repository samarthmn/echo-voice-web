//! Public loopback runtime settings. Legacy runner configuration is ignored.
use crate::security::ApiError;
use serde::Deserialize;
use std::{
    fs,
    io::Write,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::OnceLock,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub bind: String,
    pub data_dir: PathBuf,
    pub google_redirect_uri: String,
    pub codex_binary: Option<PathBuf>,
    #[serde(default, rename = "runner")]
    pub _deprecated_runner: Option<serde_json::Value>,
}
static CONFIG: OnceLock<Config> = OnceLock::new();

/// Load the shared file once; packaged binaries retain the same embedded defaults.
pub fn get() -> &'static Config {
    CONFIG.get_or_init(|| {
        let path = std::env::var_os("ECHO_CONFIG_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| "echo.config.json".into());
        let source = match fs::read_to_string(&path) {
            Ok(source) => source,
            Err(e)
                if e.kind() == std::io::ErrorKind::NotFound
                    && std::env::var_os("ECHO_CONFIG_FILE").is_none() =>
            {
                include_str!("../../echo.config.json").to_owned()
            }
            Err(e) => panic!("Cannot read runtime configuration {}: {e}", path.display()),
        };
        let config: Config = serde_json::from_str(&source)
            .expect("echo.config.json contains invalid runtime settings");

        config
    })
}

/// Reject public interfaces before opening a listener, including wildcard IPs.
pub fn loopback_bind(raw: &str) -> Result<SocketAddr, ApiError> {
    let address: SocketAddr = raw.parse().map_err(|_| {
        ApiError::bad("The bind address must be a loopback IP and port, such as 127.0.0.1:3000.")
    })?;
    if !address.ip().is_loopback() {
        return Err(ApiError::bad(
            "Echo Voice supports loopback listeners only. Set bind to 127.0.0.1 or [::1].",
        ));
    }
    Ok(address)
}

/// Create private files atomically, with durable content before publishing the name.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), ApiError> {
    let parent = path
        .parent()
        .ok_or_else(|| ApiError::bad("Invalid private file path."))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        fs::File::open(parent)?.sync_all()?;
        Ok::<_, ApiError>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn listener_rejects_remote_and_wildcard_addresses() {
        for address in [
            "0.0.0.0:3000",
            "[::]:3000",
            "192.168.1.4:3000",
            "example.com:3000",
        ] {
            assert!(loopback_bind(address).is_err());
        }
        for address in ["127.0.0.1:3000", "[::1]:3000"] {
            assert!(loopback_bind(address).is_ok());
        }
    }
    #[test]
    fn legacy_runner_settings_are_accepted_and_ignored() {
        let mut value: serde_json::Value =
            serde_json::from_str(include_str!("../../echo.config.json")).unwrap();
        value["runner"] = serde_json::json!({"url":"obsolete", "anyOldField":true});
        assert!(serde_json::from_value::<Config>(value).is_ok());
        assert!(serde_json::from_str::<Config>(include_str!("../../echo.config.json")).is_ok());
    }
}
