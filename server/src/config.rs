//! Public loopback runtime settings. Unknown configuration keys are warned about and ignored.
use crate::security::ApiError;
use serde::Deserialize;
use std::{fs, net::SocketAddr, path::PathBuf, sync::OnceLock};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub bind: String,
    pub data_dir: PathBuf,
    #[serde(default)]
    pub google_redirect_uri: Option<String>,
    #[serde(flatten)]
    unknown: std::collections::BTreeMap<String, serde::de::IgnoredAny>,
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
    let config = parse_config(&path, &source)?;
    let _ = CONFIG.set(config);
    Ok(())
}

fn parse_config(path: &std::path::Path, source: &str) -> Result<Config, String> {
    let config: Config = serde_json::from_str(source)
        .map_err(|error| format!("Invalid runtime configuration {}: {error}", path.display()))?;
    for key in config.unknown.keys() {
        tracing::warn!(%key, path = %path.display(), "Unknown runtime configuration key ignored");
    }
    Ok(config)
}

pub fn get() -> &'static Config {
    CONFIG.get_or_init(|| Config {
        bind: "127.0.0.1:3000".into(),
        data_dir: ".echo-data".into(),
        google_redirect_uri: None,
        unknown: Default::default(),
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
        let error = parse_config(std::path::Path::new("bad-config.json"), "{")
            .err()
            .unwrap();
        assert!(error.contains("bad-config.json"));
        assert!(error.contains("EOF"));
    }
    #[test]
    fn unknown_config_keys_warn_and_are_ignored() {
        use std::io::Write;
        #[derive(Clone)]
        struct Log(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl Write for Log {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let log = Log(Default::default());
        let writer = log.clone();
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);
        let config = parse_config(std::path::Path::new("old-config.json"),
            r#"{"bind":"127.0.0.1:3000","dataDir":"library","retiredBinary":{"any":"value"},"runner":true}"#,
        ).unwrap();
        assert_eq!(config.bind, "127.0.0.1:3000");
        assert_eq!(config.data_dir, PathBuf::from("library"));
        let output = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
        for key in ["retiredBinary", "runner"] {
            assert!(output.contains(key));
        }
        assert!(output.contains("WARN"));
        assert!(output.contains("Unknown runtime configuration key ignored"));
        assert!(output.contains("old-config.json"));
        assert!(!output.contains("any"));
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
