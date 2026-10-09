//! Public loopback runtime settings. Legacy runner configuration is ignored.
use crate::security::ApiError;
use serde::Deserialize;
use std::{fs, net::SocketAddr, path::PathBuf, sync::OnceLock};

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
        let path = if crate::paths::installed() {
            crate::paths::installed_data_dir()
                .expect("Invalid installed data directory")
                .join("config.json")
        } else {
            std::env::var_os("ECHO_CONFIG_FILE")
                .map(PathBuf::from)
                .unwrap_or_else(|| "echo.config.json".into())
        };
        if crate::paths::installed() && path.exists() {
            let metadata = fs::symlink_metadata(&path).expect("Cannot inspect installed config");
            assert!(
                !metadata.file_type().is_symlink() && metadata.is_file(),
                "Installed config must be a regular private file"
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::{MetadataExt, PermissionsExt};
                assert!(
                    metadata.uid() == unsafe { libc::geteuid() }
                        && metadata.permissions().mode() & 0o077 == 0,
                    "Installed config must be owned by this account with mode 0600"
                );
            }
        }
        let source = match fs::read_to_string(&path) {
            Ok(source) => source,
            Err(e)
                if e.kind() == std::io::ErrorKind::NotFound
                    && (crate::paths::installed()
                        || std::env::var_os("ECHO_CONFIG_FILE").is_none()) =>
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
