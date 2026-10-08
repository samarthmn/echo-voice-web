use crate::{
    api::{get, post, text},
    extension::ExtensionConnectionPanel,
    ui::{ActionButton, BadgeTone, ButtonKind, IconButton, PageHeading, StatusBadge},
    Icon,
};
use dioxus::prelude::*;
use serde_json::{json, Value};

#[component]
pub fn Calendar(notify: EventHandler<String>) -> Element {
    let mut status = use_signal(|| Value::Null);
    let mut events = use_signal(Vec::<Value>::new);
    let mut loading = use_signal(|| true);
    let mut error = use_signal(String::new);
    let mut setup = use_signal(|| false);
    let mut refresh = use_signal(|| 0);
    use_resource(move || {
        let _ = refresh();
        async move {
            loading.set(true);
            error.set(String::new());
            match get("/integrations/status").await {
                Ok(s) => {
                    if s["google"]["connected"] == true {
                        match get("/integrations/calendar").await {
                            Ok(v) => {
                                events.set(v["events"].as_array().cloned().unwrap_or_default())
                            }
                            Err(e) => error.set(e),
                        }
                    } else {
                        events.set(Vec::new());
                    }
                    status.set(s);
                }
                Err(e) => error.set(e),
            }
            loading.set(false);
        }
    });
    let connected = status()["google"]["connected"] == true;
    let configured = status()["google"]["configured"] == true;
    rsx! {div {class:"page-content calendar-page",
        PageHeading {title:"Calendar",ActionButton {kind:ButtonKind::Secondary,disabled:loading(),onclick:move |_|refresh+=1,Icon {name:"refresh",size:16}"Refresh"}}
        div {class:"calendar-connection-grid",section {class:"panel connection-panel",span {class:"google-calendar-logo",Icon {name:"calendar",size:27}}div {h2 {"Google Calendar"}p {if connected{{text(&status()["google"],"email")}}else{"Read-only access to upcoming meetings."}}}
            if connected{StatusBadge {tone:BadgeTone::Success,Icon {name:"check",size:12}"Connected"}}else{ActionButton {kind:ButtonKind::Primary,disabled:loading(),onclick:move |_|{if configured{let _=document::eval("window.location.assign('/api/integrations/google/connect')");}else{setup.set(true)}},"Connect calendar"}}
        } ExtensionConnectionPanel {notify}}
        if !error().is_empty(){div {class:"inline-error",role:"alert",Icon {name:"alert"}"{error}"}}
        div {class:"section-heading",h2 {"Upcoming meetings " span {class:"count-label","{events().len()}"}}span {class:"small-muted","Next 30 days"}}
        if loading(){div {class:"panel loading-panel",span {class:"spinner"}"Loading calendar…"}}
        else if !connected{div {class:"calendar-empty panel",h2 {"No upcoming meetings"}p {"Connect your calendar above to load meetings."}}}
        else if events().is_empty(){div {class:"calendar-empty panel",h2 {"No upcoming meetings"}p {"Nothing scheduled in the next 30 days."}}}
        else{div {class:"event-list",for event in events(){ {let url=text(&event,"url");let supported=matches!(text(&event,"provider").as_str(),"google-meet"|"zoom"|"teams");rsx!{
            div {class:"panel event-card",div {class:"event-date",Icon {name:"calendar",size:25}}div {class:"event-info",h3 {{text(&event,"title")}}p {{crate::api::local_date_time(&text(&event,"start"))}}}
                StatusBadge {tone:BadgeTone::Neutral,Icon {name:"video",size:13}{match text(&event,"provider").as_str(){"google-meet"=>"Google Meet","zoom"=>"Zoom Web","teams"=>"Teams Web",_=>"Online meeting"}}}
                if supported&&!url.is_empty(){a {class:"button button-secondary",href:"{url}",target:"_blank",rel:"noopener noreferrer","Open meeting" Icon {name:"arrow-right",size:15}}}
            }
        }}}}}
        p {class:"small-muted","Opening a meeting does not record it. Join normally, then choose Start recording in the extension."}
        if connected{ActionButton {kind:ButtonKind::Ghost,onclick:move |_|{spawn(async move{match post("/integrations/google/disconnect",json!({})).await{Ok(_)=>{notify.call("Calendar disconnected.".into());refresh+=1;},Err(e)=>notify.call(e)}});},"Disconnect calendar"}}
        if setup(){div {class:"dialog-backdrop",div {class:"dialog",role:"dialog","aria-modal":"true","aria-labelledby":"calendar-setup-title",IconButton {class:"dialog-close",label:"Close calendar setup",icon:"close",onclick:move |_|setup.set(false)}h2 {id:"calendar-setup-title","Calendar setup"}p {"Create a Google OAuth web client with Calendar read-only access. Add its client ID and secret to your local .env file, then restart Echo."}code {"GOOGLE_CLIENT_ID" br {}"GOOGLE_CLIENT_SECRET"}p {"Authorized redirect URI:"}code {"http://localhost:3000/api/integrations/google/callback"}p {"The browser extension works without connecting Calendar."}ActionButton {kind:ButtonKind::Primary,onclick:move |_|setup.set(false),"Done"}}}}
    }}
}
