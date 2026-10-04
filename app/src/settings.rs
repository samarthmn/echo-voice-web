use crate::{
    api::{bytes, delete, get, patch, post, text},
    Icon,
};
use dioxus::prelude::*;
use serde_json::{json, Value};

/// Read one user-selected JSON file and distinguish cancellation from invalid content.
async fn choose_json_file() -> Result<Option<(String, Value)>, String> {
    let mut eval = document::eval(
        r#"
        const input = document.createElement('input'); input.type='file'; input.accept='.json,application/json';
        input.addEventListener('cancel',()=>dioxus.send({cancelled:true}),{once:true});
        input.addEventListener('change',async()=>{try {
            const file=input.files?.[0]; if(!file){dioxus.send({cancelled:true});return;}
            if(file.size>256*1024*1024)throw new Error('Choose a JSON file smaller than 256 MB.');
            dioxus.send({name:file.name,value:JSON.parse(await file.text())});
        }catch(e){dioxus.send({error:e instanceof SyntaxError?'This file is not valid JSON. Choose an Echo Voice export.':e.message});}},{once:true}); input.click();
    "#,
    );
    let value: Value = eval
        .recv()
        .await
        .map_err(|_| "Unable to open the file. Please try again.".to_string())?;
    if value["cancelled"] == true {
        return Ok(None);
    }
    if let Some(error) = value["error"].as_str() {
        return Err(error.to_string());
    }
    Ok(Some((text(&value, "name"), value["value"].clone())))
}

/// Download a JSON document using a temporary browser object URL.
async fn download_json(value: Value, name: &str) -> Result<(), String> {
    let mut eval = document::eval(
        r#"
        try { const p=await dioxus.recv(); const blob=new Blob([JSON.stringify(p.value,null,2)],{type:'application/json'});
        const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=p.name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);dioxus.send({ok:true});
        }catch(e){dioxus.send({error:e.message});}
    "#,
    );
    eval.send(json!({"value":value,"name":name}))
        .map_err(|_| "Could not prepare the download.".to_string())?;
    let result: Value = eval
        .recv()
        .await
        .map_err(|_| "Could not start the download.".to_string())?;
    if let Some(error) = result["error"].as_str() {
        return Err(error.into());
    }
    Ok(())
}

#[component]
/// Switch between general preferences, vocabulary, storage, and setup help.
pub fn Settings(
    settings: Signal<Value>,
    draft: Signal<Value>,
    snapshot: Signal<Value>,
    on_change: EventHandler<Value>,
    notify: EventHandler<String>,
    initial_section: String,
) -> Element {
    let mut section = use_signal(|| {
        if ["general", "vocabulary", "storage", "help"].contains(&initial_section.as_str()) {
            initial_section.clone()
        } else {
            "general".into()
        }
    });
    rsx! {
        div { class:"settings-page",
            header { class:"settings-page-heading",
                div { div { class:"settings-eyebrow", "MAKE YOURSELF AT HOME" } h1 { "Settings" } p { "Your workspace, just the way you like it." } }
                span { class:"settings-local-badge", span {} "Local workspace" }
            }
            nav { class:"settings-tabs", "aria-label":"Settings sections",
                for (id,label,icon) in [("general","General","settings"),("vocabulary","Vocabulary","book"),("storage","Storage","hard-drive"),("help","Help & setup","help")] {
                    button { r#type:"button", class:if section()==id {"is-active"} else {""}, "aria-current":if section()==id {"page"} else {"false"}, onclick:move |_| section.set(id.into()), Icon { name:icon,size:17 } span { "{label}" } }
                }
            }
            div { class:"settings-content",
                match section().as_str() {
                    "vocabulary" => rsx! { VocabularySettings { notify } },
                    "storage" => rsx! { StorageSettings { notify } },
                    "help" => rsx! { HelpSettings { on_section:move |value:String| section.set(value) } },
                    _ => rsx! { GeneralSettings { settings,draft,snapshot,on_change,notify,on_help:move |_| section.set("help".into()) } }
                }
            }
            footer { class:"settings-footer", Icon { name:"shield",size:14 } "Thoughtfully private. Entirely yours." span { "Echo Voice · Web 0.1" } }
        }
    }
}

#[component]
/// Render an accessible labeled binary preference control.
fn Toggle(
    checked: bool,
    label: String,
    onchange: EventHandler<()>,
    #[props(default = false)] disabled: bool,
) -> Element {
    rsx! { button { r#type:"button",class:"settings-switch",role:"switch","aria-checked":checked.to_string(),"aria-label":label,disabled,onclick:move |_| onchange.call(()),span {} } }
}

#[component]
/// Maintain an editable preference draft and persist it only when Save is selected.
fn GeneralSettings(
    settings: Signal<Value>,
    mut draft: Signal<Value>,
    mut snapshot: Signal<Value>,
    on_change: EventHandler<Value>,
    notify: EventHandler<String>,
    on_help: EventHandler<()>,
) -> Element {
    let mut saving = use_signal(|| false);
    let mut error = use_signal(String::new);
    use_effect(move || {
        let incoming = settings();
        if incoming != *snapshot.peek() {
            let previous = snapshot.peek().clone();
            let mut current = draft.peek().clone();
            if let Some(values) = incoming.as_object() {
                for (key, value) in values {
                    if current[key] == previous[key] {
                        current[key] = value.clone();
                    }
                }
            }
            snapshot.set(incoming);
            draft.set(current);
        }
    });
    let changed = draft() != settings();
    let notes_provider = if text(&draft(), "notesProvider") == "chatgpt" {
        "chatgpt"
    } else {
        "ollama"
    };
    let chatgpt_model = text(&draft(), "chatgptModel");
    rsx! {
        div { class:"settings-privacy-banner", span { class:"settings-banner-icon", Icon {name:"lock",size:23} } div { h2 {"Your conversations. Your choice."} p {"Your library is stored on this computer. Audio and transcription stay local. A meeting’s transcript is sent to OpenAI only when you request optional ChatGPT notes."} } button {r#type:"button",class:"settings-text-button",onclick:move |_| on_help.call(()),"How it works" Icon {name:"arrow-right",size:16}} }
        form { class:"settings-form", onsubmit:move |event| { event.prevent_default(); if saving(){return;} if text(&draft(),"speechModel").ends_with(".en") && text(&draft(),"language")!="en" {error.set("Whisper Tiny is English-only. Choose Whisper Base for another language or automatic language detection.".into());return;} saving.set(true); error.set(String::new()); spawn(async move { match patch("/settings",draft()).await { Ok(updated)=>{draft.set(updated.clone());on_change.call(updated);notify.call("Your preferences are saved.".into());},Err(message)=>error.set(message) } saving.set(false); }); },
            section { class:"settings-card", div {class:"settings-card-heading",div {class:"settings-section-icon",Icon {name:"settings",size:19}} div {h2 {"Your workspace"}p {"The small things that make it yours."}}}
                div { class:"settings-field-grid",
                    label {class:"settings-field",span {"Your name"}input {class:"input",value:text(&draft(),"name"),placeholder:"What should we call you?",maxlength:120,oninput:move |e|draft.write()["name"]=json!(e.value())}small {"Used to personalize your local workspace."}}
                    label {class:"settings-field",span {"Recording language"}select {class:"input",value:text(&draft(),"language"),onchange:move |e|draft.write()["language"]=json!(e.value()),option {value:"en",selected:text(&draft(),"language")=="en","English"}option {value:"auto",selected:text(&draft(),"language")=="auto","Auto-detect · multilingual model"}option {value:"es",selected:text(&draft(),"language")=="es","Spanish"}option {value:"fr",selected:text(&draft(),"language")=="fr","French"}option {value:"de",selected:text(&draft(),"language")=="de","German"}option {value:"hi",selected:text(&draft(),"language")=="hi","Hindi"}option {value:"ja",selected:text(&draft(),"language")=="ja","Japanese"}option {value:"pt",selected:text(&draft(),"language")=="pt","Portuguese"}option {value:"zh",selected:text(&draft(),"language")=="zh","Chinese"}}small {"Choose a multilingual speech model for other languages."}}
                }
            }
            section {class:"settings-card",div {class:"settings-card-heading",div {class:"settings-section-icon",Icon {name:"cpu",size:19}}div {h2 {"Processing preferences"}p {"Speech stays local. Choose where your meeting notes are drafted."}}span {class:"settings-soft-badge","Local speech"}}
                div {class:"settings-field-grid",
                    label {class:"settings-field",span {"Default speech model"}select {class:"input",value:text(&draft(),"speechModel"),onchange:move |e|draft.write()["speechModel"]=json!(e.value()),option {value:"onnx-community/whisper-tiny.en",selected:text(&draft(),"speechModel")=="onnx-community/whisper-tiny.en","Whisper Tiny · English"}option {value:"onnx-community/whisper-base",selected:text(&draft(),"speechModel")=="onnx-community/whisper-base","Whisper Base · Multilingual"}}small {"Models download to this browser and process audio locally."}}
                    label {class:"settings-field",span {"Default notes provider"}select {class:"input",value:notes_provider,"aria-describedby":"settings-provider-help",onchange:move |e|{let provider=e.value();draft.write()["notesProvider"]=json!(provider);if draft()["chatgptModel"].is_null(){draft.write()["chatgptModel"]=json!("");}},option {value:"ollama",selected:notes_provider=="ollama","Ollama · Local"}option {value:"chatgpt",selected:notes_provider=="chatgpt","ChatGPT · Optional cloud"}}small {id:"settings-provider-help","Applies when you request notes. Recording and transcription remain local."}}
                }
                if notes_provider == "chatgpt" {
                    div {class:"settings-provider-card",div {class:"settings-provider-heading",span {class:"settings-provider-icon",Icon {name:"sparkles",size:19}}div {h3 {"ChatGPT notes, by choice"}span {"Optional cloud processing"}}}
                        p {"When you request ChatGPT notes, the meeting’s active transcript, including speaker labels, and instructions are sent to OpenAI. Your audio is not uploaded, and saving this preference sends no meeting content."}
                        p {class:"settings-provider-allowance","Sign in through the official Codex flow with an eligible ChatGPT plan. Requests use your plan’s Codex allowance, not API credits. No API key is needed."}
                        div {class:"settings-provider-bottom",div {span {"ChatGPT model"}strong {if chatgpt_model.is_empty(){"Account default"}else{"{chatgpt_model}"}}small {"Choose from your account’s available models in Models → ChatGPT."}}button {r#type:"button",class:"button button-secondary",onclick:move |_|open_chatgpt_models(),"Set up ChatGPT" Icon {name:"arrow-right",size:15}}}
                    }
                } else {
                    div {class:"settings-local-notes-field",label {class:"settings-field",span {"Default local notes model"}input {class:"input",value:text(&draft(),"notesModel"),maxlength:120,placeholder:"qwen2.5:3b",oninput:move |e|draft.write()["notesModel"]=json!(e.value())}small {"The name of a model installed in your local Ollama library. Notes are generated on this computer."}}}
                }
                div {class:"settings-toggle-row",div {h3 {"Transcribe after recording"}p {"Start local transcription when a recording is saved. Audio is kept if processing fails."}}Toggle {checked:draft()["autoTranscribe"].as_bool().unwrap_or(true),label:"Transcribe after recording",onchange:move |_|{let enabled=draft()["autoTranscribe"].as_bool().unwrap_or(true);draft.write()["autoTranscribe"]=json!(!enabled);}}}
                div {class:"settings-info",Icon {name:"info",size:16}p {"Transcription runs after recording. Speaker labels can be reviewed manually; automatic speaker grouping and live transcription are not available in this version."}}
                if notes_provider == "ollama" {details {class:"settings-advanced",summary {"Local notes connection" Icon {name:"chevron-down",size:16}}div {label {class:"settings-field",span {"Ollama address"}input {class:"input",r#type:"url",value:text(&draft(),"ollamaUrl"),placeholder:"http://127.0.0.1:11434",required:true,oninput:move |e|draft.write()["ollamaUrl"]=json!(e.value())}small {"Only a service running on this computer is supported. Ollama is optional; recording and transcription work without it."}}}}}
            }
            if !error().is_empty() {div {class:"settings-error",role:"alert","{error}"}}
            div {class:"settings-save-row",span {if changed {"You have unsaved changes."}else {Icon {name:"check",size:15}"Your preferences are up to date"}}div {class:"settings-save-actions",if changed {button {r#type:"button",class:"button button-secondary",disabled:saving(),onclick:move |_|{draft.set(settings());error.set(String::new());},"Discard changes"}}button {r#type:"submit",class:"button button-primary",disabled:!changed||saving(),Icon {name:if saving(){"loader"}else{"check"},size:16}if saving(){"Saving…"}else{"Save changes"}}}}
        }
    }
}

/// Navigate to account setup from the provider preference.
fn open_chatgpt_models() {
    let _ = document::eval(
        "window.dispatchEvent(new CustomEvent('echo-open-models',{detail:{provider:'chatgpt'}}))",
    );
}

/// Close the editor and restore focus to its originating vocabulary action.
fn close_vocabulary_editor(mut editor: Signal<Option<Value>>) {
    editor.set(None);
    let _ = document::eval(
        "requestAnimationFrame(()=>document.getElementById('settings-add-word')?.focus())",
    );
}

#[component]
/// Manage terms, aliases, search, JSON import, and export.
fn VocabularySettings(notify: EventHandler<String>) -> Element {
    let mut entries = use_signal(Vec::<Value>::new);
    let mut loading = use_signal(|| true);
    let mut error = use_signal(String::new);
    let mut search = use_signal(String::new);
    let mut editor = use_signal(|| None::<Value>);
    let mut busy = use_signal(|| false);
    let mut progress = use_signal(String::new);
    let mut refresh = use_signal(|| 0u32);
    use_effect(move || {
        let _ = refresh();
        spawn(async move {
            loading.set(true);
            error.set(String::new());
            match get("/vocabulary").await {
                Ok(data) => entries.set(data["entries"].as_array().cloned().unwrap_or_default()),
                Err(message) => error.set(message),
            }
            loading.set(false);
        });
    });
    let query = search().to_lowercase();
    let filtered: Vec<(String, Value)> = entries()
        .into_iter()
        .filter(|entry| {
            format!(
                "{} {}",
                text(entry, "term"),
                entry["aliases"]
                    .as_array()
                    .map(|list| list
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" "))
                    .unwrap_or_default()
            )
            .to_lowercase()
            .contains(&query)
        })
        .map(|entry| (text(&entry, "id"), entry))
        .collect();
    let enabled = entries()
        .iter()
        .filter(|entry| entry["enabled"].as_bool().unwrap_or(true))
        .count();
    rsx! {
        div {class:"settings-section-top",div {h2 {"Words that matter to you"}p {"Give names, acronyms, and specialist terms their proper spelling."}}button {id:"settings-add-word",r#type:"button",class:"button button-primary",disabled:busy()||loading(),onclick:move |_|editor.set(Some(json!({"term":"","aliases":""}))),Icon {name:"plus",size:17}"Add word"}}
        div {class:"settings-info settings-info-vocabulary",Icon {name:"sparkles",size:18}p {"Enabled aliases replace exact phrases in new transcripts. Past versions keep the vocabulary they were created with. Similar-sounding correction is not applied."}}
        section {class:"settings-card settings-vocabulary-card",
            div {class:"settings-vocabulary-toolbar",label {class:"settings-search",Icon {name:"search",size:17}input {value:search(),placeholder:"Search your vocabulary…","aria-label":"Search vocabulary",oninput:move |e|search.set(e.value())}}div {
                button {r#type:"button",class:"button button-ghost",disabled:busy()||loading(),onclick:move |_|{spawn(async move {match choose_json_file().await {Ok(Some((_,value)))=>{busy.set(true);error.set(String::new());let result=import_vocabulary(value,entries,progress).await;match result {Ok(message)=>notify.call(message),Err(message)=>error.set(message)}busy.set(false);progress.set(String::new());},Ok(None)=>{},Err(message)=>error.set(message)}});},Icon {name:"upload",size:15}"Import"}
                button {r#type:"button",class:"button button-ghost",disabled:busy()||loading()||entries().is_empty(),onclick:move |_|{spawn(async move {if let Err(message)=download_json(json!({"version":1,"entries":entries()}),"echo-voice-vocabulary.json").await {error.set(message);}});},Icon {name:"download",size:15}"Export"}
            }}
            if let Some(current)=editor() {
                form {class:"settings-word-editor",onsubmit:move |event|{event.prevent_default();if busy(){return;}let Some(edit)=editor()else{return;};let current_id=text(&edit,"id");let preferred=text(&edit,"term").trim().to_lowercase();if entries().iter().any(|row|text(row,"id")!=current_id&&text(row,"term").trim().to_lowercase()==preferred){error.set("That spelling already exists. Edit the existing word to add more aliases.".into());return;}busy.set(true);error.set(String::new());spawn(async move {let id=text(&edit,"id");let aliases:Vec<String>=text(&edit,"aliases").split(',').map(str::trim).filter(|s|!s.is_empty()).map(str::to_owned).collect();let mut value=json!({"term":text(&edit,"term").trim(),"aliases":aliases});if id.is_empty(){value["enabled"]=json!(true);}let saved=if id.is_empty(){post("/vocabulary",value).await}else{patch(&format!("/vocabulary/{id}"),value).await};match saved{Ok(saved)=>{if id.is_empty(){entries.write().push(saved);}else{let mut rows=entries();for entry in &mut rows {if text(entry,"id")==id{*entry=saved.clone();}}entries.set(rows);}close_vocabulary_editor(editor);notify.call("Vocabulary saved.".into());},Err(message)=>error.set(message)}busy.set(false);});},
                    div {class:"settings-editor-title",h3 {if text(&current,"id").is_empty(){"A new word for your workspace"}else{"Edit preferred spelling"}}button {r#type:"button",class:"icon-button","aria-label":"Cancel vocabulary editing",disabled:busy(),onclick:move |_|close_vocabulary_editor(editor),Icon {name:"x",size:17}}}
                    div {class:"settings-field-grid",label {class:"settings-field",span {"Preferred spelling"}input {class:"input",onmounted:move |event| async move {let _=event.data().set_focus(true).await;},value:text(&current,"term"),required:true,maxlength:120,placeholder:"e.g. Figma",oninput:move |e|{if let Some(value)=editor.write().as_mut(){value["term"]=json!(e.value());}}}}label {class:"settings-field",span {"Heard as " small {"(comma-separated)"}}input {class:"input",value:text(&current,"aliases"),placeholder:"e.g. fig ma, figmah",maxlength:2500,oninput:move |e|{if let Some(value)=editor.write().as_mut(){value["aliases"]=json!(e.value());}}}}}
                    div {class:"settings-editor-actions",button {r#type:"button",class:"button button-secondary",disabled:busy(),onclick:move |_|close_vocabulary_editor(editor),"Cancel"}button {r#type:"submit",class:"button button-primary",disabled:busy()||text(&current,"term").trim().is_empty(),Icon {name:if busy(){"loader"}else{"check"},size:15}"Save word"}}
                }
            }
            if !error().is_empty() {div {class:"settings-error settings-inset",role:"alert","{error}" if entries().is_empty()&&!loading(){button {r#type:"button",class:"settings-text-button",onclick:move |_|{let next=refresh()+1;refresh.set(next);},"Try again"}}}}
            if !progress().is_empty() {p {class:"settings-load-state",role:"status",Icon {name:"loader",size:18}"{progress}"}}
            if loading() {div {class:"settings-load-state",role:"status",Icon {name:"loader",size:20}"Loading vocabulary…"}}
            else if filtered.is_empty() {div {class:"settings-empty",span {Icon {name:"book",size:27}}h3 {if search().is_empty(){"Make every word feel familiar"}else{"No matching words"}}p {if search().is_empty(){"Add the people, projects, and phrases that come up in your conversations."}else{"Try another spelling or alias."}}if search().is_empty(){button {r#type:"button",class:"settings-text-button",disabled:busy(),onclick:move |_|editor.set(Some(json!({"term":"","aliases":""}))),"Add your first word" Icon {name:"arrow-right",size:16}}}}}
            else {div {class:"settings-word-list",div {class:"settings-word-list-header",span {"Preferred spelling / heard as"}span {"Enabled"}}for (id,entry) in filtered {VocabularyRow {key:"{id}",entry,entries,busy,error,on_edit:move |value:Value|editor.set(Some(value)),notify}}}}
            div {class:"settings-vocabulary-footer",span {"{entries().len()} words · {enabled} enabled"}span {"Saved on this computer"}}
        }
    }
}

#[component]
/// Expose enable, edit, and delete actions for one vocabulary entry.
fn VocabularyRow(
    entry: Value,
    mut entries: Signal<Vec<Value>>,
    mut busy: Signal<bool>,
    mut error: Signal<String>,
    on_edit: EventHandler<Value>,
    notify: EventHandler<String>,
) -> Element {
    let enabled = entry["enabled"].as_bool().unwrap_or(true);
    let toggle_id = text(&entry, "id");
    let delete_id = toggle_id.clone();
    let edit = entry.clone();
    let term = text(&entry, "term");
    let aliases: Vec<String> = entry["aliases"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    rsx! {div {class:if enabled{"settings-word-row"}else{"settings-word-row settings-word-disabled"},
        div {class:"settings-word-copy",h3 {"{term}"}p {if aliases.is_empty(){span {class:"settings-no-alias","No aliases added"}}else{for alias in aliases{span {"{alias}"}}}}}
        div {class:"settings-word-actions",Toggle {checked:enabled,label:format!("Enable {term}"),disabled:busy(),onchange:move |_|{let id=toggle_id.clone();busy.set(true);error.set(String::new());spawn(async move {match patch(&format!("/vocabulary/{id}"),json!({"enabled":!enabled})).await{Ok(saved)=>{let rows=entries().into_iter().map(|row|if text(&row,"id")==id{saved.clone()}else{row}).collect();entries.set(rows);},Err(message)=>error.set(message)}busy.set(false);});}}
            button {r#type:"button",class:"icon-button",disabled:busy(),"aria-label":format!("Edit {term}"),onclick:move |_|{let mut value=edit.clone();value["aliases"]=json!(edit["aliases"].as_array().map(|a|a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default());on_edit.call(value);},Icon {name:"edit",size:15}}
            button {r#type:"button",class:"icon-button settings-delete-word",disabled:busy(),"aria-label":format!("Remove {term}"),onclick:move |_|{let id=delete_id.clone();busy.set(true);error.set(String::new());spawn(async move {match delete(&format!("/vocabulary/{id}")).await{Ok(_)=>{let rows=entries().into_iter().filter(|row|text(row,"id")!=id).collect();entries.set(rows);notify.call("Vocabulary entry removed.".into());},Err(message)=>error.set(message)}busy.set(false);});},Icon {name:"trash",size:15}}
        }
    }}
}

/// Validate imported terms before merging them into the workspace vocabulary.
async fn import_vocabulary(
    value: Value,
    mut entries: Signal<Vec<Value>>,
    mut progress: Signal<String>,
) -> Result<String, String> {
    let list = if value.is_array() {
        value.as_array()
    } else {
        value["entries"].as_array()
    }
    .ok_or("Choose an export containing an entries array.")?;
    if list.len() > 2000 {
        return Err("Import up to 2,000 words at a time.".into());
    }
    for entry in list {
        let term = text(entry, "term");
        let aliases = entry["aliases"].as_array();
        if term.trim().is_empty()
            || term.len() > 120
            || aliases.is_none()
            || aliases.is_some_and(|a| {
                a.len() > 20 || a.iter().any(|v| v.as_str().is_none_or(|s| s.len() > 120))
            })
            || (!entry["enabled"].is_null() && !entry["enabled"].is_boolean())
        {
            return Err("Each entry needs a spelling of up to 120 characters, up to 20 text aliases, and an optional enabled flag.".into());
        }
    }
    let mut existing: std::collections::HashSet<String> = entries()
        .iter()
        .map(|v| text(v, "term").to_lowercase())
        .collect();
    let mut added = 0;
    let mut skipped = 0;
    for (index, entry) in list.iter().enumerate() {
        progress.set(format!("Importing {} of {}…", index + 1, list.len()));
        let term = text(entry, "term").trim().to_string();
        if existing.contains(&term.to_lowercase()) {
            skipped += 1;
            continue;
        }
        let saved=post("/vocabulary",json!({"term":term,"aliases":entry["aliases"],"enabled":entry["enabled"].as_bool().unwrap_or(true)})).await.map_err(|message|format!("{added} entries were saved before import stopped. {message}"))?;
        entries.write().push(saved);
        existing.insert(term.to_lowercase());
        added += 1;
    }
    Ok(format!(
        "Imported {added} entries. {skipped} existing or duplicate spellings skipped."
    ))
}

#[component]
/// Display managed library usage and offer explicit backup, restore, and cache actions.
fn StorageSettings(notify: EventHandler<String>) -> Element {
    let mut storage = use_signal(|| Value::Null);
    let mut vocabulary_count = use_signal(|| None::<usize>);
    let mut loading = use_signal(|| true);
    let mut error = use_signal(String::new);
    let mut busy = use_signal(String::new);
    let mut archive = use_signal(|| None::<(String, Value)>);
    let mut refresh = use_signal(|| 0u32);
    use_effect(move || {
        let _ = refresh();
        spawn(async move {
            loading.set(true);
            error.set(String::new());
            match get("/storage").await {
                Ok(data) => {
                    storage.set(data);
                    match get("/vocabulary").await {
                        Ok(words) => vocabulary_count
                            .set(Some(words["entries"].as_array().map(Vec::len).unwrap_or(0))),
                        Err(message) => error.set(message),
                    }
                }
                Err(message) => error.set(message),
            }
            loading.set(false);
        });
    });
    let count = storage()["meetings"].as_u64().unwrap_or(0);
    let size = storage()["bytes"].as_f64().unwrap_or(0.);
    let available = storage()["availableBytes"].as_f64().unwrap_or(0.);
    let used = (size / (size + available).max(1.) * 100.).clamp(1., 100.);
    let storage_path = text(&storage(), "path");
    rsx! {
        div {class:"settings-section-top",div {h2 {"A home for your conversations"}p {"Your library lives on your computer. Keep an independent copy whenever you like."}}}
        if !error().is_empty(){div {class:"settings-error",role:"alert","{error}"}}
        section {class:"settings-card",div {class:"settings-card-heading",div {class:"settings-section-icon",Icon {name:"hard-drive",size:20}}div {h2 {"Local storage"}p {"Audio and meeting records, under your control."}}span {class:"settings-soft-badge",Icon {name:"lock",size:12}"Private"}}
            if loading(){p {class:"settings-load-state",role:"status",Icon {name:"loader",size:19}"Checking local storage…"}}
            else if !storage().is_null(){div {class:"settings-storage-stats",div {span {"Library size"}strong {"{bytes(size)}"}}div {span {"Saved meetings"}strong {"{count}"}}div {span {"Available on disk"}strong {"{bytes(available)}"}}}div {class:"settings-storage-meter",role:"img","aria-label":format!("{} used by Echo Voice; {} available",bytes(size),bytes(available)),span {style:"width:{used}%"}}div {class:"settings-storage-legend",span {i {}"Echo Voice library"}span {"Space available for future conversations"}}if available<500.*1024.*1024.{div {class:"settings-storage-warning",role:"status","Your disk has less than 500 MB free. Export your library and free up disk space before a long recording."}}div {class:"settings-storage-path",Icon {name:"folder",size:19}div {span {"Library location on this computer"}code {"{storage_path}"}}}}
            else{button {r#type:"button",class:"button button-secondary",onclick:move |_|{let n=refresh()+1;refresh.set(n);},"Retry storage check"}}
        }
        div {class:"settings-backup-grid",
            section {class:"settings-card",div {class:"settings-backup-icon",Icon {name:"download",size:22}}h2 {"Take a copy with you"}p {"Export a web library archive with recordings, transcripts, notes, and saved moments. Your current library stays exactly where it is."}button {r#type:"button",class:"button button-secondary",disabled:!busy().is_empty()||loading()||storage().is_null(),onclick:move |_|{busy.set("export".into());error.set(String::new());spawn(async move {match export_library().await{Ok(())=>notify.call("Library backup prepared. Check your browser downloads.".into()),Err(message)=>error.set(message)}busy.set(String::new());});},Icon {name:if busy()=="export"{"loader"}else{"download"},size:16}if busy()=="export"{"Preparing backup…"}else{"Export library"}}}
            section {class:"settings-card",div {class:"settings-backup-icon",Icon {name:"upload",size:22}}h2 {"Bring your library home"}p {"Restore a supported Echo Voice Web archive into an empty library. Your source file is preserved. Meetings and vocabulary cannot be merged."}button {r#type:"button",class:"button button-secondary",disabled:!busy().is_empty()||loading()||storage().is_null()||count>0||vocabulary_count().is_none_or(|n|n>0),onclick:move |_|{spawn(async move {match choose_json_file().await{Ok(Some((name,value)))=>{if value["format"]!="echo-voice-web"||value["version"]!=1{error.set("Choose a supported Echo Voice Web version 1 library archive.".into());}else{error.set(String::new());archive.set(Some((name,value)));}},Ok(None)=>{},Err(message)=>error.set(message)}});},Icon {name:"file",size:16}"Choose library file"}if count>0||vocabulary_count().is_some_and(|n|n>0){small {class:"settings-import-note","Import requires an empty meeting library and vocabulary list."}}}
        }
        if let Some((name,_))=archive(){section {class:"settings-card settings-import-review",div {h3 {"Ready to restore" span {"{name}"}}p {"The archive is validated before importing. Desktop libraries, credentials, and model downloads are not imported."}}div {button {r#type:"button",class:"button button-secondary",disabled:!busy().is_empty(),onclick:move |_|archive.set(None),"Cancel"}button {r#type:"button",class:"button button-primary",disabled:!busy().is_empty(),onclick:move |_|{if let Some((_,value))=archive(){busy.set("import".into());error.set(String::new());spawn(async move {match post("/storage/import",value).await{Ok(restored)=>{vocabulary_count.set(Some(restored["vocabulary"].as_u64().unwrap_or(0) as usize));archive.set(None);if let Ok(data)=get("/storage").await{storage.set(data);}let _=document::eval("window.dispatchEvent(new CustomEvent('echo-library-changed'));");notify.call("Your library was restored from the backup.".into());},Err(message)=>error.set(message)}busy.set(String::new());});}},Icon {name:if busy()=="import"{"loader"}else{"upload"},size:16}if busy()=="import"{"Restoring…"}else{"Restore library"}}}}}
        div {class:"settings-info",Icon {name:"info",size:18}p {strong {"Your library and your models live in different places. "}"Meeting files live in the folder above; speech models live in this browser’s cache. Clearing browser data removes downloaded models, so you may need to download them again. Library exports do not include models or account credentials."}}
    }
}

/// Download the server's portable library archive, including audio but excluding credentials.
async fn export_library() -> Result<(), String> {
    let mut eval = document::eval(
        r#"try{const r=await fetch('/api/storage/export');if(!r.ok){const v=await r.json().catch(()=>({}));throw new Error(v.error||'Could not create the backup. Your library is unchanged.');}const blob=await r.blob();if(!blob.size)throw new Error('The backup was empty. Please try again.');const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='echo-voice-library-'+new Date().toISOString().slice(0,10)+'.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);dioxus.send({ok:true});}catch(e){dioxus.send({error:e.message});}"#,
    );
    let value: Value = eval
        .recv()
        .await
        .map_err(|_| "The download could not be prepared.".to_string())?;
    if let Some(error) = value["error"].as_str() {
        Err(error.into())
    } else {
        Ok(())
    }
}

#[component]
/// Present local setup instructions and shortcuts to relevant configuration screens.
fn HelpSettings(on_section: EventHandler<String>) -> Element {
    let mut mic = use_signal(|| "idle".to_string());
    let mut mic_message = use_signal(String::new);
    rsx! {
        div {class:"settings-setup-hero",span {class:"settings-setup-icon",Icon {name:"sparkles",size:26}}div {class:"settings-eyebrow","A FEW SIMPLE STEPS"}h2 {"Good conversations start here."}p {"Recording, transcription, and notes are separate. Start with what you need; add the rest whenever you’re ready."}}
        section {class:"settings-card settings-steps",
            div {class:"settings-setup-step",span {class:"settings-step-number","01"}div {h3 {"Give your microphone a moment"}p {"For in-person conversations, test your room microphone. Permission is requested only when you choose to test or record."}button {r#type:"button",class:"button button-secondary",disabled:mic()=="checking",onclick:move |_|{mic.set("checking".into());mic_message.set(String::new());spawn(async move {let mut eval=document::eval(r#"try{if(!isSecureContext||!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone access needs localhost or a secure HTTPS connection.');if(!window.MediaRecorder)throw new Error('This browser cannot record audio. Try the latest desktop Chrome or Edge.');const stream=await navigator.mediaDevices.getUserMedia({audio:true});stream.getTracks().forEach(track=>track.stop());dioxus.send({ok:true});}catch(e){const messages={NotAllowedError:'Microphone access was denied. Allow the microphone in your browser site settings, then test again.',NotFoundError:'No microphone was found. Connect one and test again.',NotReadableError:'The microphone is busy or unavailable. Check your system input settings.'};dioxus.send({error:messages[e.name]||e.message});}"#);match eval.recv::<Value>().await{Ok(value)if value["ok"]==true=>{mic.set("ready".into());mic_message.set("Microphone access works. The test has ended; no audio was saved.".into());},Ok(value)=>{mic.set("error".into());mic_message.set(text(&value,"error"));},Err(_)=>{mic.set("error".into());mic_message.set("The microphone test could not finish. Please try again.".into());}}});},Icon {name:if mic()=="checking"{"loader"}else if mic()=="ready"{"check"}else{"mic"},size:16}if mic()=="checking"{"Waiting for permission…"}else if mic()=="ready"{"Test microphone again"}else{"Test microphone access"}}if !mic_message().is_empty(){p {class:if mic()=="error"{"settings-mic-result is-error"}else{"settings-mic-result"},role:"status","{mic_message}"}}}span {class:"settings-step-tag","Recording"}}
            div {class:"settings-setup-step",span {class:"settings-step-number","02"}div {h3 {"Choose a local speech model"}p {"Open Models to download a speech model. Downloads use the internet; once cached, recognition runs on your device. You can record while transcription setup waits."}button {r#type:"button",class:"settings-text-button",onclick:move |_|on_section.call("general".into()),"Review processing preferences" Icon {name:"arrow-right",size:15}}}span {class:"settings-step-tag","Transcription"}}
            div {class:"settings-setup-step",span {class:"settings-step-number","03"}div {h3 {"Choose how to draft your notes"}p {"For local notes, install and run Ollama on this computer, download a compatible text model, and set its name in General. Ollama remains the default; recording and transcription need neither notes provider."}a {class:"settings-text-button",href:"https://ollama.com/download",target:"_blank",rel:"noreferrer","Get Ollama" Icon {name:"arrow-right",size:15}}
                div {class:"settings-help-chatgpt",h4 {"Prefer your ChatGPT account?"}p {"Open Models → ChatGPT and choose Sign in to use the official Codex sign-in flow. An eligible plan’s Codex allowance covers these requests; API credits are not used. After setup, choose ChatGPT as your notes provider."}p {"ChatGPT notes send the active transcript to OpenAI only after you request them. Audio and speech recognition stay local. Every generated draft needs your review."}button {r#type:"button",class:"settings-text-button",onclick:move |_|open_chatgpt_models(),"Set up ChatGPT" Icon {name:"arrow-right",size:15}}}
            }span {class:"settings-step-tag","Optional"}}
            div {class:"settings-setup-step",span {class:"settings-step-number","04"}div {h3 {"Bring your calendar along"}p {"Open Calendar to configure Google Calendar and the optional local Google Meet runner. The runner needs local setup and host admission. Calendar access alone does not record meetings."}}span {class:"settings-step-tag","Optional"}}
        }
        div {class:"settings-section-top settings-faq-title",div {h2 {"A little clarity goes a long way."}p {"The details that help you feel at home."}}}
        section {class:"settings-card settings-faq",
            details {open:true,summary {Icon {name:"shield",size:17}span {"What stays private?"}Icon {name:"chevron-down",size:16}}p {"Your library is stored on your computer. Speech recognition runs inside your browser, and Ollama notes run locally. Optional ChatGPT notes send the meeting’s active transcript and instructions to OpenAI after you request them; audio is not uploaded for notes or cloud transcription. Model downloads contact the model host. Connecting Google Calendar exchanges calendar metadata with Google, and the meeting runner connects to Google Meet."}}
            details {summary {Icon {name:"sparkles",size:17}span {"How does my ChatGPT plan work with Echo?"}Icon {name:"chevron-down",size:16}}p {"Echo uses the official Codex helper and managed ChatGPT sign-in. You need a plan and account that are eligible for Codex. Requests use that plan’s Codex allowance, which can have usage limits; this is not a general ChatGPT token pool or an API-credit balance. Echo never asks for an API key for this option. Sign-in and model availability are managed in Models → ChatGPT. Choosing the provider does not send meeting content or start a notes request."}}
            details {summary {Icon {name:"mic",size:17}span {"Which browsers and devices can record?"}Icon {name:"chevron-down",size:16}}p {"Use an up-to-date desktop Chrome or Edge on localhost for the recommended experience. Firefox and Safari may support room recording when microphone access and a compatible MediaRecorder audio format are available; recording and model performance can vary. A responsive mobile layout does not guarantee mobile recording support. Keep Echo Voice open during recording and transcription."}}
            details {summary {Icon {name:"book",size:17}span {"Can I rely on every word and speaker label?"}Icon {name:"chevron-down",size:16}}p {"Transcripts and generated notes are drafts. Review names, numbers, and decisions against the original audio. Timestamps are approximate passage timings. Automatic speaker grouping and live transcription are unavailable in this release. You can correct the transcript and assign speaker labels manually."}}
            details {summary {Icon {name:"hard-drive",size:17}span {"How do I back up or move my meetings?"}Icon {name:"chevron-down",size:16}}p {"Export a web library archive in Storage and keep the downloaded copy in a safe location. Restore it into an empty Echo Voice Web library and vocabulary list. Browser model downloads are separate and can be downloaded again. ChatGPT sign-in credentials are excluded from library exports, so connect your account separately on another computer. Legacy desktop-library migration is not supported. Deleting a meeting here does not delete copies you previously exported."}}
            details {summary {Icon {name:"help",size:17}span {"What if recording or processing is interrupted?"}Icon {name:"chevron-down",size:16}}p {"Saved audio chunks remain available if speech or notes processing fails. Reopen the meeting and retry processing after fixing the reported issue. A browser crash or lost microphone may leave a gap after the last saved chunk. Recording never resumes automatically; review the recording and consent before starting again."}}
        }
    }
}
