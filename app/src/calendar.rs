use crate::ui::{ActionButton, BadgeTone, ButtonKind, IconButton, PageHeading, StatusBadge};
use crate::{
    api::{get, post, text},
    Icon,
};
use dioxus::prelude::*;
use serde_json::{json, Value};
#[component]
/// Display connected calendar events and consent-gated actions for supported Meet links.
pub fn Calendar(
    settings: Signal<Value>,
    on_meeting: EventHandler<Value>,
    notify: EventHandler<String>,
) -> Element {
    let mut status = use_signal(|| Value::Null);
    let mut events = use_signal(Vec::<Value>::new);
    let mut loading = use_signal(|| true);
    let mut error = use_signal(String::new);
    let mut setup = use_signal(|| false);
    let mut selected = use_signal(|| Value::Null);
    let mut consent = use_signal(|| false);
    let mut joining = use_signal(|| false);
    let mut refresh = use_signal(|| 0);
    use_resource(move || {
        let _ = refresh();
        async move {
            loading.set(true);
            error.set(String::new());
            match get("/integrations/status").await {
                Ok(s) => {
                    if s["google"]["connected"].as_bool().unwrap_or(false) {
                        match get("/integrations/calendar").await {
                            Ok(v) => {
                                events.set(v["events"].as_array().cloned().unwrap_or_default())
                            }
                            Err(e) => error.set(e),
                        }
                    }
                    status.set(s)
                }
                Err(e) => error.set(e),
            }
            loading.set(false);
        }
    });
    let connected = status()["google"]["connected"].as_bool().unwrap_or(false);
    let configured = status()["google"]["configured"].as_bool().unwrap_or(false);
    let runner_ready = status()["runner"]["reachable"].as_bool().unwrap_or(false)
        && status()["runner"]["ready"].as_bool().unwrap_or(false);
    rsx! {div{class:"page-content calendar-page",PageHeading{title:"Calendar",ActionButton{kind:ButtonKind::Secondary,disabled:loading(),onclick:move |_|refresh+=1,Icon{name:"refresh",size:16}"Refresh"}}
    div{class:"calendar-connection-grid",section{class:"panel connection-panel",span{class:"google-calendar-logo",Icon{name:"calendar",size:27}}div{h2{"Google Calendar"}p{if connected{{text(&status()["google"],"email")}}else{"Read-only access to upcoming Google Meet calls."}}}if connected{StatusBadge{tone:BadgeTone::Success,Icon{name:"check",size:12}"Connected"}}else{ActionButton{kind:ButtonKind::Primary,disabled:loading(),onclick:move |_|{if configured{let _=document::eval("window.location.assign('/api/integrations/google/connect')");}else{setup.set(true)}},"Connect calendar" Icon{name:"arrow",size:16}}}}
    section{class:"panel runner-panel",span{class:if runner_ready{"connection-dot ready"}else{"connection-dot"}}div{strong{"Local meeting runner"}p{if runner_ready{"Ready on this computer"}else{"Setup needed to join meetings"}}}IconButton{label:"Meeting runner setup",icon:"chevron",onclick:move |_|setup.set(true)}}}
    if !error().is_empty(){div{class:"inline-error",role:"alert",Icon{name:"alert"}"{error}"}}
    div{class:"section-heading",h2{"Upcoming meetings " span{class:"count-label","{events().len()}"}}span{class:"small-muted","Next 30 days"}}
    if loading(){div{class:"panel loading-panel",span{class:"spinner"}"Loading calendar…"}}else if !connected{div{class:"calendar-empty panel",h2{"No upcoming meetings"}p{"Connect your calendar above to load meetings."}}}
    else if events().is_empty(){div{class:"calendar-empty panel",h2{"No upcoming meetings"}p{"Nothing scheduled in the next 30 days."}}}
    else{div{class:"event-list",for event in events(){
    div{class:"panel event-card",div{class:"event-date",Icon{name:"calendar",size:25}}div{class:"event-info",h3{{text(&event,"title")}}p{{format!("{} · {} invited",crate::api::local_date_time(&text(&event,"start")),event["attendees"])}}}span{class:"badge",Icon{name:"video",size:13}{match text(&event,"provider").as_str(){"google-meet"=>"Google Meet","zoom"=>"Zoom","teams"=>"Microsoft Teams",_=>"Online meeting"}}}ActionButton{kind:ButtonKind::Secondary,disabled:text(&event,"provider")!="google-meet"||!runner_ready||event["url"].is_null(),onclick:move |_|{selected.set(event.clone());consent.set(false);},"Send Echo" Icon{name:"arrow",size:15}}}
    }}}
    div{class:"calendar-explainer",Icon{name:"shield",size:21}div{p{"Google Meet recording requires the local runner and host admission."}}}
    if connected{ActionButton{kind:ButtonKind::Ghost,onclick:move |_|{spawn(async move{match post("/integrations/google/disconnect",json!({})).await{Ok(_)=>{notify.call("Calendar disconnected.".into());refresh+=1;},Err(e)=>notify.call(e)}});},"Disconnect calendar"}}
    if setup(){div{class:"dialog-backdrop",div{class:"dialog",role:"dialog","aria-modal":"true","aria-labelledby":"calendar-setup-title",IconButton{class:"dialog-close",label:"Close connection setup",icon:"close",onclick:move |_|setup.set(false)}h2{id:"calendar-setup-title","Calendar setup"}div{class:"setup-numbered",span{"1"}div{h3{"Connect Google Calendar"}p{"Create a Google OAuth web client with Calendar read-only access. Add your client ID and secret to your local .env file, then restart Echo."}code{"GOOGLE_CLIENT_ID" br{}"GOOGLE_CLIENT_SECRET"}p{"Authorized redirect URI:"}code{"http://localhost:3000/api/integrations/google/callback"}}}div{class:"setup-numbered",span{"2"}div{h3{"Start the local meeting runner"}p{"Run the meeting helper in Docker on Mac, Windows or Linux. It joins Google Meet as a visible recording participant; the host must admit it."}code{"docker compose -f compose.runner.yaml up --build -d"}p{"Start Docker first. See runner/README.md for setup and troubleshooting."}}}div{class:"privacy-note",Icon{name:"shield",size:19}p{"In-person recording and transcription work without connecting a calendar."}}ActionButton{kind:ButtonKind::Primary,full_width:true,onclick:move |_|{setup.set(false);refresh+=1;},"Recheck connections"}}}}
    if selected().is_object(){div{class:"dialog-backdrop",div{class:"dialog",role:"dialog","aria-modal":"true","aria-labelledby":"join-title",IconButton{class:"dialog-close",label:"Close join dialog",icon:"close",disabled:joining(),onclick:move |_|selected.set(Value::Null)}h2{id:"join-title","Send Echo to this meeting"}p{class:"dialog-description",{text(&selected(),"title")}}div{class:"privacy-note",Icon{name:"video",size:20}p{"Echo joins as a visible recording participant. The local runner must stay open. Meeting controls and host admission still apply."}}label{class:"check-row consent-row",input{r#type:"checkbox",checked:consent(),onchange:move|e|consent.set(e.checked())}span{"I have permission from everyone to record this meeting."}}ActionButton{kind:ButtonKind::Primary,full_width:true,disabled:!consent()||joining(),onclick:move |_|{spawn(async move{joining.set(true);match post("/meetings",json!({"title":selected()["title"],"mode":"online","consent":true,"meetingUrl":selected()["url"],"calendarEventId":selected()["id"],"speechModel":settings()["speechModel"],"notesModel":settings()["notesModel"]})).await{Ok(m)=>{let _=document::eval("window.dispatchEvent(new CustomEvent('echo-library-changed')); ");match post("/integrations/bot",json!({"meetingId":m["id"],"url":selected()["url"],"consent":true})).await{Ok(session)=>{on_meeting.call(m);selected.set(Value::Null);notify.call(if text(&session,"status")=="failed"{text(&session,"detail")}else{"Connecting to the meeting…".into()})},Err(e)=>{let _=crate::api::patch(&format!("/meetings/{}",text(&m,"id")),json!({"status":"error","error":e})).await;let _=document::eval("window.dispatchEvent(new CustomEvent('echo-library-changed')); ");notify.call(e)}}},Err(e)=>notify.call(e)}joining.set(false);});},if joining(){"Sending Echo…"}else{"Join with Echo"}}}}}
    }}
}
