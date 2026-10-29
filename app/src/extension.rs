use crate::{
    api::{delete, get, post, text},
    ui::{ActionButton, BadgeTone, ButtonKind, StatusBadge},
    Icon,
};
use dioxus::prelude::*;
use serde_json::{json, Value};

fn acknowledged_action(before_poll: &Value, pending: &Value, snapshot: &Value) -> Option<String> {
    if pending.is_null()
        || before_poll != pending
        || pending["recordingId"] != snapshot["recordingId"]
        || !["receiving", "complete"].contains(&text(snapshot, "status").as_str())
    {
        return None;
    }
    let controls = snapshot["controls"].as_array()?;
    if controls
        .iter()
        .any(|control| control["commandId"] == pending["commandId"])
    {
        return None;
    }
    match text(pending, "action").as_str() {
        "pause" => Some("Pause acknowledged.".into()),
        "resume" => Some("Resume acknowledged.".into()),
        "stop" => Some("Stop acknowledged. Finishing transfer to Echo.".into()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acknowledgement_requires_a_later_poll_for_the_exact_submitted_command() {
        let pending = json!({"recordingId":"r","commandId":"c","action":"pause"});
        let mut snapshot = json!({"recordingId":"r","status":"receiving","controls":[]});
        assert_eq!(
            acknowledged_action(&pending, &pending, &snapshot).as_deref(),
            Some("Pause acknowledged.")
        );
        assert_eq!(acknowledged_action(&Value::Null, &pending, &snapshot), None);
        snapshot["controls"] = json!([{"commandId":"c","action":"pause"}]);
        assert_eq!(acknowledged_action(&pending, &pending, &snapshot), None);
        snapshot["controls"] = json!([]);
        snapshot["recordingId"] = json!("other");
        assert_eq!(acknowledged_action(&pending, &pending, &snapshot), None);
        snapshot["recordingId"] = json!("r");
        snapshot["status"] = json!("deleted");
        assert_eq!(acknowledged_action(&pending, &pending, &snapshot), None);
    }
}

#[component]
pub fn ExtensionConnectionPanel(notify: EventHandler<String>) -> Element {
    let mut connections = use_signal(|| Value::Null);
    let mut presence = use_signal(|| None::<Value>);
    let mut extension_path = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut error = use_signal(String::new);
    let mut refresh = use_signal(|| 0u32);
    use_resource(move || {
        let _ = refresh();
        async move {
            match get("/extensions/connections").await {
                Ok(v) => {
                    extension_path.set(text(&v, "extensionPath"));
                    connections.set(v);
                }
                Err(e) => error.set(e),
            }
            let result = crate::api::evaluate("return await window.echoExtensionMessage({type:'ECHO_PRESENT',origin:location.origin});").await;
            presence.set(Some(result.unwrap_or(Value::Null)));
        }
    });
    crate::ui::use_poll_every(5000, move || {
        refresh += 1;
    });
    let browsers = connections()["connections"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let browser = presence();
    let status = browser
        .as_ref()
        .map(|v| text(v, "status"))
        .unwrap_or_default();
    let endpoint = browser
        .as_ref()
        .map(|v| text(v, "endpoint"))
        .unwrap_or_default();
    let origin = web_sys::window()
        .and_then(|window| window.location().origin().ok())
        .unwrap_or_default();
    let different_endpoint = matches!(status.as_str(), "connected" | "echo-offline")
        && !endpoint.is_empty()
        && !origin.is_empty()
        && endpoint != origin;
    let endpoint_host = endpoint.strip_prefix("http://").unwrap_or(&endpoint);
    rsx! {
        section {
            class: "panel extension-panel",
            "aria-label": "Browser extension connection",
            div { class: "section-heading",
                h2 {
                    Icon { name: "video", size: 18 }
                    "Browser extension"
                }
                StatusBadge { tone: if status == "connected" { BadgeTone::Success } else { BadgeTone::Neutral },
                    match status.as_str() {
                        "connected" => "Connected",
                        "echo-offline" => "Echo offline",
                        "waiting" => "Waiting for approval",
                        _ if browser.is_none() => "Checking…",
                        _ => "Not connected",
                    }
                }
            }
            p { class: "small-muted", "Record meetings in Brave or Chrome and send them to Echo." }
            if !endpoint.is_empty() {
                p { class: "small-muted", "This browser: {endpoint}" }
            }
            if browser.as_ref().is_some_and(|v| v["installed"] != true) {
                p { "Install the browser extension:" }
                ol { class: "extension-install-steps",
                    li {
                        "Open "
                        code { "brave://extensions" }
                        " or "
                        code { "chrome://extensions" }
                        ". "
                        button {
                            class: "extension-copy",
                            r#type: "button",
                            onclick: move |_| {
                                spawn(async move {
                                    match crate::api::evaluate(
                                            "await navigator.clipboard.writeText('brave://extensions'); return true;",
                                        )
                                        .await
                                    {
                                        Ok(_) => notify.call("Brave extensions address copied.".into()),
                                        Err(_) => {
                                            error
                                                .set(
                                                    "Could not copy. Select and copy brave://extensions manually."
                                                        .into(),
                                                )
                                        }
                                    }
                                });
                            },
                            "Copy Brave address"
                        }
                    }
                    li { "Turn on Developer mode." }
                    li {
                        "Select Load unpacked and choose this folder:"
                        div { class: "extension-folder",
                            code {
                                if extension_path().is_empty() {
                                    "extension/dist"
                                } else {
                                    "{extension_path}"
                                }
                            }
                            button {
                                class: "extension-copy",
                                r#type: "button",
                                onclick: move |_| {
                                    spawn(async move {
                                        let path = if extension_path().is_empty() {
                                            "extension/dist".to_string()
                                        } else {
                                            extension_path()
                                        };
                                        let script = format!(
                                            "await navigator.clipboard.writeText({}); return true;",
                                            json!(path),
                                        );
                                        match crate::api::evaluate(&script).await {
                                            Ok(_) => notify.call("Extension folder copied.".into()),
                                            Err(_) => {
                                                error
                                                    .set(
                                                        "Could not copy the folder. Select and copy the path manually."
                                                            .into(),
                                                    )
                                            }
                                        }
                                    });
                                },
                                "Copy folder"
                            }
                        }
                        if extension_path().is_empty() {
                            small { "Relative to your Echo project folder." }
                        }
                    }
                }
                ActionButton {
                    kind: ButtonKind::Secondary,
                    disabled: busy(),
                    onclick: move |_| refresh += 1,
                    "Check again"
                }
            } else if browser.as_ref().is_some_and(|v| v["installed"] == true)
                && (matches!(status.as_str(), "none" | "revoked") || different_endpoint)
            {
                if different_endpoint {
                    p {
                        "This browser is connected to Echo at {endpoint_host}. Connect it to this Echo instead?"
                    }
                }
                ActionButton {
                    kind: ButtonKind::Primary,
                    disabled: busy(),
                    onclick: move |_| {
                        spawn(async move {
                            busy.set(true);
                            error.set(String::new());
                            match post("/extensions/intent", json!({})).await {
                                Ok(v) => {
                                    let script = format!(
                                        "return await window.echoExtensionMessage({});",
                                        json!({ "type" : "ECHO_CONNECT", "intent" : v["intent"] }),
                                    );
                                    match crate::api::evaluate(&script).await {
                                        Ok(reply) if reply["status"] == "confirm-in-extension" => {
                                            refresh += 1;
                                            notify
                                                .call(
                                                    "Confirm in the Echo extension window that opens.".into(),
                                                );
                                        }
                                        Ok(reply) if reply["ok"] == true => {
                                            refresh += 1;
                                            notify.call("Browser connected to Echo.".into());
                                        }
                                        Ok(_) => {
                                            error
                                                .set(
                                                    "Could not connect. Open the extension and try again."
                                                        .into(),
                                                )
                                        }
                                        Err(e) => {
                                            error
                                                .set(
                                                    format!(
                                                        "Could not reach the extension: {e}. Open it and try again.",
                                                    ),
                                                )
                                        }
                                    }
                                }
                                Err(e) => {
                                    error
                                        .set(
                                            if e.contains("404") {
                                                "Update Echo to connect your browser extension.".into()
                                            } else {
                                                e
                                            },
                                        )
                                }
                            }
                            busy.set(false);
                        });
                    },
                    if busy() {
                        "Connecting…"
                    } else {
                        "Connect browser extension"
                    }
                }
            }
            for connection in browsers {
                {
                    let id = text(&connection, "installationId");
                    let name = text(&connection, "name");
                    let since = text(&connection, "createdAt");
                    rsx! {
                        div { class: "extension-connection-row",
                            span {
                                strong { "{name}" }
                                small { "Connected since {since}" }
                            }
                            ActionButton {
                                kind: ButtonKind::Ghost,
                                compact: true,
                                disabled: busy(),
                                onclick: move |_| {
                                    let id = id.clone();
                                    spawn(async move {
                                        busy.set(true);
                                        match delete(&format!("/extensions/connections/{id}")).await {
                                            Ok(_) => {
                                                refresh += 1;
                                                notify.call("Browser disconnected.".into());
                                            }
                                            Err(e) => error.set(e),
                                        }
                                        busy.set(false);
                                    });
                                },
                                "Disconnect"
                            }
                        }
                    }
                }
            }
            if !error().is_empty() {
                p { class: "inline-error", role: "alert", "{error}" }
            }
        }
    }
}

#[component]
pub fn ExtensionRecordingStatus(meeting: Signal<Value>, notify: EventHandler<String>) -> Element {
    let _ = notify;
    let mut recording = use_signal(|| Value::Null);
    let mut error = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut live = use_signal(|| Value::Null);
    let mut pending_control = use_signal(|| Value::Null);
    let mut acknowledgement = use_signal(|| Value::Null);
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
    let mut recording_refresh = use_signal(|| 0u32);
    crate::ui::use_poll_every(3000, move || {
        recording_refresh += 1;
    });
    use_resource(move || {
        let _ = recording_refresh();
        async move {
            let id = text(&meeting(), "id");
            let pending_before_poll = pending_control();
            match get("/extensions/recordings").await {
                Ok(v) => {
                    let snapshot = v["recordings"]
                        .as_array()
                        .and_then(|items| items.iter().find(|r| r["meetingId"] == id))
                        .cloned()
                        .unwrap_or(Value::Null);
                    if text(&meeting(), "id") == id {
                        if let Some(message) =
                            acknowledged_action(&pending_before_poll, &pending_control(), &snapshot)
                        {
                            acknowledgement.set(
                                json!({"recordingId":snapshot["recordingId"],"message":message}),
                            );
                            pending_control.set(Value::Null);
                        }
                        recording.set(snapshot);
                        error.set(String::new());
                    }
                }
                Err(e) => error.set(e),
            }
        }
    });
    if recording().is_null()
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
    let pending_here = !pending_control().is_null() && pending_control()["recordingId"] == id;
    let acknowledged_here = acknowledgement()["recordingId"] == id;
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
    rsx! {
        section {
            class: "panel extension-panel",
            "aria-label": "Extension recording status",
            h2 { "Browser recording" }
            if value.is_null() {
                p { class: "small-muted",
                    "Start a recording from the Echo extension in your meeting tab."
                }
            }
            if !live().is_null() {
                p { role: "status", {text(&live(), "message")} }
            }
            if !value.is_null() {
                p { class: "small-muted",
                    if receiving {
                        "Recording saved in the browser; transfer is in progress."
                    } else {
                        "Recording saved in Echo."
                    }
                }
                if receiving {
                    div { class: "extension-controls",
                        for action in ["pause", "resume", "stop"] {
                            {
                                let id = id.clone();
                                rsx! {
                                    ActionButton {
                                        kind: if action == "stop" { ButtonKind::Primary } else { ButtonKind::Secondary },
                                        compact: true,
                                        disabled: busy() || pending_here || !commands.is_empty(),
                                        onclick: move |_| {
                                            if busy() || pending_control()["recordingId"] == id
                                                || recording()["controls"].as_array().is_some_and(|items| !items.is_empty())
                                            {
                                                return;
                                            }
                                            busy.set(true);
                                            let id = id.clone();
                                            spawn(async move {
                                                error.set(String::new());
                                                acknowledgement.set(Value::Null);
                                                match crate::api::evaluate("return crypto.randomUUID();").await {
                                                    Ok(command) => {
                                                        match post(
                                                                &format!("/extensions/recordings/{id}/controls"),
                                                                json!({ "commandId" : command, "action" : action }),
                                                            )
                                                            .await
                                                        {
                                                            Ok(_) => {
                                                                pending_control
                                                                    .set(
                                                                        json!(
                                                                            { "recordingId" : id, "commandId" : command, "action" :
                                                                            action }
                                                                        ),
                                                                    )
                                                            }
                                                            Err(e) => error.set(e),
                                                        }
                                                    }
                                                    Err(e) => error.set(e),
                                                }
                                                busy.set(false);
                                            });
                                        },
                                        {
                                            match action {
                                                "pause" => "Pause",
                                                "resume" => "Resume",
                                                _ => "Stop",
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if pending_here || !commands.is_empty() {
                    p { role: "status", "Control pending — waiting for the extension." }
                } else if acknowledged_here {
                    p { role: "status", {text(&acknowledgement(), "message")} }
                }
                if !draft.is_empty() {
                    p { class: "extension-live-preview", role: "status",
                        "Draft transcript: {draft}"
                    }
                }
            }
            if !error().is_empty() {
                p { class: "inline-error", role: "alert", "{error}" }
            }
        }
    }
}
