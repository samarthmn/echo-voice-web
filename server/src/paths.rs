//! Local web-server paths. Temporary work stays beneath the project directory.
use std::{
    fs,
    path::{Path, PathBuf},
};
pub(crate) type PathError = Box<dyn std::error::Error + Send + Sync>;
#[derive(Clone, Debug)]
pub(crate) struct RuntimePaths {
    pub resource_root: PathBuf,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub runtime_dir: PathBuf,
}
pub(crate) fn resource_root() -> Result<PathBuf, PathError> {
    if let Some(root) = std::env::var_os("ECHO_RESOURCE_ROOT") {
        return Ok(fs::canonicalize(PathBuf::from(root))?);
    }
    let executable = fs::canonicalize(std::env::current_exe()?)?;
    if let Some(root) = executable
        .ancestors()
        .find(|path| path.join("public/index.html").is_file())
    {
        return Ok(root.to_path_buf());
    }
    let fallback = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    if fallback.join("public/index.html").is_file() {
        return Ok(fs::canonicalize(fallback)?);
    }
    Err(
        "Cannot find Echo's public/ folder; run from the repository or set ECHO_RESOURCE_ROOT"
            .into(),
    )
}
impl RuntimePaths {
    #[cfg(test)]
    pub(crate) fn resolve() -> Result<Self, PathError> {
        Ok(Self::resolve_at(resource_root()?))
    }
    pub(crate) fn resolve_at(resource_root: PathBuf) -> Self {
        let data_dir = std::env::var_os("ECHO_DATA_DIR")
            .map_or_else(|| crate::config::get().data_dir.clone(), PathBuf::from);
        let data_dir = if data_dir.is_absolute() {
            data_dir
        } else {
            resource_root.join(data_dir)
        };
        Self {
            cache_dir: data_dir.join("models"),
            runtime_dir: resource_root.join("tmp"),
            resource_root,
            data_dir,
        }
    }
}
#[cfg(not(test))]
static PATHS: std::sync::OnceLock<RuntimePaths> = std::sync::OnceLock::new();
#[cfg(test)]
static TEST_PATHS: std::sync::Mutex<Option<RuntimePaths>> = std::sync::Mutex::new(None);
pub(crate) fn init(paths: RuntimePaths) {
    #[cfg(not(test))]
    {
        let _ = PATHS.set(paths);
    }
    #[cfg(test)]
    {
        *TEST_PATHS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(paths);
    }
}
pub(crate) fn get() -> Result<RuntimePaths, crate::security::ApiError> {
    #[cfg(not(test))]
    {
        PATHS.get().cloned().ok_or_else(|| {
            crate::security::ApiError::new(500, "Echo runtime paths are not initialized.")
        })
    }
    #[cfg(test)]
    {
        TEST_PATHS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .ok_or_else(|| {
                crate::security::ApiError::new(500, "Echo runtime paths are not initialized.")
            })
    }
}
pub(crate) fn private_directory(path: &Path) -> Result<(), PathError> {
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
        #[allow(
            unsafe_code,
            reason = "Read the effective user ID to check private directory ownership."
        )]
        // SAFETY: geteuid takes no arguments, has no preconditions, and only reads the effective user ID.
        let effective_uid = unsafe { libc::geteuid() };
        if fs::metadata(path)?.uid() != effective_uid {
            return Err("Private directory belongs to another account".into());
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_public_root_from_executable() {
        let root = super::resource_root().unwrap();
        assert!(root.is_absolute());
        assert!(root.join("public/index.html").is_file());
    }
}
