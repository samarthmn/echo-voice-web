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
    let runner_ready = status()["runner"]["reachable"].as_bool().unwrap_or(false);
    rsx! {div{class:"page-content calendar-page",div{class:"page-heading",div{span{class:"eyebrow","BE THERE, FULLY"}h1{"Your next conversation."}p{"Bring a private note-taker to the meetings that matter."}}button{class:"button button-secondary",disabled:loading(),onclick:move |_|refresh+=1,Icon{name:"refresh",size:16}"Refresh"}}
    div{class:"calendar-connection-grid",section{class:"panel connection-panel",span{class:"google-calendar-logo",Icon{name:"calendar",size:27}}div{h2{"Google Calendar"}p{if connected{"Your calendar is connected"}else{"Your schedule, one less thing to remember."}}}if connected{span{class:"badge badge-green",Icon{name:"check",size:12}"Connected"}}else{button{class:"button button-primary",disabled:loading(),onclick:move |_|{if configured{let _=document::eval("window.location.assign('/api/integrations/google/connect')");}else{setup.set(true)}},"Connect calendar" Icon{name:"arrow",size:16}}}}
    section{class:"panel runner-panel",span{class:if runner_ready{"connection-dot ready"}else{"connection-dot"}}div{strong{"Local meeting runner"}p{if runner_ready{"Ready on this computer"}else{"Setup needed to join meetings"}}}button{class:"icon-button","aria-label":"Meeting runner setup",onclick:move |_|setup.set(true),Icon{name:"chevron"}}}}
    if !error().is_empty(){div{class:"inline-error",role:"alert",Icon{name:"alert"}"{error}"}}
    div{class:"section-heading",h2{"Upcoming meetings " span{class:"count-label","{events().len()}"}}span{class:"small-muted","Next 30 days"}}
    if loading(){div{class:"panel loading-panel",span{class:"spinner"}"Looking at your calendar…"}}else if !connected{div{class:"calendar-empty panel",div{class:"calendar-art","aria-hidden":"true",div{class:"mini-calendar",div{}span{"YOUR NEXT"}strong{"big idea"}i{"· · ·"}}span{class:"calendar-art-note",Icon{name:"check",size:14}"Every detail, remembered"}}h2{"A little preparation. A lot more presence."}p{"Connect your calendar to see upcoming meetings and invite your local Echo note-taker to a Google Meet."}button{class:"button button-primary",onclick:move |_|{if configured{let _=document::eval("window.location.assign('/api/integrations/google/connect')");}else{setup.set(true)}},Icon{name:"link",size:17}"Connect Google Calendar"}span{class:"small-muted","Read-only calendar access. Disconnect whenever you like."}}}
    else if events().is_empty(){div{class:"empty-state panel",Icon{name:"calendar",size:32}h3{"A little breathing room."}p{"No upcoming meetings in the next thirty days."}}}
    else{div{class:"event-list",for event in events(){
    div{class:"panel event-card",div{class:"event-date",Icon{name:"calendar",size:25}}div{class:"event-info",h3{{text(&event,"title")}}p{{format!("{} · {} invited",text(&event,"start"),event["attendees"])}}}span{class:"badge",Icon{name:"video",size:13}{text(&event,"provider")}}button{class:"button button-secondary",disabled:text(&event,"provider")!="google-meet"||!runner_ready||event["url"].is_null(),onclick:move |_|{selected.set(event.clone());consent.set(false);},"Send Echo" Icon{name:"arrow",size:15}}}
    }}}
    div{class:"calendar-explainer",Icon{name:"shield",size:21}div{h3{"Your calendar connects. Your recordings stay home."}p{"Google provides event details. Echo’s optional local runner joins as a visible participant and saves audio to this computer. Keep the runner running; the host may need to admit it. This runner supports Google Meet only. Zoom and Teams require a separate adapter."}}}
    if connected{button{class:"button button-ghost",onclick:move |_|{spawn(async move{match post("/integrations/google/disconnect",json!({})).await{Ok(_)=>{notify.call("Calendar disconnected.".into());refresh+=1;},Err(e)=>notify.call(e)}});},"Disconnect calendar"}}
    if setup(){div{class:"dialog-backdrop",div{class:"dialog",role:"dialog","aria-modal":"true","aria-labelledby":"calendar-setup-title",button{class:"icon-button dialog-close","aria-label":"Close connection setup",onclick:move |_|setup.set(false),Icon{name:"close"}}h2{id:"calendar-setup-title","Connect your meeting world."}p{class:"dialog-description","Two connections, with everything processed locally."}div{class:"setup-numbered",span{"1"}div{h3{"Connect Google Calendar"}p{"Create a Google OAuth web client with Calendar read-only access. Add your client ID and secret to your local .env file, then restart Echo."}code{"GOOGLE_CLIENT_ID" br{}"GOOGLE_CLIENT_SECRET"}p{"Authorized redirect URI:"}code{"http://localhost:3000/api/integrations/google/callback"}}}div{class:"setup-numbered",span{"2"}div{h3{"Start the local meeting runner"}p{"The optional runner uses Chromium, PulseAudio and ffmpeg on Linux. It joins Google Meet as a visible participant. The host must admit it."}code{"See runner/README.md for setup"}p{"A browser tab alone cannot join as a separate participant. This local helper is required."}}}div{class:"privacy-note",Icon{name:"shield",size:19}p{"In-person recording and transcription work without connecting a calendar."}}button{class:"button button-primary full-width",onclick:move |_|{setup.set(false);refresh+=1;},"Recheck connections"}}}}
    if selected().is_object(){div{class:"dialog-backdrop",div{class:"dialog",role:"dialog","aria-modal":"true","aria-labelledby":"join-title",button{class:"icon-button dialog-close",disabled:joining(),"aria-label":"Close join dialog",onclick:move |_|selected.set(Value::Null),Icon{name:"close"}}h2{id:"join-title","Send Echo to this meeting"}p{class:"dialog-description",{text(&selected(),"title")}}div{class:"privacy-note",Icon{name:"video",size:20}p{"Echo joins as a visible recording participant. The local runner must stay open. Meeting controls and host admission still apply."}}label{class:"check-row consent-row",input{r#type:"checkbox",checked:consent(),onchange:move|e|consent.set(e.checked())}span{"I have permission from everyone to record this meeting."}}button{class:"button button-primary full-width",disabled:!consent()||joining(),onclick:move |_|{spawn(async move{joining.set(true);match post("/meetings",json!({"title":selected()["title"],"mode":"online","consent":true,"meetingUrl":selected()["url"],"calendarEventId":selected()["id"],"speechModel":settings()["speechModel"],"notesModel":settings()["notesModel"]})).await{Ok(m)=>{match post("/integrations/bot",json!({"meetingId":m["id"],"url":selected()["url"],"consent":true})).await{Ok(_)=>{on_meeting.call(m);selected.set(Value::Null);notify.call("Join request sent. The host may need to admit Echo.".into())},Err(e)=>{let _=crate::api::patch(&format!("/meetings/{}",text(&m,"id")),json!({"status":"error","error":e})).await;notify.call(e)}}},Err(e)=>notify.call(e)}joining.set(false);});},if joining(){"Sending Echo…"}else{"Join with Echo"}}}}}
    }}
}
