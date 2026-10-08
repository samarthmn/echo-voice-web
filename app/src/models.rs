use crate::ui::{
    ActionButton, BadgeTone, ButtonKind, IconButton, PageHeading, SectionHeading, StatusBadge,
};
use crate::{
    api::{get, patch, text},
    Icon,
};
use dioxus::prelude::*;
use serde_json::{json, Value};
#[component]
/// Render the shared speech catalog, local notes setup, and optional ChatGPT account connection.
pub fn Models(
    settings: Signal<Value>,
    download: Signal<Value>,
    notes_download: Signal<Value>,
    on_change: EventHandler<Value>,
    notify: EventHandler<String>,
) -> Element {
    let mut catalog = use_signal(Vec::<Value>::new);
    let mut installed = use_signal(Vec::<String>::new);
    let mut outdated = use_signal(Vec::<String>::new);
    let mut error = use_signal(String::new);
    let mut notes = use_signal(|| Value::Null);
    let mut native_speech = use_signal(|| Value::Null);
    let mut refresh = use_signal(|| 0);
    let download_status = use_memo(move || text(&download(), "status"));
    let notes_download_status = use_memo(move || text(&notes_download(), "status"));
    use_resource(move || {
        let _ = refresh();
        let _ = download_status();
        let _ = notes_download_status();
        async move {
            if catalog().is_empty() {
                match crate::api::evaluate("return window.echoInference.models").await {
                    Ok(value) => catalog.set(value.as_array().cloned().unwrap_or_default()),
                    Err(message) => error.set(message),
                }
            }
            match document::eval("return await window.echoInference.getDownloadedModels()").await {
                Ok(v) => installed.set(
                    v.as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default(),
                ),
                Err(e) => error.set(format!("Could not inspect model cache: {e}")),
            }
            if let Ok(value) =
                crate::api::evaluate("return await window.echoInference.getOutdatedModels()").await
            {
                outdated.set(
                    value
                        .as_array()
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|item| item.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default(),
                );
            }
            if let Ok(value) = get("/speech").await {
                native_speech.set(value);
            }
            if let Ok(v) = get("/notes").await {
                notes.set(v)
            }
        }
    });
    let models: Vec<_> = catalog()
        .iter()
        .map(|model| {
            (
                text(model, "id"),
                text(model, "name"),
                text(model, "description"),
                text(model, "size"),
                text(model, "language"),
                model["recommended"] == true,
                text(model, "engine") == "native",
            )
        })
        .collect();
    let native_available = native_speech()["available"].as_bool().unwrap_or(false);
    let native_detail = text(&native_speech(), "detail");
    let available = notes()["available"].as_bool().unwrap_or(false);
    let notes_downloading = notes_download_status() == "downloading";
    let notes_progress = notes_download()["progress"].as_f64().unwrap_or(0.);
    let notes_progress_text = text(&notes_download(), "detail");
    let notes_download_error = text(&notes_download(), "error");
    let speech_downloading = matches!(download_status().as_str(), "queued" | "downloading");
    let download_id = text(&download(), "modelId");
    let progress = download()["progress"].as_f64().unwrap_or(0.);
    let progress_text = text(&download(), "detail");
    let download_error = text(&download(), "error");
    rsx! {div{class:"page-content",PageHeading{title:"Models"}
    nav{class:"model-section-links",aria_label:"Model setup sections",a{href:"#speech-models",Icon{name:"mic",size:16}"Speech models"}a{href:"#local-notes",Icon{name:"cpu",size:16}"Local notes"}a{href:"#chatgpt-connection",Icon{name:"sparkles",size:16}"ChatGPT"}}
    if !error().is_empty(){div{class:"inline-error",role:"alert",Icon{name:"alert"}"{error}"}}
    if download_status()=="failed"{div{class:"inline-error",role:"alert",Icon{name:"alert"}"{download_error}"}}
    SectionHeading{id:"speech-models",title:"Transcription",description:"Downloads include speaker recognition."}
    div{class:"model-grid",for (id,name,description,size,language,recommended,native) in models{
    article{class:if text(&settings(),"speechModel")==id{"model-card panel model-selected"}else{"model-card panel"},div{class:"model-card-top",span{class:"model-symbol",Icon{name:"cpu",size:26}}StatusBadge{tone:if recommended{BadgeTone::Accent}else{BadgeTone::Neutral},if recommended{"Recommended"}else{"Full-size model"}}}h3{"{name}"}p{"{description}"}if native&&!native_available{p{class:"small-muted",if native_detail.is_empty(){"Install Node.js 22 or newer, run npm ci, then check again."}else{"{native_detail}"}}ActionButton{kind:ButtonKind::Ghost,compact:true,onclick:move |_|refresh+=1,"Check engine"}}div{class:"model-specs",span{Icon{name:"download",size:14}"{size}"}span{"{language}"}span{Icon{name:"cpu",size:14}"Runs locally"}}div{class:"model-status",span{class:if installed().contains(&id.to_string()){"connection-dot ready"}else{"connection-dot"}}if installed().contains(&id.to_string()){"Downloaded · ready to use"}else if speech_downloading && download_id==id{"Downloading"}else if outdated().contains(&id){"Model update required"}else{"Not downloaded"}if text(&settings(),"speechModel")==id{span{class:"small-muted","Default"}}}
    if speech_downloading && download_id==id{div{class:"download-status",div{span{"{progress_text}"}IconButton{label:"Cancel model download",icon:"close",onclick:move |_|{let _=document::eval("window.echoInference.cancelInference()");}}}progress{value:progress.to_string(),max:"100"}}}
    else if installed().contains(&id.to_string()){div{class:"model-card-actions",ActionButton{kind:ButtonKind::Secondary,disabled:notes_downloading||speech_downloading||text(&settings(),"speechModel")==id,onclick:{let id=id.clone();move |_|{let id=id.clone();spawn(async move{match patch("/settings",json!({"speechModel":id})).await{Ok(v)=>{on_change.call(v);notify.call("Default speech model updated.".into());},Err(e)=>notify.call(e)}});}},Icon{name:"check",size:16}if text(&settings(),"speechModel")==id{"Default model"}else{"Use as default"}}IconButton{icon:"trash",label:format!("Remove {name}"),disabled:notes_downloading||speech_downloading,onclick:{let id=id.clone();move |_|{let id=id.clone();spawn(async move{match crate::api::evaluate(&format!("return await window.echoInference.removeModel({})",json!(id))).await{Ok(_)=>{refresh+=1;notify.call("Model removed. Saved transcripts are unchanged.".into());},Err(e)=>notify.call(format!("Could not remove model: {e}"))}});}}}}}
    else{ActionButton{kind:ButtonKind::Primary,full_width:true,disabled:notes_downloading||speech_downloading||(native&&!native_available),onclick:{let id=id.clone();move |_|{error.set(String::new());let _=document::eval(&format!("window.echoInference.downloadModel({}).catch(()=>{{}});",json!(id)));}},Icon{name:"download",size:16}if outdated().contains(&id){"Download update"}else{"Download model"}}}
    }
    }}
    SectionHeading{id:"local-notes",class:"notes-model-heading",title:"Local notes"}
    div{class:"panel ollama-panel",span{class:"model-symbol",Icon{name:"sparkles",size:26}}div{class:"ollama-copy",h3{"Ollama"}p{if available{"Choose a model for meeting notes."}else{"Start Ollama to generate local notes."}}div{class:"model-status",span{class:if available{"connection-dot ready"}else{"connection-dot"}}if available{"Ollama connected"}else{"Ollama not connected"}}
    if available{div{class:"ollama-select",select{class:"input",disabled:notes_downloading,"aria-label":"Local notes model",value:text(&settings(),"notesModel"),onchange:move|e|{spawn(async move{match patch("/settings",json!({"notesModel":e.value()})).await{Ok(v)=>on_change.call(v),Err(e)=>notify.call(e)}});},option{value:text(&settings(),"notesModel"),{text(&settings(),"notesModel")}}for m in notes()["models"].as_array().cloned().unwrap_or_default(){if m.as_str()!=settings()["notesModel"].as_str(){option{value:m.as_str().unwrap_or_default(),{m.as_str().unwrap_or_default()}}}}}ActionButton{kind:ButtonKind::Secondary,disabled:notes_downloading||speech_downloading,onclick:move |_|{let _=document::eval(&format!("window.echoNotes.downloadModel({}).catch(()=>{{}});",json!(text(&settings(),"notesModel"))));},Icon{name:"download",size:16}if notes_downloading{"Downloading…"}else{"Download selected"}}}}
    if notes_downloading{div{class:"download-status",role:"status",span{"{notes_progress_text}"}progress{value:notes_progress.to_string(),max:"100","aria-label":"Notes model download progress"}}}
    if notes_download_status()=="failed"{div{class:"inline-error",role:"alert",Icon{name:"alert"}"{notes_download_error}"}}
    }div{class:"ollama-actions",ActionButton{kind:ButtonKind::Secondary,onclick:move |_|refresh+=1,Icon{name:"refresh",size:16}"Check connection"}}}
    crate::chatgpt::ChatGptConnection{settings,on_change,notify}
    }}
}
