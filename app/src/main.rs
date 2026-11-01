#![allow(
    unused_qualifications,
    reason = "Dioxus RSX event attributes expand to qualified paths; rustc suggests invalid RSX edits."
)]

mod api;
mod calendar;
mod extension;
mod icons;
use extension::ExtensionRecordingStatus;
mod models;
mod notes_model;
mod onboarding;
mod privacy;
mod review;
mod settings;
mod ui;
use api::{get, patch, post, text, time};
use dioxus::prelude::*;
use review::MeetingReview;
use serde_json::{json, Value};
use settings::Settings;
use std::collections::HashMap;
use ui::{
    count_label, ActionButton, BadgeTone, ButtonKind, IconButton, PageHeading, SectionHeading,
    StatusBadge,
};

fn valid_extension_link_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

// Capture progress must not overwrite a title edit or a newer transcript/notes response.
fn merge_extension_progress(existing: &Value, incoming: &Value) -> Value {
    if existing["id"] != incoming["id"] || !existing.is_object() {
        return incoming.clone();
    }
    let mut next = existing.clone();
    for key in ["duration", "extensionRecording"] {
        if !incoming[key].is_null() {
            next[key] = incoming[key].clone();
        }
    }
    next
}

/// A terminal event removes only its meeting, preserving other queued jobs.
fn transcription_jobs(mut jobs: Vec<String>, id: &str, started: bool) -> Vec<String> {
    if id.is_empty() {
        return jobs;
    }
    jobs.retain(|job| job != id);
    if started {
        jobs.push(id.into());
    }
    jobs
}

/// Progress describes the current real worker stage while other jobs stay queued.
fn processing_label(
    jobs: &[String],
    progress: &HashMap<String, String>,
    active: &str,
    cancelling: bool,
) -> String {
    if cancelling {
        return "Cancelling transcription…".into();
    }
    if let Some(status) = progress.get(active) {
        if jobs.len() > 1 {
            return format!("{status} · {} queued", jobs.len() - 1);
        }
        return status.clone();
    }
    if jobs.len() > 1 {
        format!("Transcribing {} meetings on this device…", jobs.len())
    } else {
        "Transcribing on this device…".into()
    }
}

/// Reserve notes independently of speech jobs and suppress duplicate requests after navigation.
fn start_notes_job(jobs: &mut HashMap<String, String>, id: &str, provider: &str) -> bool {
    if id.is_empty() || jobs.contains_key(id) {
        return false;
    }
    jobs.insert(id.into(), provider.into());
    true
}

#[cfg(test)]
mod processing_tests {
    use super::{
        merge_extension_progress, processing_label, start_notes_job, transcription_jobs,
        valid_extension_link_id,
    };

    #[test]
    fn receiving_progress_updates_duration_without_overwriting_local_review_content() {
        let existing = serde_json::json!({"id":"meeting","title":"Edited title","duration":100,"transcripts":[{"text":"final"}]});
        let incoming = serde_json::json!({"id":"meeting","title":"Old title","duration":360,"transcripts":[],"extensionRecording":{"totalFrames":5_760_000}});
        let merged = merge_extension_progress(&existing, &incoming);
        assert_eq!(merged["duration"], 360);
        assert_eq!(merged["title"], "Edited title");
        assert_eq!(merged["transcripts"], existing["transcripts"]);
        assert_eq!(
            merge_extension_progress(&serde_json::Value::Null, &incoming),
            incoming
        );
    }

    #[test]
    fn extension_links_accept_only_uuid_path_segments() {
        assert!(valid_extension_link_id(
            "12345678-1234-1234-1234-123456789abc"
        ));
        for value in [
            "",
            "../settings",
            "12345678-1234-1234-1234-123456789ab/",
            "12345678-1234-1234-1234-123456789abc?x",
        ] {
            assert!(!valid_extension_link_id(value));
        }
    }

    #[test]
    fn notes_jobs_retain_provider_across_review_remount_and_finish_only_their_meeting() {
        let mut jobs = HashMap::new();
        assert!(start_notes_job(&mut jobs, "first", "ollama"));
        assert!(!start_notes_job(&mut jobs, "first", "ollama"));
        assert!(start_notes_job(&mut jobs, "second", "ollama"));
        assert_eq!(jobs.get("first").map(String::as_str), Some("ollama"));
        jobs.remove("second"); // The same removal runs for success and failure.
        assert_eq!(jobs.get("first").map(String::as_str), Some("ollama"));
        jobs.remove("first");
        assert!(start_notes_job(&mut jobs, "first", "ollama"));
        assert!(!start_notes_job(&mut jobs, "", "ollama"));
    }
    use std::collections::HashMap;

    #[test]
    fn progress_describes_the_active_stage_and_remaining_queue() {
        let jobs = vec!["first".into(), "second".into()];
        let progress = HashMap::from([("first".into(), "Encoding chunk 2 of 8".into())]);
        assert_eq!(
            processing_label(&jobs, &progress, "first", false),
            "Encoding chunk 2 of 8 · 1 queued"
        );
        assert_eq!(
            processing_label(&jobs, &progress, "first", true),
            "Cancelling transcription…"
        );
        assert_eq!(
            processing_label(&jobs[1..], &progress, "", false),
            "Transcribing on this device…"
        );
    }

    #[test]
    fn completing_one_meeting_preserves_other_queued_jobs() {
        let jobs = transcription_jobs(vec!["first".into(), "second".into()], "first", false);
        assert_eq!(jobs, vec!["second"]);
    }

    #[test]
    fn duplicate_start_and_unidentified_error_do_not_corrupt_the_queue() {
        let jobs = transcription_jobs(vec!["first".into()], "first", true);
        assert_eq!(jobs, vec!["first"]);
        assert_eq!(transcription_jobs(jobs, "", false), vec!["first"]);
    }
}

/// Launch the browser-rendered Dioxus workspace.
fn main() {
    launch(App);
}

#[component]
/// Render one of the workspace's Lucide icons (see `icons.rs`) at the requested size.
pub fn Icon(name: String, #[props(default = 18)] size: u32) -> Element {
    rsx! {
        svg {
            width: "{size}",
            height: "{size}",
            view_box: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            stroke_width: "2.75",
            stroke_linecap: "round",
            stroke_linejoin: "round",
            "aria-hidden": "true",
            // Safe: the markup is a compile-time constant generated from the Lucide package.
            dangerous_inner_html: icons::icon_markup(&name),
        }
    }
}

#[component]
/// Own navigation, loaded workspace state, recorder events, and user notifications.
fn App() -> Element {
    let mut page = use_signal(|| "overview".to_string());
    let mut meetings = use_signal(Vec::<Value>::new);
    let mut selected = use_signal(|| Value::Null);
    let mut settings = use_signal(
        || json!({"name":"","speechModel":"onnx-community/whisper-large-v3-turbo","notesModel":"qwen2.5:3b","autoTranscribe":true,"language":"en"}),
    );
    // Keep unsaved preferences through tabs and the account-setup round trip.
    let settings_draft = use_signal(&*settings);
    let settings_snapshot = use_signal(&*settings);
    let mut loading = use_signal(|| true);
    let mut load_error = use_signal(String::new);
    let mut toast = use_signal(String::new);
    let mut new_meeting = use_signal(|| false);
    let mut mobile_nav = use_signal(|| false);
    let mut dark_mode = use_signal(|| false);
    use_future(move || async move {
        let mut events = document::eval(
            "dioxus.send(window.echoTheme.current()==='dark');window.addEventListener('echo-theme-change',e=>dioxus.send(e.detail==='dark'));",
        );
        while let Ok(value) = events.recv::<bool>().await {
            dark_mode.set(value);
        }
    });
    let mut query = use_signal(String::new);
    let mut filter = use_signal(|| "all".to_string());
    let mut recorder = use_signal(|| json!({"status":"idle","elapsed":0}));
    let mut processing_jobs = use_signal(Vec::<String>::new);
    let mut cancelling_processing = use_signal(|| false);
    let mut processing_progress = use_signal(HashMap::<String, String>::new);
    let mut progressing_meeting = use_signal(String::new);
    let mut model_download = use_signal(|| json!({"status":"idle"}));
    let mut notes_download = use_signal(|| json!({"status":"idle"}));
    let mut notes_jobs = use_signal(HashMap::<String, String>::new);
    let mut uploads = use_signal(Vec::<Value>::new);
    let mut settings_section = use_signal(|| "general".to_string());
    use_future(move || async move {
        match get("/meetings").await {
            Ok(v) => meetings.set(v["meetings"].as_array().cloned().unwrap_or_default()),
            Err(e) => load_error.set(e),
        }
        if let Ok(v) = get("/settings").await {
            settings.set(v);
        }
        loading.set(false);
        if let Ok(params) = document::eval("const p=new URLSearchParams(location.search);const v={calendar:p.get('calendar'),message:p.get('message'),library:p.get('library'),meeting:p.get('meeting')};if(v.calendar||v.library||v.meeting){for(const key of ['calendar','message','library','meeting'])p.delete(key);history.replaceState(null,'',location.pathname+(p.size?'?'+p.toString():'')+location.hash);}return v;").await {
            if params["calendar"] == "connected" {
                page.set("calendar".into()); toast.set("Google Calendar connected.".into());
            } else if params["calendar"] == "error" {
                page.set("calendar".into()); toast.set(text(&params,"message"));
            } else if !params["library"].is_null() || !params["meeting"].is_null() {
                let library = text(&params,"library"); let meeting = text(&params,"meeting");
                if !valid_extension_link_id(&library) || (!meeting.is_empty() && !valid_extension_link_id(&meeting)) {
                    toast.set("This Echo recording link is invalid.".into());
                } else {
                    match get("/extensions/connections").await {
                        Ok(connection) if text(&connection,"libraryId") == library => {
                            if !meeting.is_empty() {
                                match get(&format!("/meetings/{meeting}")).await {
                                    Ok(value) if text(&value,"id") == meeting && text(&value["extensionRecording"],"libraryId") == library => {
                                        selected.set(value); page.set("review".into());
                                    },
                                    _ => toast.set("This recording is unavailable in this Echo library.".into()),
                                }
                            }
                        },
                        Ok(_) => toast.set("This recording belongs to a different Echo library. Open its original library and try again.".into()),
                        Err(error) => toast.set(error),
                    }
                }
            }
        }
    });
    use_future(move || async move {
        let mut events = document::eval(
            r#"for(const name of ['echo-notes-request','echo-notes-download-state','echo-model-download-state','echo-open-models','echo-upload-progress','echo-recorder-state','echo-recording-saved','echo-library-changed','echo-extension-recording-progress','echo-transcription-complete','echo-transcript-saved','echo-transcription-error','echo-transcription-start','echo-model-progress','echo-auto-transcription-skipped']){window.addEventListener(name,e=>dioxus.send({name,detail:e.detail}));} dioxus.send({name:'echo-model-download-state',detail:window.echoInference.getModelDownloadState()});dioxus.send({name:'echo-notes-download-state',detail:window.echoNotes.getDownloadState()}); window.addEventListener('keydown',e=>{if(document.querySelector('[aria-modal="true"],dialog[open],.sidebar.open'))return;if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();dioxus.send({name:'search'})} if((e.metaKey||e.ctrlKey)&&e.key==='j'){e.preventDefault();dioxus.send({name:'new'})}});"#,
        );
        while let Ok(event) = events.recv::<Value>().await {
            match event["name"].as_str().unwrap_or("") {
                "echo-notes-request" => {
                    let body = event["detail"].clone();
                    let id = text(&body, "meetingId");
                    if !start_notes_job(&mut notes_jobs.write(), &id, &text(&body, "provider")) {
                        continue;
                    }
                    spawn(async move {
                        let result = post("/notes", body).await;
                        notes_jobs.write().remove(&id);
                        match result {
                            Ok(meeting) => {
                                if meeting["id"] == selected()["id"] {
                                    selected.set(meeting);
                                }
                                toast.set("Notes ready.".into());
                                if let Ok(value) = get("/meetings").await {
                                    meetings.set(
                                        value["meetings"].as_array().cloned().unwrap_or_default(),
                                    );
                                }
                            }
                            Err(error) => toast.set(error),
                        }
                    });
                }
                "echo-notes-download-state" => {
                    let detail = event["detail"].clone();
                    if detail["status"] == "completed" {
                        toast.set("Notes model downloaded.".into());
                    } else if detail["status"] == "failed" {
                        toast.set(text(&detail, "error"));
                    }
                    notes_download.set(detail);
                }
                "echo-model-download-state" => {
                    let detail = event["detail"].clone();
                    match detail["status"].as_str().unwrap_or("") {
                        "completed" => toast.set("Model is ready for local transcription.".into()),
                        "cancelled" => toast.set("Download cancelled.".into()),
                        _ => {}
                    }
                    model_download.set(detail);
                }
                "echo-open-models" => {
                    page.set("models".into());
                    mobile_nav.set(false);
                }
                "echo-upload-progress" => {
                    let detail = event["detail"].clone();
                    let mut active = uploads();
                    active.retain(|item| item["meetingId"] != detail["meetingId"]);
                    if detail["status"] == "Saving recording" {
                        active.push(detail);
                    }
                    uploads.set(active);
                }
                "echo-recorder-state" => recorder.set(event["detail"].clone()),
                "echo-extension-recording-progress" => {
                    let incoming = &event["detail"];
                    if !incoming["extensionRecording"].is_object()
                        || text(incoming, "id").is_empty()
                    {
                        continue;
                    }
                    let mut current = meetings();
                    if let Some(row) = current.iter_mut().find(|row| row["id"] == incoming["id"]) {
                        *row = merge_extension_progress(row, incoming);
                    } else {
                        current.insert(0, incoming.clone());
                    }
                    meetings.set(current);
                    if selected()["id"] == incoming["id"] {
                        selected.set(merge_extension_progress(&selected(), incoming));
                    }
                }
                "echo-recording-saved" => {
                    selected.set(event["detail"].clone());
                    page.set("review".into());
                    toast.set("Recording saved.".into());
                    if let Ok(v) = get("/meetings").await {
                        meetings.set(v["meetings"].as_array().cloned().unwrap_or_default());
                    }
                }
                "echo-library-changed" => {
                    if let Ok(v) = get("/meetings").await {
                        meetings.set(v["meetings"].as_array().cloned().unwrap_or_default());
                    }
                    if let Ok(v) = get("/settings").await {
                        settings.set(v);
                    }
                }
                "echo-transcription-complete" | "echo-transcript-saved" => {
                    let detail = &event["detail"];
                    let id = detail["meetingId"]
                        .as_str()
                        .or_else(|| detail["id"].as_str())
                        .unwrap_or("");
                    processing_jobs.set(transcription_jobs(processing_jobs(), id, false));
                    processing_progress.write().remove(id);
                    if progressing_meeting() == id {
                        progressing_meeting.set(String::new());
                    }
                    if processing_jobs().is_empty() {
                        cancelling_processing.set(false);
                    }
                    if detail["id"].is_string() && detail["id"] == selected()["id"] {
                        selected.set(detail.clone());
                    } else if let Some(id) = detail["meetingId"].as_str() {
                        if let Ok(m) = get(&format!("/meetings/{id}")).await {
                            if m["id"] == selected()["id"] {
                                selected.set(m);
                            }
                        }
                    }
                    toast.set("Transcript ready.".into());
                    if let Ok(v) = get("/meetings").await {
                        meetings.set(v["meetings"].as_array().cloned().unwrap_or_default());
                    }
                }
                "echo-transcription-error" => {
                    let id = text(&event["detail"], "meetingId");
                    processing_jobs.set(transcription_jobs(processing_jobs(), &id, false));
                    processing_progress.write().remove(&id);
                    if progressing_meeting() == id {
                        progressing_meeting.set(String::new());
                    }
                    if processing_jobs().is_empty() {
                        cancelling_processing.set(false);
                    }
                    toast.set(
                        event["detail"]["error"]
                            .as_str()
                            .unwrap_or("Transcription failed. Your recording is still saved.")
                            .into(),
                    );
                    if !id.is_empty() && selected()["id"] == id {
                        if let Ok(meeting) = get(&format!("/meetings/{id}")).await {
                            if meeting["id"] == selected()["id"] {
                                selected.set(meeting);
                            }
                        }
                    }
                }
                "echo-model-progress" => {
                    let id = text(&event["detail"], "meetingId");
                    let status = text(&event["detail"], "status");
                    if processing_jobs().contains(&id) && !status.is_empty() {
                        processing_progress.write().insert(id.clone(), status);
                        progressing_meeting.set(id);
                    }
                }
                "echo-auto-transcription-skipped" => toast.set(text(&event["detail"], "message")),
                "echo-transcription-start" => {
                    processing_jobs.set(transcription_jobs(
                        processing_jobs(),
                        &text(&event["detail"], "meetingId"),
                        true,
                    ));
                    cancelling_processing.set(false);
                }
                "search" => {
                    page.set("meetings".into());
                    let _ = document::eval(
                        "setTimeout(()=>document.getElementById('library-search')?.focus(),100)",
                    );
                }
                "new" => {
                    let state = recorder();
                    if !matches!(
                        state["status"].as_str(),
                        Some("recording" | "paused" | "saving")
                    ) && !state["hasPendingAudio"].as_bool().unwrap_or(false)
                    {
                        new_meeting.set(true);
                    }
                }
                _ => {}
            }
        }
    });
    let nav = vec![
        ("overview", "home", "Overview"),
        ("meetings", "library", "All meetings"),
        ("calendar", "calendar", "Calendar"),
        ("models", "cpu", "Models"),
    ];
    let is_recording = matches!(
        recorder()["status"].as_str(),
        Some("recording" | "paused" | "saving")
    );
    let is_recording = is_recording
        || (text(&recorder(), "status") == "error"
            && recorder()["hasPendingAudio"].as_bool().unwrap_or(false));
    let count = meetings().len();
    let minutes = meetings()
        .iter()
        .map(|m| m["duration"].as_f64().unwrap_or(0.))
        .sum::<f64>()
        .max(0.)
        / 60.;
    let note_count = meetings()
        .iter()
        .filter(|m| !m["notes"].as_array().unwrap_or(&vec![]).is_empty())
        .count();
    let mut visible = meetings()
        .into_iter()
        .filter(|m| {
            let q = query().to_lowercase();
            let search = q.is_empty() || m.to_string().to_lowercase().contains(&q);
            search
                && (filter() == "all"
                    || text(m, "mode") == filter()
                    || (filter() == "saved"
                        && !m["moments"].as_array().unwrap_or(&vec![]).is_empty()))
        })
        .collect::<Vec<_>>();
    visible.sort_by_key(|meeting| std::cmp::Reverse(text(meeting, "createdAt")));
    let current_page = page();
    let heading = match current_page.as_str() {
        "meetings" => "All meetings",
        "calendar" => "Calendar",
        "models" => "Models",
        "settings" => "Settings",
        "review" => "Meeting workspace",
        _ => "Overview",
    };
    let selected_id = text(&selected(), "id");
    rsx! {
        a { class: "skip-link", href: "#workspace-main", "Skip to content" }
        div { class: if is_recording { "app-shell has-recording" } else { "app-shell" },
            if mobile_nav() {
                button {
                    class: "nav-scrim",
                    "aria-label": "Close navigation",
                    onclick: move |_| mobile_nav.set(false),
                }
            }
            aside {
                id: "workspace-navigation",
                "aria-label": "Workspace",
                class: if mobile_nav() { "sidebar open" } else { "sidebar" },
                a {
                    class: "brand",
                    href: "#",
                    "aria-label": "Echo",
                    onclick: move |e| {
                        e.prevent_default();
                        page.set("overview".into());
                        mobile_nav.set(false);
                    },
                    img {
                        class: "brand-mark",
                        src: "/favicon.svg",
                        alt: "",
                        width: "36",
                        height: "36",
                    }
                    span { "Echo" }
                }
                nav { class: "main-nav", "aria-label": "Main navigation",
                    for (id, icon, label) in nav {
                        button {
                            class: if current_page == id { "nav-item active" } else { "nav-item" },
                            "aria-current": if current_page == id { "page" } else { "false" },
                            onclick: move |_| {
                                page.set(id.into());
                                mobile_nav.set(false);
                            },
                            Icon { name: icon }
                            span { "{label}" }
                            if id == "meetings" {
                                span { class: "nav-count", "{count}" }
                            }
                        }
                    }
                }
                div { class: "sidebar-bottom",
                    button {
                        class: if current_page == "settings" { "nav-item active" } else { "nav-item" },
                        onclick: move |_| {
                            page.set("settings".into());
                            settings_section.set("general".into());
                            mobile_nav.set(false);
                        },
                        Icon { name: "settings" }
                        span { "Settings" }
                    }
                }
            }
            div { class: "main-shell",
                header { class: "topbar",
                    div { class: "topbar-left",
                        button {
                            class: "icon-button mobile-menu",
                            "aria-label": "Open navigation",
                            "aria-expanded": mobile_nav(),
                            "aria-controls": "workspace-navigation",
                            onclick: move |_| mobile_nav.set(true),
                            Icon { name: "menu" }
                        }
                        span { class: "breadcrumb-home", "Workspace" }
                        Icon { name: "chevron", size: 13 }
                        strong { "{heading}" }
                    }
                    div { class: "topbar-right",
                        button {
                            class: "icon-button theme-toggle",
                            "aria-label": if dark_mode() { "Switch to light mode" } else { "Switch to dark mode" },
                            "aria-pressed": dark_mode(),
                            onclick: move |_| {
                                let next = if dark_mode() { "light" } else { "dark" };
                                dark_mode.set(next == "dark");
                                let _ = document::eval(&format!("window.echoTheme.set({})", json!(next)));
                            },
                            Icon { name: if dark_mode() { "sun" } else { "moon" }, size: 19 }
                        }
                        button {
                            class: "global-search",
                            onclick: move |_| {
                                page.set("meetings".into());
                                let _ = document::eval(
                                    "setTimeout(()=>document.getElementById('library-search')?.focus(),100)",
                                );
                            },
                            Icon { name: "search", size: 16 }
                            span { "Search meetings" }
                            kbd { "⌘ K" }
                        }
                        ActionButton {
                            kind: ButtonKind::Primary,
                            compact: true,
                            disabled: is_recording,
                            onclick: move |_| new_meeting.set(true),
                            Icon { name: "plus", size: 16 }
                            span { class: "topbar-button-label", "New meeting" }
                        }
                    }
                }
                main { id: "workspace-main", tabindex: "-1",
                    if !load_error().is_empty() {
                        div { class: "load-error inline-error",
                            Icon { name: "alert" }
                            "{load_error}"
                            ActionButton {
                                kind: ButtonKind::Secondary,
                                onclick: move |_| {
                                    spawn(async move {
                                        loading.set(true);
                                        match get("/meetings").await {
                                            Ok(v) => {
                                                meetings.set(v["meetings"].as_array().cloned().unwrap_or_default());
                                                load_error.set(String::new());
                                            }
                                            Err(e) => load_error.set(e),
                                        }
                                        loading.set(false);
                                    });
                                },
                                "Retry"
                            }
                        }
                    }
                    if current_page == "overview" {
                        div { class: "page-content overview",
                            PageHeading { title: "Overview" }
                            div { class: "quick-actions",
                                button {
                                    class: "quick-action",
                                    disabled: is_recording,
                                    onclick: move |_| new_meeting.set(true),
                                    span { class: "quick-icon peach",
                                        Icon { name: "mic", size: 21 }
                                    }
                                    span {
                                        strong { "Record in person" }
                                        small { "Room microphone" }
                                    }
                                    Icon { name: "arrow-right", size: 17 }
                                }
                                button {
                                    class: "quick-action",
                                    onclick: move |_| {
                                        settings_section.set("extension".into());
                                        page.set("settings".into());
                                    },
                                    span { class: "quick-icon lavender",
                                        Icon { name: "calendar", size: 21 }
                                    }
                                    span {
                                        strong { "Online meeting" }
                                        small { "Browser extension" }
                                    }
                                    Icon { name: "arrow-right", size: 17 }
                                }
                                label { class: "quick-action upload-action",
                                    span { class: "quick-icon mint",
                                        Icon { name: "upload", size: 21 }
                                    }
                                    span {
                                        strong { "Upload a recording" }
                                        small { "Audio file" }
                                    }
                                    Icon { name: "arrow-right", size: 17 }
                                    input {
                                        r#type: "file",
                                        "aria-label": "Upload a recording",
                                        accept: "audio/*,video/webm,video/mp4",
                                        onchange: move |_| {
                                            spawn(async move {
                                                match crate::api::evaluate(
                                                        "return await window.echo.upload(document.getElementById('audio-upload'))",
                                                    )
                                                    .await
                                                {
                                                    Ok(_) => {}
                                                    Err(e) => toast.set(format!("Upload could not complete: {e}")),
                                                }
                                            });
                                        },
                                        id: "audio-upload",
                                        class: "file-input",
                                    }
                                }
                            }
                            if !loading() && load_error().is_empty()
                                && onboarding::needs_first_transcript(&meetings())
                            {
                                onboarding::FirstTranscript {
                                    settings,
                                    download: model_download,
                                    meetings,
                                    on_models: move |()| page.set("models".into()),
                                    on_record: move |()| new_meeting.set(true),
                                    on_open: move |m| {
                                        selected.set(m);
                                        page.set("review".into());
                                    },
                                }
                            }
                            if count > 0 {
                                div { class: "stats-row",
                                    div { class: "stat-item",
                                        span { class: "stat-icon",
                                            Icon { name: "video", size: 18 }
                                        }
                                        div {
                                            strong { "{count}" }
                                            span { "Meetings" }
                                        }
                                    }
                                    div { class: "stat-item",
                                        span { class: "stat-icon",
                                            Icon { name: "clock", size: 18 }
                                        }
                                        div {
                                            strong { "{minutes:.0}" }
                                            span { "Minutes" }
                                        }
                                    }
                                    div { class: "stat-item",
                                        span { class: "stat-icon",
                                            Icon { name: "sparkles", size: 18 }
                                        }
                                        div {
                                            strong { "{note_count}" }
                                            span { "With notes" }
                                        }
                                    }
                                    div { class: "stat-item privacy-stat",
                                        span { class: "stat-icon",
                                            Icon { name: "shield", size: 18 }
                                        }
                                        div {
                                            strong { "Local" }
                                            span { "Audio capture" }
                                        }
                                    }
                                }
                            }
                            div { class: "overview-columns",
                                section { class: "recent-section",
                                    SectionHeading { title: "Recent meetings",
                                        button {
                                            class: "text-button",
                                            onclick: move |_| page.set("meetings".into()),
                                            "View all"
                                            Icon { name: "arrow-right", size: 15 }
                                        }
                                    }
                                    if count == 0 {
                                        div { class: "empty-library panel",
                                            div { class: "empty-library-icon",
                                                Icon { name: "mic", size: 27 }
                                            }
                                            h3 { "No meetings yet" }
                                            p { "Record a meeting or upload audio." }
                                            ActionButton {
                                                kind: ButtonKind::Secondary,
                                                onclick: move |_| {
                                                    spawn(async move {
                                                        if let Ok(v) = get("/demo").await {
                                                            selected.set(v);
                                                            page.set("review".into());
                                                        } else {
                                                            toast.set("Sample meeting is unavailable.".into());
                                                        }
                                                    });
                                                },
                                                Icon { name: "play", size: 14 }
                                                "Explore a sample meeting"
                                            }
                                            span { class: "small-muted", "Sample · no audio" }
                                        }
                                    } else {
                                        div { class: "recent-list",
                                            for meeting in visible.iter().take(4).cloned() {
                                                MeetingCard {
                                                    meeting,
                                                    on_open: move |m| {
                                                        selected.set(m);
                                                        page.set("review".into());
                                                    },
                                                }
                                            }
                                        }
                                    }
                                }

                            }
                        }
                    } else if current_page == "meetings" {
                        div { class: "page-content",
                            PageHeading { title: "All meetings",
                                ActionButton {
                                    kind: ButtonKind::Primary,
                                    disabled: is_recording,
                                    onclick: move |_| new_meeting.set(true),
                                    Icon { name: "plus" }
                                    "New meeting"
                                }
                            }
                            div { class: "library-toolbar",
                                div { class: "search-field",
                                    Icon { name: "search", size: 18 }
                                    input {
                                        id: "library-search",
                                        placeholder: "Search meetings, transcripts, and notes…",
                                        value: query(),
                                        oninput: move |e| query.set(e.value()),
                                        "aria-label": "Search meeting library",
                                    }
                                    if !query().is_empty() {
                                        IconButton {
                                            label: "Clear search",
                                            icon: "close",
                                            onclick: move |_| query.set(String::new()),
                                        }
                                    }
                                }
                                div { class: "filter-tabs",
                                    for (id, label) in [
                                        ("all", "All meetings"),
                                        ("in-person", "In person"),
                                        ("online", "Online"),
                                        ("saved", "Saved moments"),
                                    ]
                                    {
                                        button {
                                            class: if filter() == id { "active" } else { "" },
                                            "aria-pressed": filter() == id,
                                            onclick: move |_| filter.set(id.into()),
                                            "{label}"
                                        }
                                    }
                                }
                            }
                            if loading() {
                                div { class: "loading-panel",
                                    span { class: "spinner" }
                                    "Loading meetings…"
                                }
                            } else if visible.is_empty() {
                                div { class: "panel empty-state library-empty",
                                    Icon { name: "library", size: 36 }
                                    h2 {
                                        if query().is_empty() {
                                            "No meetings yet"
                                        } else {
                                            "No meetings found."
                                        }
                                    }
                                    p {
                                        if query().is_empty() {
                                            "Record a meeting or upload audio."
                                        } else {
                                            "Try a different word or choose All meetings."
                                        }
                                    }
                                    ActionButton {
                                        kind: ButtonKind::Secondary,
                                        disabled: count == 0 && is_recording,
                                        onclick: move |_| {
                                            query.set(String::new());
                                            filter.set("all".into());
                                            if count == 0 {
                                                new_meeting.set(true);
                                            }
                                        },
                                        if count == 0 {
                                            "New meeting"
                                        } else {
                                            "Clear filters"
                                        }
                                    }
                                }
                            } else {
                                SectionHeading { title: "Meetings",
                                    span { class: "small-muted",
                                        {count_label(visible.len(), "meeting", "meetings")}
                                    }
                                }
                                div { class: "meeting-grid",
                                    for meeting in visible {
                                        MeetingCard {
                                            meeting,
                                            on_open: move |m| {
                                                selected.set(m);
                                                page.set("review".into());
                                            },
                                        }
                                    }
                                }
                            }
                        }
                    } else if current_page == "review" {
                        if selected().is_object() {
                            div { key: "{selected_id}",
                                if text(&selected(), "mode") == "online" {
                                    ExtensionRecordingStatus {
                                        meeting: selected,
                                        notify: move |s| toast.set(s),
                                    }
                                }
                                MeetingReview {
                                    meeting: selected,
                                    transcribing: processing_jobs().contains(&selected_id),
                                    generating_notes: notes_jobs().get(&selected_id).cloned().unwrap_or_default(),
                                    on_back: move |()| {
                                        page.set("meetings".into());
                                        spawn(async move {
                                            if let Ok(v) = get("/meetings").await {
                                                meetings.set(v["meetings"].as_array().cloned().unwrap_or_default());
                                            }
                                        });
                                    },
                                    on_change: move |m: Value| {
                                        if m["id"] == selected()["id"] {
                                            selected.set(m);
                                        }
                                        spawn(async move {
                                            if let Ok(v) = get("/meetings").await {
                                                meetings.set(v["meetings"].as_array().cloned().unwrap_or_default());
                                            }
                                        });
                                    },
                                    notify: move |s| toast.set(s),
                                }
                            }
                        }
                    } else if current_page == "calendar" {
                        calendar::Calendar {
                            notify: move |s| toast.set(s),
                            on_extension: move |()| {
                                settings_section.set("extension".into());
                                page.set("settings".into());
                            },
                        }
                    } else if current_page == "models" {
                        models::Models {
                            settings,
                            download: model_download,
                            notes_download,
                            on_change: move |s| settings.set(s),
                            notify: move |s| toast.set(s),
                        }
                    } else if current_page == "settings" {
                        Settings {
                            settings,
                            draft: settings_draft,
                            snapshot: settings_snapshot,
                            on_change: move |s| settings.set(s),
                            notify: move |s| toast.set(s),
                            section: settings_section,
                        }
                    }
                }
            }
        }
        div { class: if is_recording { "task-stack above-recording" } else { "task-stack" },
            for upload in uploads() {
                div { class: "upload-progress panel", role: "status",
                    div {
                        Icon { name: "upload", size: 17 }
                        strong { "Saving recording…" }
                        span { {format!("{:.0}%", upload["progress"].as_f64().unwrap_or(0.))} }
                    }
                    p { {text(&upload, "fileName")} }
                    progress {
                        max: "100",
                        value: upload["progress"].as_f64().unwrap_or(0.).to_string(),
                        "aria-label": format!("Saving {}", text(&upload, "fileName")),
                    }
                }
            }
            if !notes_jobs().is_empty() {
                div { class: "processing-banner", role: "status",
                    span { class: "spinner" }
                    span {
                        {
                            format!(
                                "Generating notes for {}…",
                                count_label(notes_jobs().len(), "meeting", "meetings"),
                            )
                        }
                    }
                }
            }
            if !processing_jobs().is_empty() {
                div { class: "processing-banner", role: "status",
                    span { class: "spinner" }
                    span {
                        {
                            processing_label(
                                &processing_jobs(),
                                &processing_progress(),
                                &progressing_meeting(),
                                cancelling_processing(),
                            )
                        }
                    }
                    ActionButton {
                        kind: ButtonKind::Ghost,
                        disabled: cancelling_processing(),
                        onclick: move |_| {
                            cancelling_processing.set(true);
                            let _ = document::eval("window.echoInference.cancelInference()");
                        },
                        if processing_jobs().len() > 1 {
                            "Cancel all"
                        } else {
                            "Cancel"
                        }
                    }
                }
            }
        }
        if is_recording {
            RecorderBar {
                recorder,
                on_open: move |()| {
                    let id = text(&recorder(), "meetingId");
                    spawn(async move {
                        if let Ok(m) = get(&format!("/meetings/{id}")).await {
                            selected.set(m);
                            page.set("review".into());
                        }
                    });
                },
                notify: move |s| toast.set(s),
            }
        }
        if new_meeting() {
            NewMeeting {
                settings,
                on_close: move |()| new_meeting.set(false),
                on_calendar: move |()| {
                    new_meeting.set(false);
                    settings_section.set("extension".into());
                    page.set("settings".into());
                },
                on_start: move |m| {
                    selected.set(m);
                    page.set("review".into());
                    spawn(async move {
                        if let Ok(v) = get("/meetings").await {
                            meetings.set(v["meetings"].as_array().cloned().unwrap_or_default());
                        }
                    });
                },
            }
        }
        if !toast().is_empty() {
            div { class: "toast", role: "status",
                Icon { name: "sparkles", size: 18 }
                span { "{toast}" }
                IconButton {
                    label: "Dismiss notification",
                    icon: "close",
                    onclick: move |_| toast.set(String::new()),
                }
            }
        }
    }
}

#[component]
/// Present a saved meeting's title, local date, duration, and processing state.
fn MeetingCard(meeting: Value, on_open: EventHandler<Value>) -> Element {
    let title = text(&meeting, "title");
    let mode = text(&meeting, "mode");
    let status = text(&meeting, "status");
    let date = api::local_date(&text(&meeting, "createdAt"));
    let duration = time(meeting["duration"].as_f64().unwrap_or(0.));
    let tags = if let Some(notes) = meeting["notes"].as_array() {
        notes
            .last()
            .and_then(|n| n["actions"].as_array())
            .map_or(0, std::vec::Vec::len)
    } else {
        0
    };
    rsx! {
        button {
            class: "meeting-card panel",
            onclick: move |_| on_open.call(meeting.clone()),
            div { class: "meeting-card-top",
                span { class: if mode == "online" { "meeting-icon lavender" } else { "meeting-icon peach" },
                    Icon { name: if mode == "online" { "video" } else { "mic" }, size: 21 }
                }
                StatusBadge { tone: if status == "ready" { BadgeTone::Success } else if status == "error" || status == "interrupted" { BadgeTone::Warning } else { BadgeTone::Neutral },
                    "{status}"
                }
            }
            h3 { "{title}" }
            div { class: "meeting-card-meta",
                span { "{date}" }
                span { "·" }
                Icon { name: "clock", size: 13 }
                span { "{duration}" }
            }
            div { class: "meeting-card-bottom",
                span {
                    if tags > 0 {
                        {count_label(tags, "next step", "next steps")}
                    } else if status == "ready" {
                        "Open transcript"
                    } else {
                        "Open meeting"
                    }
                }
                Icon { name: "arrow-right", size: 16 }
            }
        }
    }
}

#[component]
/// Collect recording consent and microphone choices before creating and starting a meeting.
fn NewMeeting(
    settings: Signal<Value>,
    on_close: EventHandler<()>,
    on_calendar: EventHandler<()>,
    on_start: EventHandler<Value>,
) -> Element {
    let mut title = use_signal(String::new);
    let mut consent = use_signal(|| false);
    let mut muted = use_signal(|| false);
    let mut busy = use_signal(|| false);
    let mut error = use_signal(String::new);
    let mut devices = use_signal(Vec::<Value>::new);
    let mut device = use_signal(String::new);
    let mut tested = use_signal(|| false);
    rsx! {
        div { class: "dialog-backdrop",
            div {
                class: "dialog",
                id: "new-meeting-dialog",
                role: "dialog",
                "aria-modal": "true",
                "aria-labelledby": "new-meeting-heading",
                IconButton {
                    class: "dialog-close",
                    id: "close-new-meeting",
                    label: "Close new meeting",
                    icon: "close",
                    disabled: busy(),
                    onclick: move |_| on_close.call(()),
                }
                h2 { id: "new-meeting-heading", "New meeting" }
                div { class: "meeting-mode-options",
                    div { class: "mode-option selected",
                        span { class: "mode-option-icon",
                            Icon { name: "mic", size: 22 }
                        }
                        div {
                            strong { "In person" }
                            span { "Capture your room microphone" }
                        }
                        Icon { name: "check", size: 17 }
                    }
                    button {
                        class: "mode-option",
                        disabled: busy(),
                        onclick: move |_| on_calendar.call(()),
                        span { class: "mode-option-icon",
                            Icon { name: "calendar", size: 22 }
                        }
                        div {
                            strong { "Online meeting" }
                            span { "Set up the browser extension to record calls" }
                        }
                        Icon { name: "chevron", size: 17 }
                    }
                }
                label { class: "field-label", r#for: "new-meeting-title",
                    "Meeting name "
                    span { "Optional" }
                }
                input {
                    class: "input",
                    id: "new-meeting-title",
                    placeholder: "e.g. Monday product catch-up",
                    maxlength: "180",
                    disabled: busy(),
                    value: title(),
                    oninput: move |e| title.set(e.value()),
                }
                div { class: "mic-setup",
                    div {
                        Icon { name: "mic", size: 18 }
                        span {
                            if tested() {
                                "Microphone access is ready"
                            } else {
                                "Choose your microphone"
                            }
                        }
                    }
                    ActionButton {
                        kind: ButtonKind::Secondary,
                        compact: true,
                        disabled: busy(),
                        onclick: move |_| {
                            spawn(async move {
                                busy.set(true);
                                error.set(String::new());
                                match crate::api::evaluate("return await window.echo.testMicrophone()").await
                                {
                                    Ok(v) => {
                                        devices.set(v.as_array().cloned().unwrap_or_default());
                                        tested.set(true);
                                    }
                                    Err(e) => {
                                        error
                                            .set(
                                                format!(
                                                    "Microphone access failed. Check your browser permissions. {e}",
                                                ),
                                            );
                                    }
                                }
                                busy.set(false);
                            });
                        },
                        if tested() {
                            "Check again"
                        } else {
                            "Test access"
                        }
                    }
                }
                if !devices().is_empty() {
                    select {
                        class: "input",
                        "aria-label": "Microphone",
                        disabled: busy(),
                        value: device(),
                        onchange: move |e| device.set(e.value()),
                        option { value: "", "System default microphone" }
                        for d in devices() {
                            option { value: text(&d, "id"), {text(&d, "label")} }
                        }
                    }
                }
                label { class: "check-row",
                    input {
                        r#type: "checkbox",
                        disabled: busy(),
                        checked: muted(),
                        onchange: move |e| muted.set(e.checked()),
                    }
                    span {
                        "Start with my microphone muted"
                        small { class: "check-hint", "You can unmute during the recording." }
                    }
                }
                div { class: "privacy-note",
                    Icon { name: "shield", size: 19 }
                    p { "Keep this tab open while recording. Audio is saved on this device." }
                }
                label { class: "check-row consent-row",
                    input {
                        r#type: "checkbox",
                        disabled: busy(),
                        checked: consent(),
                        onchange: move |e| consent.set(e.checked()),
                    }
                    span { "I have permission from everyone being recorded." }
                }
                if !error().is_empty() {
                    div { class: "inline-error", role: "alert",
                        Icon { name: "alert" }
                        "{error}"
                    }
                }
                ActionButton {
                    kind: ButtonKind::Primary,
                    full_width: true,
                    disabled: !consent() || busy(),
                    onclick: move |_| {
                        spawn(async move {
                            busy.set(true);
                            error.set(String::new());
                            let meeting_title = if title().trim().is_empty() {
                                "New meeting".into()
                            } else {
                                title()
                            };
                            match post(
                                    "/meetings",
                                    json!(
                                        { "title" : meeting_title, "mode" : "in-person", "consent" :
                                        true, "speechModel" : settings() ["speechModel"], "notesModel" :
                                        settings() ["notesModel"], "liveTranscription" : false }
                                    ),
                                )
                                .await
                            {
                                Ok(m) => {
                                    let script = format!(
                                        "return await window.echoRecorder.start({{meeting:{},deviceId:{},startMuted:{}}})",
                                        m,
                                        json!(device()),
                                        muted(),
                                    );
                                    match crate::api::evaluate(&script).await {
                                        Ok(_) => {
                                            let latest = get(&format!("/meetings/{}", text(&m, "id")))
                                                .await
                                                .unwrap_or(m);
                                            on_start.call(latest);
                                            on_close.call(());
                                        }
                                        Err(e) => {
                                            let msg = format!("Could not start recording: {e}");
                                            let _ = patch(
                                                    &format!("/meetings/{}", text(&m, "id")),
                                                    json!({ "status" : "error", "error" : msg }),
                                                )
                                                .await;
                                            error.set(msg);
                                        }
                                    }
                                }
                                Err(e) => error.set(e),
                            }
                            busy.set(false);
                        });
                    },
                    if busy() {
                        span { class: "spinner" }
                        "Getting ready…"
                    } else {
                        Icon { name: "mic" }
                        "Start recording"
                    }
                }

            }
        }

    }
}

#[component]
/// Expose recording, pause, mute, and stop controls for the active microphone session.
fn RecorderBar(
    recorder: Signal<Value>,
    on_open: EventHandler<()>,
    notify: EventHandler<String>,
) -> Element {
    let state = recorder();
    let status = text(&state, "status");
    let muted = state["muted"].as_bool().unwrap_or(false);
    let elapsed = time(state["elapsed"].as_f64().unwrap_or(0.));
    let level = state["level"].as_f64().unwrap_or(0.);
    rsx! {
        div {
            class: "recorder-bar",
            role: "region",
            "aria-label": "Active recording controls",
            div { class: "recording-status",
                span { class: if status == "recording" { "record-dot pulse" } else { "record-dot" } }
                div {
                    strong {
                        if status == "paused" {
                            "Recording paused"
                        } else if status == "saving" {
                            "Saving recording…"
                        } else if status == "error" {
                            "Recording interrupted"
                        } else if muted {
                            "Microphone muted"
                        } else {
                            "Recording"
                        }
                    }
                    button { onclick: move |_| on_open.call(()), "View active meeting" }
                }
            }
            div {
                class: "recorder-level",
                "aria-label": "Microphone audio level",
                for i in 0..12 {
                    span {
                        class: if level * 12. > f64::from(i) { "lit" } else { "" },
                        style: format!("height:{}px", 8 + (i % 5) * 3),
                    }
                }
            }
            strong { class: "recorder-time", "{elapsed}" }
            button {
                class: "icon-button",
                disabled: status == "saving" || status == "error",
                "aria-label": if muted { "Unmute capture" } else { "Mute capture" },
                onclick: move |_| {
                    let _ = document::eval("window.echoRecorder.toggleMute()");
                },
                Icon { name: if muted { "mute" } else { "mic" } }
            }
            button {
                class: "icon-button",
                disabled: status == "saving" || status == "error",
                "aria-label": if status == "paused" { "Resume recording" } else { "Pause recording" },
                onclick: move |_| {
                    let _ = document::eval(
                        if status == "paused" {
                            "window.echoRecorder.resume()"
                        } else {
                            "window.echoRecorder.pause()"
                        },
                    );
                },
                Icon { name: if text(&state, "status") == "paused" { "play" } else { "pause" } }
            }
            button {
                class: "button button-record-stop",
                disabled: text(&state, "status") == "saving",
                onclick: move |_| {
                    spawn(async move {
                        let script = if text(&recorder(), "status") == "error" {
                            "return await window.echoRecorder.retry()"
                        } else {
                            "return await window.echoRecorder.stop()"
                        };
                        if let Err(e) = crate::api::evaluate(script).await {
                            notify
                                .call(
                                    format!(
                                        "Could not finish saving: {e}. Keep this tab open and retry.",
                                    ),
                                );
                        }
                    });
                },
                Icon { name: "stop", size: 15 }
                if text(&state, "status") == "error" {
                    "Retry save"
                } else {
                    "Stop & save"
                }
            }
            if let Some(error) = state["error"].as_str() {
                p { class: "recorder-error", "{error}" }
            }
        }
    }
}
