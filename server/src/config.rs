//! Public runtime defaults are shared with the Python runner in echo.config.json.
//! Only Google OAuth credentials belong in .env; runner authentication is generated locally.
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
    pub runner: Runner,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Runner {
    pub url: String,
    // Applied by the Python runner; deserialize here to validate the shared schema.
    #[serde(rename = "headless")]
    pub _headless: bool,
    pub admission_timeout_seconds: u64,
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
        assert!(
            (1..=3600).contains(&config.runner.admission_timeout_seconds),
            "Runner admission timeout must be 1–3600 seconds"
        );
        let runner = url::Url::parse(&config.runner.url).expect("Invalid runner URL");
        assert!(
            runner.scheme() == "http"
                && runner.host_str() == Some("127.0.0.1")
                && runner.username().is_empty()
                && runner.password().is_none()
                && matches!(runner.path(), "" | "/")
                && runner.query().is_none()
                && runner.fragment().is_none(),
            "Runner URL must be http://127.0.0.1:<port>"
        );
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

/// Both processes use this per-library secret; a checked-in shared secret would be unsafe.
pub fn runner_token(data: &Path) -> Result<String, ApiError> {
    let folder = data.join("credentials");
    fs::create_dir_all(&folder)?;
    if fs::symlink_metadata(&folder)?.file_type().is_symlink() {
        return Err(ApiError::bad(
            "The credentials folder must not be a symbolic link.",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o700))?;
    }
    let path = folder.join("runner-token");
    let lock_path = folder.join("runner-token.lock");
    for file in [&path, &lock_path] {
        if fs::symlink_metadata(file).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(ApiError::bad(
                "Runner credentials must not be symbolic links.",
            ));
        }
    }
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options.open(lock_path)?;
    fs2::FileExt::lock_exclusive(&lock)?;
    let token = match fs::read_to_string(&path) {
        Ok(token) => token,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let token = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            write_private(&path, token.as_bytes())?;
            token
        }
        Err(e) => return Err(e.into()),
    };
    if token.len() < 32
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(ApiError::new(500, "The generated runner credential is invalid. Stop both processes and remove credentials/runner-token to regenerate it."));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(token)
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
    fn generated_token_is_private_and_stable() {
        let dir = tempfile::tempdir().unwrap();
        let token = runner_token(dir.path()).unwrap();
        assert_eq!(token.len(), 64);
        assert_eq!(runner_token(dir.path()).unwrap(), token);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.path().join("credentials/runner-token"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
