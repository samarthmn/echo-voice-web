//! Local web-server paths. Temporary work stays beneath the project directory.
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
    pub runtime_dir: PathBuf,
}
impl RuntimePaths {
    pub fn resolve() -> Result<Self, PathError> {
        let resource_root = std::env::current_dir()?;
        let data_dir = std::env::var_os("ECHO_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| crate::config::get().data_dir.clone());
        Ok(Self {
            cache_dir: data_dir.join("models"),
            runtime_dir: resource_root.join("tmp"),
            resource_root,
            data_dir,
        })
    }
}
pub fn get() -> RuntimePaths {
    RuntimePaths::resolve().expect("Invalid Echo runtime paths")
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
