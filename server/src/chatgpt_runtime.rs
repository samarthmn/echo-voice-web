//! A protected filesystem for the unmodified official helper's SQLite/logs.
//! macOS uses a native encrypted image; Linux requires a private tmpfs runtime.
//! Neither platform falls back to an ordinary plaintext directory.
use crate::{security::ApiError, store};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncWriteExt, process::Command, time::timeout};
use zeroize::Zeroizing;

fn unavailable() -> ApiError {
    ApiError::new(503, "ChatGPT needs protected temporary storage. On macOS, allow Echo to attach its encrypted helper disk image; on Linux, sign in to a desktop session with a private memory-backed XDG_RUNTIME_DIR. Retry the connection. Local recording and saved notes remain available.")
}
fn private(path: &Path) -> Result<(), ApiError> {
    crate::paths::private_directory(path).map_err(|_| unavailable())
}
pub(super) fn fixture_runtime() -> bool {
    cfg!(debug_assertions)
        && std::env::var("ECHO_TEST_MODE").as_deref() == Ok("1")
        && std::env::var_os("ECHO_TEST_STORAGE_KEY").is_some()
        && std::env::var("ECHO_TEST_CHATGPT_RUNTIME").as_deref() == Ok("fixture")
}
pub(super) struct ProtectedHome {
    pub home: PathBuf,
    #[cfg(target_os = "macos")]
    image: Option<PathBuf>,
    owned_root: Option<PathBuf>,
}
impl ProtectedHome {
    pub async fn prepare(root: &Path) -> Result<Self, ApiError> {
        if fixture_runtime() {
            let home = root.join("chatgpt");
            private(&home)?;
            return Ok(Self {
                home,
                #[cfg(target_os = "macos")]
                image: None,
                owned_root: None,
            });
        }
        #[cfg(target_os = "macos")]
        {
            use hkdf::Hkdf;
            use sha2::Sha256;
            let image = root.join("chatgpt-runtime.sparseimage");
            let mounted = root.join("chatgpt-runtime");
            private(&mounted)?;
            let secret = store::with_key(|key| {
                let mut bytes = Zeroizing::new([0; 32]);
                Hkdf::<Sha256>::new(None, key.bytes())
                    .expand(b"Echo ChatGPT encrypted runtime v1", bytes.as_mut())
                    .map_err(|_| std::io::Error::other("Cannot derive helper storage key."))?;
                let mut password = Zeroizing::new(
                    bytes
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>()
                        .into_bytes(),
                );
                password.push(0);
                Ok(password)
            })?;
            // Recover only a mount that native image metadata maps to this exact
            // managed encrypted image. Device names alone are never authority.
            detach_owned(&image, &mounted).await?;
            if std::fs::read_dir(&mounted)?.next().is_some() {
                return Err(unavailable());
            }
            if image.exists() {
                let metadata = std::fs::symlink_metadata(&image)?;
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(unavailable());
                }
                if plist(&["isencrypted", "-plist", utf8(&image)?], None).await?["encrypted"]
                    != true
                {
                    return Err(unavailable());
                }
            } else {
                let pending = root.join(format!(
                    ".chatgpt-runtime-{}.sparseimage",
                    uuid::Uuid::new_v4()
                ));
                let created = command(
                    &[
                        "create",
                        "-size",
                        "128m",
                        "-fs",
                        "HFS+",
                        "-volname",
                        "Echo Private Helper",
                        "-type",
                        "SPARSE",
                        "-encryption",
                        "AES-256",
                        "-stdinpass",
                        "-nospotlight",
                        utf8(&pending)?,
                    ],
                    Some(&secret),
                )
                .await;
                if created.is_err() {
                    let _ = std::fs::remove_file(&pending);
                    return Err(unavailable());
                }
                if plist(&["isencrypted", "-plist", utf8(&pending)?], None).await?["encrypted"]
                    != true
                {
                    let _ = std::fs::remove_file(&pending);
                    return Err(unavailable());
                }
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&pending, std::fs::Permissions::from_mode(0o600))?;
                std::fs::rename(&pending, &image)?;
            }
            let attached = plist(
                &[
                    "attach",
                    "-plist",
                    "-stdinpass",
                    "-nobrowse",
                    "-mountpoint",
                    utf8(&mounted)?,
                    utf8(&image)?,
                ],
                Some(&secret),
            )
            .await;
            if attached.is_err()
                || owned_mount(&plist(&["info", "-plist"], None).await?, &image, &mounted)?
                    .is_none()
            {
                let _ = detach_owned(&image, &mounted).await;
                return Err(unavailable());
            }
            let result = (|| {
                let home = mounted.join("codex");
                // Threads are ephemeral. Discard previous runtime logs while the
                // volume remains encrypted, bounding growth across launches.
                if home.exists() {
                    std::fs::remove_dir_all(&home)?;
                }
                private(&home)?;
                Ok(Self {
                    home,
                    image: Some(image.clone()),
                    owned_root: Some(mounted.clone()),
                })
            })();
            if result.is_err() {
                let _ = detach_owned(&image, &mounted).await;
            }
            result
        }
        #[cfg(target_os = "linux")]
        {
            use sha2::{Digest, Sha256};
            use std::{
                ffi::CString,
                os::unix::{
                    ffi::OsStrExt,
                    fs::{MetadataExt, PermissionsExt},
                },
            };
            let parent =
                PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").ok_or_else(unavailable)?);
            let metadata = std::fs::symlink_metadata(&parent)?;
            if !parent.is_absolute()
                || !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.permissions().mode() & 0o077 != 0
            {
                return Err(unavailable());
            }
            let name = CString::new(parent.as_os_str().as_bytes()).map_err(|_| unavailable())?;
            let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
            if unsafe { libc::statfs(name.as_ptr(), filesystem.as_mut_ptr()) } != 0
                || unsafe { filesystem.assume_init() }.f_type != libc::TMPFS_MAGIC
            {
                return Err(unavailable());
            }
            let identity = format!("{:x}", Sha256::digest(root.as_os_str().as_encoded_bytes()));
            let owned = parent.join(format!("echo-chatgpt-{identity}"));
            private(&owned)?;
            let home = owned.join("codex");
            if home.exists() {
                std::fs::remove_dir_all(&home)?;
            }
            private(&home)?;
            Ok(Self {
                home,
                owned_root: Some(owned),
            })
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = root;
            Err(unavailable())
        }
    }
    pub async fn close(&self) -> Result<(), ApiError> {
        #[cfg(target_os = "macos")]
        if let (Some(image), Some(mounted)) = (&self.image, &self.owned_root) {
            return detach_owned(image, mounted).await;
        }
        #[cfg(target_os = "linux")]
        if let Some(root) = &self.owned_root {
            std::fs::remove_dir_all(root)?;
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn utf8(path: &Path) -> Result<&str, ApiError> {
    path.to_str().ok_or_else(unavailable)
}
#[cfg(target_os = "macos")]
async fn command(args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>, ApiError> {
    let mut child = Command::new("/usr/bin/hdiutil")
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("TMPDIR", crate::paths::get().runtime_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| unavailable())?;
    let mut stdin = child.stdin.take().ok_or_else(unavailable)?;
    if let Some(input) = input {
        stdin.write_all(input).await.map_err(|_| unavailable())?;
    }
    drop(stdin);
    let output = timeout(Duration::from_secs(45), child.wait_with_output())
        .await
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())?;
    if !output.status.success() || output.stdout.len() > 1024 * 1024 {
        return Err(unavailable());
    }
    Ok(output.stdout)
}
#[cfg(target_os = "macos")]
async fn plist(args: &[&str], input: Option<&[u8]>) -> Result<Value, ApiError> {
    let bytes = command(args, input).await?;
    let mut child = Command::new("/usr/bin/plutil")
        .env_clear()
        .args(["-convert", "json", "-o", "-", "-"])
        .env("TMPDIR", crate::paths::get().runtime_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| unavailable())?;
    child
        .stdin
        .take()
        .ok_or_else(unavailable)?
        .write_all(&bytes)
        .await
        .map_err(|_| unavailable())?;
    let output = timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())?;
    if !output.status.success() {
        return Err(unavailable());
    }
    serde_json::from_slice(&output.stdout).map_err(|_| unavailable())
}
#[cfg(target_os = "macos")]
fn owned_mount(info: &Value, image: &Path, mounted: &Path) -> Result<Option<String>, ApiError> {
    let mut matched = None;
    for item in info["images"].as_array().ok_or_else(unavailable)? {
        for entity in item["system-entities"].as_array().ok_or_else(unavailable)? {
            if entity["mount-point"].as_str() != mounted.to_str() {
                continue;
            }
            if item["image-path"].as_str() != image.to_str() || matched.is_some() {
                return Err(unavailable());
            }
            let device = entity["dev-entry"]
                .as_str()
                .filter(|v| {
                    v.starts_with("/dev/disk")
                        && v[9..].bytes().all(|b| b.is_ascii_digit() || b == b's')
                })
                .ok_or_else(unavailable)?;
            matched = Some(device.to_owned());
        }
    }
    Ok(matched)
}
#[cfg(target_os = "macos")]
async fn detach_owned(image: &Path, mounted: &Path) -> Result<(), ApiError> {
    if let Some(device) = owned_mount(&plist(&["info", "-plist"], None).await?, image, mounted)? {
        command(&["detach", &device], None).await?;
    }
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn detach_requires_exact_native_image_and_mount_ownership() {
        let image = Path::new("/private/library/helper.sparseimage");
        let mounted = Path::new("/private/library/mount");
        let info = json!({"images":[{"image-path":image,"system-entities":[{"dev-entry":"/dev/disk23s1","mount-point":mounted}]}]});
        assert_eq!(
            owned_mount(&info, image, mounted).unwrap().as_deref(),
            Some("/dev/disk23s1")
        );
        assert!(owned_mount(&info, Path::new("/other/image"), mounted).is_err());
        assert_eq!(
            owned_mount(&info, image, Path::new("/other/mount")).unwrap(),
            None
        );
        let mut reused = info.clone();
        reused["images"][0]["image-path"] = json!("/another/image");
        assert!(owned_mount(&reused, image, mounted).is_err());
    }
    #[tokio::test]
    #[ignore = "Requires native macOS DiskImages access; creates only an isolated encrypted test volume"]
    async fn native_encrypted_runtime_mounts_and_closes_with_owned_cleanup() {
        let _guard = store::TEST_LIBRARY_LOCK.lock().await;
        let directory = store::test_directory();
        store::reset_for_tests();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        store::test_key();
        std::env::remove_var("ECHO_TEST_CHATGPT_RUNTIME");
        store::init().unwrap();
        let protected = ProtectedHome::prepare(directory.path()).await.unwrap();
        let outcome = std::fs::write(
            protected.home.join("synthetic-transcript"),
            b"synthetic protected helper content",
        )
        .and_then(|_| std::fs::read(protected.home.join("synthetic-transcript")));
        let closed = protected.close().await;
        assert_eq!(outcome.unwrap(), b"synthetic protected helper content");
        closed.unwrap();
        assert!(!protected.home.exists());
        let image = directory.path().join("chatgpt-runtime.sparseimage");
        assert_eq!(
            plist(&["isencrypted", "-plist", utf8(&image).unwrap()], None)
                .await
                .unwrap()["encrypted"],
            true
        );
        let again = ProtectedHome::prepare(directory.path()).await.unwrap();
        assert!(!again.home.join("synthetic-transcript").exists());
        again.close().await.unwrap();
        store::reset_for_tests();
    }
}
