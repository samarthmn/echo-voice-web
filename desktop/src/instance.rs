use crate::protocol::{Bootstrap, Request, Status, MAX_MESSAGE};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
    time::Duration,
};
pub fn private_directory(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        if fs::symlink_metadata(&current).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("Echo's private folders cannot be symbolic links.".into());
        }
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    if fs::metadata(path).map_err(|e| e.to_string())?.uid() != unsafe { libc::geteuid() } {
        return Err("This data folder belongs to another account.".into());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
}
pub fn private_file(path: &Path) -> Result<File, String> {
    if fs::symlink_metadata(path)
        .is_ok_and(|m| m.file_type().is_symlink() || m.uid() != unsafe { libc::geteuid() })
    {
        return Err("Unsafe private runtime file.".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    Ok(file)
}
pub struct Instance {
    pub auth: Bootstrap,
    pub directory: PathBuf,
    _lock: Option<File>,
}
impl Instance {
    pub fn acquire(directory: &Path) -> Result<(Self, bool), String> {
        private_directory(directory)?;
        let lock = private_file(&directory.join("launcher.lock"))?;
        if fs2::FileExt::try_lock_exclusive(&lock).is_err() {
            let mut file = private_file(&directory.join("instance.json"))?;
            let mut bytes = Vec::new();
            (&mut file)
                .take(MAX_MESSAGE as u64)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            let auth = serde_json::from_slice(&bytes)
                .map_err(|_| "Echo is already starting. Retry shortly.".to_owned())?;
            return Ok((
                Self {
                    auth,
                    directory: directory.into(),
                    _lock: None,
                },
                false,
            ));
        }
        let auth = Bootstrap {
            instance_id: uuid::Uuid::new_v4().to_string(),
            secret: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
        };
        let mut file = private_file(&directory.join("instance.json"))?;
        file.set_len(0).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(&auth).unwrap())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok((
            Self {
                auth,
                directory: directory.into(),
                _lock: Some(lock),
            },
            true,
        ))
    }
    pub fn request(&self, action: &str, force: bool) -> Result<Status, String> {
        let mut stream = UnixStream::connect(self.directory.join("s")).map_err(|_| {
            "Echo's verified runtime is unavailable. Retry to restart it.".to_owned()
        })?;
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .map_err(|e| e.to_string())?;
        let request = Request::new(&self.auth, action, force);
        stream
            .write_all(format!("{}\n", serde_json::to_string(&request).unwrap()).as_bytes())
            .map_err(|e| e.to_string())?;
        let mut line = String::new();
        BufReader::new(stream)
            .take(MAX_MESSAGE as u64)
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        let status: Status = serde_json::from_str(&line)
            .map_err(|_| "Echo's runtime returned an invalid response.".to_owned())?;
        if !status.authentic(&self.auth, &request) {
            return Err(
                "Echo could not authenticate this runtime. It will not be opened or stopped."
                    .into(),
            );
        }
        Ok(status)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn directory() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("tmp");
        fs::create_dir_all(&root).unwrap();
        tempfile::Builder::new()
            .prefix("di-")
            .tempdir_in(root)
            .unwrap()
    }
    #[test]
    fn second_launcher_cannot_claim_the_owner_lock() {
        let dir = directory();
        let (owner, first) = Instance::acquire(dir.path()).unwrap();
        let (second, fresh) = Instance::acquire(dir.path()).unwrap();
        assert!(first);
        assert!(!fresh);
        assert_eq!(owner.auth.instance_id, second.auth.instance_id);
    }
    #[test]
    fn forged_control_response_is_rejected() {
        let dir = directory();
        let (instance, _) = Instance::acquire(dir.path()).unwrap();
        let listener = std::os::unix::net::UnixListener::bind(dir.path().join("s")).unwrap();
        let task = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut request)
                .unwrap();
            let request: Request = serde_json::from_str(&request).unwrap();
            writeln!(stream,"{}",serde_json::json!({"version":1,"instanceId":request.instance_id,"nonce":request.nonce,"workspaceUrl":"http://evil.invalid","activeRequests":0,"activeProcessing":0,"shuttingDown":false,"mac":"0".repeat(64)})).unwrap();
        });
        assert!(instance
            .request("status", false)
            .err()
            .unwrap()
            .contains("authenticate"));
        task.join().unwrap();
    }
}
