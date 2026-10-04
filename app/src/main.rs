mod api;
mod calendar;
mod chatgpt;
mod models;
mod review;
mod settings;
use api::{get, patch, post, text, time};
use dioxus::prelude::*;
use review::MeetingReview;
use serde_json::{json, Value};
use settings::Settings;

fn main() {
    dioxus::launch(App);
}

#[component]
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
        "menu"=>"M4 6h16M4 12h16M4 18h16", "alert"=>"m12 3 10 18H2Zm0 6v5m0 3h.01", "video"=>"M3 5h12v14H3Zm12 5 7-4v12l-7-4",
        _ => "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
    };
    rsx! {svg{width:"{size}",height:"{size}",view_box:"0 0 24 24",fill:"none",stroke:"currentColor",stroke_width:"1.7",stroke_linecap:"round",stroke_linejoin:"round","aria-hidden":"true",path{d:path}}}
}

#[component]
fn App() -> Element {
    let mut page = use_signal(|| "overview".to_string());
    let mut meetings = use_signal(Vec::<Value>::new);
    let mut selected = use_signal(|| Value::Null);
    let mut settings = use_signal(
        || json!({"name":"","speechModel":"onnx-community/whisper-tiny.en","notesModel":"qwen2.5:3b","autoTranscribe":true,"language":"en"}),
    );
    // Keep unsaved preferences through tabs and the account-setup round trip.
    let settings_draft = use_signal(|| settings());
    let settings_snapshot = use_signal(|| settings());
    let mut loading = use_signal(|| true);
    let mut load_error = use_signal(String::new);
    let mut toast = use_signal(String::new);
    let mut new_meeting = use_signal(|| false);
    let mut mobile_nav = use_signal(|| false);
    let mut query = use_signal(String::new);
    let mut filter = use_signal(|| "all".to_string());
    let mut recorder = use_signal(|| json!({"status":"idle","elapsed":0}));
    let mut processing = use_signal(String::new);
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
            r#"for(const name of ['echo-open-models','echo-upload-progress','echo-recorder-state','echo-recording-saved','echo-library-changed','echo-transcription-complete','echo-transcript-saved','echo-transcription-error','echo-transcription-start','echo-auto-transcription-skipped']){window.addEventListener(name,e=>dioxus.send({name,detail:e.detail}));} window.addEventListener('keydown',e=>{if(document.querySelector('[aria-modal="true"],dialog[open],.sidebar.open'))return;if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();dioxus.send({name:'search'})} if((e.metaKey||e.ctrlKey)&&e.key==='j'){e.preventDefault();dioxus.send({name:'new'})}});"#,
        );
        while let Ok(event) = events.recv::<Value>().await {
            match event["name"].as_str().unwrap_or("") {
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
                    toast.set("Recording saved safely in your workspace.".into());
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
                    processing.set(String::new());
                    let detail = &event["detail"];
                    if detail["id"].is_string() && detail["id"] == selected()["id"] {
                        selected.set(detail.clone())
                    } else if let Some(id) = detail["meetingId"].as_str() {
                        if let Ok(m) = get(&format!("/meetings/{id}")).await {
                            if m["id"] == selected()["id"] {
                                selected.set(m)
                            }
                        }
                    }
                    toast.set("Transcript ready. Make it your own.".into());
                    if let Ok(v) = get("/meetings").await {
                        meetings.set(v["meetings"].as_array().cloned().unwrap_or_default())
                    }
                }
                "echo-transcription-error" => {
                    processing.set(String::new());
                    toast.set(
                        event["detail"]["error"]
                            .as_str()
                            .unwrap_or("Transcription failed. Your recording is still saved.")
                            .into(),
                    )
                }
                "echo-auto-transcription-skipped" => toast.set(text(&event["detail"], "message")),
                "echo-transcription-start" => processing.set("Transcribing on your device…".into()),
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
    visible.sort_by(|a, b| text(b, "createdAt").cmp(&text(a, "createdAt")));
    let current_page = page();
    let heading = match current_page.as_str() {
        "meetings" => "All meetings",
        "calendar" => "Calendar",
        "models" => "Models",
        "settings" => "Settings",
        "review" => "Meeting workspace",
        _ => "Overview",
    };
    let name = text(&settings(), "name");
    let selected_id = text(&selected(), "id");
    rsx! {
        a{class:"skip-link",href:"#workspace-main","Skip to content"}
        div{class:if is_recording{"app-shell has-recording"}else{"app-shell"},
            if mobile_nav(){button{class:"nav-scrim","aria-label":"Close navigation",onclick:move |_|mobile_nav.set(false)}}
            aside{id:"workspace-navigation","aria-label":"Workspace",class:if mobile_nav(){"sidebar open"}else{"sidebar"},
                a{class:"brand",href:"#",onclick:move |e|{e.prevent_default();page.set("overview".into());mobile_nav.set(false);},div{class:"brand-mark",span{} span{} span{} span{}} span{"echo" span{"voice"}}}
                div{class:"workspace-switch",div{class:"workspace-avatar","P"}div{strong{"Personal workspace"}span{span{class:"tiny-dot"}"Only on this device"}}Icon{name:"chevron-down",size:15}}
                span{class:"nav-section-label","WORKSPACE"}
                nav{class:"main-nav","aria-label":"Main navigation",for (id,icon,label) in nav{button{class:if current_page==id{"nav-item active"}else{"nav-item"},"aria-current":if current_page==id{"page"}else{"false"},onclick:move |_|{page.set(id.into());mobile_nav.set(false);},Icon{name:icon}span{"{label}"}if id=="meetings"{span{class:"nav-count","{count}"}}if id=="models"{span{class:"nav-dot"}}}}}
                div{class:"sidebar-bottom",div{class:"privacy-card",div{class:"privacy-icon",Icon{name:"shield",size:20}}h4{"Your words. Your choice."}p{"Local by default.\nCloud connections are your choice."}button{onclick:move |_|{settings_section.set("help".into());page.set("settings".into());mobile_nav.set(false);},"Our local-first promise" Icon{name:"arrow",size:14}}}
                    button{class:if current_page=="settings"{"nav-item active"}else{"nav-item"},onclick:move |_|{page.set("settings".into());settings_section.set("general".into());mobile_nav.set(false);},Icon{name:"settings"}span{"Settings"}}
                    button{class:"nav-item",onclick:move |_|{page.set("settings".into());settings_section.set("help".into());mobile_nav.set(false);},Icon{name:"help"}span{"Setup & help"}}
                    div{class:"profile",div{class:"profile-avatar","{name.chars().next().unwrap_or('Y').to_uppercase()}"}div{strong{if name.is_empty(){"Your local space"}else{"{name}"}}span{"A little more present."}}span{class:"version","v0.1"}}
                }
            }
            div{class:"main-shell",header{class:"topbar",div{class:"topbar-left",button{class:"icon-button mobile-menu","aria-label":"Open navigation","aria-expanded":mobile_nav(),"aria-controls":"workspace-navigation",onclick:move |_|mobile_nav.set(true),Icon{name:"menu"}}span{class:"breadcrumb-home","Workspace"}Icon{name:"chevron",size:13}strong{"{heading}"}}div{class:"topbar-right",span{class:"local-pill",span{class:"tiny-dot"}"Local workspace"}button{class:"global-search",onclick:move |_|{page.set("meetings".into());let _=document::eval("setTimeout(()=>document.getElementById('library-search')?.focus(),100)");},Icon{name:"search",size:16}span{"Search anything"}kbd{"⌘ K"}}button{class:"button button-primary button-small",disabled:is_recording,onclick:move |_|new_meeting.set(true),Icon{name:"plus",size:16}span{"New meeting"}}}}
                main{id:"workspace-main",tabindex:"-1",
                    if !load_error().is_empty(){div{class:"load-error inline-error",Icon{name:"alert"}"{load_error}" button{class:"button button-secondary",onclick:move |_|{spawn(async move{loading.set(true);match get("/meetings").await{Ok(v)=>{meetings.set(v["meetings"].as_array().cloned().unwrap_or_default());load_error.set(String::new())},Err(e)=>load_error.set(e)}loading.set(false);});},"Retry"}}}
                    if current_page=="overview"{
                        div{class:"page-content overview",div{class:"page-heading",div{span{class:"eyebrow","A LITTLE MORE PRESENT"}h1{"Good conversations start here."}p{"Let the ideas flow. We’ll help you remember the details."}}div{class:"today-label",Icon{name:"calendar",size:15}"Your personal workspace"}}
                            section{class:"hero-card",div{class:"hero-content",span{class:"hero-kicker",span{class:"tiny-dot"}"LOCAL FIRST. YOUR CHOICE."}h2{"Less note-taking." br{}span{"More being there."}}p{"Turn your conversations into clear transcripts,\nthoughtful notes, and meaningful next steps."}div{class:"hero-actions",button{class:"button button-white",disabled:is_recording,onclick:move |_|new_meeting.set(true),Icon{name:"mic",size:17}"Start a conversation" Icon{name:"arrow-right",size:16}}button{class:"hero-secondary",onclick:move |_|{settings_section.set("help".into());page.set("settings".into());},"How it works" Icon{name:"arrow",size:15}}}}
                                div{class:"hero-visual","aria-hidden":"true",div{class:"orbit orbit-one"}div{class:"orbit orbit-two"}div{class:"orbit orbit-three"}div{class:"hero-wave",for i in 0..35{span{style:format!("height:{}px;animation-delay:{}ms",18.+((i as f64*0.77).sin().abs()*75.)*(1.-((i as f64-17.)/23.).abs()),i*65)}}}div{class:"floating-note",div{class:"floating-note-icon",Icon{name:"sparkles",size:15}}div{strong{"Clarity, captured."}span{"Every good idea has a place."}}}div{class:"hero-local",Icon{name:"shield",size:13}"Recorded on your device"}}
                            }
                            div{class:"quick-actions",button{class:"quick-action",disabled:is_recording,onclick:move |_|new_meeting.set(true),span{class:"quick-icon peach",Icon{name:"mic",size:21}}span{strong{"In-person conversation"}small{"One room. Every voice."}}Icon{name:"arrow-right",size:17}}button{class:"quick-action",onclick:move |_|page.set("calendar".into()),span{class:"quick-icon lavender",Icon{name:"calendar",size:21}}span{strong{"From your calendar"}small{"A note-taker for your next call."}}Icon{name:"arrow-right",size:17}}label{class:"quick-action upload-action",span{class:"quick-icon mint",Icon{name:"upload",size:21}}span{strong{"Upload a recording"}small{"Give an existing conversation clarity."}}Icon{name:"arrow-right",size:17}input{r#type:"file","aria-label":"Upload a recording",accept:"audio/*,video/webm,video/mp4",onchange:move |_|{spawn(async move{match crate::api::evaluate("return await window.echo.upload(document.getElementById('audio-upload'))").await{Ok(_)=>{},Err(e)=>toast.set(format!("Upload could not complete: {e}"))}});},id:"audio-upload",class:"file-input"}}}
                            if count>0{div{class:"stats-row",div{class:"stat-item",span{class:"stat-icon",Icon{name:"video",size:18}}div{strong{"{count}"}span{"Conversations captured"}}}div{class:"stat-item",span{class:"stat-icon",Icon{name:"clock",size:18}}div{strong{"{minutes:.0}"}span{"Minutes remembered"}}}div{class:"stat-item",span{class:"stat-icon",Icon{name:"sparkles",size:18}}div{strong{"{note_count}"}span{"Meetings with clarity"}}}div{class:"stat-item privacy-stat",span{class:"stat-icon",Icon{name:"shield",size:18}}div{strong{"Local"}span{"Audio capture"}}}}}
                            div{class:if count==0{"overview-columns overview-first-use"}else{"overview-columns"},if count==0{SetupCard{on_help:move |_|{settings_section.set("help".into());page.set("settings".into());},on_models:move |_|page.set("models".into()),on_calendar:move |_|page.set("calendar".into())}}section{class:"recent-section",div{class:"section-heading",h2{"Your recent conversations"}button{class:"text-button",onclick:move |_|page.set("meetings".into()),"View all" Icon{name:"arrow-right",size:15}}}if count==0{div{class:"empty-library panel",div{class:"empty-library-icon",Icon{name:"mic",size:27}}h3{"The start of something worth remembering."}p{"Your conversations will find a home here.\nRecord your first, or take a look around."}button{class:"button button-secondary",onclick:move |_|{spawn(async move{if let Ok(v)=get("/demo").await{selected.set(v);page.set("review".into())}else{toast.set("Sample meeting is unavailable.".into())}});},Icon{name:"play",size:14}"Explore a sample meeting"}span{class:"small-muted","Illustrative example · no audio or real meeting data"}}}else{div{class:"recent-list",for meeting in visible.iter().take(4).cloned(){MeetingCard{meeting,on_open:move |m|{selected.set(m);page.set("review".into());}}}}}
                            }
                                if count>0{SetupCard{on_help:move |_|{settings_section.set("help".into());page.set("settings".into());},on_models:move |_|page.set("models".into()),on_calendar:move |_|page.set("calendar".into())}}
                            }div{class:"workspace-footer",Icon{name:"shield",size:13}"A quiet space for your conversations. Nothing leaves without you."}
                        }
                    }else if current_page=="meetings"{
                        div{class:"page-content",div{class:"page-heading",div{span{class:"eyebrow","YOUR COLLECTIVE CLARITY"}h1{"Every conversation, remembered."}p{"Find the idea, the decision, or the detail you came back for."}}button{class:"button button-primary",disabled:is_recording,onclick:move |_|new_meeting.set(true),Icon{name:"plus"}"New meeting"}}
                            div{class:"library-toolbar",div{class:"search-field",Icon{name:"search",size:18}input{id:"library-search",placeholder:"Search meetings, transcripts, and notes…",value:query(),oninput:move |e|query.set(e.value()),"aria-label":"Search meeting library"}if !query().is_empty(){button{class:"icon-button","aria-label":"Clear search",onclick:move |_|query.set(String::new()),Icon{name:"close",size:15}}}}div{class:"filter-tabs",for (id,label) in [("all","All meetings"),("in-person","In person"),("online","Online"),("saved","Saved moments")]{button{class:if filter()==id{"active"}else{""},"aria-pressed":filter()==id,onclick:move |_|filter.set(id.into()),"{label}"}}}}
                            if loading(){div{class:"loading-panel",span{class:"spinner"}"Opening your library…"}}else if visible.is_empty(){div{class:"panel empty-state library-empty",Icon{name:"library",size:36}h2{if query().is_empty(){"Your story starts with a conversation."}else{"No conversations found."}}p{if query().is_empty(){"Start recording or upload audio from the overview to build your private library."}else{"Try a different word or choose All meetings."}}button{class:"button button-secondary",disabled:count==0&&is_recording,onclick:move |_|{query.set(String::new());filter.set("all".into());if count==0{new_meeting.set(true)}},if count==0{"Start a conversation"}else{"Clear filters"}}}}else{div{class:"section-heading",h2{"Saved on this device"}span{class:"small-muted","{visible.len()} meetings"}}div{class:"meeting-grid",for meeting in visible{MeetingCard{meeting,on_open:move |m|{selected.set(m);page.set("review".into());}}}}}
                        }
                    }else if current_page=="review"{
                        if selected().is_object(){
                            div{key:"{selected_id}",
                            if text(&selected(),"mode")=="online" && selected()["tracks"].as_array().map(|t|t.is_empty()).unwrap_or(true){BotStatus{meeting:selected,notify:move|s|toast.set(s)}}
                            MeetingReview{meeting:selected,on_back:move |_|{page.set("meetings".into());spawn(async move{if let Ok(v)=get("/meetings").await{meetings.set(v["meetings"].as_array().cloned().unwrap_or_default())}});},on_change:move |m:Value|{if m["id"]==selected()["id"]{selected.set(m);}spawn(async move{if let Ok(v)=get("/meetings").await{meetings.set(v["meetings"].as_array().cloned().unwrap_or_default())}});},notify:move |s|toast.set(s)}
                            }
                        }
                    }else if current_page=="calendar"{calendar::Calendar{settings,on_meeting:move|m|{selected.set(m);page.set("review".into());},notify:move|s|toast.set(s)}}
                    else if current_page=="models"{models::Models{settings,on_change:move|s|settings.set(s),notify:move|s|toast.set(s),on_setup:move |_|{settings_section.set("help".into());page.set("settings".into());}}}
                    else if current_page=="settings"{Settings{key:"{settings_section}",settings,draft:settings_draft,snapshot:settings_snapshot,on_change:move|s|settings.set(s),notify:move|s|toast.set(s),initial_section:settings_section()}}
                }
            }
        }
        div{class:if is_recording{"task-stack above-recording"}else{"task-stack"},
        for upload in uploads(){div{class:"upload-progress panel",role:"status",div{Icon{name:"upload",size:17}strong{"Saving recording…"}span{{format!("{:.0}%",upload["progress"].as_f64().unwrap_or(0.))}}}p{{text(&upload,"fileName")}}progress{max:"100",value:upload["progress"].as_f64().unwrap_or(0.).to_string(),"aria-label":format!("Saving {}",text(&upload,"fileName"))}}}
        if !processing().is_empty(){div{class:"processing-banner",role:"status",span{class:"spinner"}"{processing}" button{class:"button button-ghost",onclick:move |_|{let _=document::eval("window.echoInference.cancelInference()");processing.set(String::new());},"Cancel"}}}
        }
        if is_recording{RecorderBar{recorder,on_open:move |_|{let id=text(&recorder(),"meetingId");spawn(async move{if let Ok(m)=get(&format!("/meetings/{id}")).await{selected.set(m);page.set("review".into());}});},notify:move|s|toast.set(s)}}
        if new_meeting(){NewMeeting{settings,on_close:move |_|new_meeting.set(false),on_calendar:move |_|{new_meeting.set(false);page.set("calendar".into());},on_start:move|m|{selected.set(m);page.set("review".into());spawn(async move{if let Ok(v)=get("/meetings").await{meetings.set(v["meetings"].as_array().cloned().unwrap_or_default())}});}}}
        if !toast().is_empty(){div{class:"toast",role:"status",Icon{name:"sparkles",size:18}span{"{toast}"}button{class:"icon-button","aria-label":"Dismiss notification",onclick:move |_|toast.set(String::new()),Icon{name:"close",size:16}}}}
    }
}

#[component]
fn SetupCard(
    on_help: EventHandler<()>,
    on_models: EventHandler<()>,
    on_calendar: EventHandler<()>,
) -> Element {
    rsx! {aside {class:"onboarding-column",aria_label:"Getting started",
        div {class:"section-heading",h2 {"Make yourself at home"}}
        div {class:"panel setup-card",
            span {class:"setup-card-icon",Icon {name:"sparkles",size:21}}
            h3 {"Ready when you are."}
            p {"Record right away. Set up transcription and connections when you need them."}
            button {class:"setup-step",onclick:move |_|on_help.call(()),span {"1"}div {strong {"Meet your workspace"}small {"Microphone, storage, and privacy"}}Icon {name:"chevron",size:16}}
            button {class:"setup-step",onclick:move |_|on_models.call(()),span {"2"}div {strong {"Set up transcription"}small {"Choose a model to run locally"}}Icon {name:"chevron",size:16}}
            button {class:"setup-step",onclick:move |_|on_calendar.call(()),span {"3"}div {strong {"Connect your calendar"}small {"Optional · for online meetings"}}Icon {name:"chevron",size:16}}
        }
    }}
}

#[component]
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
    rsx! {button{class:"meeting-card panel",onclick:move |_|on_open.call(meeting.clone()),div{class:"meeting-card-top",span{class:if mode=="online"{"meeting-icon lavender"}else{"meeting-icon peach"},Icon{name:if mode=="online"{"video"}else{"mic"},size:21}}span{class:if status=="ready"{"badge badge-green"}else if status=="error"||status=="interrupted"{"badge badge-amber"}else{"badge"},"{status}"}}h3{"{title}"}div{class:"meeting-card-meta",span{"{date}"}span{"·"}Icon{name:"clock",size:13}span{"{duration}"}}div{class:"meeting-card-bottom",span{if tags>0{"{tags} next steps"}else if status=="ready"{"Ready to revisit"}else{"Open conversation"}}Icon{name:"arrow-right",size:16}}}}
}

#[component]
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
    rsx! {div{class:"dialog-backdrop",div{class:"dialog",id:"new-meeting-dialog",role:"dialog","aria-modal":"true","aria-labelledby":"new-meeting-heading",button{class:"icon-button dialog-close",id:"close-new-meeting","aria-label":"Close new meeting",disabled:busy(),onclick:move |_|on_close.call(()),Icon{name:"close",size:20}}h2{id:"new-meeting-heading","Make space for a conversation."}p{class:"dialog-description","A private recording. A clearer head."}
        div{class:"meeting-mode-options",div{class:"mode-option selected",span{class:"mode-option-icon",Icon{name:"mic",size:22}}div{strong{"In person"}span{"Capture your room microphone"}}Icon{name:"check",size:17}}button{class:"mode-option",disabled:busy(),onclick:move |_|on_calendar.call(()),span{class:"mode-option-icon",Icon{name:"calendar",size:22}}div{strong{"Online meeting"}span{"Connect a meeting from your calendar"}}Icon{name:"chevron",size:17}}}
        label{class:"field-label",r#for:"new-meeting-title","Meeting name " span{"Optional"}}input{class:"input",id:"new-meeting-title",placeholder:"e.g. Monday product catch-up",maxlength:"180",disabled:busy(),value:title(),oninput:move|e|title.set(e.value())}
        div{class:"mic-setup",div{Icon{name:"mic",size:18}span{if tested(){"Microphone access is ready"}else{"Choose your microphone"}}}button{class:"button button-secondary button-small",disabled:busy(),onclick:move |_|{spawn(async move{busy.set(true);error.set(String::new());match crate::api::evaluate("return await window.echo.testMicrophone()").await{Ok(v)=>{devices.set(v.as_array().cloned().unwrap_or_default());tested.set(true)},Err(e)=>error.set(format!("Microphone access failed. Check your browser permissions. {e}"))}busy.set(false);});},if tested(){"Check again"}else{"Test access"}}}
        if !devices().is_empty(){select{class:"input","aria-label":"Microphone",disabled:busy(),value:device(),onchange:move|e|device.set(e.value()),option{value:"","System default microphone"}for d in devices(){option{value:text(&d,"id"),{text(&d,"label")}}}}}
        label{class:"check-row",input{r#type:"checkbox",disabled:busy(),checked:muted(),onchange:move|e|muted.set(e.checked())}span{"Start with microphone capture muted"}}
        div{class:"privacy-note",Icon{name:"shield",size:19}p{"Audio stays in your local workspace. Transcription runs on this device after recording. Keep this tab open while recording."}}
        label{class:"check-row consent-row",input{r#type:"checkbox",disabled:busy(),checked:consent(),onchange:move|e|consent.set(e.checked())}span{"I have permission from everyone being recorded."}}
        if !error().is_empty(){div{class:"inline-error",role:"alert",Icon{name:"alert"}"{error}"}}
        button{class:"button button-primary full-width",disabled:!consent()||busy(),onclick:move |_|{spawn(async move{busy.set(true);error.set(String::new());let meeting_title=if title().trim().is_empty(){"New conversation".into()}else{title()};match post("/meetings",json!({"title":meeting_title,"mode":"in-person","consent":true,"speechModel":settings()["speechModel"],"notesModel":settings()["notesModel"],"liveTranscription":false})).await{Ok(m)=>{let script=format!("return await window.echoRecorder.start({{meeting:{},deviceId:{},startMuted:{}}})",m,serde_json::to_string(&device()).unwrap(),muted());match crate::api::evaluate(&script).await{Ok(_)=>{let latest=get(&format!("/meetings/{}",text(&m,"id"))).await.unwrap_or(m);on_start.call(latest);on_close.call(())},Err(e)=>{let msg=format!("Could not start recording: {e}");let _=patch(&format!("/meetings/{}",text(&m,"id")),json!({"status":"error","error":msg})).await;error.set(msg)}}},Err(e)=>error.set(e)}busy.set(false);});},if busy(){span{class:"spinner"}"Getting ready…"}else{Icon{name:"mic"}"Start recording"}}
        p{class:"dialog-footnote","No model yet? Record now and transcribe when you’re ready."}
    }}}
}

#[component]
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
    rsx! {div{class:"recorder-bar",role:"region","aria-label":"Active recording controls",div{class:"recording-status",span{class:if status=="recording"{"record-dot pulse"}else{"record-dot"}}div{strong{if status=="paused"{"Recording paused"}else if status=="saving"{"Saving your conversation…"}else if status=="error"{"Recording needs attention"}else{"Listening to your conversation"}}button{onclick:move |_|on_open.call(()),"View active meeting"}}}div{class:"recorder-level","aria-label":"Microphone audio level",for i in 0..12{span{class:if level*12.>i as f64{"lit"}else{""},style:format!("height:{}px",8+(i%5)*3)}}}strong{class:"recorder-time","{elapsed}"}button{class:"icon-button",disabled:status=="saving"||status=="error","aria-label":if muted{"Unmute capture"}else{"Mute capture"},onclick:move |_|{let _=document::eval("window.echoRecorder.toggleMute()");},Icon{name:if muted{"mute"}else{"mic"}}}button{class:"icon-button",disabled:status=="saving"||status=="error","aria-label":if status=="paused"{"Resume recording"}else{"Pause recording"},onclick:move |_|{let _=document::eval(if status=="paused"{"window.echoRecorder.resume()"}else{"window.echoRecorder.pause()"});},Icon{name:if text(&state,"status")=="paused"{"play"}else{"pause"}}}button{class:"button button-record-stop",disabled:text(&state,"status")=="saving",onclick:move |_|{spawn(async move{let script=if text(&recorder(),"status")=="error"{"return await window.echoRecorder.retry()"}else{"return await window.echoRecorder.stop()"};if let Err(e)=crate::api::evaluate(script).await{notify.call(format!("Could not finish saving: {e}. Keep this tab open and retry."));}});},Icon{name:"stop",size:15}if text(&state,"status")=="error"{"Retry save"}else{"Stop & save"}}if let Some(error)=state["error"].as_str(){p{class:"recorder-error","{error}"}}}}
}

#[component]
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
    rsx! {div{class:"bot-status panel",Icon{name:"video"}div{strong{"Local meeting participant"}p{if status().is_null(){"Check the runner for admission and recording status."}else{{format!("{} · {}",text(&status(),"status"),text(&status(),"detail"))}}}}button{class:"button button-secondary button-small",disabled:busy(),onclick:{let id=id.clone();move |_|{let id=id.clone();spawn(async move{busy.set(true);match get(&format!("/integrations/bot?meetingId={id}")).await{Ok(v)=>status.set(v),Err(e)=>notify.call(e)}busy.set(false);});}},"Check status"}button{class:"button button-secondary button-small",disabled:busy(),onclick:{let id=id.clone();move |_|{let id=id.clone();spawn(async move{busy.set(true);match api::delete(&format!("/integrations/bot?meetingId={id}")).await{Ok(v)=>{status.set(v);notify.call("Stop requested. Check status, then save the completed recording.".into())},Err(e)=>notify.call(e)}busy.set(false);});}},"Stop bot"}button{class:"button button-primary button-small",disabled:busy(),onclick:move |_|{let id=id.clone();spawn(async move{busy.set(true);match post(&format!("/integrations/bot/import?meetingId={id}"),json!({})).await{Ok(v)=>{meeting.set(v["meeting"].clone());let _=document::eval(&format!("window.dispatchEvent(new CustomEvent('echo-recording-saved',{{detail:{}}}))",v["meeting"]));notify.call("Meeting recording saved locally.".into());},Err(e)=>notify.call(e)}busy.set(false);});},"Save recording"}}}
}
