#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod instance;
mod library;
// The shared wire module also includes verification/signing helpers used only by the server.
#[cfg_attr(not(test), expect(dead_code))]
#[path = "../../server/src/control_protocol.rs"]
mod protocol;
mod runtime;
mod update;
use runtime::{LaunchPaths, RestartBudget, RuntimeSupervisor, ShutdownOutcome, ShutdownReason};
use std::sync::Mutex;
use tauri::Manager;
struct Desktop {
    paths: LaunchPaths,
    supervisor: Option<RuntimeSupervisor>,
    error: Option<String>,
    budget: RestartBudget,
    quit_requested: bool,
    pending_update: Option<update::PendingUpdate>,
    updating: bool,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct View {
    running: bool,
    detail: String,
    browsers: Vec<runtime::Browser>,
    choice: Option<String>,
    workspace_url: Option<String>,
    quit_requested: bool,
    library_path: String,
}
#[tauri::command]
fn status(state: tauri::State<Mutex<Desktop>>) -> View {
    let mut s = state.lock().unwrap();
    if let Ok(selected) = library::selected(&s.paths.app_base) {
        s.paths.data = selected;
    }
    let result = s.supervisor.as_mut().map(|r| r.status());
    let (running,detail,url)=match result{Some(Ok(status))=>(true,"Echo is running. Closing a workspace tab leaves Echo available for recording transfers.".into(),Some(status.workspace_url)),Some(Err(e))=>(false,e,None),None=>(false,s.error.clone().unwrap_or_else(||"Echo is stopped.".into()),None)};
    View {
        running,
        detail,
        browsers: runtime::browsers(),
        choice: runtime::read_choice(&s.paths.app_base),
        library_path: s.paths.data.display().to_string(),
        workspace_url: url,
        quit_requested: std::mem::take(&mut s.quit_requested),
    }
}
#[tauri::command]
fn retry(state: tauri::State<Mutex<Desktop>>) -> Result<(), String> {
    let mut s = state.lock().unwrap();
    if s.updating {
        return Err("Wait for the current maintenance operation to finish.".into());
    }
    if s.supervisor.as_mut().is_some_and(|r| r.status().is_ok()) {
        return Ok(());
    }
    s.supervisor.take();
    if !s.budget.permit() {
        return Err("Echo stopped three times in five minutes. Wait before retrying and review the server log.".into());
    }
    match RuntimeSupervisor::start(s.paths.clone()) {
        Ok(r) => {
            s.paths.data = r.data.clone();
            s.supervisor = Some(r);
            s.error = None;
            Ok(())
        }
        Err(e) => {
            s.error = Some(e.clone());
            Err(e)
        }
    }
}
#[tauri::command]
fn open_echo(browser_id: String, state: tauri::State<Mutex<Desktop>>) -> Result<(), String> {
    let mut s = state.lock().unwrap();
    let browser = runtime::browsers()
        .into_iter()
        .find(|b| b.id == browser_id)
        .ok_or("Choose an installed Brave or Google Chrome browser.")?;
    let url = s
        .supervisor
        .as_mut()
        .ok_or("Start Echo first.")?
        .status()?
        .workspace_url;
    runtime::open(&browser, &url)?;
    runtime::save_choice(&s.paths.app_base, &browser.id)
}
#[tauri::command]
fn quit(force: bool, app: tauri::AppHandle, state: tauri::State<Mutex<Desktop>>) -> QuitReply {
    let mut s = state.lock().unwrap();
    if s.updating {
        return QuitReply {
            kind: "retry",
            message: "Wait for the current maintenance operation to finish.".into(),
            can_force: false,
        };
    }
    if let Some(r) = &mut s.supervisor {
        match r.request_shutdown(if force{ShutdownReason::Force}else{ShutdownReason::Requested}) {
            Ok(ShutdownOutcome::Stopped | ShutdownOutcome::Detached) => {},
            Ok(ShutdownOutcome::Busy(status)) => return QuitReply {kind:"busy",message:format!("Echo has {} active requests and {} recording or processing tasks. Wait for them to finish, or Quit anyway. Extension recording can remain in this browser and transfer when Echo reopens.",status.active_requests,status.active_processing),can_force:true},
            Err(error) => return QuitReply {kind:"retry",message:format!("{error} Choose Quit anyway to stop only this launcher's server, or keep Echo running."),can_force:r.running.child.is_some()},
        }
    }
    app.exit(0);
    QuitReply {
        kind: "stopped",
        message: String::new(),
        can_force: false,
    }
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct QuitReply {
    kind: &'static str,
    message: String,
    can_force: bool,
}
#[tauri::command]
fn update_status() -> String {
    update::status().into()
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateReply {
    kind: &'static str,
    message: String,
    can_install: bool,
}
#[tauri::command]
async fn check_updates(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Desktop>>,
) -> Result<UpdateReply, String> {
    {
        let mut desktop = state.lock().unwrap();
        if desktop.updating {
            return Err("A maintenance operation is already running.".into());
        }
        desktop.pending_update = None;
    }
    if !cfg!(target_os = "macos") {
        return Ok(UpdateReply{kind:"manual",message:"Ubuntu .deb updates require a verified package from https://echovoice.samarthmn.com. Automatic installation is not enabled for .deb packages.".into(),can_install:false});
    }
    if update::TrustConfig::compiled()?.is_none() {
        return Ok(UpdateReply {
            kind: "disabled",
            message: update::status().into(),
            can_install: false,
        });
    }
    match update::check(&app).await? {
        None => Ok(UpdateReply {
            kind: "current",
            message: "Echo is up to date with the configured release channel.".into(),
            can_install: false,
        }),
        Some(update) => {
            let message=format!("Echo {} is available. Install update will verify the download and restart Echo after active work finishes. Browser recordings remain saved locally.",update.version());
            state.lock().unwrap().pending_update = Some(update);
            Ok(UpdateReply {
                kind: "available",
                message,
                can_install: true,
            })
        }
    }
}
struct UpdateActivity(tauri::AppHandle);
impl Drop for UpdateActivity {
    fn drop(&mut self) {
        self.0.state::<Mutex<Desktop>>().lock().unwrap().updating = false;
    }
}
#[tauri::command]
async fn install_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Desktop>>,
) -> Result<String, String> {
    if !cfg!(target_os = "macos") {
        return Err("Install the verified Ubuntu .deb package using your system installer.".into());
    }
    let pending = {
        let mut desktop = state.lock().unwrap();
        if desktop.updating {
            return Err("A maintenance operation is already running.".into());
        }
        let pending = desktop
            .pending_update
            .clone()
            .ok_or("Check for a signed update first.")?;
        desktop.updating = true;
        pending
    };
    let _activity = UpdateActivity(app.clone());
    // Failed downloads leave the running server and installed application intact.
    let bytes = pending.download_verified().await?;
    let paths = {
        let desktop = state.lock().unwrap();
        // Prepare fallible resources before stopping the server. Every error
        // after quiescence must pass through the restart handler below.
        instance::private_directory(&desktop.paths.runtime)?;
        std::env::set_var("TMPDIR", &desktop.paths.runtime);
        desktop.paths.clone()
    };
    {
        let mut desktop = state.lock().unwrap();
        let runtime = desktop
            .supervisor
            .as_mut()
            .ok_or("Start Echo before installing an update.")?;
        if runtime.running.child.is_none() {
            return Err("Install the update from the Echo window that started this server.".into());
        }
        match runtime.request_shutdown(ShutdownReason::Requested)?{
            // Keep the exclusive launcher lock until installation/restart completes.
            ShutdownOutcome::Stopped=>{},
            ShutdownOutcome::Busy(_)=>return Err("Echo is recording, transferring, or processing. Finish that work, then choose Install update again.".into()),
            ShutdownOutcome::Detached=>return Err("Echo lost its runtime connection. Restart Echo before updating.".into()),
        }
    }
    let installation = tauri::async_runtime::spawn_blocking(move || {
        update::replace_after_snapshot(
            || library::snapshot_for_update(&paths,pending.version()),
            || pending.install_verified(bytes),
        )
    }).await.map_err(|_|"The update stopped before it could finish. Reopen Echo; your library and any completed backup remain available.".to_owned())
        .and_then(|result|result);
    let snapshot = match installation {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let mut desktop = state.lock().unwrap();
            desktop.supervisor.take();
            match RuntimeSupervisor::start(desktop.paths.clone()) {
                Ok(runtime) => {
                    desktop.paths.data = runtime.data.clone();
                    desktop.supervisor = Some(runtime)
                }
                Err(start_error) => desktop.error = Some(start_error),
            };
            return Err(error);
        }
    };
    eprintln!(
        "Echo update: verified encrypted library backup saved at {}",
        snapshot.path.display()
    );
    // Retain the snapshot's source lock until the process restarts.
    let _snapshot = snapshot;
    app.restart();
}
fn begin_maintenance(app: &tauri::AppHandle) -> Result<UpdateActivity, String> {
    let state = app.state::<Mutex<Desktop>>();
    let mut desktop = state.lock().unwrap();
    if desktop.updating {
        return Err("A maintenance operation is already running.".into());
    }
    desktop.updating = true;
    Ok(UpdateActivity(app.clone()))
}
fn maintain_library(
    app: &tauri::AppHandle,
    work: impl FnOnce(&LaunchPaths) -> Result<LaunchPaths, String>,
) -> Result<(), String> {
    let state = app.state::<Mutex<Desktop>>();
    let (mut supervisor, paths) = {
        let mut desktop = state.lock().unwrap();
        if desktop
            .supervisor
            .as_ref()
            .is_some_and(|runtime| runtime.running.child.is_none())
        {
            return Err(
                "Use the Echo window that started this server to manage its library.".into(),
            );
        }
        (desktop.supervisor.take(), desktop.paths.clone())
    };
    let fallback_lock;
    if let Some(runtime) = supervisor.as_mut() {
        let shutdown = runtime.request_shutdown(ShutdownReason::Requested);
        let error = match shutdown {
            Ok(ShutdownOutcome::Stopped) => None,
            Ok(ShutdownOutcome::Busy(_)) => Some(
                "Finish recording, transfers, and processing before managing the library.".into(),
            ),
            Ok(ShutdownOutcome::Detached) => {
                Some("Restart Echo before managing its library.".into())
            }
            Err(error) => Some(error),
        };
        if let Some(error) = error {
            state.lock().unwrap().supervisor = supervisor;
            return Err(error);
        }
        fallback_lock = None;
    } else {
        let (instance, owned) = instance::Instance::acquire(&paths.runtime)?;
        if !owned {
            return Err(
                "Another Echo window is using this library. Close it before continuing.".into(),
            );
        }
        fallback_lock = Some(instance);
    }
    // Native events stay responsive while the local owner retains the launcher lock.
    let outcome = work(&paths);
    let next_paths = outcome.as_ref().unwrap_or(&paths).clone();
    drop(supervisor);
    drop(fallback_lock);
    let started = RuntimeSupervisor::start(next_paths.clone());
    let mut desktop = state.lock().unwrap();
    desktop.paths = next_paths;
    match started {
        Ok(runtime) => {
            desktop.paths.data = runtime.data.clone();
            desktop.supervisor = Some(runtime);
            desktop.error = None;
        }
        Err(error) => desktop.error = Some(error),
    }
    outcome.map(|_| ())
}
fn pick_library(app: &tauri::AppHandle) -> Result<Option<std::path::PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .set_title("Choose an Echo data folder")
        .blocking_pick_folder()
        .map(|path| {
            path.into_path()
                .map_err(|_| "Choose a local folder.".to_owned())
        })
        .transpose()
}
#[tauri::command]
async fn choose_library(app: tauri::AppHandle) -> Result<String, String> {
    let activity = begin_maintenance(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _activity=activity;
        let Some(source)=pick_library(&app)? else { return Ok("Library selection cancelled.".into()); };
        maintain_library(&app, |paths| library::import_with(paths,&source,|copy|library::validate_copy(copy,&source)))?;
        Ok("Library copied and verified. Echo now uses the copy; the original folder is preserved. Browser recordings still belong to their existing browser profile.".into())
    }).await.map_err(|_| "Library selection could not finish. Your original is preserved.".to_owned())?
}
#[tauri::command]
async fn recover_library(
    phrase: String,
    other_library: bool,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let phrase = zeroize::Zeroizing::new(phrase);
    if phrase.len() > 4096 || phrase.split_whitespace().count() != 24 {
        return Err("Enter the 24 words from this library's recovery phrase.".into());
    }
    let activity = begin_maintenance(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _activity=activity;
        let source=if other_library { let Some(path)=pick_library(&app)? else { return Ok("Library recovery cancelled.".into()); }; Some(path) } else {None};
        maintain_library(&app, |paths| {
            let mut target=paths.clone();
            if let Some(source)=source { target.data=source; }
            library::maintenance(&target,Some(phrase))?;
            Ok(paths.clone())
        })?;
        Ok("The library key was restored to your operating system credential store. If you recovered another folder, choose Copy existing library to use it.".into())
    }).await.map_err(|_| "Library recovery could not finish. Your saved data is preserved.".to_owned())?
}
#[tauri::command]
fn browser_download(browser_id: String) -> Result<(), String> {
    let url = match browser_id.as_str() {
        "brave" => "https://brave.com/download/",
        "chrome" => "https://www.google.com/chrome/",
        _ => return Err("Choose Brave or Chrome.".into()),
    };
    std::process::Command::new(if cfg!(target_os = "macos") {
        "/usr/bin/open"
    } else {
        "xdg-open"
    })
    .arg(url)
    .spawn()
    .map_err(|_| "Open the browser's official download page in your browser.".to_owned())?;
    Ok(())
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let packaged = app.path().resource_dir()?.join("runtime");
            let resource = if cfg!(debug_assertions) {
                std::env::var_os("ECHO_DESKTOP_RESOURCE_DIR")
                    .map(std::path::PathBuf::from)
                    .unwrap_or(packaged)
            } else {
                packaged
            };
            let paths = LaunchPaths::resolve(resource)?;
            let mut desktop = Desktop {
                paths,
                supervisor: None,
                error: None,
                budget: RestartBudget::default(),
                quit_requested: false,
                pending_update: None,
                updating: false,
            };
            desktop.budget.permit();
            match RuntimeSupervisor::start(desktop.paths.clone()) {
                Ok(runtime) => {
                    desktop.paths.data = runtime.data.clone();
                    desktop.supervisor = Some(runtime)
                }
                Err(error) => desktop.error = Some(error),
            }
            app.manage(Mutex::new(desktop));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
            retry,
            open_echo,
            quit,
            update_status,
            check_updates,
            install_update,
            browser_download,
            choose_library,
            recover_library
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                window
                    .state::<Mutex<Desktop>>()
                    .lock()
                    .unwrap()
                    .quit_requested = true;
            }
        })
        .build(tauri::generate_context!())
        .expect("Could not open the Echo status window")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
                app.state::<Mutex<Desktop>>().lock().unwrap().quit_requested = true;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
}
