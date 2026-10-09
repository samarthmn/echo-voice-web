//! Installed resources are immutable; user data and transient files live separately.
use std::{
    fs,
    path::{Path, PathBuf},
};

pub type PathError = Box<dyn std::error::Error + Send + Sync>;
#[derive(Clone, Debug)]
pub struct RuntimePaths {
    pub resource_root: PathBuf,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub log_dir: PathBuf,
    pub runtime_dir: PathBuf,
}
pub fn installed() -> bool {
    std::env::var("ECHO_RUNTIME_MODE").as_deref() == Ok("installed")
}
fn absolute_env(name: &str, fallback: PathBuf) -> Result<PathBuf, PathError> {
    let path = std::env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or(fallback);
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("{name} must be an absolute path without parent traversal").into());
    }
    Ok(path)
}
pub fn installed_data_dir() -> Result<PathBuf, PathError> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("HOME is unavailable")?;
    let fallback = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Echo Voice")
    } else {
        absolute_env("XDG_DATA_HOME", home.join(".local/share"))?.join("echo-voice")
    };
    absolute_env("ECHO_DATA_DIR", fallback)
}
impl RuntimePaths {
    pub fn resolve() -> Result<Self, PathError> {
        if !installed() {
            let resource_root = std::env::current_dir()?;
            let data_dir = std::env::var_os("ECHO_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| crate::config::get().data_dir.clone());
            return Ok(Self {
                cache_dir: data_dir.join("models"),
                log_dir: data_dir.join("logs"),
                runtime_dir: resource_root.join("tmp"),
                resource_root,
                data_dir,
            });
        }
        let resource_root = absolute_env("ECHO_RESOURCE_DIR", PathBuf::new())?;
        if !resource_root.join("public/index.html").is_file() {
            return Err("Echo resources are missing. Reinstall the application.".into());
        }
        let data_dir = installed_data_dir()?;
        let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME is unavailable")?);
        let cache = if cfg!(target_os = "macos") {
            home.join("Library/Caches/Echo Voice")
        } else {
            absolute_env("XDG_CACHE_HOME", home.join(".cache"))?.join("echo-voice")
        };
        let state = if cfg!(target_os = "macos") {
            home.join("Library/Logs/Echo Voice")
        } else {
            absolute_env("XDG_STATE_HOME", home.join(".local/state"))?.join("echo-voice")
        };
        let paths = Self {
            resource_root,
            data_dir: data_dir.clone(),
            cache_dir: absolute_env("ECHO_CACHE_DIR", cache)?,
            log_dir: absolute_env("ECHO_LOG_DIR", state)?,
            runtime_dir: absolute_env("ECHO_RUNTIME_DIR", data_dir.join("runtime"))?,
        };
        for path in [
            &paths.data_dir,
            &paths.cache_dir,
            &paths.log_dir,
            &paths.runtime_dir,
        ] {
            if path.starts_with(&paths.resource_root) {
                return Err("Writable directories must be outside installed resources".into());
            }
        }
        Ok(paths)
    }
    pub fn prepare(&self) -> Result<(), PathError> {
        if installed() {
            for path in [
                &self.data_dir,
                &self.cache_dir,
                &self.log_dir,
                &self.runtime_dir,
            ] {
                private_directory(path)?;
            }
        }
        Ok(())
    }
}
pub fn get() -> RuntimePaths {
    RuntimePaths::resolve().expect("Invalid Echo runtime paths")
}
pub fn node_binary() -> PathBuf {
    if installed() {
        get().resource_root.join("bin/node")
    } else {
        PathBuf::from("node")
    }
}
pub fn private_directory(path: &Path) -> Result<(), PathError> {
    // Reject symlinks in every existing component, including an attacker-controlled parent.
    let mut current = PathBuf::new();
    for part in path.components() {
        current.push(part);
        if let Ok(metadata) = fs::symlink_metadata(&current) {
            if metadata.file_type().is_symlink() {
                return Err("Private directories cannot contain symbolic links".into());
            }
        }
    }
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if fs::metadata(path)?.uid() != unsafe { libc::geteuid() } {
            return Err("Private directory belongs to another account".into());
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
