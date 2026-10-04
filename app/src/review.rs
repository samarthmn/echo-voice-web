use crate::{api, Icon};
use dioxus::prelude::*;
use serde_json::{json, Value};

/// Read optional string metadata without displaying JSON null.
fn text(v: &Value, key: &str) -> String {
    api::text(v, key)
}
/// Clone a JSON collection for safe iteration during component rendering.
fn list(v: &Value, key: &str) -> Vec<Value> {
    v[key].as_array().cloned().unwrap_or_default()
}
/// Read a numeric field with a zero fallback for incomplete legacy records.
fn num(v: &Value, key: &str) -> f64 {
    v[key].as_f64().unwrap_or(0.)
}
/// Resolve the active saved version from a meeting's history.
fn current(v: &Value, collection: &str, active: &str) -> Value {
    let versions = list(v, collection);
    versions
        .iter()
        .find(|version| version["id"] == v[active])
        .cloned()
        .or_else(|| versions.last().cloned())
        .unwrap_or(Value::Null)
}
/// Identify the read-only sample meeting before enabling persisted actions.
fn is_demo(v: &Value) -> bool {
    v["demo"].as_bool().unwrap_or(false)
}
/// Identify recording or processing states that make destructive edits unsafe.
fn is_active(v: &Value) -> bool {
    matches!(
        text(v, "status").as_str(),
        "recording" | "paused" | "processing"
    )
}
/// Display a saved timestamp in the browser's local timezone.
fn readable_date(value: &str) -> String {
    api::local_date_time(value)
}
/// Dispatch a browser-only UI action without waiting for a return value.
fn js(source: String) {
    let _ = document::eval(&source);
}
/// Move playback to a timestamp and optionally highlight its transcript passage.
fn seek(time: f64, passage: Option<String>) {
    js(format!(
        "const a=document.getElementById('review-audio');if(a){{a.currentTime={};}}",
        time.max(0.)
    ));
    if let Some(id) = passage {
        js("window.echoReviewFollow=false;const input=document.getElementById('review-transcript-search');if(input&&input.value){input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));}const filter=document.getElementById('review-highlight-filter');if(filter?.getAttribute('aria-pressed')==='true')filter.click();".into());
        js(format!("let attempts=0;const reveal=()=>{{const p=document.getElementById({});if(p){{document.querySelectorAll('.review-passage-selected').forEach(x=>x.classList.remove('review-passage-selected'));p.classList.add('review-passage-selected');p.scrollIntoView({{behavior:'smooth',block:'center'}});p.focus({{preventScroll:true}});}}else if(attempts++<100){{document.getElementById('review-show-more')?.click();setTimeout(reveal,40);}}}};requestAnimationFrame(reveal)", json!(format!("passage-{id}"))));
    }
}
/// Persist transcript or notes edits while preserving active version and evidence references.
async fn save(
    method: &str,
    path: String,
    mut body: Value,
    mut meeting: Signal<Value>,
    on_change: EventHandler<Value>,
    notify: EventHandler<String>,
    message: &str,
) -> bool {
    if method == "POST" && path.starts_with("/meetings/") {
        let allowed: &[&str] = if path.ends_with("/transcripts") {
            &["model", "passages", "vocabulary", "label"]
        } else if path.ends_with("/notes") {
            &[
                "model",
                "transcriptVersionId",
                "summary",
                "decisions",
                "actions",
                "edited",
                "provider",
                "usage",
            ]
        } else {
            &[]
        };
        if !allowed.is_empty() {
            if let Some(object) = body.as_object_mut() {
                object.retain(|key, _| allowed.contains(&key.as_str()));
            }
        }
    }
    let result = match method {
        "PATCH" => api::patch(&path, body).await,
        "DELETE" => api::delete(&path).await,
        _ => api::post(&path, body).await,
    };
    match result {
        Ok(value) => {
            meeting.set(value.clone());
            on_change.call(value);
            notify.call(message.into());
            true
        }
        Err(error) => {
            notify.call(error);
            false
        }
    }
}
/// Start local transcription using the meeting's selected speech model.
fn audio_transcribe(v: &Value) {
    js(format!("if(window.echoInference){{window.echoInference.transcribeMeeting({},{}).catch(e=>window.dispatchEvent(new CustomEvent('echo-transcription-error',{{detail:{{error:e.message}}}})));}}else{{window.dispatchEvent(new CustomEvent('echo-transcription-error',{{detail:{{error:'Speech processing is still loading. Please try again.'}}}}));}}",json!(text(v,"id")),json!(text(v,"speechModel"))));
}

#[component]
/// Present notes, transcripts, bookmarks, details, and synchronized audio for a meeting.
pub fn MeetingReview(
    meeting: Signal<Value>,
    on_back: EventHandler<()>,
    on_change: EventHandler<Value>,
    notify: EventHandler<String>,
) -> Element {
    let value = meeting();
    let notes = current(&value, "notes", "activeNotesId");
    let mut tab = use_signal(|| {
        if notes.is_null() {
            "transcript".to_string()
        } else {
            "notes".to_string()
        }
    });
    let mut rename = use_signal(|| false);
    let mut title = use_signal(|| text(&value, "title"));
    let mut busy = use_signal(|| false);
    let demo = is_demo(&value);
    let active = is_active(&value);
    let heading = text(&value, "title");
    let created = readable_date(&text(&value, "createdAt"));
    let duration = api::time(num(&value, "duration"));
    let mode = match text(&value, "mode").as_str() {
        "in-person" => "In person",
        "online" => "Online meeting",
        _ => "Imported audio",
    };
    let status = text(&value, "status");
    let status_label = if status == "ready" {
        "Ready to review"
    } else {
        status.as_str()
    };
    let moment_count = list(&value, "moments").len();
    let id = text(&value, "id");
    let error = text(&value, "error");
    let delete_id = id.clone();
    rsx! {
        article { class: "review-workspace",
            div { class: "review-breadcrumb", button { class: "review-back", onclick: move |_| on_back.call(()), Icon { name: "arrow-left", size: 15 } "All meetings" } span { "/" } span { "Meeting workspace" } }
            header { class: "review-header",
                div { class: "review-heading",
                    if demo { span { class: "review-example", Icon { name: "sparkles", size: 12 } "EXAMPLE MEETING · EXPLORE THE WORKSPACE" } }
                    if rename() {
                        form { class: "review-title-form", onsubmit: move |event| { event.prevent_default(); let next=title().trim().to_string(); if next.is_empty() {notify.call("Give this meeting a name.".into());return;} let path=format!("/meetings/{}",text(&meeting(),"id")); busy.set(true); spawn(async move { if save("PATCH",path,json!({"title":next}),meeting,on_change,notify,"Meeting renamed.").await {rename.set(false);}busy.set(false);}); },
                            input { class: "input", aria_label: "Meeting name", maxlength: "200", value: "{title}", autofocus: true, oninput: move |event| title.set(event.value()) }
                            button { class: "icon-button", aria_label: "Save meeting name", disabled: busy(), Icon { name: "check", size: 17 } }
                            button { r#type: "button", class: "icon-button", aria_label: "Cancel rename", onclick: move |_| rename.set(false), Icon { name: "close", size: 17 } }
                        }
                    } else {
                        div { class: "review-title-line", h1 { "{heading}" } if !demo { button { class: "icon-button review-title-edit", aria_label: "Rename meeting", onclick: move |_| {title.set(text(&meeting(),"title"));rename.set(true);}, Icon { name: "edit", size: 16 } } } }
                    }
                    div { class: "review-meta", span { Icon { name: "clock", size: 14 } "{created}" } i {} span { "{duration}" } i {} span { Icon { name: "mic", size: 14 } "{mode}" } span { class: "review-status review-status-{status}", if status=="ready" {Icon { name: "check", size: 11 }} "{status_label}" } }
                }
                div { class: "review-header-actions", details { class: "review-export", summary { class: "button button-secondary", Icon { name: "download", size: 15 } "Export" Icon { name: "chevron", size: 13 } } div { class: "review-dropdown", div { class: "review-dropdown-label", "INDEPENDENT COPIES" }
                    if demo {p { "Record or import a meeting to export your own files." }} else { for (format,label,hint) in [("json","Meeting data","Text, history & metadata"),("txt","Transcript","Readable text"),("srt","Subtitles","Timestamped captions"),("md","Meeting notes","Notes and evidence")] { a { href: "/api/meetings/{id}/export?format={format}", download: true, Icon { name: "file", size: 16 } span { "{label}" small { "{hint}" } } span { class: "review-format", ".{format}" } } } p { "For a full backup including audio, use Storage in Settings." } }
                } } }
            }
            if !error.is_empty() { div { class: "review-notice review-notice-warning", role: "status", Icon { name: "help", size: 17 } span { "{error} Your saved material remains available." } } }
            if active { div { class: "review-notice", span { class: "review-recording-dot" } span { "This meeting is recording or processing. Your saved material remains available to review." } } }
            nav { class: "review-tabs", aria_label: "Meeting views", for (key,label,icon) in [("notes","Notes","file"),("transcript","Transcript","volume"),("moments","Saved moments","bookmark"),("details","Details","help")] {
                button { class: if tab()==key {"review-tab review-tab-active"} else {"review-tab"}, aria_current: if tab()==key {"page"} else {"false"}, onclick: move |_| tab.set(key.into()), Icon { name: icon, size: 16 } span { "{label}" } if key=="moments" && moment_count>0 {span { class: "review-tab-count", "{moment_count}" }} }
            } }
            div { class: "review-body",
                div { hidden: tab()!="notes", NotesPane { meeting, on_change, notify, tab } }
                div { hidden: tab()!="transcript", TranscriptPane { meeting, on_change, notify } }
                div { hidden: tab()!="moments", MomentsPane { meeting, on_change, notify, tab } }
                div { hidden: tab()!="details", DetailsPane { meeting, on_change, notify } }
            }
            if !list(&value,"tracks").is_empty() { AudioPlayer { meeting, on_change, notify } } else if demo { div { class: "review-example-footer", Icon { name: "help", size: 14 } "This example includes sample notes and a transcript. Record your own meeting to try audio playback." } }
            dialog { id: "review-delete-dialog", class: "review-dialog", aria_labelledby: "review-delete-title",
                div { class: "review-dialog-icon", Icon { name: "trash", size: 23 } } h2 { id: "review-delete-title", "Delete this meeting?" } p { "“{heading}” and all of its managed recordings, transcript versions, notes, and saved moments will be permanently deleted." } p { class: "review-muted", "This cannot be undone. Independent exports and backups will remain." }
                div { class: "review-dialog-actions", button { id: "review-keep-meeting", class: "button button-secondary", disabled: busy(), onclick: move |_| js("document.getElementById('review-delete-dialog').close()".into()), "Keep meeting" } button { class: "button review-delete-solid", disabled: busy(), onclick: move |_| {let path=format!("/meetings/{delete_id}");busy.set(true);spawn(async move {match api::delete(&path).await {Ok(_)=>{js("document.getElementById('review-delete-dialog')?.close()".into());notify.call("Meeting and its local files deleted.".into());on_back.call(());},Err(error)=>notify.call(error)}busy.set(false);});}, "Delete permanently" } }
            }
        }
    }
}

/// Refresh account readiness before presenting optional cloud generation controls.
async fn refresh_chatgpt(mut account: Signal<Value>, mut loading: Signal<bool>) {
    if loading() {
        return;
    }
    loading.set(true);
    account.set(match api::get("/chatgpt").await {
        Ok(value) => value,
        Err(error) => json!({"connected":false,"error":error}),
    });
    loading.set(false);
}
/// Label the provider that produced a saved notes version.
fn notes_source(notes: &Value) -> &'static str {
    if text(notes, "provider") == "chatgpt" {
        "ChatGPT · OpenAI"
    } else {
        "Local · Ollama"
    }
}
/// Describe actual known token usage without filling in unknown totals.
fn notes_usage(notes: &Value) -> String {
    let usage = &notes["usage"];
    let parts: Vec<String> = [
        ("inputTokens", "input"),
        ("outputTokens", "output"),
        ("cachedInputTokens", "cached input"),
    ]
    .iter()
    .filter_map(|(key, label)| usage[*key].as_u64().map(|count| format!("{count} {label}")))
    .collect();
    if parts.is_empty() {
        if text(notes, "provider") == "chatgpt" {
            "Token usage was not reported by ChatGPT.".into()
        } else {
            String::new()
        }
    } else {
        format!("Reported token usage: {}", parts.join(" · "))
    }
}

#[component]
/// Review and edit evidence-linked notes, with explicit consent for cloud generation.
fn NotesPane(
    meeting: Signal<Value>,
    on_change: EventHandler<Value>,
    notify: EventHandler<String>,
    mut tab: Signal<String>,
) -> Element {
    let value = meeting();
    let notes = current(&value, "notes", "activeNotesId");
    let transcript = current(&value, "transcripts", "activeTranscriptId");
    let mut busy = use_signal(|| false);
    let mut generating = use_signal(|| false);
    let mut draft = use_signal(|| Value::Null);
    let mut provider = use_signal(|| "ollama".to_string());
    let mut provider_touched = use_signal(|| false);
    let mut chatgpt_model = use_signal(String::new);
    let account = use_signal(|| Value::Null);
    let account_loading = use_signal(|| false);
    let demo = is_demo(&value);
    use_future(move || async move {
        if demo {
            return;
        }
        if let Ok(settings) = api::get("/settings").await {
            chatgpt_model.set(text(&settings, "chatgptModel"));
            if !provider_touched() && text(&settings, "notesProvider") == "chatgpt" {
                provider.set("chatgpt".into());
                refresh_chatgpt(account, account_loading).await;
            }
        }
    });
    let locked = demo || is_active(&value) || busy();
    let editing = !draft().is_null();
    let shown = if editing { draft() } else { notes.clone() };
    let model = text(&notes, "model");
    let stale = !notes.is_null()
        && !transcript.is_null()
        && notes["transcriptVersionId"] != transcript["id"];
    let cloud_selected = provider() == "chatgpt";
    let account_connected = account()["connected"].as_bool().unwrap_or(false);
    let account_busy = account()["busy"].as_bool().unwrap_or(false);
    let account_email = text(&account()["account"], "email");
    let account_error = text(&account(), "error");
    let source_label = notes_source(&notes);
    let usage_label = notes_usage(&notes);
    let mut request_generation = move |cloud_consent: bool| {
        if is_demo(&meeting())
            || is_active(&meeting())
            || busy()
            || current(&meeting(), "transcripts", "activeTranscriptId").is_null()
        {
            return;
        }
        let selected = provider();
        if selected == "chatgpt"
            && (!cloud_consent
                || !account()["connected"].as_bool().unwrap_or(false)
                || account()["busy"].as_bool().unwrap_or(false))
        {
            return;
        }
        busy.set(true);
        generating.set(true);
        js("document.getElementById('review-chatgpt-dialog')?.close()".into());
        let mut body = json!({"meetingId":text(&meeting(), "id"),"provider":selected,"cloudConsent":cloud_consent});
        if selected == "chatgpt" && !chatgpt_model().trim().is_empty() {
            body["model"] = json!(chatgpt_model().trim());
        }
        spawn(async move {
            save(
                "POST",
                "/notes".into(),
                body,
                meeting,
                on_change,
                notify,
                "Your notes are ready to review.",
            )
            .await;
            busy.set(false);
            generating.set(false);
        });
    };
    let generate = move |_| {
        if provider() == "chatgpt" {
            js("document.getElementById('review-chatgpt-dialog').showModal();document.getElementById('review-chatgpt-cancel').focus()".into());
            spawn(refresh_chatgpt(account, account_loading));
        } else {
            request_generation(false);
        }
    };
    rsx! {section { class: "review-notes", aria_label: "Meeting notes",
        if !demo && !editing {
            div { class: "review-notes-options",
                div { class: "review-notes-provider", label { r#for: "review-notes-provider", "Create notes with" } select { id: "review-notes-provider", class: "input", value: "{provider}", disabled: locked, onchange: move |event| { let selected=event.value();provider_touched.set(true);provider.set(selected.clone());if selected=="chatgpt" {spawn(refresh_chatgpt(account,account_loading));} }, option { value: "ollama", "Local · Ollama" } option { value: "chatgpt", "ChatGPT · OpenAI" } } }
                div { class: "review-notes-provider-info", if cloud_selected {
                    strong { "Optional cloud notes" } p { "Your transcript is shared with OpenAI only after you confirm. Audio stays on this computer." }
                    div { class: "review-provider-account", role: "status", if account_loading() { span { "Checking your ChatGPT connection…" } } else if account_connected { span { class: "review-provider-connected", Icon { name: "check", size: 13 } if account_email.is_empty() { "ChatGPT connected" } else { "{account_email}" } } if account_busy {span { "Another ChatGPT request is running." }} } else if !account_error.is_empty() {span {"Connection status unavailable."}button {class:"review-provider-link",onclick:move |_|{spawn(refresh_chatgpt(account,account_loading));},"Retry connection",Icon{name:"refresh",size:13}}} else { span { "ChatGPT is not connected." } button { class: "review-provider-link", onclick: move |_| js("window.dispatchEvent(new Event('echo-open-models'))".into()), "Connect in Models", Icon { name: "arrow", size: 13 } } } }
                    if !account_error.is_empty() { p { class: "review-provider-error", "{account_error}" } }
                } else { strong { "On your computer" } p { "Ollama keeps your transcript and generated notes local. Choose a model in Settings." } } }
            }
        }
        if notes.is_null() {
            div { class: "review-empty", span { class: "review-empty-icon", Icon { name: "sparkles", size: 27 } } span { class: "review-eyebrow", "MAKE SPACE FOR WHAT MATTERS" } h2 { "Your conversation, distilled." } p { if transcript.is_null() {"Once your transcript is ready, Echo can find the summary, decisions, and next steps."} else {"Turn the transcript into a clear summary, decisions, and next steps."} }
                if !transcript.is_null() {button { class: "button button-primary", disabled: locked, onclick: generate, Icon { name: "sparkles", size: 16 } if busy() {"Writing your notes…"} else {"Generate meeting notes"} }} else {button { class: "button button-primary", disabled: locked||list(&value,"tracks").is_empty(), onclick: move |_| audio_transcribe(&meeting()), Icon { name: "volume", size: 16 } "Create transcript" }}
                span { class: "review-empty-footnote", Icon { name: "shield", size: 13 } if transcript.is_null() {"Speech recognition runs locally in your browser."} else if cloud_selected {"Uses your ChatGPT account through Codex, subject to your plan’s usage limits."} else {"Requires a running local Ollama model. Configure it in Settings."} }
            }
        } else {
            div { class: "review-section-heading", div { span { class: "review-eyebrow", "THE BIG PICTURE" } h2 { "Less replaying. More clarity." } p { "The important parts of your conversation, with the words behind them." } }
                div { class: "review-section-actions", if editing {
                    button { class: "button button-ghost", onclick: move |_| draft.set(Value::Null), "Cancel" }
                    button { class: "button button-primary", disabled: busy(), onclick: move |_| {let mut body=draft();if ["summary","decisions","actions"].iter().any(|key|list(&body,key).iter().any(|item|text(item,"text").trim().is_empty())){notify.call("Each note needs some text before saving.".into());return;}body["edited"]=json!(true);let path=format!("/meetings/{}/notes",text(&meeting(),"id"));busy.set(true);spawn(async move {if save("POST",path,body,meeting,on_change,notify,"Notes saved as a new version.").await{draft.set(Value::Null);}busy.set(false);});}, Icon { name: "check", size: 14 } "Save version" }
                } else {
                    button { class: "button button-secondary", disabled: locked, onclick: move |_| draft.set(current(&meeting(),"notes","activeNotesId")), Icon { name: "edit", size: 14 } "Edit notes" }
                    if !demo {button { class: "icon-button", aria_label: "Generate a new notes version", title: "Generate a new draft, preserving this version", disabled: locked, onclick: generate, Icon { name: "sparkles", size: 16 } }}
                } }
            }
            if generating() {div { class: "review-notice", role: "status", span { class: "review-spin", Icon { name: "refresh", size: 16 } } span { if cloud_selected {"Writing a fresh draft with ChatGPT… Your existing notes stay available."} else {"Writing a fresh draft locally… Your existing notes stay available."} } }}
            if stale {div { class: "review-notice review-notice-warning", Icon { name: "refresh", size: 17 } span { "These notes use an earlier transcript. Review the source version in Details, or generate a new draft." } }}
            div { class: "review-draft-label", Icon { name: "sparkles", size: 13 } span { if notes["edited"].as_bool().unwrap_or(false) {"Edited notes"} else {"AI draft · review for accuracy"} } span { class: "review-draft-divider", "·" } if !demo {span { "{source_label}" } span { class: "review-draft-divider", "·" }} span { title: "{model}", "{model}" } }
            if !usage_label.is_empty() {p { class: "review-notes-usage", "{usage_label}" }}
            div { class: "review-notes-grid", for (group,title,icon,helper) in [("summary","Summary","file","A little context goes a long way."),("decisions","Key decisions","check","What everyone aligned on."),("actions","Action items","check","The next steps, all in one place.")] {
                section { class: "review-note-card review-note-{group}", header { span { class: "review-section-icon review-icon-{group}", Icon { name: icon, size: 19 } } div { h3 { "{title}" } p { "{helper}" } } span { class: "review-note-count", "{list(&shown,group).len()}" } }
                    div { class: "review-note-items", if list(&shown,group).is_empty() {p { class: "review-muted", "No {title} recorded." }}
                        for (index,item) in list(&shown,group).into_iter().enumerate() {
                            {let done=item["done"].as_bool().unwrap_or(false);let note_text=text(&item,"text");let owner=text(&item,"owner");let due=text(&item,"dueDate");let source=meeting()["transcripts"].as_array().and_then(|items|items.iter().find(|v|v["id"]==shown["transcriptVersionId"])).cloned().unwrap_or(Value::Null);rsx!{
                                div { class: if done {"review-note-item review-note-done"} else {"review-note-item"},
                                    if group=="actions" {button { class: if done {"review-check review-checked"} else {"review-check"}, aria_label: "Toggle action completion", aria_pressed: done, disabled: locked, onclick: move |_| {if editing {let mut next=draft();next[group][index]["done"]=json!(!done);draft.set(next);}else{let mut body=current(&meeting(),"notes","activeNotesId");body[group][index]["done"]=json!(!done);body["edited"]=json!(true);let path=format!("/meetings/{}/notes",text(&meeting(),"id"));busy.set(true);spawn(async move {save("POST",path,body,meeting,on_change,notify,"Action item updated.").await;busy.set(false);});}}, if done {Icon { name: "check", size: 13 }} }}
                                    if group=="decisions" {span { class: "review-decision-index", "{index+1:02}" }}
                                    div { class: "review-note-content", if editing {textarea { class: "input review-note-textarea", aria_label: "Edit {title} {index+1}", rows: "3", value: "{note_text}", oninput: move |event|{let mut next=draft();next[group][index]["text"]=json!(event.value());draft.set(next);} }
                                        if group=="actions" {div { class: "review-action-edit", label { "Owner" input { class: "input", value: "{owner}", placeholder: "Unassigned", oninput: move |event| {let mut next=draft();next[group][index]["owner"]=json!(event.value());draft.set(next);} } } label { "Due date" input { class: "input", r#type: "date", value: "{due}", oninput: move |event|{let mut next=draft();next[group][index]["dueDate"]=json!(event.value());draft.set(next);} } } } }
                                    } else {p { "{note_text}" } if group=="actions"&&(!owner.is_empty()||!due.is_empty()) {div { class: "review-action-meta", if !owner.is_empty() {span {span { class: "review-avatar", "{owner.chars().next().unwrap_or(' ')}" } "{owner}" }} if !due.is_empty() {span {Icon { name: "clock", size: 12 } "{due}" }} } }}
                                    div { class: "review-evidence", for evidence_id in list(&item,"passageIds") { {let pid=evidence_id.as_str().unwrap_or_default().to_string();let passage=list(&source,"passages").into_iter().find(|p|text(p,"id")==pid).unwrap_or(Value::Null);let timestamp=num(&passage,"start");let excerpt=text(&passage,"text");let valid=list(&transcript,"passages").iter().any(|p|text(p,"id")==pid);rsx!{button { class: "review-evidence-link", title: "{excerpt}", disabled: !valid, onclick: move |_| {tab.set("transcript".into());seek(timestamp,Some(pid.clone()));}, Icon { name: "volume", size: 12 } "{api::time(timestamp)}" }}} } if list(&item,"passageIds").is_empty() {span { class: "review-no-evidence", "No linked evidence · review this note" }} }
                                    }
                                }
                            }}
                        }
                    }
                }
            } }
            div { class: "review-notes-footer", Icon { name: "shield", size: 14 } span {if demo {"Example content. Your real meetings stay on your device."} else if text(&notes,"provider")=="chatgpt" {"Generated with ChatGPT. Saved locally, with links to your transcript for review."} else {"Generated locally. Every linked timestamp takes you back to the conversation."}} }
        }
        dialog { id: "review-chatgpt-dialog", class: "review-dialog review-cloud-dialog", aria_labelledby: "review-chatgpt-title", aria_describedby: "review-chatgpt-description",
            div { class: "review-dialog-icon", Icon { name: "sparkles", size: 23 } }
            span { class: "review-eyebrow", "OPTIONAL CLOUD PROCESSING" }
            h2 { id: "review-chatgpt-title", "Create notes with ChatGPT?" }
            p { id: "review-chatgpt-description", "Echo will send this meeting’s transcript, including speaker labels and spoken text, to OpenAI through your connected ChatGPT account." }
            div { class: "review-cloud-facts", p { Icon { name: "shield", size: 16 } span { "Your original audio is not sent. The resulting notes are saved in your local library." } } p { Icon { name: "clock", size: 16 } span { "Uses Codex usage included with your ChatGPT plan, subject to your plan’s limits. Availability and limits depend on your account." } } }
            div { class: "review-cloud-status", role: "status", if account_loading() {"Checking your ChatGPT connection…"} else if account_connected {Icon { name: "check", size: 14 } if account_email.is_empty() {"ChatGPT connected"} else {"Connected as {account_email}"} } else if !account_error.is_empty() {"Connection status unavailable."} else {"Connect your ChatGPT account in Models to continue."} }
            if account_busy {p { class: "review-provider-error", "Another ChatGPT request is running. Wait for it to finish, then try again." }}
            if !account_error.is_empty() {p { class: "review-provider-error", "{account_error}" }}
            div { class: "review-dialog-actions", button { id: "review-chatgpt-cancel", class: "button button-secondary", onclick: move |_| js("document.getElementById('review-chatgpt-dialog').close()".into()), "Cancel" }
                if !account_loading() && !account_connected && !account_error.is_empty() {button {class:"button button-primary",onclick:move |_|{spawn(refresh_chatgpt(account,account_loading));},"Retry connection"}} else if !account_loading() && !account_connected {button { class: "button button-primary", onclick: move |_| js("document.getElementById('review-chatgpt-dialog').close();window.dispatchEvent(new Event('echo-open-models'))".into()), "Connect in Models" }} else {button { class: "button button-primary", disabled: locked||account_loading()||!account_connected||account_busy, onclick: move |_| request_generation(true), Icon { name: "sparkles", size: 15 } "Generate with ChatGPT" }}
            }
        }
    }}
}

#[component]
/// Review transcript history, speaker labels, and timestamped passages.
fn TranscriptPane(
    meeting: Signal<Value>,
    on_change: EventHandler<Value>,
    notify: EventHandler<String>,
) -> Element {
    let value = meeting();
    let transcript = current(&value, "transcripts", "activeTranscriptId");
    let mut query = use_signal(String::new);
    let mut only_highlights = use_signal(|| false);
    let mut limit = use_signal(|| 60usize);
    let mut editing = use_signal(String::new);
    let mut correction = use_signal(String::new);
    let mut speaker = use_signal(String::new);
    let mut speaker_name = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let locked = is_demo(&value) || is_active(&value) || busy();
    let all = list(&transcript, "passages");
    let total = all.len();
    let mut speaker_labels = Vec::new();
    for passage in &all {
        let label = text(passage, "speaker");
        if !speaker_labels.contains(&label) {
            speaker_labels.push(label);
        }
    }
    let moments = list(&value, "moments");
    let passages: Vec<Value> = all
        .into_iter()
        .filter(|p| {
            let highlighted = moments
                .iter()
                .any(|m| m["passageId"] == p["id"] && text(m, "kind") == "highlight");
            (!only_highlights() || highlighted)
                && (query().trim().is_empty()
                    || format!("{} {}", text(p, "speaker"), text(p, "text"))
                        .to_lowercase()
                        .contains(&query().trim().to_lowercase()))
        })
        .collect();
    let shown = passages.iter().take(limit()).cloned().collect::<Vec<_>>();
    rsx! {section { class: "review-transcript", aria_label: "Transcript",
        div { class: "review-section-heading", div { span { class: "review-eyebrow", "EVERY WORD, IN CONTEXT" } h2 { "The conversation" } p { if transcript.is_null() {"Your original words, ready to read and revisit."} else {"{total} passages · Click a timestamp to revisit a moment."} } } if !transcript.is_null() {button { class: "button button-secondary", disabled: locked||list(&value,"tracks").is_empty(), onclick: move |_| audio_transcribe(&meeting()), Icon { name: "refresh", size: 14 } "Regenerate" }} }
        if transcript.is_null() {div { class: "review-empty", span { class: "review-empty-icon", Icon { name: "volume", size: 27 } } h2 { "Ready when you are." } p { if is_active(&value) {"Your audio is being saved. Create the transcript after the meeting ends."} else {"Turn your recording into a searchable transcript with a local speech model. The audio stays on your device."} } button { class: "button button-primary", disabled: locked||list(&value,"tracks").is_empty(), onclick: move |_| audio_transcribe(&meeting()), Icon { name: "volume", size: 16 } "Create transcript" } }} else {
            div { class: "review-transcript-toolbar", label { class: "review-search", Icon { name: "search", size: 16 } input { id: "review-transcript-search", placeholder: "Find in this conversation…", aria_label: "Search transcript", value: "{query}", oninput: move |event|{query.set(event.value());limit.set(60);} } if !query().is_empty() {button { class: "icon-button", aria_label: "Clear transcript search", onclick: move |_|query.set(String::new()), Icon { name: "close", size: 13 } }} }
                button { id: "review-highlight-filter", class: if only_highlights(){"button review-filter review-filter-active"}else{"button button-secondary review-filter"}, aria_pressed: only_highlights(), onclick: move |_|only_highlights.toggle(), Icon { name: "bookmark", size: 14 } "Highlights" }
                if !list(&value,"tracks").is_empty() { button { class: "button button-ghost review-follow", onclick: move |_|js("window.echoReviewFollow=true;document.querySelector('.review-passage-playing')?.scrollIntoView({behavior:'smooth',block:'center'})".into()), Icon { name: "volume", size: 14 } "Follow playback" } }
            }
            if only_highlights() {p { class: "review-filter-hint", "Showing highlighted passages. Playback still includes the full recording." }}
            div { class: "review-passages", onwheel: move |_| js("window.echoReviewFollow=false".into()), ontouchmove: move |_| js("window.echoReviewFollow=false".into()), onmouseup: move |_|js("if(window.getSelection()?.toString())window.echoReviewFollow=false".into()),
                for (index,passage) in shown.into_iter().enumerate() {
                    {let pid=text(&passage,"id");let passage_id=pid.clone();let edit_id=pid.clone();let highlight_id=pid.clone();let passage_text=text(&passage,"text");let copy_text=passage_text.clone();let edit_text=passage_text.clone();let speaker_label=text(&passage,"speaker");let speaker_color=speaker_labels.iter().position(|label|label==&speaker_label).unwrap_or(0)%4;let rename_label=speaker_label.clone();let start=num(&passage,"start");let end=num(&passage,"end");let highlighted=moments.iter().any(|m|m["passageId"]==passage["id"]&&text(m,"kind")=="highlight");let highlight_text=passage_text.clone();rsx!{
                        div { id: "passage-{pid}", "data-start": "{start}", "data-end": "{end}", tabindex: "-1", class: if highlighted {"review-passage review-passage-highlighted"} else {"review-passage"},
                            div { class: "review-passage-gutter", button { class: "review-timestamp", aria_label: "Seek to {api::time(start)}", onclick: move |_|seek(start,None), "{api::time(start)}" } span { class: "review-speaker-avatar review-speaker-color-{speaker_color}", "{speaker_label.chars().next().unwrap_or('S')}" } }
                            div { class: "review-passage-main", div { class: "review-passage-label", button { class: "review-speaker", disabled: locked, title: "Rename this speaker throughout the transcript", onclick: move |_|{speaker.set(rename_label.clone());speaker_name.set(rename_label.clone());js("const dialog=document.getElementById('review-speaker-dialog');dialog.onclose=()=>document.getElementById('review-speaker-sample')?.pause();dialog.showModal();document.getElementById('review-speaker-name').focus()".into());}, "{speaker_label}" if !is_demo(&value) {Icon { name: "edit", size: 11 }} } if passage["uncertain"].as_bool().unwrap_or(false) {span { class: "review-uncertain", "Needs review" }} }
                                if editing()==passage_id {div { class: "review-passage-edit", textarea { class: "input", aria_label: "Edit passage text", rows: "4", autofocus: true, value: "{correction}", oninput: move |event|correction.set(event.value()) } div { button { class: "button button-ghost", onclick: move |_|editing.set(String::new()), "Cancel" } button { class: "button button-primary", disabled: busy()||correction().trim().is_empty(), onclick: move |_| {let mut body=current(&meeting(),"transcripts","activeTranscriptId");if let Some(items)=body["passages"].as_array_mut(){for p in items.iter_mut(){if text(p,"id")==editing(){p["text"]=json!(correction().trim());}}}body["label"]=json!("Edited transcript");let path=format!("/meetings/{}/transcripts",text(&meeting(),"id"));busy.set(true);spawn(async move {if save("POST",path,body,meeting,on_change,notify,"Transcript saved as a new version.").await{editing.set(String::new());}busy.set(false);});}, "Save correction" } } }} else {p { "{passage_text}" }}
                                div { class: "review-passage-actions", button { class: "review-text-action", onclick: move |_| {let script=format!("return navigator.clipboard.writeText({}).then(()=>true).catch(()=>false)",json!(copy_text));spawn(async move {match document::eval(&script).await {Ok(v) if v==json!(true)=>notify.call("Copied to clipboard.".into()),_=>notify.call("Select the text and use your browser’s Copy command.".into())}});}, Icon { name: "file", size: 12 } "Copy" } button { class: "review-text-action", disabled: locked, onclick: move |_|{editing.set(edit_id.clone());correction.set(edit_text.clone());}, Icon { name: "edit", size: 12 } "Edit" } button { class: "review-text-action", disabled: locked||highlighted, onclick: move |_|{let path=format!("/meetings/{}/moments",text(&meeting(),"id"));let body=json!({"time":start,"kind":"highlight","passageId":highlight_id,"label":highlight_text.chars().take(500).collect::<String>()});busy.set(true);spawn(async move{save("POST",path,body,meeting,on_change,notify,"Passage saved to your moments.").await;busy.set(false);});}, Icon { name: "bookmark", size: 12 } if highlighted {"Highlighted"} else {"Highlight"} } }
                            } span { class: "review-passage-number", "{index+1:02}" }
                        }
                    }}
                }
                if passages.is_empty() {div { class: "review-small-empty", Icon { name: "search", size: 23 } h3 { "No matching passages" } p { "Try a different phrase, or save a passage using Highlight." } }}
            }
            if passages.len()>limit() {button { id: "review-show-more", class: "button button-secondary review-load-more", onclick: move |_|limit+=60, "Show more passages" Icon { name: "chevron", size: 15 } }}
            div { class: "review-transcript-footer", Icon { name: "help", size: 13 } "Timestamps mark passage boundaries. Speaker labels are editable attribution aids, not verified identities." }
        }
        dialog { id: "review-speaker-dialog", class: "review-dialog", aria_labelledby: "review-speaker-title", h2 { id: "review-speaker-title", "Who was speaking?" } p { "Rename “{speaker}” throughout this transcript. The original version stays in your history." }
            SpeakerSamples { key: speaker(), meeting, speaker: speaker(), notify }
            form { onsubmit: move |event|{event.prevent_default();if speaker_name().trim().is_empty(){return;}let mut body=current(&meeting(),"transcripts","activeTranscriptId");if let Some(items)=body["passages"].as_array_mut(){for p in items.iter_mut(){if text(p,"speaker")==speaker(){p["speaker"]=json!(speaker_name().trim());}}}body["label"]=json!("Speaker labels edited");let path=format!("/meetings/{}/transcripts",text(&meeting(),"id"));busy.set(true);spawn(async move{if save("POST",path,body,meeting,on_change,notify,"Speaker updated throughout this transcript.").await{js("document.getElementById('review-speaker-dialog').close()".into());}busy.set(false);});},
                label { class: "review-form-label", "Speaker name" input { id: "review-speaker-name", class: "input", maxlength: "100", value: "{speaker_name}", oninput: move |event|speaker_name.set(event.value()) } }
                div { class: "review-dialog-actions", button { r#type: "button", class: "button button-secondary", onclick: move |_|js("document.getElementById('review-speaker-dialog').close()".into()), "Cancel" } button { class: "button button-primary", disabled: busy()||speaker_name().trim().is_empty(), "Save speaker" } }
            }
        }
    }}
}

#[component]
/// Preview passage audio when assigning speaker labels.
fn SpeakerSamples(
    meeting: Signal<Value>,
    speaker: String,
    notify: EventHandler<String>,
) -> Element {
    let value = meeting();
    let samples: Vec<Value> = list(
        &current(&value, "transcripts", "activeTranscriptId"),
        "passages",
    )
    .into_iter()
    .filter(|passage| text(passage, "speaker") == speaker)
    .collect();
    let tracks = list(&value, "tracks");
    let mut index = use_signal(|| 0usize);
    let sample = samples
        .get(index() % samples.len().max(1))
        .cloned()
        .unwrap_or(Value::Null);
    let start = num(&sample, "start");
    let end = (start + 8.).min(num(&sample, "end").max(start + 1.));
    let excerpt = text(&sample, "text").chars().take(140).collect::<String>();
    let source = tracks
        .first()
        .map(|track| text(track, "url"))
        .unwrap_or_default();
    let unavailable = source.is_empty() || samples.is_empty();
    rsx! {
        div { class: "review-speaker-samples",
            if !source.is_empty() { audio { id: "review-speaker-sample", src: "{source}", preload: "metadata" } }
            div { class: "review-speaker-sample-heading", span { "LISTEN TO THE ORIGINAL" } span { if !samples.is_empty() { "{index()%samples.len()+1} / {samples.len()}" } } }
            if unavailable { p { "A speaker sample needs the original audio for this meeting." } } else { p { "“{excerpt}”" } }
            div { class: "review-speaker-sample-actions",
                button { r#type: "button", class: "button button-secondary", aria_label: "Play speaker sample", disabled: unavailable, onclick: move |_| {
                    let script = format!("document.getElementById('review-audio')?.pause();const a=document.getElementById('review-speaker-sample');try{{a.currentTime={start};a.ontimeupdate=()=>{{if(a.currentTime>={end})a.pause();}};await a.play();return true;}}catch(error){{return false;}}");
                    spawn(async move { if document::eval(&script).await.ok() != Some(json!(true)) { notify.call("The sample could not be played. Try the original recording or download it from Details.".into()); } });
                }, Icon { name: "play", size: 13 } "Listen · {api::time(start)}" }
                button { r#type: "button", class: "button button-ghost", aria_label: "Next speaker sample", disabled: unavailable || samples.len() < 2, onclick: move |_| { js("document.getElementById('review-speaker-sample')?.pause()".into()); index += 1; }, "Next sample" Icon { name: "arrow", size: 13 } }
            }
            small { "Samples come from the shared recording. Labels are not verified identities." }
        }
    }
}

#[component]
/// Review and edit timestamped bookmarks linked to playback.
fn MomentsPane(
    meeting: Signal<Value>,
    on_change: EventHandler<Value>,
    notify: EventHandler<String>,
    mut tab: Signal<String>,
) -> Element {
    let value = meeting();
    let mut moments = list(&value, "moments");
    moments.sort_by(|a, b| num(a, "time").total_cmp(&num(b, "time")));
    let mut busy = use_signal(|| false);
    let mut editing = use_signal(String::new);
    let mut label = use_signal(String::new);
    let locked = is_demo(&value) || is_active(&value) || busy();
    rsx! {section { class: "review-moments", aria_label: "Saved moments", div { class: "review-section-heading", div { span { class: "review-eyebrow", "WORTH COMING BACK TO" } h2 { "Your saved moments" } p { "A few words, a useful idea, a moment you want to remember." } } button { class: "button button-secondary", disabled: locked||list(&value,"tracks").is_empty(), onclick: move |_|{busy.set(true);spawn(async move{bookmark(meeting,on_change,notify).await;busy.set(false);});}, Icon { name: "plus", size: 15 } "Bookmark current time" } }
        if moments.is_empty() {div { class: "review-empty", span { class: "review-empty-icon", Icon { name: "bookmark", size: 27 } } h2 { "Keep the moments that matter." } p { "Highlight a passage in the transcript or bookmark a point in your recording. Everything you save will be here." } button { class: "button button-secondary", onclick: move |_|tab.set("transcript".into()), "Explore transcript" Icon { name: "arrow", size: 14 } } }} else {div { class: "review-moment-list", for moment in moments { {let mid=text(&moment,"id");let edit_id=mid.clone();let remove_id=mid.clone();let moment_label=text(&moment,"label");let edit_label=moment_label.clone();let kind=text(&moment,"kind");let start=num(&moment,"time");let passage=text(&moment,"passageId");rsx!{
            div { class: "review-moment", span { class: "review-moment-icon review-moment-{kind}", Icon { name: "bookmark", size: 17 } } div { class: "review-moment-content", div { class: "review-moment-label", span { "{kind.to_uppercase()}" } button { class: "review-timestamp", onclick: move |_|{if !passage.is_empty(){tab.set("transcript".into());seek(start,Some(passage.clone()));}else{seek(start,None)}}, "{api::time(start)}" Icon { name: "arrow", size: 11 } } }
                if editing()==mid {form { onsubmit: move |event|{event.prevent_default();if label().trim().is_empty(){return;}let path=format!("/meetings/{}/moments/{}",text(&meeting(),"id"),editing());let body=json!({"label":label().trim()});busy.set(true);spawn(async move{if save("PATCH",path,body,meeting,on_change,notify,"Saved moment updated.").await{editing.set(String::new());}busy.set(false);});}, input { class: "input", aria_label: "Saved moment label", maxlength: "500", autofocus: true, value: "{label}", oninput: move |event|label.set(event.value()) } button { class: "icon-button", aria_label: "Save moment label", disabled: busy()||label().trim().is_empty(), Icon { name: "check", size: 16 } } button { r#type: "button", class: "icon-button", aria_label: "Cancel editing moment", onclick: move |_|editing.set(String::new()), Icon { name: "close", size: 16 } } }} else {p { "{moment_label}" }}
            } div { class: "review-moment-actions", button { class: "icon-button", aria_label: "Edit saved moment label", disabled: locked, onclick: move |_|{editing.set(edit_id.clone());label.set(edit_label.clone());}, Icon { name: "edit", size: 15 } } button { class: "icon-button", aria_label: "Remove saved moment", disabled: locked, onclick: move |_|{let path=format!("/meetings/{}/moments/{remove_id}",text(&meeting(),"id"));busy.set(true);spawn(async move {save("DELETE",path,Value::Null,meeting,on_change,notify,"Saved moment removed.").await;busy.set(false);});}, Icon { name: "close", size: 16 } } } }
        }} } }}
    }}
}

#[component]
/// Expose meeting metadata, processing choices, exports, and safe deletion.
fn DetailsPane(
    meeting: Signal<Value>,
    on_change: EventHandler<Value>,
    notify: EventHandler<String>,
) -> Element {
    let value = meeting();
    let mut busy = use_signal(|| false);
    let mut speech = use_signal(|| text(&value, "speechModel"));
    let mut notes = use_signal(|| text(&value, "notesModel"));
    let locked = is_demo(&value) || is_active(&value) || busy();
    let tracks = list(&value, "tracks");
    let bytes = tracks.iter().map(|t| num(t, "bytes")).sum::<f64>();
    let has_consent = value["consent"].as_bool().unwrap_or(false);
    let date = readable_date(&text(&value, "createdAt"));
    let duration = api::time(num(&value, "duration"));
    let mode = text(&value, "mode");
    let gaps = list(&value, "gaps");
    rsx! {section { class: "review-details", aria_label: "Meeting details", div { class: "review-section-heading", div { span { class: "review-eyebrow", "THE COMPLETE RECORD" } h2 { "Behind this meeting" } p { "Original files, processing choices, and a history you can trust." } } }
        div { class: "review-details-grid",
            section { class: "review-detail-card", h3 {Icon { name: "help", size: 17 } "Recording information"} dl { div {dt {"Created"} dd {"{date}"}} div {dt {"Duration"} dd {"{duration}"}} div {dt {"Recording mode"} dd {"{mode}"}} div {dt {"Participant consent"} dd {if has_consent {"Acknowledged"} else {"Not recorded"}}} div {dt {"Audio stored"} dd {"{api::bytes(bytes)}"}} div {dt {"Live transcript"} dd {"Unavailable in this version"}} } }
            section { class: "review-detail-card", h3 {Icon { name: "volume", size: 17 } "Original audio"} if tracks.is_empty() {p { class: "review-muted", "No original audio is available for this meeting." }} else {div { class: "review-track-list", for track in tracks { {let label=text(&track,"label");let size=api::bytes(num(&track,"bytes"));let mime=text(&track,"mimeType");let url=text(&track,"url");rsx!{div { span { class: "review-file-icon", Icon { name: "volume", size: 18 } } span {strong {"{label}"} small {"{size} · {mime}"}} if !is_demo(&value) {a { class: "icon-button", href: "{url}", download: true, aria_label: "Download {label}", Icon { name: "download", size: 16 } }} }}} } }} p { class: "review-detail-help", "Tracks preserve the captured sources. Speaker labels do not represent separate voice recordings." } }
            section { class: "review-detail-card review-processing-card", h3 {Icon { name: "sparkles", size: 17 } "Processing choices"} form { onsubmit: move |event|{event.prevent_default();let path=format!("/meetings/{}",text(&meeting(),"id"));let body=json!({"speechModel":speech(),"notesModel":notes().trim()});busy.set(true);spawn(async move {save("PATCH",path,body,meeting,on_change,notify,"Processing choices saved for future runs.").await;busy.set(false);});},
                label {"Speech recognition" select { class: "input", value: "{speech}", disabled: locked, onchange: move |event|speech.set(event.value()), option {value:"onnx-community/whisper-tiny.en",selected:speech()=="onnx-community/whisper-tiny.en","Whisper Tiny · fastest"} option {value:"onnx-community/whisper-base",selected:speech()=="onnx-community/whisper-base","Whisper Base · multilingual"} }}
                label {"Local notes model" input { class: "input", value: "{notes}", maxlength: "100", disabled: locked, placeholder: "qwen2.5:3b", oninput: move |event|notes.set(event.value()) }} button { class: "button button-secondary", disabled: locked||notes().trim().is_empty()||(speech()==text(&value,"speechModel")&&notes()==text(&value,"notesModel")), "Save choices" }
            } p { class: "review-detail-help", "Applies to the next run. Existing versions retain the model that produced them. Downloads are managed in Models." } }
            for (collection,active_id,title,icon) in [("transcripts","activeTranscriptId","Transcript history","refresh"),("notes","activeNotesId","Notes history","file")] {
                section { class: "review-detail-card", h3 {Icon { name: icon, size: 17 } "{title}" span { class: "review-note-count", "{list(&value,collection).len()}" }}
                    if list(&value,collection).is_empty() {p { class: "review-muted", "Completed results and your edits are kept as separate versions here." }} else { div { class: "review-version-list", for (index,version) in list(&value,collection).into_iter().enumerate().rev() { {let vid=text(&version,"id");let label=if text(&version,"label").is_empty(){format!("{} {}",if collection=="notes"{"Notes"}else{"Transcript"},index+1)}else{text(&version,"label")};let date=readable_date(&text(&version,"createdAt"));let model=if collection=="notes"&&!is_demo(&value){format!("{} · {}",notes_source(&version),text(&version,"model"))}else{text(&version,"model")};let usage=if collection=="notes"{notes_usage(&version)}else{String::new()};let is_current=value[active_id]==version["id"];rsx!{div { class: "review-version", span { class: "review-version-dot" } div { strong {"{label}"} small {"{date}"} span { class: "review-version-model", "{model}" } if !usage.is_empty(){small {"{usage}"}} if collection=="transcripts" {small {{format!("{} vocabulary entries used",list(&version,"vocabulary").len())}}} else {small {if version["transcriptVersionId"]==value["activeTranscriptId"] {"Uses active transcript"} else {"Uses an earlier transcript"}}} } if is_current {span { class: "review-current-version", "Active" }} else {button { class: "button button-ghost", disabled: locked, onclick: move |_| {js("document.getElementById('review-audio')?.pause()".into());let path=format!("/meetings/{}",text(&meeting(),"id"));let body=json!({active_id:vid});busy.set(true);spawn(async move{save("PATCH",path,body,meeting,on_change,notify,"Version activated.").await;busy.set(false);});}, "Restore" }} }}} } } }
                }
            }
            section { class: "review-detail-card", h3 {Icon { name: "shield", size: 17 } "Recording integrity"} if gaps.is_empty() {p { class: "review-muted", "No recording interruptions were reported." }} else {ul { class: "review-gap-list", for gap in gaps { {let start=num(&gap,"start");let end=num(&gap,"end");let reason=text(&gap,"reason");rsx!{li {button { class: "review-timestamp", onclick: move |_|seek(start,None), "{api::time(start)}–{api::time(end)}"} span {"{reason}"}}}} } }} p { class: "review-detail-help", "Pauses and disconnected sources can leave gaps. Echo never invents missing audio or text. Automatic speaker grouping and audio redaction are not available in this version." } }
        }
        div { class: "review-danger-zone", div {h3 {"Delete this meeting"} p {"Removes managed audio, transcripts, notes, and saved moments. Independent exports and backups remain."}} button {id:"review-delete-trigger",class:"button review-delete-button",disabled:locked,onclick:move |_|js("document.getElementById('review-delete-dialog').showModal();document.getElementById('review-keep-meeting').focus()".into()),Icon { name: "trash", size: 15 } "Delete meeting"} }
    }}
}

/// Create a bookmark at the current playback position and update meeting state.
async fn bookmark(
    meeting: Signal<Value>,
    on_change: EventHandler<Value>,
    notify: EventHandler<String>,
) {
    let timestamp =
        document::eval("return document.getElementById('review-audio')?.currentTime || 0")
            .await
            .ok()
            .and_then(|v| v.as_f64())
            .unwrap_or(0.);
    let path = format!("/meetings/{}/moments", text(&meeting(), "id"));
    save("POST",path,json!({"kind":"bookmark","time":timestamp,"label":format!("Bookmark at {}",api::time(timestamp))}),meeting,on_change,notify,"Bookmark saved.").await;
}

#[component]
/// Coordinate track selection, playback position, speed, and bookmark controls.
fn AudioPlayer(
    meeting: Signal<Value>,
    on_change: EventHandler<Value>,
    notify: EventHandler<String>,
) -> Element {
    let value = meeting();
    let tracks = list(&value, "tracks");
    let mut track_id = use_signal(|| tracks.first().map(|t| text(t, "id")).unwrap_or_default());
    let mut speed = use_signal(|| "1".to_string());
    let mut failed = use_signal(|| false);
    let mut busy = use_signal(|| false);
    let track = tracks
        .iter()
        .find(|t| text(t, "id") == track_id())
        .or(tracks.first())
        .cloned()
        .unwrap_or(Value::Null);
    let url = text(&track, "url");
    let label = text(&track, "label");
    let locked = is_demo(&value) || is_active(&value) || busy();
    rsx! { footer { class: "review-player review-native-player",
        div { class: "review-player-top", div { class: "review-player-source", span { class: "review-player-icon", Icon { name: "volume", size: 16 } } div { strong { "Original recording" } if tracks.len()>1 {select {aria_label:"Audio track",value:"{track_id}",onchange:move |event|{track_id.set(event.value());failed.set(false);},for item in tracks {option {value:text(&item,"id"),selected:track_id()==text(&item,"id"),{text(&item,"label")}}} }} else {small {"{label}"}} } }
            div { class: "review-player-controls", button {class:"icon-button review-jump",aria_label:"Back five seconds",disabled:failed(),onclick:move |_|js("const a=document.getElementById('review-audio');if(a)a.currentTime=Math.max(0,a.currentTime-5)".into()),Icon {name:"refresh",size:20} span {"5"}} button {class:"icon-button review-jump",aria_label:"Forward five seconds",disabled:failed(),onclick:move |_|js("const a=document.getElementById('review-audio');if(a)a.currentTime=Math.min(a.duration||0,a.currentTime+5)".into()),Icon {name:"refresh",size:20} span {"5"}} }
            div { class: "review-player-right", label {span {class:"review-visually-hidden","Playback speed"} select {aria_label:"Playback speed",value:"{speed}",onchange:move |event|{let next=event.value();if let Ok(rate)=next.parse::<f64>(){js(format!("const a=document.getElementById('review-audio');if(a)a.playbackRate={rate}"));}speed.set(next);},for rate in ["0.75","1","1.25","1.5","2"] {option {value:rate,selected:speed()==rate,"{rate}×"}} }} button {class:"icon-button",aria_label:"Bookmark current playback time",disabled:locked,onclick:move |_|{busy.set(true);spawn(async move{bookmark(meeting,on_change,notify).await;busy.set(false);});},Icon {name:"bookmark",size:17}} }
        }
        audio {id:"review-audio",src:"{url}",preload:"metadata",controls:true,onerror:move |_|failed.set(true),onloadedmetadata:move |_|{js(format!("const a=document.getElementById('review-audio');if(a){{a.playbackRate={};a.ontimeupdate=()=>{{document.querySelectorAll('.review-passage').forEach(p=>{{const active=a.currentTime>=Number(p.dataset.start)&&a.currentTime<Number(p.dataset.end);const changed=active&&!p.classList.contains('review-passage-playing');p.classList.toggle('review-passage-playing',active);if(changed&&window.echoReviewFollow)p.scrollIntoView({{behavior:'smooth',block:'center'}});}});}};}}",speed()));}
        }
        if failed() {p {class:"review-player-error",role:"status","This audio could not be played. " a {href:"{url}",download:true,"Download the original"} " to try another player."}}
    }}
}
