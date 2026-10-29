//! Shared workspace controls keep action hierarchy and accessibility consistent.
use dioxus::prelude::*;

/// Presentation only: unknown capability checks never become a ready claim.
/// These values are recomputed from the browser/runtime, not saved preferences.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct SetupReadiness {
    pub recording_ready: Option<bool>,
    pub selected_speech_model_ready: Option<bool>,
    pub optional_notes_ready: Option<bool>,
}

/// Use singular count labels only for one item.
pub fn count_label(count: usize, singular: &str, plural: &str) -> String {
    format!("{count} {}", if count == 1 { singular } else { plural })
}

#[derive(Clone, Copy, Default, PartialEq)]
pub enum ButtonKind {
    Primary,
    #[default]
    Secondary,
    Ghost,
}

#[component]
pub fn ActionButton(
    children: Element,
    #[props(default)] kind: ButtonKind,
    #[props(default)] compact: bool,
    #[props(default)] full_width: bool,
    #[props(default)] disabled: bool,
    #[props(default)] class: String,
    id: Option<String>,
    button_type: Option<String>,
    aria_label: Option<String>,
    onclick: Option<EventHandler<MouseEvent>>,
) -> Element {
    let variant = match kind {
        ButtonKind::Primary => "button-primary",
        ButtonKind::Secondary => "button-secondary",
        ButtonKind::Ghost => "button-ghost",
    };
    let size = if compact { "button-small" } else { "" };
    let width = if full_width { "full-width" } else { "" };
    rsx! {
        button {
            class: "button {variant} {size} {width} {class}",
            id,
            r#type: button_type.unwrap_or_else(|| "button".into()),
            aria_label,
            disabled,
            onclick: move |event| {
                if let Some(handler) = onclick {
                    handler.call(event);
                }
            },
            {children}
        }
    }
}

#[component]
pub fn IconButton(
    icon: String,
    label: String,
    onclick: EventHandler<MouseEvent>,
    #[props(default)] disabled: bool,
    #[props(default)] class: String,
    id: Option<String>,
) -> Element {
    rsx! {
        button {
            r#type: "button",
            class: "icon-button {class}",
            id,
            aria_label: label.clone(),
            title: label,
            disabled,
            onclick,
            crate::Icon { name: icon, size: 18 }
        }
    }
}

#[component]
pub fn PageHeading(title: String, #[props(default)] children: Element) -> Element {
    rsx! {
        header { class: "page-heading",
            div {
                h1 { "{title}" }
            }
            {children}
        }
    }
}

#[component]
pub fn SectionHeading(
    title: String,
    #[props(default)] description: String,
    #[props(default)] class: String,
    #[props(default)] children: Element,
    id: Option<String>,
) -> Element {
    rsx! {
        div { class: "section-heading {class}", id,
            div {
                h2 { "{title}" }
                if !description.is_empty() {
                    p { "{description}" }
                }
            }
            {children}
        }
    }
}

#[derive(Clone, Copy, Default, PartialEq)]
pub enum BadgeTone {
    #[default]
    Neutral,
    Success,
    Accent,
    Warning,
}

#[component]
pub fn StatusBadge(children: Element, #[props(default)] tone: BadgeTone) -> Element {
    let class = match tone {
        BadgeTone::Neutral => "badge",
        BadgeTone::Success => "badge badge-green",
        BadgeTone::Accent => "badge badge-purple",
        BadgeTone::Warning => "badge badge-amber",
    };
    rsx! {
        span { class, {children} }
    }
}

/// Call back on a visible-only interval; remove its timer when the component unmounts.
pub fn use_poll_every(ms: u32, callback: impl FnMut() + Copy + 'static) {
    let id = use_hook(|| format!("echo-poll-{}", js_sys::Math::random()));
    let cleanup = id.clone();
    use_drop(move || {
        let _ = document::eval(&format!(
            "window.echoPollStop?.({});",
            serde_json::json!(cleanup)
        ));
    });
    use_future(move || {
        let id = id.clone();
        let mut callback = callback;
        async move {
            let mut eval = document::eval(&format!(
                r#"const id={}; window.echoPolls ||= {{}}; const tick=()=>{{if(!document.hidden)dioxus.send(true)}}; const timer=setInterval(tick,{}); window.echoPolls[id]=()=>clearInterval(timer); window.echoPollStop=(id)=>{{window.echoPolls[id]?.(); delete window.echoPolls[id];}};"#,
                serde_json::json!(id),
                ms
            ));
            while eval.recv::<bool>().await.is_ok() {
                callback();
            }
        }
    });
}
