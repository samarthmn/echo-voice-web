use crate::{
    api::{delete, get, post, text},
    ui::{ActionButton, BadgeTone, ButtonKind, StatusBadge},
    Icon,
};
use dioxus::prelude::*;
use serde_json::{json, Value};

#[component]
pub fn ExtensionConnectionPanel(notify: EventHandler<String>) -> Element {
    let mut connections = use_signal(|| Value::Null);
    let mut code = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut error = use_signal(String::new);
    let mut refresh = use_signal(|| 0u32);
    use_resource(move || {
        let _ = refresh();
        async move {
            match get("/extensions/connections").await {
                Ok(v) => {
                    connections.set(v);
                    error.set(String::new());
                }
                Err(e) => error.set(e),
            }
        }
    });
    use_future(move || async move {
        loop {
            let _ = document::eval("await new Promise(r=>setTimeout(r,5000));return true;").await;
            refresh += 1;
        }
    });
    let installed = connections()["connections"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let requests = connections()["requests"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    rsx! {section {class:"panel extension-panel", "aria-label":"Browser extension connection",
        div {class:"section-heading", h2 { Icon {name:"video",size:18} "Browser extension" }
            StatusBadge {tone:if installed.is_empty(){BadgeTone::Neutral}else{BadgeTone::Success}, if installed.is_empty(){"Not connected"}else{"Connected"}}
        }
        p {class:"small-muted","Record the meeting you attend in Brave or Chrome. " a {href:"/extension-guide.html",target:"_blank",rel:"noopener noreferrer","Installation guide"}}
        if !code().is_empty() {div {class:"extension-pair-code",label {"Enter this code in the extension"} code {"{code}"} small {"Expires in five minutes. Approve the connection below after entering it."}}}
        ActionButton {kind:ButtonKind::Secondary,disabled:busy(),onclick:move |_|{spawn(async move {
            busy.set(true); error.set(String::new());
            match post("/extensions/pairing",json!({})).await {Ok(v)=>code.set(text(&v,"code")),Err(e)=>error.set(e)}
            busy.set(false);
        });},Icon {name:"plus",size:16} "Connect an extension"}
        for request in requests { {let id=text(&request,"requestId");let name=text(&request,"name");rsx!{
            div {class:"extension-connection-row",span {strong {"{name}"}small {"Requests access to transfer recordings into this library."}}
                ActionButton {kind:ButtonKind::Primary,compact:true,disabled:busy(),onclick:move |_|{let id=id.clone();spawn(async move {
                    busy.set(true); match post(&format!("/extensions/requests/{id}/approve"),json!({})).await {Ok(_)=>{refresh+=1;code.set(String::new());notify.call("Extension connection approved.".into());},Err(e)=>error.set(e)}busy.set(false);
                });},"Approve connection"}
            }
        }}}
        for connection in installed { {let id=text(&connection,"installationId");let name=text(&connection,"name");rsx!{
            div {class:"extension-connection-row",span {strong {"{name}"}small {"This library"}}
                ActionButton {kind:ButtonKind::Ghost,compact:true,disabled:busy(),onclick:move |_|{let id=id.clone();spawn(async move {
                    busy.set(true);match delete(&format!("/extensions/connections/{id}")).await{Ok(_)=>{refresh+=1;notify.call("Extension disconnected. Pending recordings remain in its browser.".into());},Err(e)=>error.set(e)}busy.set(false);
                });},"Disconnect"}
            }
        }}}
        if !error().is_empty(){p {class:"inline-error",role:"alert","{error}"}}
    }}
}

#[component]
pub fn ExtensionRecordingStatus(meeting: Signal<Value>, notify: EventHandler<String>) -> Element {
    let mut recording = use_signal(|| Value::Null);
    let mut error = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut live = use_signal(|| Value::Null);
    let mut legacy = use_signal(|| Value::Null);
    let listener_id = use_hook(|| format!("extension-live-{}", js_sys::Math::random()));
    let cleanup_id = listener_id.clone();
    use_drop(move || {
        let _=document::eval(&format!("const key={};const listeners=window.echoExtensionStateListeners;if(listeners?.[key]){{window.removeEventListener('echo-extension-live-state',listeners[key]);delete listeners[key];}}",json!(cleanup_id)));
    });
    use_future(move || {
        let listener_id = listener_id.clone();
        async move {
            let mut evaluation = document::eval(&format!("const key={};const send=()=>dioxus.send(window.echoExtensionLive?.getState()||[]);window.echoExtensionStateListeners||={{}};window.echoExtensionStateListeners[key]=send;window.addEventListener('echo-extension-live-state',send);send();",json!(listener_id)));
            while let Ok(states) = evaluation.recv::<Vec<Value>>().await {
                let id = text(&meeting(), "id");
                live.set(
                    states
                        .into_iter()
                        .find(|s| s["meetingId"] == id)
                        .unwrap_or(Value::Null),
                );
            }
        }
    });
    use_resource(move || async move {
        let id = text(&meeting(), "id");
        if let Ok(v) = get("/extensions/legacy-recordings").await {
            legacy.set(
                v["recordings"]
                    .as_array()
                    .and_then(|items| items.iter().find(|r| r["meetingId"] == id))
                    .cloned()
                    .unwrap_or(Value::Null),
            );
        }
    });
    use_future(move || async move {
        loop {
            let id = text(&meeting(), "id");
            match get("/extensions/recordings").await {
                Ok(v) => {
                    recording.set(
                        v["recordings"]
                            .as_array()
                            .and_then(|items| items.iter().find(|r| r["meetingId"] == id))
                            .cloned()
                            .unwrap_or(Value::Null),
                    );
                    error.set(String::new());
                }
                Err(e) => error.set(e),
            }
            let _ = document::eval("await new Promise(r=>setTimeout(r,3000));return true;").await;
        }
    });
    if recording().is_null()
        && legacy()["ready"] != true
        && meeting()["tracks"]
            .as_array()
            .is_some_and(|tracks| !tracks.is_empty())
    {
        return rsx! {};
    }
    let value = recording();
    let id = text(&value, "recordingId");
    let receiving = text(&value, "status") == "receiving";
    let commands = value["controls"].as_array().cloned().unwrap_or_default();
    let draft = value["draft"]["words"]
        .as_array()
        .map(|words| {
            words
                .iter()
                .rev()
                .take(50)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .filter_map(|w| w["text"].as_str())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    rsx! {section {class:"panel extension-panel", "aria-label":"Extension recording status",
        h2 {"Browser recording"}
        if value.is_null(){p {class:"small-muted","Start a recording from the Echo extension in your meeting tab. Older runner audio can be recovered with the migration guide."}}
        if legacy()["ready"]==true{ActionButton {kind:ButtonKind::Secondary,disabled:busy(),onclick:move |_|{spawn(async move{
            busy.set(true);let id=text(&meeting(),"id");match post(&format!("/extensions/legacy-recordings/{id}/recover"),json!({})).await{Ok(v)=>{notify.call("Old recording recovered. Reopen this meeting to review it.".into());let _=document::eval(&format!("window.dispatchEvent(new CustomEvent('echo-recording-saved',{{detail:{}}}));window.dispatchEvent(new Event('echo-library-changed'));",v["meeting"]));},Err(e)=>error.set(e)}busy.set(false);
        });},"Recover old recording"}}
        if !live().is_null(){p {role:"status",{text(&live(),"message")}}}
        if !value.is_null() {p {class:"small-muted",if receiving {"Recording saved in the browser; transfer is in progress."}else{"Recording saved in Echo."}}
            if receiving{div {class:"extension-controls",for action in ["pause","resume","stop"]{{let id=id.clone();rsx!{ActionButton {kind:if action=="stop"{ButtonKind::Primary}else{ButtonKind::Secondary},compact:true,disabled:busy()||!commands.is_empty(),onclick:move |_|{let id=id.clone();spawn(async move{
                busy.set(true);match crate::api::evaluate("return crypto.randomUUID();").await{Ok(command)=>{match post(&format!("/extensions/recordings/{id}/controls"),json!({"commandId":command,"action":action})).await{Ok(_)=>notify.call("Control requested — waiting for the extension.".into()),Err(e)=>error.set(e)}},Err(e)=>error.set(e)}busy.set(false);
            });},{match action{"pause"=>"Pause","resume"=>"Resume",_=>"Stop"}}}}}}}}
            if !commands.is_empty(){p {role:"status","Control pending — waiting for the extension."}}
            if !draft.is_empty(){p {class:"extension-live-preview",role:"status","Draft transcript: {draft}"}}
        }
        if !error().is_empty(){p {class:"inline-error",role:"alert","{error}"}}
    }}
}
