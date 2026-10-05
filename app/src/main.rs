mod api;
mod calendar;
mod chatgpt;
mod models;
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
    use super::{processing_label, start_notes_job, transcription_jobs};

    #[test]
    fn notes_jobs_retain_provider_across_review_remount_and_finish_only_their_meeting() {
        let mut jobs = HashMap::new();
        assert!(start_notes_job(&mut jobs, "first", "chatgpt"));
        assert!(!start_notes_job(&mut jobs, "first", "ollama"));
        assert!(start_notes_job(&mut jobs, "second", "ollama"));
        assert_eq!(jobs.get("first").map(String::as_str), Some("chatgpt"));
        jobs.remove("second"); // The same removal runs for success and failure.
        assert_eq!(jobs.get("first").map(String::as_str), Some("chatgpt"));
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
    dioxus::launch(App);
}

#[component]
/// Render one of the workspace's inline vector icons at the requested size.
pub fn Icon(name: String, #[props(default = 18)] size: u32) -> Element {
    let path = match name.as_str() {
        "home" => "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
        "mic" => "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8",
        "calendar" => "M8 2v4m8-4v4M3 10h18M4 4h16a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm4 10h2m4 0h2m-8 3h2",
        "clock" => "M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
        "check" => "m5 12 4 4L19 6", "plus" => "M12 5v14M5 12h14", "search" => "m21 21-4.3-4.3M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0Z",
        "close"|"x" => "m6 6 12 12M6 18 18 6", "arrow"=>"M7 17 17 7M7 7h10v10", "arrow-right"=>"M4 12h16m-6-6 6 6-6 6", "arrow-left"=>"M20 12H4m6-6-6 6 6 6", "chevron"=>"m9 5 7 7-7 7", "chevron-down"=>"m6 9 6 6 6-6",
        "shield"|"lock" => "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Zm-4 9 3 3 5-6",
        "file"|"book"|"folder" => "M14 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9ZM14 2v7h7M7 13h10M7 17h7",
        "library" => "M4 3v18M8 3v18m4-18 5 18M19 3v18", "upload"=>"M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5", "download"=>"M12 3v13m-5-5 5 5 5-5M4 15v5h16v-5",
        "play" => "m7 4 14 8-14 8Z", "pause"=>"M8 4v16M16 4v16", "stop"=>"M5 5h14v14H5Z", "more"=>"M5 12h.01M12 12h.01M19 12h.01",
        "sparkles"=>"m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4",
        "cpu"|"hard-drive"=>"M6 6h12v12H6ZM9 9h6v6H9ZM9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4",
        "bookmark"=>"M6 3h12v18l-6-4-6 4Z", "trash"=>"M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
        "settings"=>"M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM9 2h6l1 4 4 1 2 5-3 3v4l-5 3-3-3H7l-4-4 1-4-2-3 3-5Z",
        "help"|"info"=>"M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4m.1 3h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
        "refresh"|"loader"=>"M20 7v5h-5M4 17v-5h5m-4-4a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3",
        "volume"=>"m11 5-6 4H2v6h3l6 4Zm4 3a5 5 0 0 1 0 8m3-11a9 9 0 0 1 0 14",
        "mute"=>"m11 5-6 4H2v6h3l6 4Zm5 4 5 6m-5 0 5-6",
        "edit"=>"m16 3 5 5-13 13H3v-5Zm-2 2 5 5", "users"=>"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm5-3a4 4 0 0 1 0 8m4 9v-2a4 4 0 0 0-3-4",
        "link"=>"m10 13 4-4m-7 7-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m4 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0",
        "sun"=>"M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17m10-10 1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
        "moon"=>"M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z",
        "menu"=>"M4 6h16M4 12h16M4 18h16", "alert"=>"m12 3 10 18H2Zm0 6v5m0 3h.01", "video"=>"M3 5h12v14H3Zm12 5 7-4v12l-7-4",
        _ => "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
    };
    rsx! {svg{width:"{size}",height:"{size}",view_box:"0 0 24 24",fill:"none",stroke:"currentColor",stroke_width:"1.7",stroke_linecap:"round",stroke_linejoin:"round","aria-hidden":"true",path{d:path}}}
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
        };
        if let Ok(v) = get("/settings").await {
            settings.set(v)
        };
        loading.set(false);
        if let Ok(params)=document::eval("const p=new URLSearchParams(location.search);const v={calendar:p.get('calendar'),message:p.get('message')};if(v.calendar)history.replaceState(null,'',location.pathname);return v;").await {if params["calendar"]=="connected"{page.set("calendar".into());toast.set("Google Calendar connected.".into());}else if params["calendar"]=="error"{page.set("calendar".into());toast.set(text(&params,"message"));}}
    });
    use_future(move || async move {
        let mut events = document::eval(
            r#"for(const name of ['echo-notes-request','echo-notes-download-state','echo-model-download-state','echo-open-models','echo-upload-progress','echo-recorder-state','echo-recording-saved','echo-library-changed','echo-transcription-complete','echo-transcript-saved','echo-transcription-error','echo-transcription-start','echo-model-progress','echo-auto-transcription-skipped']){window.addEventListener(name,e=>dioxus.send({name,detail:e.detail}));} dioxus.send({name:'echo-model-download-state',detail:window.echoInference.getModelDownloadState()});dioxus.send({name:'echo-notes-download-state',detail:window.echoNotes.getDownloadState()}); window.addEventListener('keydown',e=>{if(document.querySelector('[aria-modal="true"],dialog[open],.sidebar.open'))return;if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();dioxus.send({name:'search'})} if((e.metaKey||e.ctrlKey)&&e.key==='j'){e.preventDefault();dioxus.send({name:'new'})}});"#,
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
                    let _=document::eval("setTimeout(()=>document.getElementById('chatgpt-connection')?.scrollIntoView({block:'start',behavior:'smooth'}),100)");
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
                "echo-recording-saved" => {
                    selected.set(event["detail"].clone());
                    page.set("review".into());
                    toast.set("Recording saved.".into());
                    if let Ok(v) = get("/meetings").await {
                        meetings.set(v["meetings"].as_array().cloned().unwrap_or_default())
                    }
                }
                "echo-library-changed" => {
                    if let Ok(v) = get("/meetings").await {
                        meetings.set(v["meetings"].as_array().cloned().unwrap_or_default())
                    }
                    if let Ok(v) = get("/settings").await {
                        settings.set(v)
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
                        selected.set(detail.clone())
                    } else if let Some(id) = detail["meetingId"].as_str() {
                        if let Ok(m) = get(&format!("/meetings/{id}")).await {
                            if m["id"] == selected()["id"] {
                                selected.set(m)
                            }
                        }
                    }
                    toast.set("Transcript ready.".into());
                    if let Ok(v) = get("/meetings").await {
                        meetings.set(v["meetings"].as_array().cloned().unwrap_or_default())
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
                        new_meeting.set(true)
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
        a{class:"skip-link",href:"#workspace-main","Skip to content"}
        div{class:if is_recording{"app-shell has-recording"}else{"app-shell"},
            if mobile_nav(){button{class:"nav-scrim","aria-label":"Close navigation",onclick:move |_|mobile_nav.set(false)}}
            aside{id:"workspace-navigation","aria-label":"Workspace",class:if mobile_nav(){"sidebar open"}else{"sidebar"},
                a{class:"brand",href:"#",onclick:move |e|{e.prevent_default();page.set("overview".into());mobile_nav.set(false);},div{class:"brand-mark",span{} span{} span{} span{}} span{"echo" span{"voice"}}}
                nav{class:"main-nav","aria-label":"Main navigation",for (id,icon,label) in nav{button{class:if current_page==id{"nav-item active"}else{"nav-item"},"aria-current":if current_page==id{"page"}else{"false"},onclick:move |_|{page.set(id.into());mobile_nav.set(false);},Icon{name:icon}span{"{label}"}if id=="meetings"{span{class:"nav-count","{count}"}}if id=="models"{span{class:"nav-dot"}}}}}
                div{class:"sidebar-bottom",
                    button{class:if current_page=="settings"{"nav-item active"}else{"nav-item"},onclick:move |_|{page.set("settings".into());settings_section.set("general".into());mobile_nav.set(false);},Icon{name:"settings"}span{"Settings"}}
                }
            }
            div{class:"main-shell",header{class:"topbar",div{class:"topbar-left",button{class:"icon-button mobile-menu","aria-label":"Open navigation","aria-expanded":mobile_nav(),"aria-controls":"workspace-navigation",onclick:move |_|mobile_nav.set(true),Icon{name:"menu"}}span{class:"breadcrumb-home","Workspace"}Icon{name:"chevron",size:13}strong{"{heading}"}}div{class:"topbar-right",button{class:"icon-button theme-toggle","aria-label":if dark_mode(){"Switch to light mode"}else{"Switch to dark mode"},"aria-pressed":dark_mode(),onclick:move |_|{let next=if dark_mode(){"light"}else{"dark"};dark_mode.set(next=="dark");let _=document::eval(&format!("window.echoTheme.set({})",json!(next)));},Icon{name:if dark_mode(){"sun"}else{"moon"},size:19}}button{class:"global-search",onclick:move |_|{page.set("meetings".into());let _=document::eval("setTimeout(()=>document.getElementById('library-search')?.focus(),100)");},Icon{name:"search",size:16}span{"Search meetings"}kbd{"⌘ K"}}ActionButton{kind:ButtonKind::Primary,compact:true,disabled:is_recording,onclick:move |_|new_meeting.set(true),Icon{name:"plus",size:16}span{"New meeting"}}}}
                main{id:"workspace-main",tabindex:"-1",
                    if !load_error().is_empty(){div{class:"load-error inline-error",Icon{name:"alert"}"{load_error}" ActionButton{kind:ButtonKind::Secondary,onclick:move |_|{spawn(async move{loading.set(true);match get("/meetings").await{Ok(v)=>{meetings.set(v["meetings"].as_array().cloned().unwrap_or_default());load_error.set(String::new())},Err(e)=>load_error.set(e)}loading.set(false);});},"Retry"}}}
                    if current_page=="overview"{
                        div{class:"page-content overview",PageHeading{title:"Overview"}
                            div{class:"quick-actions",button{class:"quick-action",disabled:is_recording,onclick:move |_|new_meeting.set(true),span{class:"quick-icon peach",Icon{name:"mic",size:21}}span{strong{"Record in person"}small{"Room microphone"}}Icon{name:"arrow-right",size:17}}button{class:"quick-action",onclick:move |_|page.set("calendar".into()),span{class:"quick-icon lavender",Icon{name:"calendar",size:21}}span{strong{"Online meeting"}small{"Google Meet"}}Icon{name:"arrow-right",size:17}}label{class:"quick-action upload-action",span{class:"quick-icon mint",Icon{name:"upload",size:21}}span{strong{"Upload a recording"}small{"Audio file"}}Icon{name:"arrow-right",size:17}input{r#type:"file","aria-label":"Upload a recording",accept:"audio/*,video/webm,video/mp4",onchange:move |_|{spawn(async move{match crate::api::evaluate("return await window.echo.upload(document.getElementById('audio-upload'))").await{Ok(_)=>{},Err(e)=>toast.set(format!("Upload could not complete: {e}"))}});},id:"audio-upload",class:"file-input"}}}
                            if count>0{div{class:"stats-row",div{class:"stat-item",span{class:"stat-icon",Icon{name:"video",size:18}}div{strong{"{count}"}span{"Meetings"}}}div{class:"stat-item",span{class:"stat-icon",Icon{name:"clock",size:18}}div{strong{"{minutes:.0}"}span{"Minutes"}}}div{class:"stat-item",span{class:"stat-icon",Icon{name:"sparkles",size:18}}div{strong{"{note_count}"}span{"With notes"}}}div{class:"stat-item privacy-stat",span{class:"stat-icon",Icon{name:"shield",size:18}}div{strong{"Local"}span{"Audio capture"}}}}}
                            div{class:"overview-columns",section{class:"recent-section",SectionHeading{title:"Recent meetings",button{class:"text-button",onclick:move |_|page.set("meetings".into()),"View all" Icon{name:"arrow-right",size:15}}}if count==0{div{class:"empty-library panel",div{class:"empty-library-icon",Icon{name:"mic",size:27}}h3{"No meetings yet"}p{"Record a meeting or upload audio."}ActionButton{kind:ButtonKind::Secondary,onclick:move |_|{spawn(async move{if let Ok(v)=get("/demo").await{selected.set(v);page.set("review".into())}else{toast.set("Sample meeting is unavailable.".into())}});},Icon{name:"play",size:14}"Explore a sample meeting"}span{class:"small-muted","Sample · no audio"}}}else{div{class:"recent-list",for meeting in visible.iter().take(4).cloned(){MeetingCard{meeting,on_open:move |m|{selected.set(m);page.set("review".into());}}}}}
                            }

                            }
                        }
                    }else if current_page=="meetings"{
                        div{class:"page-content",PageHeading{title:"All meetings",ActionButton{kind:ButtonKind::Primary,disabled:is_recording,onclick:move |_|new_meeting.set(true),Icon{name:"plus"}"New meeting"}}
                            div{class:"library-toolbar",div{class:"search-field",Icon{name:"search",size:18}input{id:"library-search",placeholder:"Search meetings, transcripts, and notes…",value:query(),oninput:move |e|query.set(e.value()),"aria-label":"Search meeting library"}if !query().is_empty(){IconButton{label:"Clear search",icon:"close",onclick:move |_|query.set(String::new())}}}div{class:"filter-tabs",for (id,label) in [("all","All meetings"),("in-person","In person"),("online","Online"),("saved","Saved moments")]{button{class:if filter()==id{"active"}else{""},"aria-pressed":filter()==id,onclick:move |_|filter.set(id.into()),"{label}"}}}}
                            if loading(){div{class:"loading-panel",span{class:"spinner"}"Loading meetings…"}}else if visible.is_empty(){div{class:"panel empty-state library-empty",Icon{name:"library",size:36}h2{if query().is_empty(){"No meetings yet"}else{"No meetings found."}}p{if query().is_empty(){"Record a meeting or upload audio."}else{"Try a different word or choose All meetings."}}ActionButton{kind:ButtonKind::Secondary,disabled:count==0&&is_recording,onclick:move |_|{query.set(String::new());filter.set("all".into());if count==0{new_meeting.set(true)}},if count==0{"New meeting"}else{"Clear filters"}}}}else{SectionHeading{title:"Meetings",span{class:"small-muted",{count_label(visible.len(),"meeting","meetings")}}}div{class:"meeting-grid",for meeting in visible{MeetingCard{meeting,on_open:move |m|{selected.set(m);page.set("review".into());}}}}}
                        }
                    }else if current_page=="review"{
                        if selected().is_object(){
                            div{key:"{selected_id}",
                            if text(&selected(),"mode")=="online" && selected()["tracks"].as_array().map(|t|t.is_empty()).unwrap_or(true){BotStatus{meeting:selected,notify:move|s|toast.set(s)}}
                            MeetingReview{meeting:selected,transcribing:processing_jobs().contains(&selected_id),generating_notes:notes_jobs().get(&selected_id).cloned().unwrap_or_default(),on_back:move |_|{page.set("meetings".into());spawn(async move{if let Ok(v)=get("/meetings").await{meetings.set(v["meetings"].as_array().cloned().unwrap_or_default())}});},on_change:move |m:Value|{if m["id"]==selected()["id"]{selected.set(m);}spawn(async move{if let Ok(v)=get("/meetings").await{meetings.set(v["meetings"].as_array().cloned().unwrap_or_default())}});},notify:move |s|toast.set(s)}
                            }
                        }
                    }else if current_page=="calendar"{calendar::Calendar{settings,on_meeting:move|m|{selected.set(m);page.set("review".into());spawn(async move{if let Ok(v)=get("/meetings").await{meetings.set(v["meetings"].as_array().cloned().unwrap_or_default())}});},notify:move|s|toast.set(s)}}
                    else if current_page=="models"{models::Models{settings,download:model_download,notes_download,on_change:move|s|settings.set(s),notify:move|s|toast.set(s)}}
                    else if current_page=="settings"{Settings{key:"{settings_section}",settings,draft:settings_draft,snapshot:settings_snapshot,on_change:move|s|settings.set(s),notify:move|s|toast.set(s),initial_section:settings_section()}}
                }
            }
        }
        div{class:if is_recording{"task-stack above-recording"}else{"task-stack"},
        for upload in uploads(){div{class:"upload-progress panel",role:"status",div{Icon{name:"upload",size:17}strong{"Saving recording…"}span{{format!("{:.0}%",upload["progress"].as_f64().unwrap_or(0.))}}}p{{text(&upload,"fileName")}}progress{max:"100",value:upload["progress"].as_f64().unwrap_or(0.).to_string(),"aria-label":format!("Saving {}",text(&upload,"fileName"))}}}
        if !notes_jobs().is_empty(){div{class:"processing-banner",role:"status",span{class:"spinner"}span{{format!("Generating notes for {}…",count_label(notes_jobs().len(),"meeting","meetings"))}}}}
        if !processing_jobs().is_empty(){div{class:"processing-banner",role:"status",span{class:"spinner"}span{{processing_label(&processing_jobs(), &processing_progress(), &progressing_meeting(), cancelling_processing())}}ActionButton{kind:ButtonKind::Ghost,disabled:cancelling_processing(),onclick:move |_|{cancelling_processing.set(true);let _=document::eval("window.echoInference.cancelInference()");},if processing_jobs().len()>1 {"Cancel all"} else {"Cancel"}}}}
        }
        if is_recording{RecorderBar{recorder,on_open:move |_|{let id=text(&recorder(),"meetingId");spawn(async move{if let Ok(m)=get(&format!("/meetings/{id}")).await{selected.set(m);page.set("review".into());}});},notify:move|s|toast.set(s)}}
        if new_meeting(){NewMeeting{settings,on_close:move |_|new_meeting.set(false),on_calendar:move |_|{new_meeting.set(false);page.set("calendar".into());},on_start:move|m|{selected.set(m);page.set("review".into());spawn(async move{if let Ok(v)=get("/meetings").await{meetings.set(v["meetings"].as_array().cloned().unwrap_or_default())}});}}}
        if !toast().is_empty(){div{class:"toast",role:"status",Icon{name:"sparkles",size:18}span{"{toast}"}IconButton{label:"Dismiss notification",icon:"close",onclick:move |_|toast.set(String::new())}}}
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
            .map(|v| v.len())
            .unwrap_or(0)
    } else {
        0
    };
    rsx! {button{class:"meeting-card panel",onclick:move |_|on_open.call(meeting.clone()),div{class:"meeting-card-top",span{class:if mode=="online"{"meeting-icon lavender"}else{"meeting-icon peach"},Icon{name:if mode=="online"{"video"}else{"mic"},size:21}}StatusBadge{tone:if status=="ready"{BadgeTone::Success}else if status=="error"||status=="interrupted"{BadgeTone::Warning}else{BadgeTone::Neutral},"{status}"}}h3{"{title}"}div{class:"meeting-card-meta",span{"{date}"}span{"·"}Icon{name:"clock",size:13}span{"{duration}"}}div{class:"meeting-card-bottom",span{if tags>0{{count_label(tags,"next step","next steps")}}else if status=="ready"{"Open transcript"}else{"Open meeting"}}Icon{name:"arrow-right",size:16}}}}
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
    rsx! {div{class:"dialog-backdrop",div{class:"dialog",id:"new-meeting-dialog",role:"dialog","aria-modal":"true","aria-labelledby":"new-meeting-heading",IconButton{class:"dialog-close",id:"close-new-meeting",label:"Close new meeting",icon:"close",disabled:busy(),onclick:move |_|on_close.call(())}h2{id:"new-meeting-heading","New meeting"}
        div{class:"meeting-mode-options",div{class:"mode-option selected",span{class:"mode-option-icon",Icon{name:"mic",size:22}}div{strong{"In person"}span{"Capture your room microphone"}}Icon{name:"check",size:17}}button{class:"mode-option",disabled:busy(),onclick:move |_|on_calendar.call(()),span{class:"mode-option-icon",Icon{name:"calendar",size:22}}div{strong{"Online meeting"}span{"Connect a meeting from your calendar"}}Icon{name:"chevron",size:17}}}
        label{class:"field-label",r#for:"new-meeting-title","Meeting name " span{"Optional"}}input{class:"input",id:"new-meeting-title",placeholder:"e.g. Monday product catch-up",maxlength:"180",disabled:busy(),value:title(),oninput:move|e|title.set(e.value())}
        div{class:"mic-setup",div{Icon{name:"mic",size:18}span{if tested(){"Microphone access is ready"}else{"Choose your microphone"}}}ActionButton{kind:ButtonKind::Secondary,compact:true,disabled:busy(),onclick:move |_|{spawn(async move{busy.set(true);error.set(String::new());match crate::api::evaluate("return await window.echo.testMicrophone()").await{Ok(v)=>{devices.set(v.as_array().cloned().unwrap_or_default());tested.set(true)},Err(e)=>error.set(format!("Microphone access failed. Check your browser permissions. {e}"))}busy.set(false);});},if tested(){"Check again"}else{"Test access"}}}
        if !devices().is_empty(){select{class:"input","aria-label":"Microphone",disabled:busy(),value:device(),onchange:move|e|device.set(e.value()),option{value:"","System default microphone"}for d in devices(){option{value:text(&d,"id"),{text(&d,"label")}}}}}
        label{class:"check-row",input{r#type:"checkbox",disabled:busy(),checked:muted(),onchange:move|e|muted.set(e.checked())}span{"Start with microphone capture muted"}}
        div{class:"privacy-note",Icon{name:"shield",size:19}p{"Keep this tab open while recording. Audio is saved on this device."}}
        label{class:"check-row consent-row",input{r#type:"checkbox",disabled:busy(),checked:consent(),onchange:move|e|consent.set(e.checked())}span{"I have permission from everyone being recorded."}}
        if !error().is_empty(){div{class:"inline-error",role:"alert",Icon{name:"alert"}"{error}"}}
        ActionButton{kind:ButtonKind::Primary,full_width:true,disabled:!consent()||busy(),onclick:move |_|{spawn(async move{busy.set(true);error.set(String::new());let meeting_title=if title().trim().is_empty(){"New meeting".into()}else{title()};match post("/meetings",json!({"title":meeting_title,"mode":"in-person","consent":true,"speechModel":settings()["speechModel"],"notesModel":settings()["notesModel"],"liveTranscription":false})).await{Ok(m)=>{let script=format!("return await window.echoRecorder.start({{meeting:{},deviceId:{},startMuted:{}}})",m,serde_json::to_string(&device()).unwrap(),muted());match crate::api::evaluate(&script).await{Ok(_)=>{let latest=get(&format!("/meetings/{}",text(&m,"id"))).await.unwrap_or(m);on_start.call(latest);on_close.call(())},Err(e)=>{let msg=format!("Could not start recording: {e}");let _=patch(&format!("/meetings/{}",text(&m,"id")),json!({"status":"error","error":msg})).await;error.set(msg)}}},Err(e)=>error.set(e)}busy.set(false);});},if busy(){span{class:"spinner"}"Getting ready…"}else{Icon{name:"mic"}"Start recording"}}

    }}}
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
    rsx! {div{class:"recorder-bar",role:"region","aria-label":"Active recording controls",div{class:"recording-status",span{class:if status=="recording"{"record-dot pulse"}else{"record-dot"}}div{strong{if status=="paused"{"Recording paused"}else if status=="saving"{"Saving recording…"}else if status=="error"{"Recording interrupted"}else if muted{"Microphone muted"}else{"Recording"}}button{onclick:move |_|on_open.call(()),"View active meeting"}}}div{class:"recorder-level","aria-label":"Microphone audio level",for i in 0..12{span{class:if level*12.>i as f64{"lit"}else{""},style:format!("height:{}px",8+(i%5)*3)}}}strong{class:"recorder-time","{elapsed}"}button{class:"icon-button",disabled:status=="saving"||status=="error","aria-label":if muted{"Unmute capture"}else{"Mute capture"},onclick:move |_|{let _=document::eval("window.echoRecorder.toggleMute()");},Icon{name:if muted{"mute"}else{"mic"}}}button{class:"icon-button",disabled:status=="saving"||status=="error","aria-label":if status=="paused"{"Resume recording"}else{"Pause recording"},onclick:move |_|{let _=document::eval(if status=="paused"{"window.echoRecorder.resume()"}else{"window.echoRecorder.pause()"});},Icon{name:if text(&state,"status")=="paused"{"play"}else{"pause"}}}button{class:"button button-record-stop",disabled:text(&state,"status")=="saving",onclick:move |_|{spawn(async move{let script=if text(&recorder(),"status")=="error"{"return await window.echoRecorder.retry()"}else{"return await window.echoRecorder.stop()"};if let Err(e)=crate::api::evaluate(script).await{notify.call(format!("Could not finish saving: {e}. Keep this tab open and retry."));}});},Icon{name:"stop",size:15}if text(&state,"status")=="error"{"Retry save"}else{"Stop & save"}}if let Some(error)=state["error"].as_str(){p{class:"recorder-error","{error}"}}}}
}

#[component]
/// Poll a meeting guest's state and expose stop and finalized-audio import actions.
fn BotStatus(mut meeting: Signal<Value>, notify: EventHandler<String>) -> Element {
    let mut status = use_signal(|| Value::Null);
    let mut busy = use_signal(|| false);
    let id = text(&meeting(), "id");
    use_future(move || async move {
        let id = text(&meeting(), "id");
        loop {
            match get(&format!("/integrations/bot?meetingId={id}")).await {
                Ok(v) => {
                    let state = text(&v, "status");
                    status.set(v);
                    if state == "recording" {
                        if let Ok(m) = get(&format!("/meetings/{id}")).await {
                            meeting.set(m);
                        }
                    }
                    if state == "completed" || state == "failed" {
                        break;
                    }
                }
                Err(e) => {
                    status.set(json!({"status":"Needs attention","detail":e}));
                    break;
                }
            }
            let _ =
                document::eval("await new Promise(resolve=>setTimeout(resolve,5000));return true;")
                    .await;
        }
    });
    rsx! {div{class:"bot-status panel",Icon{name:"video"}div{strong{"Local meeting participant"}p{if status().is_null(){"Check the runner for admission and recording status."}else{{format!("{} · {}",text(&status(),"status"),text(&status(),"detail"))}}}}ActionButton{kind:ButtonKind::Secondary,compact:true,disabled:busy(),onclick:{let id=id.clone();move |_|{let id=id.clone();spawn(async move{busy.set(true);match get(&format!("/integrations/bot?meetingId={id}")).await{Ok(v)=>status.set(v),Err(e)=>notify.call(e)}busy.set(false);});}},"Check status"}ActionButton{kind:ButtonKind::Secondary,compact:true,disabled:busy(),onclick:{let id=id.clone();move |_|{let id=id.clone();spawn(async move{busy.set(true);match api::delete(&format!("/integrations/bot?meetingId={id}")).await{Ok(v)=>{status.set(v);notify.call("Stop requested. Check status, then save the completed recording.".into())},Err(e)=>notify.call(e)}busy.set(false);});}},"Stop bot"}ActionButton{kind:ButtonKind::Primary,compact:true,disabled:busy(),onclick:move |_|{let id=id.clone();spawn(async move{busy.set(true);match post(&format!("/integrations/bot/import?meetingId={id}"),json!({})).await{Ok(v)=>{meeting.set(v["meeting"].clone());let _=document::eval(&format!("window.dispatchEvent(new CustomEvent('echo-recording-saved',{{detail:{}}}))",v["meeting"]));notify.call("Meeting recording saved locally.".into());},Err(e)=>notify.call(e)}busy.set(false);});},"Save recording"}}}
}
