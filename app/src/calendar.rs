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
    let listener_id = use_hook(|| format!("runner-auth-{}", js_sys::Math::random()));
    let listener_cleanup = listener_id.clone();
    use_drop(move || {
        let _ = document::eval(&format!(
            "window.echoRunnerAuth?.unsubscribe({});",
            json!(listener_cleanup)
        ));
    });
    use_future(move || {
        let listener_id = listener_id.clone();
        async move {
            let mut evaluation = document::eval(&format!(
                "window.echoRunnerAuth.subscribe({},()=>dioxus.send({{}}));",
                json!(listener_id)
            ));
            while evaluation.recv::<Value>().await.is_ok() {
                refresh += 1;
            }
        }
    });
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
    let runner_online = status()["runner"]["reachable"].as_bool().unwrap_or(false);
    let runner_runtime_ready = status()["runner"]["ready"].as_bool().unwrap_or(false);
    let runner_ready = status()["runner"]["joinReady"].as_bool().unwrap_or(false);
    let auth = status()["runner"]["auth"].clone();
    let auth_state = text(&auth, "state");
    let auth_email = text(&auth, "email");
    let signed_in = auth_state == "signed_in";
    let signing_in = auth_state == "signing_in";
    let auth_session_id = if signing_in {
        auth["sessionId"].clone()
    } else {
        Value::Null
    };
    let account_matches = status()["runner"]["accountMatches"]
        .as_bool()
        .unwrap_or(false);
    rsx! {div{class:"page-content calendar-page",PageHeading{title:"Calendar",ActionButton{kind:ButtonKind::Secondary,disabled:loading(),onclick:move |_|refresh+=1,Icon{name:"refresh",size:16}"Refresh"}}
    div{class:"calendar-connection-grid",section{class:"panel connection-panel",span{class:"google-calendar-logo",Icon{name:"calendar",size:27}}div{h2{"Google Calendar"}p{if connected{{text(&status()["google"],"email")}}else{"Read-only access to upcoming Google Meet calls."}}}if connected{StatusBadge{tone:BadgeTone::Success,Icon{name:"check",size:12}"Connected"}}else{ActionButton{kind:ButtonKind::Primary,disabled:loading(),onclick:move |_|{if configured{let _=document::eval("window.location.assign('/api/integrations/google/connect')");}else{setup.set(true)}},"Connect calendar" Icon{name:"arrow",size:16}}}}
    section{class:"panel runner-panel",span{class:if runner_ready{"connection-dot ready"}else{"connection-dot"}}div{class:"runner-panel-info",strong{"Meeting runner"}p{if !runner_online{"Runner offline · Start Docker to connect"}else if !runner_runtime_ready{{let detail=text(&status()["runner"],"detail");if detail.is_empty(){"Runner setup needed".to_string()}else{detail}}}else if signed_in&&!account_matches{"Sign-in account does not match Google Calendar"}else if signed_in{{format!("Signed in as {auth_email}")}}else if auth_state=="expired"{"Google session expired · Sign in again"}else if auth_state=="signing_in"{"Google sign-in is in progress"}else{"Sign in with your connected Google account"}}if runner_online&&!text(&auth,"detail").is_empty(){p{class:"small-muted",{text(&auth,"detail")}}}}div{class:"runner-panel-actions",if runner_online{if signed_in{ActionButton{kind:ButtonKind::Ghost,compact:true,onclick:move |_|{let _=document::eval("window.dispatchEvent(new Event('echo-runner-sign-out'));");},"Sign out of runner"}}else{ActionButton{kind:ButtonKind::Secondary,compact:true,disabled:!connected||loading()||!runner_runtime_ready,onclick:move |_|{let _=document::eval(&format!("window.dispatchEvent(new CustomEvent('echo-runner-sign-in',{{detail:{{sessionId:{}}}}}));",auth_session_id));},if signing_in{"Continue sign-in"}else{"Sign in to runner"}}}}IconButton{label:"Meeting runner setup",icon:"chevron",onclick:move |_|setup.set(true)}}}}
    if !error().is_empty(){div{class:"inline-error",role:"alert",Icon{name:"alert"}"{error}"}}
    div{class:"section-heading",h2{"Upcoming meetings " span{class:"count-label","{events().len()}"}}span{class:"small-muted","Next 30 days"}}
    if loading(){div{class:"panel loading-panel",span{class:"spinner"}"Loading calendar…"}}else if !connected{div{class:"calendar-empty panel",h2{"No upcoming meetings"}p{"Connect your calendar above to load meetings."}}}
    else if events().is_empty(){div{class:"calendar-empty panel",h2{"No upcoming meetings"}p{"Nothing scheduled in the next 30 days."}}}
    else{div{class:"event-list",for event in events(){
    div{class:"panel event-card",div{class:"event-date",Icon{name:"calendar",size:25}}div{class:"event-info",h3{{text(&event,"title")}}p{{format!("{} · {} invited",crate::api::local_date_time(&text(&event,"start")),event["attendees"])}}}span{class:"badge",Icon{name:"video",size:13}{match text(&event,"provider").as_str(){"google-meet"=>"Google Meet","zoom"=>"Zoom","teams"=>"Microsoft Teams",_=>"Online meeting"}}}ActionButton{kind:ButtonKind::Secondary,disabled:text(&event,"provider")!="google-meet"||!runner_ready||event["url"].is_null(),onclick:move |_|{selected.set(event.clone());consent.set(false);},"Send Echo" Icon{name:"arrow",size:15}}}
    }}}
    div{class:"calendar-explainer",Icon{name:"shield",size:21}div{p{"Echo joins with the signed-in Google account and records incoming meeting audio. Camera and microphone access are blocked. Meeting controls and host admission still apply."}}}
    if connected{ActionButton{kind:ButtonKind::Ghost,onclick:move |_|{spawn(async move{match post("/integrations/google/disconnect",json!({})).await{Ok(_)=>{notify.call("Calendar disconnected.".into());refresh+=1;},Err(e)=>notify.call(e)}});},"Disconnect calendar"}}
    if setup(){div{class:"dialog-backdrop",div{class:"dialog",role:"dialog","aria-modal":"true","aria-labelledby":"calendar-setup-title",IconButton{class:"dialog-close",label:"Close connection setup",icon:"close",onclick:move |_|setup.set(false)}h2{id:"calendar-setup-title","Calendar setup"}div{class:"setup-numbered",span{"1"}div{h3{"Connect Google Calendar"}p{"Create a Google OAuth web client with Calendar read-only access. Add your client ID and secret to your local .env file, then restart Echo."}code{"GOOGLE_CLIENT_ID" br{}"GOOGLE_CLIENT_SECRET"}p{"Authorized redirect URI:"}code{"http://localhost:3000/api/integrations/google/callback"}}}div{class:"setup-numbered",span{"2"}div{h3{"Start the local meeting runner"}p{"Run the meeting helper in Docker on Mac, Windows or Linux. It joins Google Meet with your signed-in Google account. Host admission may be required."}code{"docker compose -f compose.runner.yaml up --build -d"}p{"Start Docker first. See runner/README.md for setup and troubleshooting."}}}div{class:"privacy-note",Icon{name:"shield",size:19}p{"In-person recording and transcription work without connecting a calendar."}}ActionButton{kind:ButtonKind::Primary,full_width:true,onclick:move |_|{setup.set(false);refresh+=1;},"Recheck connections"}}}}
    if selected().is_object(){div{class:"dialog-backdrop",div{class:"dialog",role:"dialog","aria-modal":"true","aria-labelledby":"join-title",IconButton{class:"dialog-close",label:"Close join dialog",icon:"close",disabled:joining(),onclick:move |_|selected.set(Value::Null)}h2{id:"join-title","Send Echo to this meeting"}p{class:"dialog-description",{text(&selected(),"title")}}div{class:"privacy-note",Icon{name:"video",size:20}p{"The runner joins using your Google account’s display name and records incoming audio. Camera and microphone access are blocked. The runner must stay open; meeting controls and host admission still apply."}}label{class:"check-row consent-row",input{r#type:"checkbox",checked:consent(),onchange:move|e|consent.set(e.checked())}span{"I have permission from everyone to record this meeting."}}ActionButton{kind:ButtonKind::Primary,full_width:true,disabled:!consent()||joining(),onclick:move |_|{spawn(async move{joining.set(true);match post("/meetings",json!({"title":selected()["title"],"mode":"online","consent":true,"meetingUrl":selected()["url"],"calendarEventId":selected()["id"],"speechModel":settings()["speechModel"],"notesModel":settings()["notesModel"]})).await{Ok(m)=>{let _=document::eval("window.dispatchEvent(new CustomEvent('echo-library-changed')); ");match post("/integrations/bot",json!({"meetingId":m["id"],"url":selected()["url"],"consent":true})).await{Ok(session)=>{on_meeting.call(m);selected.set(Value::Null);notify.call(if text(&session,"status")=="failed"{text(&session,"detail")}else{"Connecting to the meeting…".into()})},Err(e)=>{let _=crate::api::patch(&format!("/meetings/{}",text(&m,"id")),json!({"status":"error","error":e})).await;let _=document::eval("window.dispatchEvent(new CustomEvent('echo-library-changed')); ");notify.call(e)}}},Err(e)=>notify.call(e)}joining.set(false);});},if joining(){"Sending Echo…"}else{"Join with Echo"}}}}}
    }}
}
