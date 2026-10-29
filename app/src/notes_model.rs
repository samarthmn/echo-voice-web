use crate::api::get;
use dioxus::prelude::*;
use serde_json::Value;

/// Select a model reported by the local Ollama service.
#[component]
pub fn NotesModelSelect(
    label: String,
    value: String,
    disabled: bool,
    #[props(default)] refresh_key: String,
    onchange: EventHandler<String>,
) -> Element {
    let mut status = use_signal(|| Value::Null);
    let mut refresh = use_signal(|| 0u32);
    use_resource(use_reactive((&refresh_key,), move |(_key,)| {
        let _ = refresh();
        async move {
            status.set(Value::Null);
            status.set(get("/notes").await.unwrap_or(Value::Null));
        }
    }));
    let available = status()["available"] == true;
    let models: Vec<String> = status()["models"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let no_models = models.is_empty();
    let missing = available && !value.is_empty() && !models.contains(&value);
    rsx! {
        div {
            div { style: "display: flex; align-items: center; gap: 8px;",
                select {
                    class: "input",
                    "aria-label": "{label}",
                    disabled: disabled || !available || no_models,
                    value: if available && !value.is_empty() { value.clone() } else { String::new() },
                    onchange: move |event| onchange.call(event.value()),
                    if !available {
                        option { value: "", selected: true, "Start Ollama to choose a model" }
                    } else if no_models && !missing {
                        option { value: "", selected: true, "No models installed yet" }
                    } else if value.is_empty() {
                        option { value: "", selected: true, "Choose an installed model" }
                    }
                    if missing {
                        option { value: "{value}", selected: true, "{value} (not installed)" }
                    }
                    for model in models {
                        option { value: "{model}", selected: model == value, "{model} (installed)" }
                    }
                }
                button {
                    r#type: "button",
                    class: "icon-button",
                    "aria-label": "Refresh installed models",
                    title: "Refresh installed models",
                    onclick: move |_| refresh += 1,
                    crate::Icon { name: "refresh", size: 16 }
                }
            }
            if !available {
                button {
                    r#type: "button",
                    class: "settings-text-button",
                    onclick: move |_| refresh += 1,
                    "Check connection"
                }
            } else if status()["models"].as_array().is_none_or(|items| items.is_empty()) {
                p { class: "small-muted",
                    "No models installed yet — download one in "
                    button {
                        r#type: "button",
                        class: "settings-text-button",
                        onclick: move |_| {
                            let _ = document::eval("window.dispatchEvent(new Event('echo-open-models'))");
                        },
                        "Models"
                    }
                }
            } else if missing {
                p { class: "small-muted", "Saved model is not installed. Choose another model." }
            }
        }
    }
}
