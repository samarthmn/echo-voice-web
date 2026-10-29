use crate::{
    api::{get, post, text},
    ui::{ActionButton, ButtonKind},
    Icon,
};
use dioxus::prelude::*;
use serde_json::{json, Value};

#[component]
pub fn RecoverySettings(on_ready: EventHandler<bool>) -> Element {
    let mut ready = use_signal(|| false);
    let mut loading = use_signal(|| true);
    let mut busy = use_signal(|| false);
    let mut error = use_signal(String::new);
    let mut setup = use_signal(|| Value::Null);
    let mut checking = use_signal(|| false);
    let mut words = use_signal(|| vec![String::new(); 3]);
    let mut refresh = use_signal(|| 0u32);
    use_effect(move || {
        let _ = refresh();
        spawn(async move {
            loading.set(true);
            match get("/privacy/status").await {
                Ok(value) => {
                    let value = value["recoveryReady"] == true;
                    ready.set(value);
                    on_ready.call(value);
                    error.set(String::new());
                }
                Err(message) => error.set(message),
            }
            loading.set(false);
        });
    });
    rsx! {
        section { class: "settings-card recovery-card",
            div { class: "settings-card-heading",
                div { class: "settings-section-icon",
                    Icon { name: "lock", size: 20 }
                }
                div {
                    h2 { "Protect your library" }
                }
            }
            if loading() {
                p { role: "status", "Checking recovery setup…" }
            } else if setup().is_null() {
                p {
                    "Your saved library is encrypted on this computer. Save a recovery phrase to restore encrypted backups if you move computers or lose access to your system’s saved key."
                }
                if ready() {
                    p { class: "recovery-ready", role: "status",
                        Icon { name: "check", size: 16 }
                        "Recovery phrase saved"
                    }
                    small {
                        "Existing backups keep using the phrase they were created with. Keep that phrase if you create a new one."
                    }
                }
                ActionButton {
                    button_type: "button",
                    kind: ButtonKind::Secondary,
                    disabled: busy(),
                    onclick: move |_| {
                        busy.set(true);
                        error.set(String::new());
                        spawn(async move {
                            match post("/privacy/recovery/prepare", json!({})).await {
                                Ok(value) => {
                                    setup.set(value);
                                    checking.set(false);
                                    words.set(vec![String::new(); 3]);
                                }
                                Err(message) => error.set(message),
                            }
                            busy.set(false);
                        });
                    },
                    if busy() {
                        "Preparing…"
                    } else if ready() {
                        "Create a new recovery phrase"
                    } else {
                        "Save recovery phrase"
                    }
                }
            } else if !checking() {
                p {
                    "Keep these 24 words somewhere private, such as your password manager. Anyone with the phrase and your backup can open it. Echo cannot replace a lost phrase."
                }
                ol {
                    class: "recovery-words",
                    "aria-label": "Library recovery phrase",
                    for (index, word) in text(&setup(), "phrase").split_whitespace().enumerate() {
                        li { key: "{index}", "{word}" }
                    }
                }
                p { class: "recovery-note",
                    "Do not include these words in screenshots, support messages, or a meeting recording."
                }
                ActionButton {
                    button_type: "button",
                    kind: ButtonKind::Primary,
                    onclick: move |_| checking.set(true),
                    "I saved the phrase"
                }
                ActionButton {
                    button_type: "button",
                    kind: ButtonKind::Secondary,
                    onclick: move |_| {
                        let id = setup()["setupId"].clone();
                        setup.set(Value::Null);
                        words.set(vec![String::new(); 3]);
                        spawn(async move {
                            let _ = post("/privacy/recovery/cancel", json!({ "setupId" : id })).await;
                        });
                    },
                    "Cancel"
                }
            } else {
                form {
                    onsubmit: move |event| {
                        event.prevent_default();
                        if busy() {
                            return;
                        }
                        busy.set(true);
                        error.set(String::new());
                        let value = json!({ "setupId" : setup() ["setupId"], "words" : words() });
                        spawn(async move {
                            match post("/privacy/recovery/confirm", value).await {
                                Ok(_) => {
                                    setup.set(Value::Null);
                                    words.set(vec![String::new(); 3]);
                                    ready.set(true);
                                    on_ready.call(true);
                                }
                                Err(message) => error.set(message),
                            }
                            busy.set(false);
                        });
                    },
                    p { "Check your saved phrase and enter the three words below." }
                    div { class: "recovery-confirm-fields",
                        for index in 0..3 {
                            label { class: "settings-field",
                                span { "Word {setup()[\"confirmWords\"][index]}" }
                                input {
                                    class: "input",
                                    r#type: "password",
                                    autocomplete: "off",
                                    spellcheck: "false",
                                    required: true,
                                    maxlength: 32,
                                    value: words()[index].clone(),
                                    oninput: move |event| words.write()[index] = event.value(),
                                }
                            }
                        }
                    }
                    div { class: "recovery-actions",
                        ActionButton {
                            button_type: "button",
                            kind: ButtonKind::Secondary,
                            disabled: busy(),
                            onclick: move |_| checking.set(false),
                            "Show phrase again"
                        }
                        ActionButton {
                            button_type: "submit",
                            kind: ButtonKind::Primary,
                            disabled: busy(),
                            if busy() {
                                "Checking…"
                            } else {
                                "Confirm recovery phrase"
                            }
                        }
                    }
                }
            }
            if !error().is_empty() {
                div { class: "settings-error", role: "alert", "{error}" }
                if !loading() && setup().is_null() {
                    ActionButton {
                        button_type: "button",
                        kind: ButtonKind::Secondary,
                        onclick: move |_| {
                            let value = refresh() + 1;
                            refresh.set(value);
                        },
                        "Retry"
                    }
                }
            }
        }
    }
}
