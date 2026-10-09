//! First-use guidance derived from current capabilities, never a saved setup flag.
use crate::{
    api::{evaluate, text},
    ui::{ActionButton, BadgeTone, ButtonKind, SectionHeading, SetupReadiness, StatusBadge},
    Icon,
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
    on_open: EventHandler<Value>,
) -> Element {
    let mut refresh = use_signal(|| 0_u32);
    let selected_model = use_memo(move || {
        next_recording(&meetings())
            .map(|meeting| text(&meeting, "speechModel"))
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| text(&settings(), "speechModel"))
    });
    let download_status = use_memo(move || text(&download(), "status"));
    let notes_model = use_memo(move || text(&settings(), "notesModel"));
    let notes_provider = use_memo(move || text(&settings(), "notesProvider"));
    let capabilities = use_resource(move || {
        let _ = refresh();
        let _ = selected_model();
        let _ = download_status();
        let notes_model = notes_model();
        let notes_provider = notes_provider();
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
                    {notes_provider} === 'chatgpt' ? null : fetch('/api/notes', {{signal:AbortSignal.timeout(5000)}}).then(r => r.ok ? r.json() : null).catch(() => null)
                ]);
                return {{recordingReady, microphonePermission:microphone?.state ?? 'unknown',
                    models:window.echoInference.models, downloadedModels,
                    notesReady:notes ? Boolean(notes.available && notes.models?.includes({notes_model})) : null}};
                "#,
                notes_provider = serde_json::json!(notes_provider),
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

    rsx! {
        section {class:"panel",id:"first-transcript",aria_label:"First transcript setup",style:"padding:20px;margin:24px 0;min-width:0",
            SectionHeading {title:"First transcript"}
            div {style:"display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px",role:"status",
                StatusBadge {tone:if state.recording_ready==Some(true){BadgeTone::Success}else{BadgeTone::Neutral},
                    if state.recording_ready==Some(true){"Ready to record"}
                    else if state.recording_ready==Some(false){"Microphone setup needed"}
                    else if checking{"Checking recording…"}
                    else{"Recording check unavailable"}
                }
                StatusBadge {tone:if state.selected_speech_model_ready==Some(true){BadgeTone::Success}else{BadgeTone::Neutral},
                    if state.selected_speech_model_ready==Some(true){"Ready to transcribe"}
                    else if checking{"Checking speech model…"}
                    else if state.selected_speech_model_ready.is_none(){"Model check unavailable"}
                    else if downloading && this_download{"Model downloading"}
                    else{"Speech model needed"}
                }
            }
            if state.recording_ready==Some(false){p{class:"small-muted",style:"margin-bottom:8px",
                if value["microphonePermission"]=="denied"{"Allow microphone access in your browser’s site settings to record in person. You can still upload audio."}
                else{"This browser cannot record a microphone here. Open Echo in Brave or Chrome, or upload audio."}
            }}
            p {style:"font-size:13px;overflow-wrap:anywhere",
                if downloading && this_download{"Downloading {model_name}. You can record while it downloads."}
                else if download_failed{"The model download failed. Open Models to retry; your recordings are saved."}
                else if download_cancelled{"The model download was cancelled. Open Models to resume setup when you’re ready."}
                else if state.selected_speech_model_ready==Some(true) && pending.is_some(){"Open “{pending_title}” and choose Create transcript."}
                else if state.selected_speech_model_ready==Some(true){"Record or upload audio, then open the saved meeting to create its transcript."}
                else if checking{"Checking the selected model on this device…"}
                else if state.selected_speech_model_ready.is_none(){"Could not check the speech model. Check again, or open Models. Recording and uploads remain available."}
                else if !model_name.is_empty(){"Record or upload audio now. Download {model_name} to create a transcript."}
                else{"Record or upload audio now. Choose a supported speech model in Models to create a transcript."}
            }
            if state.selected_speech_model_ready==Some(false) && !model_size.is_empty(){p{class:"small-muted",style:"margin-top:6px","{model_size} download and model storage; keep extra space for recordings."}}
            if downloading && this_download{div{class:"download-status",style:"margin-top:12px",progress{value:progress.to_string(),max:"100",aria_label:"Speech model download progress"}}}
            div {style:"display:flex;flex-wrap:wrap;gap:8px;margin-top:12px",
                if state.selected_speech_model_ready==Some(true) && pending.is_some(){ActionButton{kind:ButtonKind::Primary,compact:true,onclick:move |_|{if let Some(meeting)=pending.clone(){on_open.call(meeting);}},Icon{name:"arrow-right",size:16}"Open recording"}}
                else if !checking && state.selected_speech_model_ready!=Some(true){ActionButton{kind:ButtonKind::Primary,compact:true,onclick:move |_|on_models.call(()),Icon{name:"cpu",size:16},if downloading{"View download"}else if download_failed{"Retry in Models"}else{"Set up transcription"}}}
                ActionButton{kind:ButtonKind::Ghost,compact:true,disabled:checking,onclick:move |_|refresh+=1,Icon{name:"refresh",size:16}"Check again"}
            }
            p {class:"small-muted",style:"margin-top:12px",
                if state.optional_notes_ready==Some(true){"Notes model ready. Generate notes after your transcript."}
                else{"Notes and Calendar are optional. Set up notes in Models after your first transcript."}
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
