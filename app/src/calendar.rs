use crate::{
    api::{get, post, text},
    ui::{ActionButton, BadgeTone, ButtonKind, IconButton, PageHeading, StatusBadge},
    Icon,
};
use dioxus::prelude::*;
use serde_json::{json, Value};

#[component]
pub fn Calendar(notify: EventHandler<String>, on_extension: EventHandler<()>) -> Element {
    let mut status = use_signal(|| Value::Null);
    let mut events = use_signal(Vec::<Value>::new);
    let mut loading = use_signal(|| true);
    let mut error = use_signal(String::new);
    let mut setup = use_signal(|| false);
    let mut busy = use_signal(|| false);
    let mut refresh = use_signal(|| 0);
    use_resource(move || {
        let _ = refresh();
        async move {
            loading.set(true);
            error.set(String::new());
            match get("/integrations/status").await {
                Ok(mut s) => {
                    if s["google"]["connected"] == true {
                        match get("/integrations/calendar").await {
                            Ok(v) => {
                                events.set(v["events"].as_array().cloned().unwrap_or_default())
                            }
                            Err(e) => {
                                events.set(Vec::new());
                                error.set(e);
                                // Refresh can discover a revoked grant while loading events.
                                s = get("/integrations/status").await.unwrap_or(Value::Null);
                            }
                        }
                    } else {
                        events.set(Vec::new());
                    }
                    status.set(s);
                }
                Err(e) => {
                    status.set(Value::Null);
                    events.set(Vec::new());
                    error.set(e);
                }
            }
            loading.set(false);
        }
    });
    crate::ui::use_poll_every(3000, move || {
        if status()["google"]["pending"] == true && !busy() && !loading() {
            refresh += 1;
        }
    });
    let connected = status()["google"]["connected"] == true;
    let configured = status()["google"]["configured"] == true;
    let pending = status()["google"]["pending"] == true;
    let reconnect = status()["google"]["reconnectRequired"] == true;
    let configuration_error = text(&status()["google"], "configurationError");
    rsx! {
        div { class: "page-content calendar-page",
            PageHeading { title: "Calendar",
                ActionButton {
                    kind: ButtonKind::Secondary,
                    disabled: loading() || busy(),
                    onclick: move |_| refresh += 1,
                    Icon { name: "refresh", size: 16 }
                    "Refresh"
                }
            }
            div { class: "calendar-connection-grid",
                section { class: "panel connection-panel",
                    span { class: "google-calendar-logo",
                        Icon { name: "calendar", size: 27 }
                    }
                    div {
                        h2 { "Google Calendar" }
                        p {
                            if connected {
                                {text(&status()["google"], "email")}
                            } else {
                                "Read-only access to upcoming meetings."
                            }
                        }
                    }
                    if connected {
                        StatusBadge { tone: BadgeTone::Success,
                            Icon { name: "check", size: 12 }
                            "Connected"
                        }
                    } else if pending {
                        StatusBadge { tone: BadgeTone::Warning, "Waiting for Google" }
                    } else {
                        ActionButton {
                            kind: ButtonKind::Primary,
                            disabled: loading() || busy() || status().is_null(),
                            onclick: move |_| {
                                if configured {
                                    let _ = document::eval(
                                        "window.location.assign('/api/integrations/google/connect')",
                                    );
                                } else {
                                    setup.set(true)
                                }
                            },
                            if reconnect {
                                "Reconnect calendar"
                            } else {
                                "Connect calendar"
                            }
                        }
                    }
                }

            }
            p { class: "calendar-extension-link",
                "Recording an online meeting? "
                button { r#type: "button", onclick: move |_| on_extension.call(()),
                    "Set up the browser extension"
                }
            }
            if pending {
                div { class: "panel", role: "status",
                    p {
                        "Finish signing in with Google in your browser. This request expires after ten minutes."
                    }
                    if connected {
                        p { "Your current calendar stays connected until the new sign-in succeeds." }
                    }
                    ActionButton {
                        kind: ButtonKind::Secondary,
                        disabled: busy(),
                        onclick: move |_| {
                            spawn(async move {
                                busy.set(true);
                                match post("/integrations/google/cancel", json!({})).await {
                                    Ok(_) => {
                                        notify.call("Calendar sign-in cancelled.".into());
                                        refresh += 1;
                                    }
                                    Err(e) => error.set(e),
                                }
                                busy.set(false);
                            });
                        },
                        "Cancel sign-in"
                    }
                }
            } else if reconnect {
                p { class: "small-muted", role: "status",
                    "Sign in again to restore Calendar access. Your recorded meetings are unchanged."
                }
            }
            if !configuration_error.is_empty() {
                p { class: "small-muted", role: "status", "{configuration_error}" }
            }
            if !error().is_empty() {
                div { class: "inline-error", role: "alert",
                    Icon { name: "alert" }
                    "{error}"
                }
            }
            div { class: "section-heading",
                h2 {
                    "Upcoming meetings "
                    span { class: "count-label", "{events().len()}" }
                }
                span { class: "small-muted", "Next 30 days" }
            }
            if loading() {
                div { class: "panel loading-panel",
                    span { class: "spinner" }
                    "Loading calendar…"
                }
            } else if status().is_null() {
                div { class: "calendar-empty panel",
                    h2 { "Calendar status unavailable" }
                    p { "Refresh to check your connection again." }
                }
            } else if !connected {
                div { class: "calendar-empty panel",
                    h2 { "No upcoming meetings" }
                    p {
                        if pending {
                            "Finish signing in to load your meetings."
                        } else if reconnect {
                            "Reconnect your calendar above to load meetings."
                        } else {
                            "Connect your calendar above to load meetings."
                        }
                    }
                }
            } else if !error().is_empty() {
                div { class: "calendar-empty panel",
                    h2 { "Meetings could not load" }
                    p { "Refresh to try again." }
                }
            } else if events().is_empty() {
                div { class: "calendar-empty panel",
                    h2 { "No upcoming meetings" }
                    p { "Nothing scheduled in the next 30 days." }
                }
            } else {
                div { class: "event-list",
                    for event in events() {
                        {
                            let url = text(&event, "url");
                            let supported = matches!(
                                text(&event, "provider").as_str(),
                                "google-meet" | "zoom" | "teams"
                            );
                            rsx! {
                                div { class: "panel event-card",
                                    div { class: "event-date",
                                        Icon { name: "calendar", size: 25 }
                                    }
                                    div { class: "event-info",
                                        h3 { {text(&event, "title")} }
                                        p { {crate::api::local_date_time(&text(&event, "start"))} }
                                    }
                                    StatusBadge { tone: BadgeTone::Neutral,
                                        Icon { name: "video", size: 13 }
                                        {
                                            match text(&event, "provider").as_str() {
                                                "google-meet" => "Google Meet",
                                                "zoom" => "Zoom Web",
                                                "teams" => "Teams Web",
                                                _ => "Online meeting",
                                            }
                                        }
                                    }
                                    if supported && !url.is_empty() {
                                        a {
                                            class: "button button-secondary",
                                            href: "{url}",
                                            target: "_blank",
                                            rel: "noopener noreferrer",
                                            "Open meeting"
                                            Icon { name: "arrow-right", size: 15 }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            p { class: "small-muted",
                "Opening a meeting does not record it. Join normally, then choose Start recording in the extension."
            }
            if connected {
                ActionButton {
                    kind: ButtonKind::Ghost,
                    disabled: busy() || loading() || pending,
                    onclick: move |_| {
                        spawn(async move {
                            busy.set(true);
                            match post("/integrations/google/disconnect", json!({})).await {
                                Ok(_) => {
                                    notify.call("Calendar disconnected.".into());
                                    refresh += 1;
                                }
                                Err(e) => error.set(e),
                            }
                            busy.set(false);
                        });
                    },
                    "Disconnect calendar"
                }
            }
            if setup() {
                div { class: "dialog-backdrop",
                    div {
                        class: "dialog",
                        role: "dialog",
                        "aria-modal": "true",
                        "aria-labelledby": "calendar-setup-title",
                        IconButton {
                            class: "dialog-close",
                            label: "Close calendar setup",
                            icon: "close",
                            onclick: move |_| setup.set(false),
                        }
                        h2 { id: "calendar-setup-title", "Calendar setup" }
                        p {
                            "Calendar is optional. Ask the person who runs this Echo workspace to configure Google Calendar, or follow the setup guide if you run it yourself."
                        }
                        details {
                            summary { "Developer configuration" }
                            p {
                                "Configure a Google OAuth web client. Add the client ID and secret to the project’s local .env file, then restart Echo."
                            }
                            code {
                                "GOOGLE_CLIENT_ID"
                                br {}
                                "GOOGLE_CLIENT_SECRET"
                            }
                            p {
                                "Use the exact callback URI from googleRedirectUri in echo.config.json."
                            }
                        }
                        a {
                            href: "https://github.com/samarthmn/echo-voice-web/blob/main/docs/integrations.md#configure-the-local-server",
                            target: "_blank",
                            rel: "noopener noreferrer",
                            "Developer setup guide"
                        }
                        p { "The browser extension works without connecting Calendar." }
                        ActionButton {
                            kind: ButtonKind::Primary,
                            onclick: move |_| setup.set(false),
                            "Done"
                        }
                    }
                }
            }
        }
    }
}
