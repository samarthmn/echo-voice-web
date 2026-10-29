use crate::{
    protected_storage::{self, LibraryKey, Reader},
    security::ApiError,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use uuid::Uuid;

type Result<T> = std::result::Result<T, ApiError>;
#[cfg(test)]
pub(crate) static TEST_LIBRARY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static DATABASE: OnceLock<Mutex<Option<Connection>>> = OnceLock::new();
static WORKSPACE_LOCK: OnceLock<Mutex<Option<fs::File>>> = OnceLock::new();
static LIBRARY_KEY: OnceLock<Mutex<Option<LibraryKey>>> = OnceLock::new();
const MAX_AUDIO: usize = 128 * 1024 * 1024;
const MAX_BACKUP: usize = 180 * 1024 * 1024;
/// Return a UTC timestamp with millisecond precision for persisted records.
pub(crate) fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
/// Generate an independent identifier for a new workspace entity.
fn id() -> String {
    Uuid::new_v4().to_string()
}
/// Resolve the library location from a developer override or shared runtime config.
pub fn data_dir() -> Result<PathBuf> {
    Ok(crate::paths::get()?.data_dir)
}
#[cfg(unix)]
/// Restrict managed data to the current account on Unix; other platforms use inherited ACLs.
pub(crate) fn secure(path: &Path, directory: bool) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(
        path,
        fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
    )?;
    Ok(())
}
#[cfg(not(unix))]
/// Restrict managed data to the current account on Unix; other platforms use inherited ACLs.
pub(crate) fn secure(_: &Path, _: bool) -> Result<()> {
    Ok(())
}
/// Create a managed folder and apply private directory permissions.
pub(crate) fn mkdir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    secure(path, true)
}
/// Write a new private file without replacing an existing recording chunk.
pub(crate) fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(data)?;
    file.sync_all()?;
    Ok(())
}
/// Access the unlocked key only after initialization has acquired the workspace lock.
/// Callers inside with_db must not recursively initialize the database.
pub(crate) fn with_key<T>(f: impl FnOnce(&LibraryKey) -> std::io::Result<T>) -> std::io::Result<T> {
    let guard = LIBRARY_KEY
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(guard.as_ref().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "The encrypted library is locked.",
        )
    })?)
}
fn file_context(path: &Path) -> std::io::Result<String> {
    let root = data_dir().map_err(std::io::Error::other)?;
    let relative = path
        .strip_prefix(&root)
        .map_err(|_| std::io::Error::other("Invalid protected storage path."))?;
    if relative
        .components()
        .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(std::io::Error::other("Invalid protected storage path."));
    }
    Ok(relative.to_string_lossy().replace('\\', "/"))
}
pub(crate) fn protected_reader(path: &Path) -> std::io::Result<Reader> {
    with_key(|key| Reader::open(key, path, &file_context(path)?))
}
pub(crate) fn read_protected(path: &Path) -> std::io::Result<Vec<u8>> {
    protected_reader(path)?.read_all()
}
pub(crate) fn write_protected(path: &Path, data: &[u8]) -> Result<()> {
    write_protected_for(path, path, data)
}
/// Staging files bind to their final logical path before publication.
pub(crate) fn write_protected_for(path: &Path, final_path: &Path, data: &[u8]) -> Result<()> {
    with_key(|key| protected_storage::write_file(key, path, &file_context(final_path)?, data))?;
    Ok(())
}
pub(crate) fn replace_protected(path: &Path, data: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| ApiError::bad("Invalid protected storage path."))?;
    mkdir(parent)?;
    let staged = parent.join(format!(".encrypted-{}", id()));
    let outcome = (|| {
        write_protected_for(&staged, path, data)?;
        let verified = with_key(|key| {
            Reader::open(key, &staged, &file_context(path)?)
                .and_then(|mut reader| reader.read_all())
        })?;
        if verified != data {
            return Err(ApiError::new(
                500,
                "The protected file could not be verified. Its source is unchanged.",
            ));
        }
        fs::rename(&staged, path)?;
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if outcome.is_err() {
        let _ = fs::remove_file(&staged);
    }
    outcome
}
fn unlock_database(path: &Path, key: &LibraryKey) -> Result<Connection> {
    let secret = key.sqlcipher_key();
    if path.exists() && fs::metadata(path)?.len() != 0 {
        // Validate through a read-only handle first. Dropping a failed writable
        // SQLite handle can checkpoint an existing WAL even with a wrong key.
        // A failed unlock must leave the authoritative database untouched.
        let check = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        check
            .pragma_update(None, "key", secret.as_str())
            .map_err(|_| {
                ApiError::new(
                    500,
                    "The encrypted library could not be unlocked. Saved data is unchanged.",
                )
            })?;
        check.execute_batch("PRAGMA cipher_compatibility=4; PRAGMA temp_store=MEMORY;")?;
        check
            .query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
            .map_err(|_| {
                ApiError::new(
                    500,
                    "The encrypted library could not be unlocked. Saved data is unchanged.",
                )
            })?;
        crate::library_schema::validate(&check)?;
    }
    if !path.exists() {
        write_private(path, &[])?;
    }
    let db = Connection::open(path)?;
    db.pragma_update(None, "key", secret.as_str())
        .map_err(|_| {
            ApiError::new(
                500,
                "The encrypted library could not be unlocked. Saved data is unchanged.",
            )
        })?;
    db.execute_batch("PRAGMA cipher_compatibility=4;")?;
    // Fail closed if a non-SQLCipher build accidentally enters production.
    let version: String = db.pragma_query_value(None, "cipher_version", |row| row.get(0))?;
    if version.is_empty() {
        return Err(ApiError::new(500, "Database encryption is unavailable."));
    }
    db.execute_batch(
        "PRAGMA cipher_memory_security=ON; PRAGMA temp_store=MEMORY; PRAGMA secure_delete=ON;",
    )?;
    db.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
        .map_err(|_| {
            ApiError::new(
                500,
                "The encrypted library could not be unlocked. Saved data is unchanged.",
            )
        })?;
    Ok(db)
}
fn preflight_plaintext_schema(root: &Path) -> Result<()> {
    use std::io::Read;
    let path = root.join("workspace.sqlite");
    if !path.exists() {
        return Ok(());
    }
    if fs::symlink_metadata(&path)?.file_type().is_symlink() {
        return Err(ApiError::new(
            500,
            "The library database must not be a symbolic link.",
        ));
    }
    let mut prefix = [0; 16];
    if fs::File::open(&path)?.read(&mut prefix)? == prefix.len() && &prefix == b"SQLite format 3\0"
    {
        let check = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        crate::library_schema::validate(&check)?;
    }
    Ok(())
}
/// Checkpoint and export plaintext SQLite into a verified encrypted sibling.
/// The original remains authoritative until the single atomic replacement.
fn open_protected_database(root: &Path, key: &LibraryKey) -> Result<Connection> {
    use std::io::Read;
    let path = root.join("workspace.sqlite");
    if path.exists() && fs::symlink_metadata(&path)?.file_type().is_symlink() {
        return Err(ApiError::new(
            500,
            "The library database must not be a symbolic link.",
        ));
    }
    let plaintext = if path.exists() {
        let mut prefix = [0; 16];
        let mut file = fs::File::open(&path)?;
        file.read(&mut prefix)? == prefix.len() && &prefix == b"SQLite format 3\0"
    } else {
        false
    };
    if plaintext {
        // Check before deleting a stale stage or checkpointing the source WAL.
        let check = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        crate::library_schema::validate(&check)?;
        drop(check);
        let staged = root.join(".workspace-encrypted.sqlite");
        // A failed export never replaces the original. Its encrypted staging
        // database can be recreated on restart, including interrupted journals.
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let stale = root.join(format!(".workspace-encrypted.sqlite{suffix}"));
            if stale.exists() {
                fs::remove_file(stale)?;
            }
        }
        let outcome = (|| {
            write_private(&staged, &[])?;
            let source = Connection::open(&path)?;
            source.execute_batch("PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")?;
            let check: String = source.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
            if check != "ok" {
                return Err(ApiError::new(500, "The existing library needs repair before encryption. Its data has not been replaced."));
            }
            let secret = key.sqlcipher_key();
            source
                .execute(
                    "ATTACH DATABASE ?1 AS encrypted KEY ?2",
                    params![staged.to_string_lossy(), secret.as_str()],
                )
                .map_err(|_| {
                    ApiError::new(
                        500,
                        "The encrypted migration could not be started. Its source is unchanged.",
                    )
                })?;
            source.execute_batch("PRAGMA encrypted.cipher_compatibility=4;")?;
            source.query_row("SELECT sqlcipher_export('encrypted')", [], |_| Ok(()))?;
            let schema: i64 = source.pragma_query_value(None, "user_version", |row| row.get(0))?;
            source.pragma_update(
                Some(rusqlite::DatabaseName::Attached("encrypted")),
                "user_version",
                schema,
            )?;
            source.execute_batch("DETACH DATABASE encrypted;")?;
            let verified = unlock_database(&staged, key)?;
            let check: String = verified.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
            if check != "ok" {
                return Err(ApiError::new(
                    500,
                    "The encrypted migration could not be verified. Its source is unchanged.",
                ));
            }
            let tables = {
                let mut statement = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")?;
                let rows = statement.query_map([], |r| r.get::<_, String>(0))?;
                rows.collect::<std::result::Result<Vec<_>, _>>()?
            };
            for table in tables {
                let query = format!("SELECT COUNT(*) FROM \"{}\"", table.replace('"', "\"\""));
                let before: u64 = source.query_row(&query, [], |r| r.get(0))?;
                let after: u64 = verified.query_row(&query, [], |r| r.get(0))?;
                if before != after {
                    return Err(ApiError::new(
                        500,
                        "The encrypted migration is incomplete. Its source is unchanged.",
                    ));
                }
            }
            drop(verified);
            drop(source);
            secure(&staged, false)?;
            fs::File::open(&staged)?.sync_all()?;
            fs::rename(&staged, &path)?;
            fs::File::open(root)?.sync_all()?;
            Ok(())
        })();
        if outcome.is_err() {
            let _ = fs::remove_file(&staged);
        }
        outcome?;
    }
    unlock_database(&path, key)
}
/// Serialize database access, acquire the workspace lock, and initialize schema and recovery lazily.
pub(crate) fn with_db<T>(f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
    let mut guard = DATABASE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if guard.is_none() {
        let root = data_dir()?;
        mkdir(&root)?;
        mkdir(&root.join("audio"))?;
        let lock_path = root.join("workspace.lock");
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)?;
        secure(&lock_path, false)?;
        fs2::FileExt::try_lock_exclusive(&lock).map_err(|_|ApiError::new(409,"Another Echo Voice server is using this data folder. Stop that server or choose a separate ECHO_DATA_DIR."))?;
        preflight_plaintext_schema(&root)?;
        let key = protected_storage::library_key(&root).map_err(|error| { tracing::warn!(%error, "Library key unlock failed"); ApiError::new(503, "Echo cannot unlock this library. Unlock the operating system credential store and retry. No replacement key or plaintext library was created.") })?;
        let mut db = open_protected_database(&root, &key)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS meetings(id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS preferences(id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS vocabulary(id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS deletion_jobs(id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS audio_chunks(meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,track_id TEXT NOT NULL,sequence INTEGER NOT NULL,file TEXT NOT NULL,bytes INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(meeting_id,track_id,sequence));")?;
        for name in [
            "workspace.sqlite",
            "workspace.sqlite-wal",
            "workspace.sqlite-shm",
        ] {
            let p = root.join(name);
            if p.exists() {
                secure(&p, false)?;
            }
        }
        crate::extensions::init_schema(&db)?;
        crate::library_schema::establish(&mut db)?;
        *LIBRARY_KEY
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(key);
        if let Err(error) = migrate_protected_files(&db)
            .and_then(|_| crate::chatgpt::protect_legacy_state())
            .and_then(|_| recover(&mut db))
        {
            LIBRARY_KEY
                .get_or_init(|| Mutex::new(None))
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            return Err(error);
        }
        crate::extensions::cache_library_id(&db)?;
        *guard = Some(db);
        *WORKSPACE_LOCK
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(lock);
    }
    let conn = guard
        .as_mut()
        .ok_or_else(|| ApiError::new(500, "The local database is unavailable."))?;
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(conn))) {
        Ok(result) => result,
        Err(panic) => {
            let message = panic
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| panic.downcast_ref::<&str>().copied())
                .unwrap_or("unknown panic");
            tracing::error!(%message, "Database operation panicked");
            if !conn.is_autocommit() {
                if let Err(error) = conn.execute_batch("ROLLBACK") {
                    tracing::error!(%error, "Database rollback failed after panic");
                }
            }
            Err(ApiError::new(500, "Echo hit an internal error; retry."))
        }
    }
}

/// Execute serialized database work away from asynchronous worker threads.
pub async fn run<T: Send + 'static>(
    f: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(move || with_db(f))
        .await
        .map_err(|error| {
            tracing::error!(%error, "Database task failed");
            ApiError::new(500, "Echo hit an internal error; retry.")
        })?
}
/// Run synchronous storage work without blocking an async worker.
pub async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(f).await.map_err(|error| {
        tracing::error!(%error, "Storage task failed");
        ApiError::new(500, "Echo hit an internal error; retry.")
    })?
}
/// Read and authenticate one bounded range on a blocking worker.
pub async fn protected_range(
    path: PathBuf,
    offset: u64,
    length: usize,
) -> std::io::Result<Vec<u8>> {
    tokio::task::spawn_blocking(move || protected_reader(&path)?.read_range(offset, length))
        .await
        .map_err(std::io::Error::other)?
}
/// Open the library and complete startup recovery before accepting requests.
pub fn init() -> Result<()> {
    with_db(|_| Ok(()))
}
#[cfg(test)]
pub(crate) fn reset_for_tests() {
    if let Some(db) = DATABASE.get() {
        db.lock().unwrap().take();
    }
    if let Some(lock) = WORKSPACE_LOCK.get() {
        lock.lock().unwrap().take();
    }
    if let Some(key) = LIBRARY_KEY.get() {
        key.lock().unwrap().take();
    }
}
/// Convert only known, verified plaintext under a durable encrypted-DB marker.
/// Every replacement is authenticated and synced before the plaintext name is
/// replaced, so a restart can resume with a mixture of sealed and legacy files.
fn migrate_protected_files(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS storage_protection(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);")?;
    let complete = db
        .query_row(
            "SELECT version FROM storage_protection WHERE id=1",
            [],
            |r| r.get::<_, u64>(0),
        )
        .optional()?;
    if complete == Some(1) {
        return Ok(());
    }
    if complete.is_some() {
        return Err(ApiError::new(
            500,
            "This library uses a newer storage protection version.",
        ));
    }
    let mut stmt = db.prepare("SELECT meeting_id,file,bytes,digest FROM audio_chunks")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (meeting, file, bytes, digest) in rows {
        valid_id(&meeting)?;
        if Path::new(&file).file_name().and_then(|s| s.to_str()) != Some(file.as_str()) {
            return Err(ApiError::new(500, "Invalid audio migration reference."));
        }
        migrate_file(
            &data_dir()?.join("audio").join(meeting).join(file),
            Some((bytes, &digest)),
        )?;
    }
    let mut stmt = db.prepare("SELECT recording_id,file,frames,digest FROM extension_chunks")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (recording, file, frames, digest) in rows {
        valid_id(&recording)?;
        if Path::new(&file).file_name().and_then(|s| s.to_str()) != Some(file.as_str()) {
            return Err(ApiError::new(500, "Invalid PCM migration reference."));
        }
        migrate_file(
            &data_dir()?.join("extension-pcm").join(recording).join(file),
            Some((frames * 2, &digest)),
        )?;
    }
    let credentials = data_dir()?.join("credentials");
    if credentials.exists() {
        for entry in fs::read_dir(&credentials)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == "google.json" || (name.starts_with("google.") && name.ends_with(".tmp")) {
                if !protected_storage::is_encrypted(&entry.path())? {
                    let source = fs::read(entry.path())?;
                    let value: Value = serde_json::from_slice(&source).map_err(|_| ApiError::new(410, "Saved Google credentials are damaged. Migration paused without replacing them."))?;
                    if !value.is_object() {
                        return Err(ApiError::new(410, "Saved Google credentials are damaged. Migration paused without replacing them."));
                    }
                }
                migrate_file(&entry.path(), None)?;
            }
        }
    }
    // Old interrupted imports have no committed ownership. Their audio must
    // still be encrypted before acknowledging completion of the migration.
    for area in ["audio", "extension-pcm"] {
        migrate_unindexed_files(&data_dir()?.join(area))?;
    }
    for entry in fs::read_dir(data_dir()?)? {
        let entry = entry?;
        if entry.file_type()?.is_dir()
            && entry.file_name().to_string_lossy().starts_with(".import-")
        {
            migrate_unindexed_files(&entry.path())?;
        }
    }
    db.execute("INSERT INTO storage_protection VALUES(1,1)", [])?;
    Ok(())
}
fn migrate_unindexed_files(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_symlink() {
            return Err(ApiError::new(
                500,
                "A symbolic link prevents protected storage migration.",
            ));
        }
        if entry.file_type()?.is_dir() {
            migrate_unindexed_files(&entry.path())?;
        } else if entry.file_type()?.is_file() && !protected_storage::is_encrypted(&entry.path())? {
            migrate_file(&entry.path(), None)?;
        }
    }
    Ok(())
}
fn migrate_file(path: &Path, expected: Option<(u64, &str)>) -> Result<()> {
    let plaintext = if protected_storage::is_encrypted(path)? {
        read_protected(path)?
    } else {
        if fs::metadata(path)?.len() > MAX_AUDIO as u64 {
            return Err(ApiError::new(
                413,
                "A legacy file is too large for protected storage migration.",
            ));
        }
        fs::read(path)?
    };
    if let Some((bytes, digest)) = expected {
        if plaintext.len() as u64 != bytes || format!("{:x}", Sha256::digest(&plaintext)) != digest
        {
            return Err(ApiError::new(
                410,
                "A legacy audio file is damaged. Migration paused without replacing it.",
            ));
        }
    }
    if !protected_storage::is_encrypted(path)? {
        replace_protected(path, &plaintext)?;
    }
    Ok(())
}
#[cfg(test)]
pub(crate) fn test_directory() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("tmp/server-storage");
    fs::create_dir_all(&root).unwrap();
    tempfile::Builder::new()
        .prefix("library-")
        .tempdir_in(root)
        .unwrap()
}
#[cfg(test)]
pub(crate) fn test_key() {
    crate::paths::init(crate::paths::RuntimePaths::resolve().unwrap());
    std::env::set_var("ECHO_TEST_MODE", "1");
    std::env::set_var("ECHO_TEST_STORAGE_KEY", STANDARD.encode([42u8; 32]));
}
/// Identify the restart marker that a still-running browser worker can reconcile.
const PROCESSING_RESTART_ERROR: &str = "Processing was interrupted by a server restart. Saved audio and earlier results are safe; retry processing.";
/// Resume durable deletion jobs and mark unfinished recording or processing work as interrupted.
fn recover(db: &mut Connection) -> Result<()> {
    let pending = {
        let mut stmt = db.prepare("SELECT id FROM deletion_jobs")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for key in pending {
        crate::extensions::tombstone(db, &key)?;
        if valid_id(&key).is_err() {
            continue;
        }
        let removed = (|| {
            let dir = data_dir()?.join("audio").join(&key);
            if dir.exists() {
                fs::remove_dir_all(dir)?;
            }
            crate::extensions::cleanup_pcm(db, &key)?;
            Ok::<_, ApiError>(())
        })();
        if removed.is_ok() {
            db.execute("DELETE FROM meetings WHERE id=?", [&key])?;
            db.execute("DELETE FROM deletion_jobs WHERE id=?", [&key])?;
        } else {
            eprintln!("[Echo Voice] Pending deletion could not finish: {key}");
        }
    }
    let tx = db.transaction()?;
    let rows = {
        let mut stmt = tx.prepare("SELECT id,data FROM meetings")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for (key, source) in rows {
        if let Ok(mut meeting) = serde_json::from_str::<Value>(&source) {
            if matches!(
                meeting["status"].as_str(),
                Some("recording" | "paused" | "processing")
            ) {
                let processing = meeting["status"] == "processing";
                meeting["status"] = json!(if processing { "error" } else { "interrupted" });
                meeting["error"] = json!(if processing {
                    PROCESSING_RESTART_ERROR
                } else {
                    "Recording was interrupted. Review your saved audio or start a new recording after checking consent and microphone access."
                });
                meeting["updatedAt"] = json!(now());
                tx.execute(
                    "UPDATE meetings SET data=? WHERE id=?",
                    params![meeting.to_string(), key],
                )?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

mod audio;
mod library_io;
mod meetings;
mod settings;
mod validation;
mod vocabulary;
pub use audio::*;
pub use library_io::*;
pub use meetings::*;
pub use settings::*;
pub(crate) use validation::*;
pub use vocabulary::*;
#[cfg(test)]
mod tests;
