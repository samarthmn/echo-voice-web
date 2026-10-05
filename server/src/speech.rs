//! Optional native Large V3 execution, owned by the local server rather than a browser heap.
use crate::{security::ApiError, store};
use axum::{
    extract::{Path, Query, Request},
    http::{header, StatusCode},
    routing::{delete, get, post},
    Json, Router,
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    path::{Component, Path as FsPath, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{watch, Mutex},
    time::timeout,
};

const MODEL: &str = "onnx-community/whisper-large-v3";
const CHECKPOINT: &str = "Xenova/whisper-large-v3";
const REVISION: &str = "67bf02d92b7754a1ff82a7f8545f8b8c378b2ef0";
const WEIGHTS: [(&str, u64); 2] = [
    ("encoder_model_quantized.onnx", 645260435),
    ("decoder_model_merged_quantized.onnx", 915059840),
];
const MODEL_JSON: [&str; 5] = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "preprocessor_config.json",
    "generation_config.json",
];
const MAX_PCM: usize = 7200 * 16000 * 4;
const MAX_LINE: usize = 8 * 1024 * 1024;
const RETAIN: usize = 32;
const TOMBSTONES: usize = 64;
static MANAGER: OnceLock<Arc<Manager>> = OnceLock::new();

type Result<T> = std::result::Result<T, ApiError>;
#[derive(Default)]
struct State {
    active: Option<String>,
    jobs: HashMap<String, Job>,
    order: VecDeque<String>,
    cancelled: VecDeque<(String, Instant)>,
}
struct Job {
    operation: Option<String>,
    public: Value,
    cancel: watch::Sender<bool>,
}
#[derive(Default)]
struct Manager {
    state: Mutex<State>,
    runtime: Mutex<Option<(Instant, bool, String)>>,
}
fn manager() -> Arc<Manager> {
    MANAGER.get_or_init(|| Arc::new(Manager::default())).clone()
}
fn root() -> Result<PathBuf> {
    Ok(std::env::current_dir()?)
}
fn cache_dir() -> PathBuf {
    store::data_dir().join("models/native-large-v3")
}
fn valid_id(id: &str) -> Result<String> {
    uuid::Uuid::parse_str(id)
        .map(|id| id.to_string())
        .map_err(|_| ApiError::bad("Supply a valid speech job ID."))
}
fn cancelled_error() -> ApiError {
    ApiError::new(
        409,
        "Local processing was cancelled. Your saved audio is unchanged.",
    )
}
fn is_cancelled(receiver: &watch::Receiver<bool>) -> bool {
    *receiver.borrow()
}

/// Register bounded native job, readiness, cancellation and model-removal endpoints.
pub fn routes() -> Router {
    Router::new()
        .route("/speech", get(status))
        .route("/speech/jobs", post(start))
        .route("/speech/jobs/{id}", get(read).delete(cancel))
        .route("/speech/model", delete(remove_model))
}

async fn runtime_available(owner: &Manager) -> (bool, String) {
    let mut cached = owner.runtime.lock().await;
    if let Some((at, available, detail)) = &*cached {
        if at.elapsed() < Duration::from_secs(5) {
            return (*available, detail.clone());
        }
    }
    let available = async {
        let root = root().ok()?;
        for file in [
            "scripts/native-speech.mjs",
            "node_modules/@huggingface/transformers/package.json",
            "node_modules/onnxruntime-node/package.json",
        ] {
            if !root.join(file).is_file() {
                return None;
            }
        }
        let output = timeout(Duration::from_secs(3), Command::new("node")
            .arg("--input-type=module").arg("-e")
            .arg("if(Number(process.versions.node.split('.')[0])<22)process.exit(1);await import('onnxruntime-node');await import('./scripts/native-speech.mjs');process.stdout.write('echo-native-ready')")
            .current_dir(root).kill_on_drop(true).output()).await.ok()?.ok()?;
        (output.status.success() && output.stdout == b"echo-native-ready").then_some(())
    }
    .await
    .is_some();
    let detail = if available { "Large V3 runs locally through the native speech helper." } else { "Large V3 requires Node.js 22 or newer and the native speech dependencies. Run npm ci in the Echo Voice folder, then retry." }.to_owned();
    *cached = Some((Instant::now(), available, detail.clone()));
    (available, detail)
}

/// Private native model files never enter browser backup exports or accept client paths.
fn safe_cache(create: bool) -> Result<PathBuf> {
    let parent = store::data_dir().join("models");
    let path = cache_dir();
    for folder in [&parent, &path] {
        if std::fs::symlink_metadata(folder).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(ApiError::bad(
                "Native model storage cannot be a symbolic link.",
            ));
        }
    }
    if create {
        std::fs::create_dir_all(&path)?;
    }
    Ok(path)
}
fn qualified(path: &FsPath) -> bool {
    let marker = path.join("ready.json");
    let Ok(metadata) = std::fs::symlink_metadata(&marker) else {
        return false;
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 64 * 1024 {
        return false;
    }
    let Ok(bytes) = std::fs::read(marker) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    if value["version"] != 1
        || value["modelId"] != MODEL
        || value["checkpoint"] != CHECKPOINT
        || value["revision"] != REVISION
        || value["forwardVerified"] != true
    {
        return false;
    }
    let Some(files) = value["files"]
        .as_array()
        .filter(|files| !files.is_empty() && files.len() <= 32)
    else {
        return false;
    };
    let pinned = format!("{CHECKPOINT}/{REVISION}");
    if !WEIGHTS.iter().all(|(name, size)| {
        files.iter().any(|entry| {
            entry["path"] == format!("{pinned}/onnx/{name}")
                && entry["size"].as_u64() == Some(*size)
        })
    }) || !MODEL_JSON.iter().all(|name| {
        files
            .iter()
            .any(|entry| entry["path"] == format!("{pinned}/{name}"))
    }) {
        return false;
    }
    files.iter().all(|entry| {
        let Some(name) = entry["path"]
            .as_str()
            .filter(|name| !name.is_empty() && name.len() < 1024)
        else {
            return false;
        };
        let relative = FsPath::new(name);
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
            || name.contains('\\')
        {
            return false;
        }
        let Some(size) = entry["size"]
            .as_u64()
            .filter(|size| *size > 0 && *size <= 4 * 1024 * 1024 * 1024)
        else {
            return false;
        };
        let mut file = path.to_path_buf();
        for part in relative.components() {
            file.push(part.as_os_str());
            if std::fs::symlink_metadata(&file)
                .is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                return false;
            }
        }
        std::fs::metadata(file).is_ok_and(|metadata| metadata.is_file() && metadata.len() == size)
    })
}
async fn status() -> Result<Json<Value>> {
    let owner = manager();
    let (available, detail) = runtime_available(&owner).await;
    let state = owner.state.lock().await;
    let qualifying = state
        .active
        .as_ref()
        .and_then(|id| state.jobs.get(id))
        .is_some_and(|job| job.operation.as_deref() == Some("download"));
    let ready = available && !qualifying && safe_cache(false).is_ok_and(|path| qualified(&path));
    let active = state
        .active
        .as_ref()
        .and_then(|id| state.jobs.get(id))
        .map(|job| json!({"jobId":job.public["jobId"],"state":job.public["state"]}));
    Ok(Json(
        json!({"available":available,"detail":detail,"modelId":MODEL,"ready":ready,"activeJob":active}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    operation: String,
    model_id: String,
    job_id: String,
    language: Option<String>,
}

async fn reserve(owner: &Manager, id: &str, operation: &str) -> Result<watch::Receiver<bool>> {
    let mut state = owner.state.lock().await;
    state
        .cancelled
        .retain(|(_, at)| at.elapsed() < Duration::from_secs(600));
    if state.cancelled.iter().any(|(cancelled, _)| cancelled == id) {
        return Err(cancelled_error());
    }
    if state.jobs.contains_key(id) {
        return Err(ApiError::new(
            409,
            "This speech job ID was already used. Check its status before starting another job.",
        ));
    }
    if state.active.is_some() {
        return Err(ApiError::new(409,"Native speech is already processing another job. Wait for it to finish or cancel your own job."));
    }
    while state.order.len() >= RETAIN {
        if let Some(old) = state.order.pop_front() {
            state.jobs.remove(&old);
        }
    }
    let (cancel, receiver) = watch::channel(false);
    state.jobs.insert(id.to_owned(), Job { operation: Some(operation.to_owned()), public: json!({"jobId":id,"state":"queued","progress":{"status":"Preparing local speech","progress":0}}), cancel });
    state.order.push_back(id.to_owned());
    state.active = Some(id.to_owned());
    Ok(receiver)
}
async fn update(owner: &Manager, id: &str, message: Value) {
    let mut state = owner.state.lock().await;
    let Some(job) = state.jobs.get_mut(id) else {
        return;
    };
    if *job.cancel.borrow() {
        return;
    }
    if let Some(fields) = message.as_object() {
        for (key, value) in fields {
            job.public[key] = value.clone();
        }
    }
}
async fn finish(owner: &Manager, id: &str, outcome: Result<Value>) {
    let mut state = owner.state.lock().await;
    if let Some(job) = state.jobs.get_mut(id) {
        if *job.cancel.borrow() {
            job.public["state"] = json!("cancelled");
            job.public.as_object_mut().unwrap().remove("result");
        } else {
            match outcome {
                Ok(result) => {
                    job.public["state"] = json!("completed");
                    job.public["result"] = result;
                    job.public["progress"] =
                        json!({"status":"Local speech complete","progress":100});
                }
                Err(error) => {
                    job.public["state"] = json!("failed");
                    job.public["error"] = json!(error.message);
                }
            }
        }
    }
    if state.active.as_deref() == Some(id) {
        state.active = None;
    }
}
struct UploadGuard {
    owner: Arc<Manager>,
    id: String,
    spool: PathBuf,
    armed: bool,
}
impl Drop for UploadGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let owner = self.owner.clone();
        let id = self.id.clone();
        let spool = self.spool.clone();
        tokio::spawn(async move {
            remove_spool(&spool).await;
            finish(
                &owner,
                &id,
                Err(ApiError::new(
                    400,
                    "The speech upload was interrupted. Retry the saved audio.",
                )),
            )
            .await;
        });
    }
}
/// Name transient audio by canonical library identity, never by a shared machine temp path.
fn spool_namespace(project: &FsPath, data: &FsPath) -> Result<PathBuf> {
    let canonical = std::fs::canonicalize(data)?;
    let identity = format!(
        "{:x}",
        Sha256::digest(canonical.as_os_str().as_encoded_bytes())
    );
    let temporary = project.join("tmp");
    let namespace = temporary.join(format!("native-speech-{identity}"));
    for folder in [&temporary, &namespace] {
        match std::fs::symlink_metadata(folder) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => return Err(ApiError::bad("Native speech temporary folders must be regular directories, not symbolic links.")),
            Err(error) if error.kind()!=std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {},
        }
    }
    Ok(namespace)
}
fn clean_namespace(project: &FsPath, data: &FsPath) -> Result<()> {
    let namespace = spool_namespace(project, data)?;
    if !namespace.exists() {
        return Ok(());
    }
    let mut orphans = Vec::new();
    for entry in std::fs::read_dir(&namespace)? {
        let entry = entry?;
        let name = entry.file_name();
        if name
            .to_str()
            .is_none_or(|name| uuid::Uuid::parse_str(name).is_err())
        {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_symlink() || !kind.is_dir() {
            return Err(ApiError::bad(
                "A native speech job folder is not a regular private directory.",
            ));
        }
        orphans.push(entry.path());
    }
    // std::fs::remove_dir_all does not follow symlinks inside an owned job directory.
    for orphan in orphans {
        std::fs::remove_dir_all(orphan)?;
    }
    match std::fs::remove_dir(namespace) {
        Ok(()) => {}
        Err(error)
            if error.kind() == std::io::ErrorKind::DirectoryNotEmpty
                || error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}
/// Recover only this library's abandoned PCM spools after store::init holds its exclusive lock.
pub fn recover_spools() -> Result<()> {
    clean_namespace(&root()?, &store::data_dir())
}
async fn remove_spool(path: &FsPath) {
    let _ = tokio::fs::remove_dir_all(path).await;
    // Leave a concurrently nonempty namespace alone; deleting an empty one is safe.
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::remove_dir(parent).await;
    }
}
fn spool(id: &str) -> Result<PathBuf> {
    let namespace = spool_namespace(&root()?, &store::data_dir())?;
    std::fs::create_dir_all(&namespace)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&namespace, std::fs::Permissions::from_mode(0o700))?;
    }
    let path = namespace.join(id);
    std::fs::create_dir(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(path)
}
async fn start(Query(input): Query<Start>, request: Request) -> Result<(StatusCode, Json<Value>)> {
    if input.model_id != MODEL || !matches!(input.operation.as_str(), "download" | "transcribe") {
        return Err(ApiError::bad(
            "Choose the supported native Large V3 operation.",
        ));
    }
    let language = input.language.as_deref().unwrap_or("auto");
    if !matches!(
        language,
        "en" | "es" | "fr" | "de" | "hi" | "ja" | "pt" | "zh" | "auto"
    ) {
        return Err(ApiError::bad(
            "Choose a supported language or automatic language for native speech.",
        ));
    }
    let id = valid_id(&input.job_id)?;
    if input.operation == "transcribe"
        && request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            != Some("application/octet-stream")
    {
        return Err(ApiError::new(
            415,
            "Native speech requires decoded 16 kHz mono Float32 audio.",
        ));
    }
    if input.operation == "transcribe" {
        if let Some(length) = request
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
        {
            if length > MAX_PCM {
                return Err(ApiError::new(
                    413,
                    "Native speech accepts recordings up to two hours.",
                ));
            }
            if length == 0 || !length.is_multiple_of(4) {
                return Err(ApiError::bad(
                    "The decoded speech audio is empty or incomplete.",
                ));
            }
        }
    }
    if input.operation == "download"
        && request
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|length| length > 0)
    {
        return Err(ApiError::bad(
            "A model download does not accept an audio body.",
        ));
    }
    let owner = manager();
    let mut cancellation = reserve(&owner, &id, &input.operation).await?;
    let spool = match spool(&id) {
        Ok(path) => path,
        Err(error) => {
            finish(
                &owner,
                &id,
                Err(ApiError::new(error.status.as_u16(), error.message.clone())),
            )
            .await;
            return Err(error);
        }
    };
    let mut guard = UploadGuard {
        owner: owner.clone(),
        id: id.clone(),
        spool: spool.clone(),
        armed: true,
    };
    let prepared = async {
        let (available, detail) = runtime_available(&owner).await;
        if !available { return Err(ApiError::new(503, detail)); }
        if is_cancelled(&cancellation) { return Err(cancelled_error()); }
        let cache = safe_cache(true)?;
        if input.operation == "transcribe" && !qualified(&cache) { return Err(ApiError::new(409,"Download and qualify Large V3 in Models before transcribing.")); }
        let audio = spool.join("audio.f32");
        if input.operation == "transcribe" {
            let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&audio).await?;
            let mut body = request.into_body().into_data_stream(); let mut bytes = 0usize;
            while let Some(chunk) = tokio::select! { _ = cancellation.changed() => { return Err(cancelled_error()); }, value = timeout(Duration::from_secs(60), body.next()) => value.map_err(|_| ApiError::new(408,"The speech upload timed out. Retry the saved audio."))? } {
                let chunk = chunk.map_err(|_| ApiError::bad("The speech upload was interrupted. Retry the saved audio."))?;
                bytes = bytes.checked_add(chunk.len()).ok_or_else(|| ApiError::new(413,"Native speech accepts recordings up to two hours."))?;
                if bytes > MAX_PCM { return Err(ApiError::new(413,"Native speech accepts recordings up to two hours.")); }
                file.write_all(&chunk).await?;
            }
            if bytes == 0 || !bytes.is_multiple_of(4) { return Err(ApiError::bad("The decoded speech audio is empty or incomplete.")); }
            file.flush().await?;
        } else {
            let body = tokio::select! {
                _ = cancellation.changed() => return Err(cancelled_error()),
                body = timeout(Duration::from_secs(60), axum::body::to_bytes(request.into_body(), 0)) => body.map_err(|_| ApiError::new(408,"The model request timed out. Retry the download."))?.map_err(|_|ApiError::bad("A model download does not accept an audio body."))?,
            };
            if !body.is_empty() { return Err(ApiError::bad("A model download does not accept an audio body.")); }
        }
        if is_cancelled(&cancellation) { return Err(cancelled_error()); }
        let cache = std::fs::canonicalize(cache)?;
        let request_file = spool.join("request.json");
        let mut value = json!({"operation":input.operation,"cacheDir":cache,"language":language});
        if input.operation == "transcribe" { value["audioPath"] = json!(audio); }
        crate::config::write_private(&request_file, &serde_json::to_vec(&value)?)?;
        Ok(request_file)
    }.await;
    let request_file = match prepared {
        Ok(path) => path,
        Err(error) => {
            let public = ApiError::new(error.status.as_u16(), error.message.clone());
            remove_spool(&spool).await;
            finish(&owner, &id, Err(public)).await;
            guard.armed = false;
            return Err(error);
        }
    };
    guard.armed = false;
    let job_id = id.clone();
    let operation = input.operation;
    tokio::spawn(async move {
        let outcome = run(&owner, &job_id, &request_file, &operation, cancellation).await;
        remove_spool(&spool).await;
        finish(&owner, &job_id, outcome).await;
    });
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"jobId":id,"state":"queued"})),
    ))
}
async fn line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err(ApiError::new(
                    502,
                    "Native speech returned an incomplete response.",
                ))
            };
        }
        let count = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(buffer.len(), |index| index + 1);
        if line.len() + count > MAX_LINE {
            return Err(ApiError::new(
                502,
                "Native speech exceeded its response limit.",
            ));
        }
        let ended = buffer[count - 1] == b'\n';
        line.extend_from_slice(&buffer[..count]);
        reader.consume(count);
        if ended {
            return Ok(Some(line));
        }
    }
}
fn result(value: &Value, operation: &str) -> Result<Value> {
    if operation == "download" {
        return Ok(json!({}));
    }
    let Some(duration) = value["duration"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0. && *n <= 7200.)
    else {
        return Err(ApiError::new(
            502,
            "Native speech returned an invalid duration.",
        ));
    };
    let words = value["words"]
        .as_array()
        .filter(|words| words.len() <= 200000)
        .ok_or_else(|| ApiError::new(502, "Native speech returned invalid word timestamps."))?;
    for word in words {
        let text = word["text"]
            .as_str()
            .filter(|text| !text.is_empty() && text.len() <= 4096);
        let times = word["timestamp"]
            .as_array()
            .filter(|times| times.len() == 2);
        let valid = times.is_some_and(|times| {
            times[0]
                .as_f64()
                .zip(times[1].as_f64())
                .is_some_and(|(start, end)| {
                    start.is_finite()
                        && end.is_finite()
                        && start >= 0.
                        && end >= start
                        && end <= duration + 1.
                })
        });
        if text.is_none() || !valid {
            return Err(ApiError::new(
                502,
                "Native speech returned invalid word timestamps.",
            ));
        }
    }
    Ok(json!({"words":words,"duration":duration}))
}
async fn run(
    owner: &Manager,
    id: &str,
    request_file: &FsPath,
    operation: &str,
    cancellation: watch::Receiver<bool>,
) -> Result<Value> {
    if is_cancelled(&cancellation) {
        return Err(cancelled_error());
    }
    let project = root()?;
    let mut command = Command::new("node");
    command
        .arg(project.join("scripts/native-speech.mjs"))
        .arg("--request")
        .arg(request_file)
        .current_dir(&project)
        .env("TMPDIR", project.join("tmp"));
    supervise(owner, id, operation, command, cancellation).await
}
async fn supervise(
    owner: &Manager,
    id: &str,
    operation: &str,
    mut command: Command,
    mut cancellation: watch::Receiver<bool>,
) -> Result<Value> {
    if is_cancelled(&cancellation) {
        return Err(cancelled_error());
    }
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn().map_err(|_| ApiError::new(503, "The native speech helper could not start. Check Node.js and reinstall the local dependencies."))?;
    let _lease = child
        .stdin
        .take()
        .ok_or_else(|| ApiError::new(503, "The native speech process could not be supervised."))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ApiError::new(503, "The native speech process has no output."))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| ApiError::new(503, "The native speech process has no diagnostics."))?;
    let mut diagnostics = tokio::spawn(async move {
        let mut buffer = [0u8; 4096];
        let mut tail = VecDeque::with_capacity(8192);
        while let Ok(size) = stderr.read(&mut buffer).await {
            if size == 0 {
                break;
            }
            for byte in &buffer[..size] {
                if tail.len() == 8192 {
                    tail.pop_front();
                }
                tail.push_back(*byte);
            }
        }
        tail.into_iter().collect::<Vec<u8>>()
    });
    update(owner, id, json!({"state":"running"})).await;
    let mut reader = BufReader::new(stdout);
    let outcome=timeout(Duration::from_secs(7200),async {
        loop {
            let next=tokio::select! { _=cancellation.changed()=>return Err(cancelled_error()), value=line(&mut reader)=>value? };
            let Some(bytes)=next else { break; };
            let message:Value=serde_json::from_slice(&bytes).map_err(|_|ApiError::new(502,"Native speech returned an invalid response."))?;
            match message["type"].as_str() {
                Some("progress") => { let progress=&message["progress"]; let status=progress["status"].as_str().filter(|s|s.len()<=512).ok_or_else(||ApiError::new(502,"Native speech returned invalid progress."))?; let amount=progress["progress"].as_f64().unwrap_or(0.).clamp(0.,100.); let mut public=json!({"status":status,"progress":amount}); if let Some(file)=progress["file"].as_str().filter(|s|s.len()<=1024) { public["file"]=json!(file); } update(owner,id,json!({"progress":public})).await; },
                Some("result") => {
                    let completed = result(&message["result"], operation)?;
                    if is_cancelled(&cancellation) { return Err(cancelled_error()); }
                    // Native ORT can abort during process teardown after successful work.
                    // The fixed helper flushes its terminal result and holds the lease;
                    // terminate and reap that owned process before publishing completion.
                    let _ = child.kill().await; let _ = child.wait().await;
                    if operation == "download" && !safe_cache(false).is_ok_and(|path|qualified(&path)) { return Err(ApiError::new(502,"Large V3 did not complete its native execution check. Retry the download.")); }
                    return Ok(completed);
                },
                Some("error") => return Err(ApiError::new(502,message["error"].as_str().filter(|s|s.len()<=4096).unwrap_or("Native speech failed. Saved audio is unchanged."))),
                _ => return Err(ApiError::new(502,"Native speech returned an unsupported response.")),
            }
        }
        let status=tokio::select! { _=cancellation.changed()=>return Err(cancelled_error()), status=child.wait()=>status? };
        if !status.success() { return Err(ApiError::new(502,format!("Native speech stopped unexpectedly ({status}). Saved audio and earlier results are unchanged."))); }
        if operation=="download" && !safe_cache(false).is_ok_and(|path|qualified(&path)) { return Err(ApiError::new(502,"Large V3 did not complete its native execution check. Retry the download.")); }
        Err(ApiError::new(502,"Native speech stopped without a result. Retry the saved audio."))
    }).await.unwrap_or_else(|_|Err(ApiError::new(504,"Native speech exceeded its execution time limit. Saved audio is unchanged.")));
    if outcome.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    let tail = match timeout(Duration::from_secs(1), &mut diagnostics).await {
        Ok(Ok(bytes)) => bytes,
        _ => {
            diagnostics.abort();
            Vec::new()
        }
    };
    if outcome.is_err() {
        if !tail.is_empty() {
            tracing::warn!(job_id = id, diagnostics = %String::from_utf8_lossy(&tail), "Native speech child failed");
        }
        if operation == "download" {
            // An encoder probe followed by a teardown crash is not a qualified download.
            if let Ok(cache) = safe_cache(false) {
                let _ = tokio::fs::remove_file(cache.join("ready.json")).await;
            }
        }
    }
    outcome
}
async fn read(Path(id): Path<String>) -> Result<Json<Value>> {
    let id = valid_id(&id)?;
    let owner = manager();
    let state = owner.state.lock().await;
    state
        .jobs
        .get(&id)
        .map(|job| Json(job.public.clone()))
        .ok_or_else(|| {
            ApiError::new(
                404,
                "This speech job is no longer available. Retry the saved audio.",
            )
        })
}
async fn cancel(Path(id): Path<String>) -> Result<Json<Value>> {
    let id = valid_id(&id)?;
    let owner = manager();
    let mut state = owner.state.lock().await;
    if let Some(job) = state.jobs.get_mut(&id) {
        if !matches!(
            job.public["state"].as_str(),
            Some("completed" | "failed" | "cancelled")
        ) {
            let _ = job.cancel.send(true);
            job.public["state"] = json!("cancelled");
            job.public.as_object_mut().unwrap().remove("result");
        }
    }
    state
        .cancelled
        .retain(|(old, at)| old != &id && at.elapsed() < Duration::from_secs(600));
    state.cancelled.push_back((id.clone(), Instant::now()));
    while state.cancelled.len() > TOMBSTONES {
        state.cancelled.pop_front();
    }
    Ok(Json(json!({"jobId":id,"state":"cancelled"})))
}
async fn remove_model() -> Result<Json<Value>> {
    let owner = manager();
    let state = owner.state.lock().await;
    if state.active.is_some() {
        return Err(ApiError::new(
            409,
            "Finish or cancel native speech before removing its model.",
        ));
    }
    let cache = safe_cache(false)?;
    if cache.exists() {
        tokio::fs::remove_dir_all(cache).await?;
    }
    drop(state);
    Ok(Json(json!({"ok":true})))
}
/// Cancel owned helper and upload work before the HTTP server completes shutdown.
pub async fn shutdown() {
    let owner = manager();
    {
        let state = owner.state.lock().await;
        for job in state.jobs.values() {
            let _ = job.cancel.send(true);
        }
    }
    let _ = timeout(Duration::from_secs(5), async {
        loop {
            if owner.state.lock().await.active.is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn exact_cancel_fences_late_results_and_prestart_requests() {
        let owner = Manager::default();
        let id = uuid::Uuid::new_v4().to_string();
        let mut receiver = reserve(&owner, &id, "transcribe").await.unwrap();
        {
            let mut state = owner.state.lock().await;
            let job = state.jobs.get_mut(&id).unwrap();
            job.cancel.send(true).unwrap();
            job.public["state"] = json!("cancelled");
        }
        receiver.changed().await.unwrap();
        update(&owner, &id, json!({"result":{"wrong":true}})).await;
        finish(&owner, &id, Ok(json!({"wrong":true}))).await;
        let state = owner.state.lock().await;
        assert_eq!(state.jobs[&id].public["state"], "cancelled");
        assert!(state.jobs[&id].public.get("result").is_none());
        assert!(state.active.is_none());
        drop(state);
        let next = uuid::Uuid::new_v4().to_string();
        owner
            .state
            .lock()
            .await
            .cancelled
            .push_back((next.clone(), Instant::now()));
        assert!(reserve(&owner, &next, "transcribe").await.is_err());
    }
    #[tokio::test]
    async fn single_job_and_bounded_history_do_not_evict_active_work() {
        let owner = Manager::default();
        for _ in 0..40 {
            let id = uuid::Uuid::new_v4().to_string();
            let _lease = reserve(&owner, &id, "transcribe").await.unwrap();
            assert!(
                reserve(&owner, &uuid::Uuid::new_v4().to_string(), "transcribe")
                    .await
                    .is_err()
            );
            finish(&owner, &id, Ok(json!({}))).await;
        }
        assert_eq!(owner.state.lock().await.jobs.len(), RETAIN);
    }
    #[tokio::test]
    async fn owned_process_is_killed_on_cancel_without_late_result() {
        let owner = Arc::new(Manager::default());
        let id = uuid::Uuid::new_v4().to_string();
        let receiver = reserve(&owner, &id, "transcribe").await.unwrap();
        let mut command = Command::new("node");
        command.arg("-e").arg("process.stdin.resume(); process.stdout.write(JSON.stringify({type:'progress',progress:{status:'Ready',progress:0}})+'\\n'); setInterval(()=>{},1000)");
        let worker_owner = owner.clone();
        let worker_id = id.clone();
        let task = tokio::spawn(async move {
            supervise(&worker_owner, &worker_id, "transcribe", command, receiver).await
        });
        timeout(Duration::from_secs(5), async {
            loop {
                if owner.state.lock().await.jobs[&id].public["progress"]["status"] == "Ready" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        owner.state.lock().await.jobs[&id]
            .cancel
            .send(true)
            .unwrap();
        let outcome = timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(outcome.unwrap_err().status, StatusCode::CONFLICT);
        finish(&owner, &id, Ok(json!({"late":true}))).await;
        assert_eq!(
            owner.state.lock().await.jobs[&id].public["state"],
            "cancelled"
        );
        assert!(owner.state.lock().await.jobs[&id]
            .public
            .get("result")
            .is_none());
    }
    #[tokio::test]
    async fn terminal_result_reaps_a_helper_holding_its_stdin_lease() {
        let owner = Manager::default();
        let id = uuid::Uuid::new_v4().to_string();
        let receiver = reserve(&owner, &id, "transcribe").await.unwrap();
        let mut command = Command::new("node");
        command.arg("-e").arg("process.stdin.resume();process.stdout.write(JSON.stringify({type:'result',result:{words:[{text:'Hello',timestamp:[0,1]}],duration:2}})+'\\n');setInterval(()=>{},1000)");
        let completed = timeout(
            Duration::from_secs(3),
            supervise(&owner, &id, "transcribe", command, receiver),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(completed["words"][0]["text"], "Hello");
        finish(&owner, &id, Ok(completed)).await;
        assert_eq!(
            owner.state.lock().await.jobs[&id].public["state"],
            "completed"
        );
        assert!(owner.state.lock().await.active.is_none());
    }
    #[tokio::test]
    async fn malformed_and_unavailable_helpers_fail_and_release_the_slot() {
        for malformed in [true, false] {
            let owner = Manager::default();
            let id = uuid::Uuid::new_v4().to_string();
            let receiver = reserve(&owner, &id, "transcribe").await.unwrap();
            let mut command = if malformed {
                Command::new("node")
            } else {
                Command::new("echo-native-missing-test-command")
            };
            if malformed {
                command.arg("-e").arg(
                    "process.stdout.write('{}\\n');process.stdin.resume();setInterval(()=>{},1000)",
                );
            }
            let outcome = timeout(
                Duration::from_secs(5),
                supervise(&owner, &id, "transcribe", command, receiver),
            )
            .await
            .unwrap();
            assert_eq!(
                outcome.as_ref().unwrap_err().status,
                if malformed {
                    StatusCode::BAD_GATEWAY
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                }
            );
            finish(&owner, &id, outcome).await;
            assert!(owner.state.lock().await.active.is_none());
            assert_eq!(owner.state.lock().await.jobs[&id].public["state"], "failed");
        }
    }
    #[tokio::test]
    async fn dropped_upload_cleans_only_owned_spool_and_releases_capacity() {
        let owner = Arc::new(Manager::default());
        let id = uuid::Uuid::new_v4().to_string();
        let _lease = reserve(&owner, &id, "transcribe").await.unwrap();
        let directory = tempfile::tempdir().unwrap();
        let spool = directory.path().join("owned-job");
        std::fs::create_dir(&spool).unwrap();
        std::fs::write(spool.join("audio.f32"), [0; 4]).unwrap();
        let other = directory.path().join("other-agent-data");
        std::fs::write(&other, b"keep").unwrap();
        drop(UploadGuard {
            owner: owner.clone(),
            id: id.clone(),
            spool: spool.clone(),
            armed: true,
        });
        timeout(Duration::from_secs(3), async {
            loop {
                if owner.state.lock().await.active.is_none() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(!spool.exists());
        assert_eq!(std::fs::read(other).unwrap(), b"keep");
        assert_eq!(owner.state.lock().await.jobs[&id].public["state"], "failed");
    }
    #[test]
    fn startup_recovery_removes_only_the_locked_library_namespace() {
        let project = tempfile::tempdir().unwrap();
        let first = project.path().join("first-library");
        let second = project.path().join("second-library");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        let own = spool_namespace(project.path(), &first).unwrap();
        let other = spool_namespace(project.path(), &second).unwrap();
        assert_ne!(own, other);
        let own_job = own.join(uuid::Uuid::new_v4().to_string());
        let other_job = other.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&own_job).unwrap();
        std::fs::create_dir_all(&other_job).unwrap();
        std::fs::write(own_job.join("audio.f32"), b"private orphan").unwrap();
        std::fs::write(other_job.join("audio.f32"), b"live other library").unwrap();
        std::fs::write(own.join("unrelated-note.txt"), b"keep").unwrap();
        clean_namespace(project.path(), &first).unwrap();
        assert!(!own_job.exists());
        assert_eq!(
            std::fs::read(other_job.join("audio.f32")).unwrap(),
            b"live other library"
        );
        assert_eq!(
            std::fs::read(own.join("unrelated-note.txt")).unwrap(),
            b"keep"
        );
        clean_namespace(project.path(), &first).unwrap();
        assert!(other_job.exists());
    }
    #[cfg(unix)]
    #[test]
    fn startup_recovery_rejects_symlink_ancestors_and_never_follows_job_links() {
        use std::os::unix::fs::symlink;
        let project = tempfile::tempdir().unwrap();
        let library = project.path().join("library");
        std::fs::create_dir(&library).unwrap();
        let external = tempfile::tempdir().unwrap();
        std::fs::write(external.path().join("keep"), b"outside").unwrap();
        symlink(external.path(), project.path().join("tmp")).unwrap();
        assert!(clean_namespace(project.path(), &library).is_err());
        std::fs::remove_file(project.path().join("tmp")).unwrap();
        let own = spool_namespace(project.path(), &library).unwrap();
        std::fs::create_dir(project.path().join("tmp")).unwrap();
        symlink(external.path(), &own).unwrap();
        assert!(clean_namespace(project.path(), &library).is_err());
        std::fs::remove_file(&own).unwrap();
        std::fs::create_dir(&own).unwrap();
        let job = own.join(uuid::Uuid::new_v4().to_string());
        symlink(external.path(), &job).unwrap();
        assert!(clean_namespace(project.path(), &library).is_err());
        std::fs::remove_file(&job).unwrap();
        std::fs::create_dir(&job).unwrap();
        symlink(external.path(), job.join("external")).unwrap();
        clean_namespace(project.path(), &library).unwrap();
        assert!(!job.exists());
        assert_eq!(
            std::fs::read(external.path().join("keep")).unwrap(),
            b"outside"
        );
    }
    #[test]
    fn timestamps_and_marker_metadata_are_validated() {
        assert!(result(
            &json!({"words":[{"text":"Hello","timestamp":[0.,1.]}],"duration":2.}),
            "transcribe"
        )
        .is_ok());
        for bad in [
            json!({"words":[{"text":"Hello","timestamp":[1.,0.]}],"duration":2.}),
            json!({"words":[{"text":"Hello","timestamp":[0.,null]}],"duration":2.}),
            json!({"words":[],"duration":7201.}),
        ] {
            assert!(result(&bad, "transcribe").is_err());
        }
        let folder = tempfile::tempdir().unwrap();
        let pinned = format!("{CHECKPOINT}/{REVISION}");
        std::fs::create_dir_all(folder.path().join(format!("{pinned}/onnx"))).unwrap();
        let mut entries = Vec::new();
        for (name, size) in WEIGHTS {
            let path = format!("{pinned}/onnx/{name}");
            std::fs::File::create(folder.path().join(&path))
                .unwrap()
                .set_len(size)
                .unwrap();
            entries.push(json!({"path":path,"size":size}));
        }
        for name in MODEL_JSON {
            let path = format!("{pinned}/{name}");
            std::fs::write(folder.path().join(&path), b"{}").unwrap();
            entries.push(json!({"path":path,"size":2}));
        }
        let mut marker = json!({"version":1,"modelId":MODEL,"checkpoint":CHECKPOINT,"revision":REVISION,"forwardVerified":true,"files":entries});
        let write = |marker: &Value| {
            std::fs::write(
                folder.path().join("ready.json"),
                serde_json::to_vec(marker).unwrap(),
            )
            .unwrap()
        };
        write(&marker);
        assert!(qualified(folder.path()));
        marker["files"][0]["path"] = json!("../weights.onnx");
        write(&marker);
        assert!(!qualified(folder.path()));
        marker["files"][0]["path"] = json!(format!("{pinned}/onnx/{}", WEIGHTS[0].0));
        marker["forwardVerified"] = json!(false);
        write(&marker);
        assert!(!qualified(folder.path()));
    }
    #[tokio::test]
    async fn bounded_protocol_rejects_partial_and_oversized_lines() {
        assert!(line(&mut BufReader::new(&b"{}"[..])).await.is_err());
        let data = vec![b'x'; MAX_LINE + 1];
        assert!(line(&mut BufReader::new(&data[..])).await.is_err());
        assert_eq!(
            line(&mut BufReader::new(&b"{}\n"[..]))
                .await
                .unwrap()
                .unwrap(),
            b"{}\n"
        );
    }
}
