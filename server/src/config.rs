//! Public loopback runtime settings. Legacy runner configuration is ignored.
use crate::security::ApiError;
use serde::Deserialize;
use std::{fs, net::SocketAddr, path::PathBuf, sync::OnceLock};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub bind: String,
    pub data_dir: PathBuf,
    #[serde(default)]
    pub google_redirect_uri: Option<String>,
    pub codex_binary: Option<PathBuf>,
    #[serde(default, rename = "runner")]
    _retired_runner: Option<serde::de::IgnoredAny>,
}
static CONFIG: OnceLock<Config> = OnceLock::new();

/// Load settings before serving so malformed configuration is reported as an error.
pub fn init(root: &std::path::Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let override_path = std::env::var_os("ECHO_CONFIG_FILE");
    let path = override_path
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("echo.config.json"));
    let path = if path.is_absolute() {
        path
    } else {
        root.join(path)
    };
    let source = match fs::read_to_string(&path) {
        Ok(source) => source,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && override_path.is_none() => {
            include_str!("../../echo.config.json").to_owned()
        }
        Err(e) => {
            return Err(format!("Cannot read runtime configuration {}: {e}", path.display()).into())
        }
    };
    let config = parse_config(root, &path, &source)?;
    let _ = CONFIG.set(config);
    Ok(())
}

fn parse_config(
    root: &std::path::Path,
    path: &std::path::Path,
    source: &str,
) -> Result<Config, String> {
    let mut config: Config = serde_json::from_str(source)
        .map_err(|error| format!("Invalid runtime configuration {}: {error}", path.display()))?;
    if let Some(binary) = config.codex_binary.as_mut() {
        if binary.is_relative() {
            *binary = root.join(&*binary);
        }
    }
    Ok(config)
}

pub fn get() -> &'static Config {
    CONFIG.get_or_init(|| Config {
        bind: "127.0.0.1:3000".into(),
        data_dir: ".echo-data".into(),
        google_redirect_uri: None,
        codex_binary: None,
        _retired_runner: None,
    })
}

pub fn redirect_uri() -> String {
    get().google_redirect_uri.clone().unwrap_or_else(|| {
        let raw = std::env::var("ECHO_BIND").unwrap_or_else(|_| get().bind.clone());
        let port = loopback_bind(&raw)
            .map(|address| address.port())
            .unwrap_or(3000);
        format!("http://localhost:{port}/api/integrations/google/callback")
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
    fn malformed_config_reports_file_and_parser_error() {
        let error = parse_config(
            std::path::Path::new("/project"),
            std::path::Path::new("bad-config.json"),
            "{",
        )
        .err()
        .unwrap();
        assert!(error.contains("bad-config.json"));
        assert!(error.contains("EOF"));
    }
    #[test]
    fn accepts_only_the_retired_runner_field() {
        let mut value: serde_json::Value =
            serde_json::from_str(include_str!("../../echo.config.json")).unwrap();
        value["runner"] = serde_json::json!({"arbitrary": [true, "old"]});
        let parse = |value: &serde_json::Value| {
            parse_config(
                std::path::Path::new("/project"),
                std::path::Path::new("config.json"),
                &value.to_string(),
            )
        };
        assert!(parse(&value).is_ok());
        value["unexpected"] = serde_json::json!(true);
        assert!(parse(&value).is_err());
    }
    #[test]
    fn relative_codex_binary_resolves_from_resource_root() {
        let root = std::path::Path::new("/project");
        let mut value: serde_json::Value =
            serde_json::from_str(include_str!("../../echo.config.json")).unwrap();
        value["codexBinary"] = serde_json::json!("tools/codex");
        let config =
            parse_config(root, &root.join("echo.config.json"), &value.to_string()).unwrap();
        assert_eq!(config.codex_binary.unwrap(), root.join("tools/codex"));
        value["codexBinary"] = serde_json::json!("/opt/codex");
        let config =
            parse_config(root, &root.join("echo.config.json"), &value.to_string()).unwrap();
        assert_eq!(
            config.codex_binary.unwrap(),
            std::path::Path::new("/opt/codex")
        );
    }
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
}
