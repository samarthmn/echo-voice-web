use crate::{
    instance::{private_directory, private_file, Instance},
    protocol::Status,
};
use std::{
    collections::VecDeque,
    io::Write,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    time::{Duration, Instant},
};
pub type LaunchError = String;
#[derive(Clone)]
pub struct LaunchPaths {
    pub resource: PathBuf,
    pub app_base: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
    pub logs: PathBuf,
    pub runtime: PathBuf,
}
impl LaunchPaths {
    pub fn resolve(resource: PathBuf) -> Result<Self, String> {
        let home =
            PathBuf::from(std::env::var_os("HOME").ok_or("Your home directory is unavailable.")?);
        let xdg = |key: &str, fallback: PathBuf| {
            std::env::var_os(key)
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .unwrap_or(fallback)
        };
        let (mut data, mut cache, mut logs) = if cfg!(target_os = "macos") {
            (
                home.join("Library/Application Support/Echo Voice"),
                home.join("Library/Caches/Echo Voice"),
                home.join("Library/Logs/Echo Voice"),
            )
        } else {
            (
                xdg("XDG_DATA_HOME", home.join(".local/share")).join("echo-voice"),
                xdg("XDG_CACHE_HOME", home.join(".cache")).join("echo-voice"),
                xdg("XDG_STATE_HOME", home.join(".local/state")).join("echo-voice"),
            )
        };
        if cfg!(debug_assertions) {
            if let Some(value) = std::env::var_os("ECHO_DESKTOP_DATA_DIR") {
                let directory = PathBuf::from(value);
                if !directory.is_absolute() {
                    return Err("The debug data folder must be absolute.".into());
                }
                cache = directory.join("cache");
                logs = directory.join("logs");
                data = directory;
            }
        }
        let app_base = data;
        let data = crate::library::selected(&app_base)?;
        use sha2::{Digest, Sha256};
        let hash = format!(
            "{:x}",
            Sha256::digest(app_base.as_os_str().as_encoded_bytes())
        );
        let runtime = cache.join("runtime").join(&hash[..12]);
        Ok(Self {
            resource,
            app_base,
            data,
            cache,
            logs,
            runtime,
        })
    }
    pub fn prepare(&self) -> Result<(), String> {
        for path in [
            &self.app_base,
            &self.data,
            &self.cache,
            &self.logs,
            &self.runtime,
        ] {
            private_directory(path)?;
        }
        if self.runtime.join("s").as_os_str().len()
            >= if cfg!(target_os = "macos") { 104 } else { 108 }
        {
            return Err(
                "Echo's private runtime folder path is too long. Use a shorter cache folder."
                    .into(),
            );
        }
        Ok(())
    }
    pub fn server_command(&self) -> Command {
        let mut command = Command::new(self.resource.join("bin/echo-server"));
        command.env_clear();
        #[cfg(test)]
        command.env("ECHO_TEST_MODE", "1").env(
            "ECHO_TEST_STORAGE_KEY",
            "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=",
        );
        #[cfg(all(debug_assertions, not(test)))]
        if std::env::var("ECHO_TEST_MODE").as_deref() == Ok("1")
            && std::env::var_os("ECHO_DESKTOP_DATA_DIR").is_some()
        {
            if let Some(key) = std::env::var_os("ECHO_TEST_STORAGE_KEY") {
                command
                    .env("ECHO_TEST_MODE", "1")
                    .env("ECHO_TEST_STORAGE_KEY", key);
            }
        }
        forward_environment(&mut command, |name| std::env::var_os(name));
        command
            .env("ECHO_RUNTIME_MODE", "installed")
            .env("ECHO_RESOURCE_DIR", &self.resource)
            .env("ECHO_DATA_DIR", &self.data)
            .env("ECHO_CACHE_DIR", &self.cache)
            .env("ECHO_LOG_DIR", &self.logs)
            .env("ECHO_RUNTIME_DIR", &self.runtime)
            .env("TMPDIR", &self.runtime)
            .current_dir(&self.data);
        command
    }
    pub fn bind(&self) -> Result<std::net::SocketAddr, String> {
        // Keep the browser origin stable when the selected library changes.
        let config = self.app_base.join("config.json");
        let raw = if config.exists() {
            let value: serde_json::Value = serde_json::from_reader(private_file(&config)?)
                .map_err(|_| {
                    "Echo config.json is invalid. Restore its previous version.".to_owned()
                })?;
            value["bind"]
                .as_str()
                .unwrap_or("127.0.0.1:3000")
                .to_owned()
        } else {
            "127.0.0.1:3000".into()
        };
        let address: std::net::SocketAddr = raw
            .parse()
            .map_err(|_| "Use a loopback IP and port in config.json.".to_owned())?;
        if address.ip() != std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
            || address.port() == 0
        {
            return Err("The desktop launcher requires 127.0.0.1 and a fixed port in config.json so your browser workspace keeps the same localhost origin.".into());
        }
        Ok(address)
    }
}
pub struct RunningInstance {
    pub workspace_url: String,
    pub child: Option<Child>,
    instance: Instance,
    _lease: Option<ChildStdin>,
}
pub enum ShutdownReason {
    Requested,
    Force,
}
pub enum ShutdownOutcome {
    Stopped,
    Detached,
    Busy(Status),
}
fn forward_environment(command: &mut Command, read: impl Fn(&str) -> Option<std::ffi::OsString>) {
    for name in [
        "HOME",
        "LANG",
        "LC_ALL",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
        "DISPLAY",
        "WAYLAND_DISPLAY",
    ] {
        if let Some(value) = read(name) {
            command.env(name, value);
        }
    }
}
pub struct RuntimeSupervisor {
    pub data: PathBuf,
    pub running: RunningInstance,
}
impl RuntimeSupervisor {
    pub fn start(mut paths: LaunchPaths) -> Result<Self, LaunchError> {
        private_directory(&paths.runtime)?;
        let (instance, owned) = Instance::acquire(&paths.runtime)?;
        paths.data = crate::library::selected(&paths.app_base)?;
        paths.prepare()?;
        if !owned {
            let status = instance.request("status", false)?;
            return Ok(Self {
                data: paths.data.clone(),
                running: RunningInstance {
                    workspace_url: status.workspace_url,
                    child: None,
                    instance,
                    _lease: None,
                },
            });
        }
        let bind = paths.bind()?;
        let probe=TcpListener::bind(bind).map_err(|_|format!("Port {} is occupied by another application or an older Echo. Close that application, then Retry. Advanced: change bind in {}. Echo has not connected to it.",bind.port(),paths.data.join("config.json").display()))?;
        drop(probe);
        let binary = paths.resource.join("bin/echo-server");
        if !binary.is_file() || !paths.resource.join("public/index.html").is_file() {
            return Err("Echo's runtime resources are missing. Reinstall the application.".into());
        }
        let log = private_file(&paths.logs.join("server.log"))?;
        log.set_len(0).map_err(|e| e.to_string())?;
        let mut command = paths.server_command();
        command
            .env("ECHO_BIND", bind.to_string())
            .env("ECHO_CONTROL_STDIN", "1")
            .current_dir(&paths.data)
            .stdin(Stdio::piped())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log);
        let mut child = command.spawn().map_err(|_| {
            "Echo could not start its server. Reinstall the application.".to_owned()
        })?;
        let mut lease = child
            .stdin
            .take()
            .ok_or("Echo's private process channel is unavailable.")?;
        if writeln!(lease, "{}", serde_json::to_string(&instance.auth).unwrap()).is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Echo's private runtime bootstrap failed.".into());
        }
        for _ in 0..100 {
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                return Err(format!(
                    "Echo's server stopped during startup. Review {}.",
                    paths.logs.join("server.log").display()
                ));
            }
            if let Ok(status) = instance.request("status", false) {
                return Ok(Self {
                    data: paths.data.clone(),
                    running: RunningInstance {
                        workspace_url: status.workspace_url,
                        child: Some(child),
                        instance,
                        _lease: Some(lease),
                    },
                });
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
        Err("Echo did not become ready. Retry or reinstall the application.".into())
    }
    pub fn status(&mut self) -> Result<Status, String> {
        if let Some(child) = &mut self.running.child {
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                return Err(
                    "Echo's server stopped. Your saved data remains available; choose Retry."
                        .into(),
                );
            }
        }
        let status = self.running.instance.request("status", false)?;
        if status.workspace_url != self.running.workspace_url {
            return Err("Echo's runtime origin changed unexpectedly. Restart Echo.".into());
        }
        Ok(status)
    }
    pub fn request_shutdown(
        &mut self,
        reason: ShutdownReason,
    ) -> Result<ShutdownOutcome, LaunchError> {
        let force = matches!(reason, ShutdownReason::Force);
        let status = match self.running.instance.request("shutdown", force) {
            Ok(status) => status,
            Err(error) => {
                if let Some(child) = &mut self.running.child {
                    if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                        return Ok(ShutdownOutcome::Stopped);
                    }
                    // A retained Child is our authority to terminate this process;
                    // a socket path, port, or saved PID is never enough.
                    if force {
                        child.kill().map_err(|e| e.to_string())?;
                        child.wait().map_err(|e| e.to_string())?;
                        return Ok(ShutdownOutcome::Stopped);
                    }
                } else {
                    // This window owns no process. Leaving it cannot terminate
                    // an unrelated or replacement server after the owner exits.
                    return Ok(ShutdownOutcome::Detached);
                }
                return Err(error);
            }
        };
        if !status.shutting_down {
            return Ok(ShutdownOutcome::Busy(status));
        }
        if let Some(child) = &mut self.running.child {
            for _ in 0..100 {
                if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                    return Ok(ShutdownOutcome::Stopped);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            if force {
                child.kill().map_err(|e| e.to_string())?;
                child.wait().map_err(|e| e.to_string())?;
            } else {
                return Err(
                    "Echo is finishing shutdown. Wait, or deliberately choose Quit anyway.".into(),
                );
            }
        }
        Ok(ShutdownOutcome::Stopped)
    }
}
impl Drop for RuntimeSupervisor {
    fn drop(&mut self) {
        self.running._lease.take(); /* EOF asks only our owned child to shut down. */
    }
}
#[derive(Default)]
pub struct RestartBudget(VecDeque<Instant>);
impl RestartBudget {
    pub fn permit(&mut self) -> bool {
        let now = Instant::now();
        while self
            .0
            .front()
            .is_some_and(|v| now.duration_since(*v) > Duration::from_secs(300))
        {
            self.0.pop_front();
        }
        if self.0.len() >= 3 {
            return false;
        }
        self.0.push_back(now);
        true
    }
}
#[derive(Clone, serde::Serialize)]
pub struct Browser {
    pub id: String,
    pub name: String,
    #[serde(skip)]
    pub path: PathBuf,
}
pub fn browsers() -> Vec<Browser> {
    let candidates: &[(&str, &str, &str)] = if cfg!(target_os = "macos") {
        &[
            ("brave", "Brave", "/Applications/Brave Browser.app"),
            ("chrome", "Google Chrome", "/Applications/Google Chrome.app"),
        ]
    } else {
        &[
            ("brave", "Brave", "/usr/bin/brave-browser"),
            ("chrome", "Google Chrome", "/usr/bin/google-chrome"),
            (
                "chrome-stable",
                "Google Chrome",
                "/usr/bin/google-chrome-stable",
            ),
        ]
    };
    candidates
        .iter()
        .filter(|(_, _, path)| Path::new(path).exists())
        .map(|(id, name, path)| Browser {
            id: (*id).into(),
            name: (*name).into(),
            path: PathBuf::from(path),
        })
        .collect()
}
pub fn open(browser: &Browser, url: &str) -> Result<(), String> {
    let mut command = if cfg!(target_os = "macos") {
        let mut c = Command::new("/usr/bin/open");
        c.arg("-a").arg(&browser.path);
        c
    } else {
        Command::new(&browser.path)
    };
    command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| {
            "The selected browser could not open. Choose another installed browser.".to_owned()
        })?;
    Ok(())
}
pub fn read_choice(data: &Path) -> Option<String> {
    let path = data.join("browser.json");
    let file = private_file(&path).ok()?;
    serde_json::from_reader(file).ok()
}
pub fn save_choice(data: &Path, choice: &str) -> Result<(), String> {
    let mut file = private_file(&data.join("browser.json"))?;
    file.set_len(0).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(choice).unwrap())
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, LaunchPaths) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let tmp = root.join("tmp");
        std::fs::create_dir_all(&tmp).unwrap();
        let dir = tempfile::Builder::new()
            .prefix("dl-")
            .tempdir_in(tmp)
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
        std::fs::create_dir_all(paths.resource.join("public")).unwrap();
        std::fs::create_dir_all(paths.resource.join("bin")).unwrap();
        std::fs::write(
            paths.resource.join("public/index.html"),
            "test installed assets",
        )
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut config = private_file(&paths.data.join("config.json")).unwrap();
        write!(config,"{}",serde_json::json!({"bind":format!("127.0.0.1:{port}"),"dataDir":"ignored","googleRedirectUri":format!("http://localhost:{port}/api/integrations/google/callback"),"codexBinary":null})).unwrap();
        (dir, paths)
    }
    #[test]
    fn retries_stop_after_three_failures() {
        let mut b = RestartBudget::default();
        assert!(b.permit());
        assert!(b.permit());
        assert!(b.permit());
        assert!(!b.permit());
    }
    #[test]
    fn unsupported_browsers_are_never_offered() {
        assert!(browsers()
            .iter()
            .all(|b| matches!(b.id.as_str(), "brave" | "chrome" | "chrome-stable")));
    }
    #[test]
    fn occupied_port_is_never_accepted_as_owned_echo() {
        let (_dir, paths) = fixture();
        let address = paths.bind().unwrap();
        let listener = TcpListener::bind(address).unwrap();
        assert!(RuntimeSupervisor::start(paths)
            .err()
            .unwrap()
            .contains("occupied"));
        assert_eq!(listener.local_addr().unwrap(), address);
    }
    #[test]
    fn missing_server_is_reported_without_starting_a_child() {
        let (_dir, paths) = fixture();
        assert!(RuntimeSupervisor::start(paths)
            .err()
            .unwrap()
            .contains("resources are missing"));
    }
    #[test]
    fn desktop_rejects_other_loopback_addresses_and_keeps_port_across_library_selection() {
        let (_dir, mut paths) = fixture();
        let original = paths.bind().unwrap();
        paths.data = paths.app_base.join("libraries").join("fixture");
        assert_eq!(paths.bind().unwrap(), original);
        for bind in ["[::1]:3000", "127.0.0.2:3000", "127.0.0.1:0"] {
            std::fs::write(
                paths.app_base.join("config.json"),
                serde_json::json!({"bind":bind}).to_string(),
            )
            .unwrap();
            assert!(paths
                .bind()
                .err()
                .unwrap()
                .contains("127.0.0.1 and a fixed port"));
        }
    }
    #[test]
    fn restarted_launcher_reloads_selection_after_acquiring_owner_lock() {
        let (_dir, paths) = fixture();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        std::fs::copy(
            root.join("target/debug/echo-server"),
            paths.resource.join("bin/echo-server"),
        )
        .unwrap();
        let mut owner = RuntimeSupervisor::start(paths.clone()).unwrap();
        let mut attached = RuntimeSupervisor::start(paths.clone()).unwrap();
        assert!(matches!(
            owner.request_shutdown(ShutdownReason::Requested).unwrap(),
            ShutdownOutcome::Stopped
        ));
        drop(owner);
        let id = "abcdef0123456789abcdef0123456789";
        let selected = paths.app_base.join("libraries").join(id);
        private_directory(&selected).unwrap();
        std::fs::copy(
            paths.data.join("workspace.sqlite"),
            selected.join("workspace.sqlite"),
        )
        .unwrap();
        std::fs::write(
            paths.app_base.join("library.json"),
            serde_json::to_vec(id).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            attached
                .request_shutdown(ShutdownReason::Requested)
                .unwrap(),
            ShutdownOutcome::Detached
        ));
        drop(attached);
        let mut restarted = RuntimeSupervisor::start(paths).unwrap();
        assert_eq!(restarted.data, selected);
        assert!(matches!(
            restarted
                .request_shutdown(ShutdownReason::Requested)
                .unwrap(),
            ShutdownOutcome::Stopped
        ));
    }
    #[test]
    fn real_server_is_authenticated_reused_and_only_owned_child_stops() {
        let (_dir, paths) = fixture();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let server = std::env::var_os("ECHO_TEST_BINARY")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("target/debug/echo-server"));
        assert!(
            server.is_file(),
            "Build echo-server before desktop integration tests"
        );
        std::fs::copy(server, paths.resource.join("bin/echo-server")).unwrap();
        let mut owner = RuntimeSupervisor::start(paths.clone()).unwrap();
        let status = owner.status().unwrap();
        assert!(status.workspace_url.starts_with("http://localhost:"));
        let mut second = RuntimeSupervisor::start(paths).unwrap();
        assert!(second.running.child.is_none());
        assert_eq!(second.status().unwrap().instance_id, status.instance_id);
        // An unfinished real upload must prevent an ordinary quit.
        let mut upload =
            std::net::TcpStream::connect(paths_bind(&owner.running.workspace_url)).unwrap();
        write!(upload,"POST /api/meetings HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{{",owner.running.workspace_url.trim_start_matches("http://")).unwrap();
        for _ in 0..100 {
            if owner.status().unwrap().active_requests > 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(matches!(
            owner.request_shutdown(ShutdownReason::Requested).unwrap(),
            ShutdownOutcome::Busy(_)
        ));
        drop(upload);
        for _ in 0..100 {
            if owner.status().unwrap().active_requests == 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(matches!(
            owner.request_shutdown(ShutdownReason::Requested).unwrap(),
            ShutdownOutcome::Stopped
        ));
        assert!(owner
            .running
            .child
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_some());
        assert!(matches!(
            second.request_shutdown(ShutdownReason::Requested).unwrap(),
            ShutdownOutcome::Detached
        ));
    }
    #[test]
    fn explicit_force_stops_only_retained_child_when_control_socket_is_lost() {
        let (_dir, paths) = fixture();
        let (instance, _) = Instance::acquire(&paths.runtime).unwrap();
        let child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut unrelated = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut owner = RuntimeSupervisor {
            data: paths.data.clone(),
            running: RunningInstance {
                workspace_url: "http://localhost:3000".into(),
                child: Some(child),
                instance,
                _lease: None,
            },
        };
        let outcome = owner.request_shutdown(ShutdownReason::Force);
        let owned_stopped = owner
            .running
            .child
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_some();
        let unrelated_running = unrelated.try_wait().unwrap().is_none();
        // Reap both processes even while exercising the failing pre-fix behavior.
        let _ = owner.running.child.as_mut().unwrap().kill();
        let _ = owner.running.child.as_mut().unwrap().wait();
        let _ = unrelated.kill();
        let _ = unrelated.wait();
        assert!(matches!(outcome, Ok(ShutdownOutcome::Stopped)));
        assert!(owned_stopped);
        assert!(unrelated_running);
    }
    fn paths_bind(url: &str) -> String {
        url.trim_start_matches("http://")
            .replace("localhost", "127.0.0.1")
    }
    #[test]
    fn server_environment_preserves_linux_keyring_session_without_inheriting_credentials() {
        let mut command = Command::new("/usr/bin/env");
        command.env_clear();
        forward_environment(&mut command, |name| match name {
            "DBUS_SESSION_BUS_ADDRESS" => Some("unix:path=/run/user/1000/bus".into()),
            "XDG_RUNTIME_DIR" => Some("/run/user/1000".into()),
            "DISPLAY" => Some(":0".into()),
            "WAYLAND_DISPLAY" => Some("wayland-0".into()),
            _ => Some("must-not-escape-if-unlisted".into()),
        });
        let output = String::from_utf8(command.output().unwrap().stdout).unwrap();
        for required in [
            "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
            "XDG_RUNTIME_DIR=/run/user/1000",
            "DISPLAY=:0",
            "WAYLAND_DISPLAY=wayland-0",
        ] {
            assert!(output.lines().any(|line| line == required));
        }
        assert!(!output.contains("OPENAI_API_KEY="));
        assert!(!output.contains("CODEX_HOME="));
        assert!(!output.contains("PATH="));
    }
}
