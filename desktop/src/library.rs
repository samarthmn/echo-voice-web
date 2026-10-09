//! Library selection is committed only after a separate copy passes server validation.
use crate::{
    instance::{private_directory, private_file},
    runtime::LaunchPaths,
};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

fn checked(path: &Path) -> Result<fs::Metadata, String> {
    let mut current = PathBuf::new();
    for part in path.components() {
        current.push(part);
        if fs::symlink_metadata(&current).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("Library folders and files cannot be symbolic links.".into());
        }
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "The library file is unavailable.".to_owned())?;
    if metadata.uid() != unsafe { libc::geteuid() } || !(metadata.is_file() || metadata.is_dir()) {
        return Err(
            "Choose a library owned by your account, containing only regular files.".into(),
        );
    }
    Ok(metadata)
}
pub fn selected(base: &Path) -> Result<PathBuf, String> {
    let preference = base.join("library.json");
    if !preference.exists() {
        return Ok(base.into());
    }
    let metadata = checked(&preference)?;
    if !metadata.is_file() || metadata.len() > 1024 {
        return Err("Echo's library selection is invalid.".into());
    }
    let id: String = serde_json::from_reader(File::open(preference).map_err(|e| e.to_string())?)
        .map_err(|_| "Echo's library selection is invalid.".to_owned())?;
    if id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Echo's library selection is invalid.".into());
    }
    let path = base.join("libraries").join(id);
    if !checked(&path)?.is_dir() || !checked(&path.join("workspace.sqlite"))?.is_file() {
        return Err(
            "The selected library is unavailable. Restore its folder before starting Echo.".into(),
        );
    }
    Ok(path)
}
fn select(base: &Path, path: &Path) -> Result<(), String> {
    if path.parent() != Some(base.join("libraries").as_path()) {
        return Err("The selected library must be inside Echo's library folder.".into());
    }
    let id = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Invalid library name.")?;
    if id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid library name.".into());
    }
    checked(path)?;
    let temporary = base.join(format!(".library-{}.json", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut file = private_file(&temporary)?;
        file.write_all(&serde_json::to_vec(id).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temporary, base.join("library.json")).map_err(|e| e.to_string())?;
        // Once rename succeeds the selection is authoritative, even if a later fsync fails.
        let _ = File::open(base).and_then(|f| f.sync_all());
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}
fn copy_regular(source: &Path, target: &Path) -> Result<(), String> {
    let before = checked(source)?;
    if before.is_dir() {
        fs::create_dir(target).map_err(|e| e.to_string())?;
        fs::set_permissions(target, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_regular(&entry.path(), &target.join(entry.file_name()))?;
        }
        File::open(target)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())?;
    } else {
        let mut input = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(source)
            .map_err(|e| e.to_string())?;
        let opened = input.metadata().map_err(|e| e.to_string())?;
        if opened.dev() != before.dev() || opened.ino() != before.ino() || opened.nlink() != 1 {
            return Err("The library changed or contains linked files. Close the old application and retry.".into());
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(target)
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        let after = input.metadata().map_err(|e| e.to_string())?;
        if after.len() != before.len()
            || after.mtime() != before.mtime()
            || after.mtime_nsec() != before.mtime_nsec()
        {
            return Err(
                "The source library changed while copying. Close the old application and retry."
                    .into(),
            );
        }
    }
    Ok(())
}
fn source_lock(source: &Path) -> Result<File, String> {
    if !checked(source)?.is_dir() || !checked(&source.join("workspace.sqlite"))?.is_file() {
        return Err("Choose the Echo data folder containing workspace.sqlite.".into());
    }
    let lock = source.join("workspace.lock");
    if lock.exists() {
        checked(&lock)?;
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(lock)
        .map_err(|_| "Echo cannot lock this source folder. Check its permissions.".to_owned())?;
    fs2::FileExt::try_lock_exclusive(&file).map_err(|_| {
        "This library is open in another Echo process. Close it before copying.".to_owned()
    })?;
    for name in ["bot-starts", "assistant-starts"] {
        let folder = source.join(name);
        if folder.exists() {
            checked(&folder)?;
            if fs::read_dir(folder)
                .map_err(|e| e.to_string())?
                .next()
                .is_some()
            {
                return Err("Stop the old meeting helper before copying this library. Its active markers were preserved.".into());
            }
        }
    }
    if source.join(".workspace-encrypted.sqlite").exists() {
        return Err("Finish the source library's interrupted migration before copying it.".into());
    }
    Ok(file)
}
fn copy_legacy(source: &Path, target: &Path) -> Result<(), String> {
    let bot = source.join("bot");
    if !bot.exists() {
        return Ok(());
    }
    checked(&bot)?;
    private_directory(&target.join("bot"))?;
    for entry in fs::read_dir(bot).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let folder = entry.path();
        if !checked(&folder)?.is_dir() {
            continue;
        }
        let session = folder.join("session.json");
        if !session.exists() {
            continue;
        } // Private profiles and other helper state are never imported.
        if checked(&session)?.len() > 1024 * 1024 {
            return Err("An old recording session is invalid.".into());
        }
        let mut prefix = [0; 8];
        let encrypted = File::open(&session)
            .map_err(|e| e.to_string())?
            .read_exact(&mut prefix)
            .is_ok()
            && &prefix == b"ECHOENC1";
        if !encrypted {
            let value: serde_json::Value =
                serde_json::from_reader(File::open(&session).map_err(|e| e.to_string())?)
                    .map_err(|_| "An old recording session is invalid.".to_owned())?;
            if !matches!(
                value["status"].as_str(),
                Some("completed" | "failed" | "interrupted")
            ) {
                return Err("Stop the old meeting helper before copying this library. Its recording remains unchanged.".into());
            }
        }
        // The server authenticates encrypted session state before this copy can be selected.
        let destination = target.join("bot").join(entry.file_name());
        private_directory(&destination)?;
        for name in ["session.json", "meeting.wav"] {
            if folder.join(name).exists() {
                copy_regular(&folder.join(name), &destination.join(name))?;
            }
        }
    }
    Ok(())
}
fn require_encrypted_file(path: &Path) -> Result<(), String> {
    if !checked(path)?.is_file() {
        return Err("An update backup contains an invalid protected file.".into());
    }
    let mut prefix = [0; 8];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut prefix))
        .map_err(|_| "Finish protected-storage migration before updating Echo.".to_owned())?;
    if &prefix != b"ECHOENC1" {
        return Err("Finish protected-storage migration before updating Echo. An unprotected file will not be copied into an update backup.".into());
    }
    Ok(())
}
fn require_encrypted_tree(path: &Path) -> Result<(), String> {
    if checked(path)?.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            require_encrypted_tree(&entry.map_err(|e| e.to_string())?.path())?;
        }
    } else {
        require_encrypted_file(path)?;
    }
    Ok(())
}
fn require_protected_source(source: &Path) -> Result<(), String> {
    let mut prefix = [0; 16];
    File::open(source.join("workspace.sqlite"))
        .and_then(|mut file| file.read_exact(&mut prefix))
        .map_err(|_| "The encrypted library is unavailable; the update was stopped.".to_owned())?;
    if &prefix == b"SQLite format 3\0" {
        return Err("Finish library encryption before updating Echo. No plaintext update backup was created.".into());
    }
    let protection = source.join("protection.json");
    if !checked(&protection)?.is_file() || checked(&protection)?.len() > 4096 {
        return Err("The library key reference is invalid; the update was stopped.".into());
    }
    let value: serde_json::Value =
        serde_json::from_reader(File::open(protection).map_err(|e| e.to_string())?)
            .map_err(|_| "The library key reference is invalid.".to_owned())?;
    if value["version"].as_u64() != Some(1)
        || value["key_id"]
            .as_str()
            .is_none_or(|id| uuid::Uuid::parse_str(id).is_err())
    {
        return Err("The library key reference is invalid; the update was stopped.".into());
    }
    for name in ["audio", "extension-pcm", "credentials", "chatgpt/auth.json"] {
        let file = source.join(name);
        if fs::symlink_metadata(&file).is_ok() {
            require_encrypted_tree(&file)?;
        }
    }
    let bot = source.join("bot");
    if bot.exists() {
        checked(&bot)?;
        for entry in fs::read_dir(bot).map_err(|e| e.to_string())? {
            let folder = entry.map_err(|e| e.to_string())?.path();
            if !checked(&folder)?.is_dir() {
                continue;
            }
            for name in ["session.json", "meeting.wav"] {
                let file = folder.join(name);
                if fs::symlink_metadata(&file).is_ok() {
                    require_encrypted_file(&file)?;
                }
            }
        }
    }
    Ok(())
}
fn copy_library_files(source: &Path, destination: &Path) -> Result<(), String> {
    for name in [
        "workspace.sqlite",
        "workspace.sqlite-wal",
        "workspace.sqlite-shm",
        "audio",
        "extension-pcm",
        "credentials",
        "protection.json",
        "recovery.json",
    ] {
        let from = source.join(name);
        if fs::symlink_metadata(&from).is_ok() {
            copy_regular(&from, &destination.join(name))?;
        }
    }
    let chatgpt = source.join("chatgpt");
    if chatgpt.exists() {
        if !checked(&chatgpt)?.is_dir() {
            return Err("The ChatGPT credential folder is invalid.".into());
        }
        let auth = chatgpt.join("auth.json");
        if fs::symlink_metadata(&auth).is_ok() {
            private_directory(&destination.join("chatgpt"))?;
            copy_regular(&auth, &destination.join("chatgpt/auth.json"))?;
        }
    }
    copy_legacy(source, destination)
}
fn sync_copy_tree(path: &Path) -> Result<(), String> {
    if checked(path)?.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            sync_copy_tree(&entry.map_err(|e| e.to_string())?.path())?;
        }
    }
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())
}

/// Kept alive until application replacement finishes, preventing another server
/// from changing the source after the verified pre-update snapshot is committed.
pub struct UpdateSnapshot {
    pub path: PathBuf,
    _source_lock: File,
}
pub fn snapshot_for_update(
    paths: &LaunchPaths,
    next_version: &str,
) -> Result<UpdateSnapshot, String> {
    snapshot_with(paths, next_version, |copy| maintenance(copy, None))
}
fn snapshot_with(
    paths: &LaunchPaths,
    next_version: &str,
    validate: impl FnOnce(&LaunchPaths) -> Result<(), String>,
) -> Result<UpdateSnapshot, String> {
    semver::Version::parse(next_version.trim_start_matches('v'))
        .map_err(|_| "The update version is invalid.".to_owned())?;
    let source_lock = source_lock(&paths.data)?;
    require_protected_source(&paths.data)?;
    let source = fs::canonicalize(&paths.data).map_err(|e| e.to_string())?;
    let base = fs::canonicalize(&paths.app_base).map_err(|e| e.to_string())?;
    let mut name = base
        .file_name()
        .ok_or("Invalid application-data folder.")?
        .to_os_string();
    name.push("-update-snapshots");
    let snapshots = base.with_file_name(name);
    if snapshots.starts_with(&source) {
        return Err("Update snapshots must be outside the current library.".into());
    }
    private_directory(&snapshots)?;
    checked(&snapshots)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let staged = snapshots.join(format!(".pending-{id}"));
    private_directory(&staged)?;
    let created = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "The system clock is unavailable.".to_owned())?
        .as_secs();
    let destination = snapshots.join(format!("{created}-{id}"));
    let result = (|| {
        let library = staged.join("library");
        private_directory(&library)?;
        copy_library_files(&source, &library)?;
        let mut copy = paths.clone();
        copy.data = library;
        validate(&copy)?;
        require_protected_source(&copy.data)?;
        // Validation may checkpoint SQLite or create protected recovery state.
        // Persist its final tree before publishing the completed snapshot name.
        sync_copy_tree(&copy.data)?;
        let descriptor = serde_json::json!({"format":"echo-update-snapshot","version":1,"fromAppVersion":env!("CARGO_PKG_VERSION"),"toAppVersion":next_version,"createdAtUnix":created,"library":"library","verified":true});
        let mut metadata = private_file(&staged.join("snapshot.json"))?;
        metadata
            .write_all(&serde_json::to_vec_pretty(&descriptor).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        metadata.sync_all().map_err(|e| e.to_string())?;
        File::open(&staged)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())?;
        fs::rename(&staged, &destination).map_err(|e| e.to_string())?;
        File::open(&snapshots)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(UpdateSnapshot {
            path: destination.clone(),
            _source_lock: source_lock,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staged);
    }
    result
}
pub fn import_with(
    paths: &LaunchPaths,
    source: &Path,
    validate: impl FnOnce(&LaunchPaths) -> Result<(), String>,
) -> Result<LaunchPaths, String> {
    if source == paths.data {
        return Err("This is the library Echo already uses.".into());
    }
    let _source_lock = source_lock(source)?;
    private_directory(&paths.app_base.join("libraries"))?;
    let destination = paths
        .app_base
        .join("libraries")
        .join(uuid::Uuid::new_v4().simple().to_string());
    fs::create_dir(&destination).map_err(|e| e.to_string())?;
    fs::set_permissions(&destination, fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    let result = (|| {
        // Intentionally do not import config, executables, browser profiles, caches or runtime secrets.
        copy_library_files(source, &destination)?;
        let mut copied = paths.clone();
        copied.data = destination.clone();
        validate(&copied)?;
        select(&paths.app_base, &destination)?;
        Ok(copied)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(destination);
    }
    result
}
pub fn maintenance(paths: &LaunchPaths, phrase: Option<Zeroizing<String>>) -> Result<(), String> {
    maintenance_inner(paths, phrase, None)
}
pub fn validate_copy(paths: &LaunchPaths, source: &Path) -> Result<(), String> {
    maintenance_inner(paths, None, Some(source))
}
fn maintenance_inner(
    paths: &LaunchPaths,
    phrase: Option<Zeroizing<String>>,
    source: Option<&Path>,
) -> Result<(), String> {
    paths.prepare()?;
    let recovery = phrase.is_some();
    if recovery
        && (!paths.data.join("workspace.sqlite").is_file()
            || !paths.data.join("recovery.json").is_file())
    {
        return Err("This library has no recovery phrase record. Choose its original folder or restore your backup.".into());
    }
    let input =
        if let Some(phrase) = phrase {
            #[derive(serde::Serialize)]
            struct RecoveryInput<'a> {
                phrase: &'a str,
            }
            Some(Zeroizing::new(
                serde_json::to_vec(&RecoveryInput {
                    phrase: phrase.as_str(),
                })
                .map_err(|e| e.to_string())?,
            ))
        } else if let Some(source) = source {
            Some(Zeroizing::new(serde_json::to_vec(&serde_json::json!({
            "chatgptSourceRoot":fs::canonicalize(source).map_err(|e|e.to_string())?,
            "chatgptDestinationRoot":fs::canonicalize(&paths.data).map_err(|e|e.to_string())?,
        })).map_err(|e|e.to_string())?))
        } else {
            None
        };
    let mut command = paths.server_command();
    command.arg(if recovery {
        "--recover-library"
    } else {
        "--check-library"
    });
    if source.is_some() {
        command.arg("--copy-connection");
    }
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|_| {
        "Echo's library helper could not start. Reinstall the application.".to_owned()
    })?;
    if let Some(bytes) = input {
        let result = child
            .stdin
            .take()
            .ok_or("The private maintenance channel is unavailable.")
            .and_then(|mut pipe| {
                pipe.write_all(&bytes)
                    .map_err(|_| "The private maintenance channel failed.")
            });
        if let Err(error) = result {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.into());
        }
    }
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        match child.try_wait().map_err(|e|e.to_string())? {
            Some(status) if status.success() => return Ok(()),
            Some(_) => return Err(if recovery {"Recovery did not unlock this library. Check the 24-word phrase and unlock your operating system credential store. Your library is unchanged."} else {"The copied library could not be validated or unlocked. The original and current library are unchanged. Unlock the credential store or recover the source library, then retry."}.into()),
            None if Instant::now() >= deadline => { let _=child.kill(); let _=child.wait(); return Err("Library maintenance timed out. Your original library is preserved.".into()); },
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, LaunchPaths, PathBuf) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        fs::create_dir_all(root.join("tmp")).unwrap();
        let dir = tempfile::Builder::new()
            .prefix("lib-")
            .tempdir_in(root.join("tmp"))
            .unwrap();
        let paths = LaunchPaths {
            resource: dir.path().join("r"),
            app_base: dir.path().join("d"),
            data: dir.path().join("d"),
            cache: dir.path().join("c"),
            logs: dir.path().join("l"),
            runtime: dir.path().join("u"),
        };
        paths.prepare().unwrap();
        let source = dir.path().join("old library Ω");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("workspace.sqlite"), b"fixture database").unwrap();
        (dir, paths, source)
    }
    fn protected_fixture(paths: &LaunchPaths) {
        fs::write(
            paths.data.join("workspace.sqlite"),
            b"synthetic ciphertext database",
        )
        .unwrap();
        fs::write(
            paths.data.join("protection.json"),
            serde_json::to_vec(
                &serde_json::json!({"version":1,"key_id":uuid::Uuid::new_v4().to_string()}),
            )
            .unwrap(),
        )
        .unwrap();
        fs::create_dir_all(paths.data.join("audio/meeting")).unwrap();
        fs::write(
            paths.data.join("audio/meeting/part"),
            b"ECHOENC1synthetic sealed audio",
        )
        .unwrap();
    }
    #[test]
    fn update_snapshot_stays_outside_library_retains_source_lock_and_never_selects_itself() {
        let (_dir, paths, _) = fixture();
        protected_fixture(&paths);
        let before = fs::read(paths.data.join("workspace.sqlite")).unwrap();
        let snapshot = snapshot_with(&paths, "0.2.0", |copy| {
            assert_eq!(
                fs::read(copy.data.join("workspace.sqlite")).unwrap(),
                before
            );
            assert!(!copy.data.starts_with(&paths.data));
            Ok(())
        })
        .unwrap();
        assert!(source_lock(&paths.data).is_err());
        assert_eq!(selected(&paths.app_base).unwrap(), paths.data);
        assert_eq!(
            fs::read(paths.data.join("workspace.sqlite")).unwrap(),
            before
        );
        let saved = snapshot.path.clone();
        drop(snapshot);
        assert!(source_lock(&paths.data).is_ok());
        let metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(saved.join("snapshot.json")).unwrap()).unwrap();
        assert_eq!(metadata["verified"], true);
        assert_eq!(metadata["toAppVersion"], "0.2.0");
        assert_eq!(
            fs::read(saved.join("library/audio/meeting/part")).unwrap(),
            b"ECHOENC1synthetic sealed audio"
        );
    }
    #[test]
    fn update_snapshot_failure_preserves_source_and_plaintext_never_becomes_a_backup() {
        let (_dir, paths, _) = fixture();
        protected_fixture(&paths);
        let before = fs::read(paths.data.join("workspace.sqlite")).unwrap();
        assert!(snapshot_with(&paths, "0.2.0", |_| Err("authentication failed".into())).is_err());
        let snapshots = paths.app_base.with_file_name("d-update-snapshots");
        assert_eq!(fs::read_dir(&snapshots).unwrap().count(), 0);
        assert_eq!(
            fs::read(paths.data.join("workspace.sqlite")).unwrap(),
            before
        );
        fs::write(
            paths.data.join("audio/meeting/part"),
            b"unprotected recording",
        )
        .unwrap();
        assert!(
            snapshot_with(&paths, "0.2.0", |_| panic!("must reject before validation")).is_err()
        );
        assert_eq!(fs::read_dir(&snapshots).unwrap().count(), 0);
        fs::write(
            paths.data.join("workspace.sqlite"),
            b"SQLite format 3\0plaintext database",
        )
        .unwrap();
        assert!(snapshot_with(&paths, "0.2.0", |_| panic!("must reject plaintext DB")).is_err());
    }
    #[test]
    fn actual_server_authenticates_update_snapshot_and_keeps_source_unchanged() {
        let (_dir, paths, _) = fixture();
        fs::create_dir_all(paths.resource.join("bin")).unwrap();
        fs::create_dir_all(paths.resource.join("public")).unwrap();
        fs::write(paths.resource.join("public/index.html"), b"fixture").unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        fs::copy(
            root.join("target/debug/echo-server"),
            paths.resource.join("bin/echo-server"),
        )
        .unwrap();
        maintenance(&paths, None).unwrap();
        // Debug fixture keys deliberately omit OS-keychain descriptors. A public
        // reference fixture lets this test exercise production snapshot shape.
        fs::write(
            paths.data.join("protection.json"),
            serde_json::to_vec(
                &serde_json::json!({"version":1,"key_id":uuid::Uuid::new_v4().to_string()}),
            )
            .unwrap(),
        )
        .unwrap();
        let before = fs::read(paths.data.join("workspace.sqlite")).unwrap();
        let snapshot = snapshot_for_update(&paths, "0.2.0").unwrap();
        assert_eq!(
            fs::read(paths.data.join("workspace.sqlite")).unwrap(),
            before
        );
        assert!(!fs::read(snapshot.path.join("library/workspace.sqlite"))
            .unwrap()
            .starts_with(b"SQLite format 3\0"));
        drop(snapshot);
        fs::create_dir_all(paths.data.join("credentials")).unwrap();
        fs::write(
            paths.data.join("credentials/google.json"),
            b"ECHOENC1forged encrypted credential",
        )
        .unwrap();
        assert!(snapshot_for_update(&paths, "0.2.1").is_err());
        assert_eq!(
            fs::read(paths.data.join("workspace.sqlite")).unwrap(),
            before
        );
    }
    #[test]
    fn copy_validation_failure_preserves_source_current_library_and_selection() {
        let (_dir, paths, source) = fixture();
        fs::write(paths.data.join("workspace.sqlite"), b"current library").unwrap();
        let error = import_with(&paths, &source, |copy| {
            fs::write(copy.data.join("workspace.sqlite"), b"failed conversion").unwrap();
            Err("corrupt audio".into())
        })
        .err()
        .unwrap();
        assert_eq!(error, "corrupt audio");
        assert_eq!(
            fs::read(source.join("workspace.sqlite")).unwrap(),
            b"fixture database"
        );
        assert_eq!(
            fs::read(paths.data.join("workspace.sqlite")).unwrap(),
            b"current library"
        );
        assert_eq!(selected(&paths.app_base).unwrap(), paths.data);
        assert_eq!(
            fs::read_dir(paths.app_base.join("libraries"))
                .unwrap()
                .count(),
            0
        );
    }
    #[test]
    fn copy_commits_only_validated_library_and_excludes_browser_profiles_and_executable_config() {
        let (_dir, paths, source) = fixture();
        fs::create_dir_all(source.join("bot/session/profile")).unwrap();
        fs::write(
            source.join("bot/session/session.json"),
            r#"{"status":"completed","audioAvailable":true}"#,
        )
        .unwrap();
        fs::write(source.join("bot/session/meeting.wav"), b"final audio").unwrap();
        fs::write(
            source.join("bot/session/profile/Cookies"),
            b"browser secret",
        )
        .unwrap();
        fs::create_dir_all(source.join("chatgpt")).unwrap();
        fs::write(source.join("chatgpt/auth.json"), b"credential fixture").unwrap();
        fs::write(source.join("chatgpt/history.jsonl"), b"must not copy").unwrap();
        fs::write(source.join("config.json"), b"{\"codexBinary\":\"/evil\"}").unwrap();
        fs::write(source.join("workspace.sqlite-wal"), b"pending commits").unwrap();
        let imported = import_with(&paths, &source, |copy| {
            assert_eq!(
                fs::read(copy.data.join("workspace.sqlite-wal")).unwrap(),
                b"pending commits"
            );
            assert!(!copy.data.join("config.json").exists());
            assert_eq!(
                fs::read(copy.data.join("chatgpt/auth.json")).unwrap(),
                b"credential fixture"
            );
            assert!(!copy.data.join("chatgpt/history.jsonl").exists());
            assert!(!copy.data.join("bot/session/profile").exists());
            Ok(())
        })
        .unwrap();
        assert_eq!(selected(&paths.app_base).unwrap(), imported.data);
        assert!(source.join("bot/session/profile/Cookies").exists());
        assert_eq!(imported.runtime, paths.runtime);
    }
    #[test]
    fn encrypted_legacy_session_is_copied_for_authenticated_server_validation() {
        let (_dir, paths, source) = fixture();
        fs::create_dir_all(source.join("bot/final")).unwrap();
        fs::write(
            source.join("bot/final/session.json"),
            b"ECHOENC1authentication-required",
        )
        .unwrap();
        let error = import_with(&paths, &source, |copy| {
            assert_eq!(
                fs::read(copy.data.join("bot/final/session.json")).unwrap(),
                b"ECHOENC1authentication-required"
            );
            Err("Server rejected unauthenticated fixture".into())
        })
        .err()
        .unwrap();
        assert_eq!(error, "Server rejected unauthenticated fixture");
        assert_eq!(selected(&paths.app_base).unwrap(), paths.data);
    }
    #[test]
    fn locked_source_links_and_active_old_runner_are_rejected_without_changing_selection() {
        let (_dir, paths, source) = fixture();
        let locked = source_lock(&source).unwrap();
        assert!(import_with(&paths, &source, |_| Ok(()))
            .err()
            .unwrap()
            .contains("another Echo"));
        drop(locked);
        std::os::unix::fs::symlink(source.join("workspace.sqlite"), source.join("audio")).unwrap();
        assert!(import_with(&paths, &source, |_| Ok(()))
            .err()
            .unwrap()
            .contains("symbolic"));
        fs::remove_file(source.join("audio")).unwrap();
        fs::create_dir_all(source.join("bot/active")).unwrap();
        fs::write(
            source.join("bot/active/session.json"),
            r#"{"status":"recording"}"#,
        )
        .unwrap();
        assert!(import_with(&paths, &source, |_| Ok(()))
            .err()
            .unwrap()
            .contains("Stop the old"));
        assert_eq!(selected(&paths.app_base).unwrap(), paths.data);
    }
    #[test]
    fn tampered_selection_cannot_escape_managed_libraries() {
        let (_dir, paths, _source) = fixture();
        fs::write(paths.app_base.join("library.json"), r#""../../outside""#).unwrap();
        assert!(selected(&paths.app_base).is_err());
    }
    #[test]
    fn actual_server_validates_copied_encrypted_library_without_exposing_http() {
        let (_dir, paths, source) = fixture();
        fs::remove_file(source.join("workspace.sqlite")).unwrap();
        fs::create_dir_all(source.join("bot/final")).unwrap();
        fs::write(
            source.join("bot/final/session.json"),
            r#"{"status":"completed","audioAvailable":false}"#,
        )
        .unwrap();
        fs::create_dir_all(paths.resource.join("bin")).unwrap();
        fs::create_dir_all(paths.resource.join("public")).unwrap();
        fs::write(paths.resource.join("public/index.html"), b"fixture").unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        fs::copy(
            root.join("target/debug/echo-server"),
            paths.resource.join("bin/echo-server"),
        )
        .unwrap();
        let mut original = paths.clone();
        original.data = source.clone();
        maintenance(&original, None).unwrap();
        let before = fs::read(source.join("workspace.sqlite")).unwrap();
        assert!(!before.starts_with(b"SQLite format 3"));
        let legacy = fs::read(source.join("bot/final/session.json")).unwrap();
        assert!(legacy.starts_with(b"ECHOENC1"));
        let imported = import_with(&paths, &source, |copy| validate_copy(copy, &source)).unwrap();
        assert_eq!(selected(&paths.app_base).unwrap(), imported.data);
        assert_eq!(
            fs::read(imported.data.join("bot/final/session.json")).unwrap(),
            legacy
        );
        assert_eq!(fs::read(source.join("workspace.sqlite")).unwrap(), before);
        assert!(!paths.runtime.join("s").exists());
        let mut tampered = legacy.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        fs::write(source.join("bot/final/session.json"), tampered).unwrap();
        assert!(import_with(&imported, &source, |copy| validate_copy(copy, &source)).is_err());
        assert_eq!(selected(&paths.app_base).unwrap(), imported.data);
        fs::write(source.join("bot/final/session.json"), legacy).unwrap();
        fs::write(source.join("workspace.sqlite"), b"corrupted fixture").unwrap();
        assert!(import_with(&imported, &source, |copy| validate_copy(copy, &source)).is_err());
        assert_eq!(selected(&paths.app_base).unwrap(), imported.data);
    }
    #[test]
    fn private_recovery_helper_accepts_original_phrase_and_preserves_database_on_wrong_phrase() {
        use crate::runtime::{RuntimeSupervisor, ShutdownOutcome, ShutdownReason};
        use std::io::Read;
        let (_dir, paths, _source) = fixture();
        fs::create_dir_all(paths.resource.join("bin")).unwrap();
        fs::create_dir_all(paths.resource.join("public")).unwrap();
        fs::write(paths.resource.join("public/index.html"), b"fixture").unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        fs::copy(
            root.join("target/debug/echo-server"),
            paths.resource.join("bin/echo-server"),
        )
        .unwrap();
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        fs::write(
            paths.app_base.join("config.json"),
            format!(r#"{{"bind":"127.0.0.1:{port}"}}"#),
        )
        .unwrap();
        let mut owner = RuntimeSupervisor::start(paths.clone()).unwrap();
        let post = |endpoint: &str, body: serde_json::Value| {
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let body = body.to_string();
            write!(stream,"POST /api/privacy/recovery/{endpoint} HTTP/1.1\r\nHost: localhost:{port}\r\nOrigin: http://localhost:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            let mut response = Zeroizing::new(String::new());
            stream.read_to_string(&mut response).unwrap();
            assert!(response.starts_with("HTTP/1.1 200"));
            serde_json::from_str::<serde_json::Value>(response.split_once("\r\n\r\n").unwrap().1)
                .unwrap()
        };
        let setup = post("prepare", serde_json::json!({}));
        let phrase = Zeroizing::new(setup["phrase"].as_str().unwrap().to_owned());
        let words: Vec<_> = phrase.split_whitespace().collect();
        post(
            "confirm",
            serde_json::json!({"setupId":setup["setupId"],"words":[words[2],words[10],words[19]]}),
        );
        assert!(matches!(
            owner.request_shutdown(ShutdownReason::Requested).unwrap(),
            ShutdownOutcome::Stopped
        ));
        let before = fs::read(paths.data.join("workspace.sqlite")).unwrap();
        assert!(maintenance(&paths, Some(Zeroizing::new("wrong ".repeat(24)))).is_err());
        assert_eq!(
            fs::read(paths.data.join("workspace.sqlite")).unwrap(),
            before
        );
        maintenance(&paths, Some(phrase)).unwrap();
        assert_eq!(
            fs::read(paths.data.join("workspace.sqlite")).unwrap(),
            before
        );
    }
}
