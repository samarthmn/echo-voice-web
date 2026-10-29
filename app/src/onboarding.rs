//! First-use guidance derived from current capabilities, never a saved setup flag.
use crate::{
    api::{evaluate, text},
    ui::{ActionButton, ButtonKind, SetupReadiness},
};
use dioxus::prelude::*;
use serde_json::Value;

fn has_transcript(meeting: &Value) -> bool {
    meeting["transcripts"]
        .as_array()
        .is_some_and(|versions| !versions.is_empty())
}

pub fn needs_first_transcript(meetings: &[Value]) -> bool {
    !meetings.iter().any(has_transcript)
}

fn next_recording(meetings: &[Value]) -> Option<Value> {
    meetings
        .iter()
        .find(|meeting| {
            !has_transcript(meeting)
                && matches!(
                    meeting["status"].as_str(),
                    Some("saved" | "ready" | "interrupted" | "error")
                )
                && meeting["tracks"].as_array().is_some_and(|a| !a.is_empty())
        })
        .cloned()
}

fn readiness(capabilities: &Value, model_id: &str) -> SetupReadiness {
    SetupReadiness {
        recording_ready: capabilities["recordingReady"].as_bool(),
        selected_speech_model_ready: capabilities["downloadedModels"].as_array().map(|ids| {
            capabilities["models"]
                .as_array()
                .is_some_and(|models| models.iter().any(|m| m["id"] == model_id))
                && ids.iter().any(|id| id.as_str() == Some(model_id))
        }),
        optional_notes_ready: capabilities["notesReady"].as_bool(),
    }
}

#[component]
pub fn FirstTranscript(
    settings: Signal<Value>,
    download: Signal<Value>,
    meetings: Signal<Vec<Value>>,
    on_models: EventHandler<()>,
    on_record: EventHandler<()>,
    on_open: EventHandler<Value>,
) -> Element {
    let mut refresh = use_signal(|| 0_u32);
    let mut mic_error = use_signal(String::new);
    let selected_model = use_memo(move || {
        next_recording(&meetings())
            .map(|meeting| text(&meeting, "speechModel"))
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| text(&settings(), "speechModel"))
    });
    let download_status = use_memo(move || text(&download(), "status"));
    let notes_model = use_memo(move || text(&settings(), "notesModel"));
    let capabilities = use_resource(move || {
        let _ = refresh();
        let _ = selected_model();
        let _ = download_status();
        let notes_model = notes_model();
        async move {
            // Capability probes. No microphone request, model download, account login,
            // or inference is started by opening Overview. Optional notes never block it.
            evaluate(&format!(
                r#"
                async function bounded(work) {{
                    let timer;
                    try {{ return await Promise.race([work, new Promise((_, reject) => {{ timer=setTimeout(() => reject(new Error('Check timed out')), 5000); }})]); }}
                    finally {{ clearTimeout(timer); }}
                }}
                const microphone = await bounded(navigator.permissions?.query({{name:'microphone'}})).catch(() => null);
                const recordingReady = Boolean(isSecureContext && navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined' && microphone?.state !== 'denied');
                const [downloadedModels, notes] = await Promise.all([
                    bounded(window.echoInference.getDownloadedModels()).catch(() => null),
                    fetch('/api/notes', {{signal:AbortSignal.timeout(5000)}}).then(r => r.ok ? r.json() : null).catch(() => null)
                ]);
                return {{recordingReady, microphonePermission:microphone?.state ?? 'unknown',
                    models:window.echoInference.models, downloadedModels,
                    notesReady:notes ? Boolean(notes.available && notes.models?.includes({notes_model})) : null}};
                "#,
                notes_model = serde_json::json!(notes_model),
            ))
            .await
        }
    });
    let value = match &*capabilities.read() {
        Some(Ok(value)) => value.clone(),
        _ => Value::Null,
    };
    let checking = capabilities.state() != UseResourceState::Ready;
    // Do not keep advertising a stale ready result while a new check is running.
    let state = readiness(
        &if checking { Value::Null } else { value.clone() },
        &selected_model(),
    );
    let model = value["models"]
        .as_array()
        .and_then(|models| models.iter().find(|m| m["id"] == selected_model()))
        .cloned()
        .unwrap_or(Value::Null);
    let model_name = text(&model, "name");
    let model_size = text(&model, "size");
    let pending = next_recording(&meetings());
    let pending_title = pending
        .as_ref()
        .map(|m| text(m, "title"))
        .unwrap_or_default();
    let downloading = matches!(download_status().as_str(), "queued" | "downloading");
    let this_download = text(&download(), "modelId") == selected_model();
    let download_failed = this_download && download_status() == "failed";
    let download_cancelled = this_download && download_status() == "cancelled";
    let progress = download()["progress"]
        .as_f64()
        .unwrap_or(0.)
        .clamp(0., 100.);
    let model_ready = state.selected_speech_model_ready == Some(true);
    let model_unknown = !checking && state.selected_speech_model_ready.is_none();
    rsx! {
        section {
            class: "panel first-transcript",
            id: "first-transcript",
            aria_label: "First transcript setup",
            h2 { "Create your first transcript" }
            p {
                if model_ready && pending.is_some() {
                    "Open “{pending_title}” and choose Create transcript."
                } else if model_ready {
                    "Record or upload audio, then open the saved meeting to create its transcript."
                } else {
                    "Record a meeting or upload audio, then transcribe it on this device."
                }
            }
            ul { class: "first-transcript-checklist",
                li {
                    if checking {
                        "Checking microphone access…"
                    } else if state.recording_ready == Some(true) {
                        "Microphone ready for in-person recording."
                    } else if state.recording_ready.is_none() {
                        "Microphone check unavailable. You can still upload audio."
                    } else if value["microphonePermission"] == "denied" {
                        "Microphone access needed. Allow it in your browser’s site settings, then check again. You can still upload audio."
                    } else if value["microphonePermission"] == "unknown" {
                        "This browser cannot record a microphone here. Open Echo in Brave or Chrome, or upload audio."
                    } else {
                        span { "Microphone access needed for in-person recording. " }
                        button {
                            r#type: "button",
                            onclick: move |_| {
                                spawn(async move {
                                    match evaluate(
                                            "const stream = await navigator.mediaDevices.getUserMedia({audio:true}); stream.getTracks().forEach(track => track.stop()); return true;",
                                        )
                                        .await
                                    {
                                        Ok(_) => {
                                            mic_error.set(String::new());
                                            refresh += 1;
                                        }
                                        Err(_) => {
                                            mic_error
                                                .set(
                                                    "Allow microphone access in your browser's site settings, then check again."
                                                        .into(),
                                                )
                                        }
                                    }
                                });
                            },
                            "Allow microphone"
                        }
                    }
                }
                li {
                    if checking {
                        "Checking speech model…"
                    } else if model_ready {
                        "Speech model ready."
                    } else if model_unknown {
                        "Could not check the speech model. Recording and uploads remain available."
                    } else if downloading && this_download {
                        "Downloading {model_name}. You can record while it downloads. "
                        button {
                            r#type: "button",
                            onclick: move |_| on_models.call(()),
                            "View download"
                        }
                    } else if download_failed {
                        "The model download failed. Your recordings are saved. "
                        button {
                            r#type: "button",
                            onclick: move |_| on_models.call(()),
                            "Retry in Models"
                        }
                    } else if download_cancelled {
                        "The model download was cancelled. "
                        button {
                            r#type: "button",
                            onclick: move |_| on_models.call(()),
                            "Resume in Models"
                        }
                    } else {
                        span { "Speech model needed. " }
                        if !model_size.is_empty() {
                            span {
                                "{model_size} download and model storage; keep extra space for recordings. "
                            }
                        }
                        button {
                            r#type: "button",
                            onclick: move |_| on_models.call(()),
                            "Set up speech model"
                        }
                    }
                }
            }
            if !mic_error().is_empty() {
                p { class: "inline-error", role: "alert", "{mic_error}" }
            }
            if downloading && this_download {
                progress {
                    value: progress.to_string(),
                    max: "100",
                    aria_label: "Speech model download progress",
                }
            }
            div { class: "first-transcript-actions",
                if let Some(meeting) = pending.filter(|_| model_ready) {
                    ActionButton {
                        kind: ButtonKind::Primary,
                        onclick: move |_| on_open.call(meeting.clone()),
                        "Open recording"
                    }
                } else {
                    ActionButton {
                        kind: ButtonKind::Primary,
                        onclick: move |_| on_record.call(()),
                        "Record a meeting"
                    }
                }
                ActionButton {
                    kind: ButtonKind::Ghost,
                    disabled: checking,
                    onclick: move |_| refresh += 1,
                    "Check again"
                }
            }
            p { class: "small-muted",
                if state.optional_notes_ready == Some(true) {
                    "Notes model ready. Generate notes after your transcript."
                } else {
                    "Notes and Calendar are optional. Set up notes in Models after your first transcript."
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recording_does_not_require_model_notes_or_calendar() {
        let value = json!({"recordingReady":true,"models":[{"id":"turbo"}],"downloadedModels":[],"notesReady":false});
        assert_eq!(
            readiness(&value, "turbo"),
            SetupReadiness {
                recording_ready: Some(true),
                selected_speech_model_ready: Some(false),
                optional_notes_ready: Some(false)
            }
        );
    }

    #[test]
    fn only_selected_known_model_can_be_ready() {
        let mut value = json!({"recordingReady":true,"models":[{"id":"turbo"},{"id":"large"}],"downloadedModels":["large","removed"]});
        assert_eq!(
            readiness(&value, "turbo").selected_speech_model_ready,
            Some(false)
        );
        assert_eq!(
            readiness(&value, "large").selected_speech_model_ready,
            Some(true)
        );
        assert_eq!(
            readiness(&value, "removed").selected_speech_model_ready,
            Some(false)
        );
        value["downloadedModels"] = Value::Null;
        assert_eq!(readiness(&value, "large").selected_speech_model_ready, None);
    }

    #[test]
    fn next_action_only_opens_saved_audio_and_guide_ends_after_first_transcript() {
        let meetings = vec![
            json!({"id":"active","status":"recording","tracks":[{}]}),
            json!({"id":"empty","status":"error","tracks":[]}),
            json!({"id":"recovered","status":"interrupted","tracks":[{}]}),
        ];
        assert!(needs_first_transcript(&meetings));
        assert_eq!(next_recording(&meetings).unwrap()["id"], "recovered");
        assert!(!needs_first_transcript(&[
            json!({"transcripts":[{"id":"final"}]})
        ]));
    }
}
