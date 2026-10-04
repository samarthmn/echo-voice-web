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
    on_change: EventHandler<Value>,
    notify: EventHandler<String>,
    on_setup: EventHandler<()>,
) -> Element {
    let mut catalog = use_signal(Vec::<Value>::new);
    let mut installed = use_signal(Vec::<String>::new);
    let mut busy = use_signal(String::new);
    let mut progress = use_signal(|| 0.);
    let mut progress_text = use_signal(String::new);
    let mut error = use_signal(String::new);
    let mut notes = use_signal(|| Value::Null);
    let mut refresh = use_signal(|| 0);
    use_resource(move || {
        let _ = refresh();
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
            if let Ok(v) = get("/notes").await {
                notes.set(v)
            }
        }
    });
    use_future(move || async move {
        let mut ev = document::eval(
            "window.addEventListener('echo-model-progress',e=>dioxus.send(e.detail));",
        );
        while let Ok(v) = ev.recv::<Value>().await {
            progress.set(v["progress"].as_f64().unwrap_or(0.));
            progress_text.set(text(&v, "status"));
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
            )
        })
        .collect();
    let available = notes()["available"].as_bool().unwrap_or(false);
    rsx! {div{class:"page-content",div{class:"page-heading",div{span{class:"eyebrow","INTELLIGENCE, ON YOUR TERMS"}h1{"Your models. Your choice."}p{"Choose local models or connect ChatGPT for optional cloud notes."}}span{class:"local-pill",Icon{name:"shield",size:14}"Private by design"}}
    nav{class:"model-section-links",aria_label:"Model setup sections",a{href:"#speech-models",Icon{name:"mic",size:16}"Speech models"}a{href:"#local-notes",Icon{name:"cpu",size:16}"Local notes"}a{href:"#chatgpt-connection",Icon{name:"sparkles",size:16}"ChatGPT"}}
    div{class:"model-info-banner",div{class:"model-info-icon",Icon{name:"cpu",size:27}}div{h2{"Download once. Think locally."}p{"Speech models live in this browser’s storage. After download, your audio is processed locally—even offline. Start small; you can always change models later."}}span{class:"badge","No API keys"}}
    if !error().is_empty(){div{class:"inline-error",role:"alert",Icon{name:"alert"}"{error}"}}
    div{id:"speech-models",class:"section-heading",div{h2{"Speech recognition"}p{"Turn a recording into a timestamped transcript."}}span{class:"small-muted","Browser · WASM"}}
    div{class:"model-grid",for (id,name,description,size,language,recommended) in models{
    article{class:if text(&settings(),"speechModel")==id{"model-card panel model-selected"}else{"model-card panel"},div{class:"model-card-top",span{class:"model-symbol",Icon{name:"cpu",size:26}}span{class:if recommended{"badge badge-purple"}else{"badge"},if recommended{"Recommended"}else{"More detail"}}}h3{"{name}"}p{"{description}"}div{class:"model-specs",span{Icon{name:"download",size:14}"{size}"}span{"{language}"}span{Icon{name:"cpu",size:14}"CPU compatible"}}div{class:"model-status",span{class:if installed().contains(&id.to_string()){"connection-dot ready"}else{"connection-dot"}}if installed().contains(&id.to_string()){"Downloaded · ready to use"}else{"Not downloaded"}if text(&settings(),"speechModel")==id{span{class:"small-muted","Default"}}}
    if busy()==id{div{class:"download-status",div{span{"{progress_text}"}button{class:"icon-button","aria-label":"Cancel model download",onclick:move |_|{let _=document::eval("window.echoInference.cancelInference()");busy.set(String::new());},Icon{name:"close",size:16}}}progress{value:progress().to_string(),max:"100"}}}
    else if installed().contains(&id.to_string()){div{class:"model-card-actions",button{class:"button button-secondary",disabled:!busy().is_empty()||text(&settings(),"speechModel")==id,onclick:{let id=id.clone();move |_|{let id=id.clone();spawn(async move{match patch("/settings",json!({"speechModel":id})).await{Ok(v)=>{on_change.call(v);notify.call("Default speech model updated.".into());},Err(e)=>notify.call(e)}});}},Icon{name:"check",size:16}if text(&settings(),"speechModel")==id{"Default model"}else{"Use as default"}}button{class:"icon-button","aria-label":format!("Remove {name}"),disabled:!busy().is_empty(),onclick:{let id=id.clone();move |_|{let id=id.clone();spawn(async move{match crate::api::evaluate(&format!("return await window.echoInference.removeModel({})",json!(id))).await{Ok(_)=>{refresh+=1;notify.call("Model removed. Saved transcripts are unchanged.".into());},Err(e)=>notify.call(format!("Could not remove model: {e}"))}});}},Icon{name:"trash",size:16}}}}
    else{button{class:"button button-primary full-width",disabled:!busy().is_empty(),onclick:{let id=id.clone();move |_|{let id=id.clone();spawn(async move{busy.set(id.clone());error.set(String::new());progress.set(0.);progress_text.set("Preparing download…".into());match crate::api::evaluate(&format!("return await window.echoInference.downloadModel({})",json!(id))).await{Ok(_)=>{refresh+=1;notify.call("Model is ready for local transcription.".into());},Err(e)=>error.set(format!("Download failed: {e}. Check your connection and retry."))}busy.set(String::new());});}},Icon{name:"download",size:16}"Download model"}}
    }
    }}
    div{id:"local-notes",class:"section-heading notes-model-heading",div{h2{"Meeting intelligence"}p{"Summaries, decisions, and next steps—with evidence."}}span{class:"small-muted","Local · Ollama"}}
    div{class:"panel ollama-panel",span{class:"model-symbol",Icon{name:"sparkles",size:26}}div{class:"ollama-copy",h3{"Your local notes assistant"}p{if available{"Ollama is connected on this computer. Choose a local model for evidence-linked notes."}else{"Connect Ollama to generate private meeting notes with a local language model."}}div{class:"model-status",span{class:if available{"connection-dot ready"}else{"connection-dot"}}if available{"Ollama connected"}else{"Ollama not connected"}}
    if available{div{class:"ollama-select",select{class:"input","aria-label":"Local notes model",value:text(&settings(),"notesModel"),onchange:move|e|{spawn(async move{match patch("/settings",json!({"notesModel":e.value()})).await{Ok(v)=>on_change.call(v),Err(e)=>notify.call(e)}});},option{value:text(&settings(),"notesModel"),{text(&settings(),"notesModel")}}for m in notes()["models"].as_array().cloned().unwrap_or_default(){if m.as_str()!=settings()["notesModel"].as_str(){option{value:m.as_str().unwrap_or_default(),{m.as_str().unwrap_or_default()}}}}}button{class:"button button-secondary",disabled:!busy().is_empty(),onclick:move |_|{spawn(async move{busy.set("notes".into());let model=text(&settings(),"notesModel");let script=format!(r#"const res=await fetch('/api/notes/models',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{model:{}}})}});if(!res.ok)throw new Error((await res.json()).error);const reader=res.body.getReader(),dec=new TextDecoder();let rest='';while(true){{const{{done,value}}=await reader.read();if(done)break;rest+=dec.decode(value,{{stream:true}});let lines=rest.split('\n');rest=lines.pop();for(const line of lines){{if(!line.trim())continue;const p=JSON.parse(line);if(p.error)throw new Error(p.error);window.dispatchEvent(new CustomEvent('echo-model-progress',{{detail:{{status:p.status||'Downloading',progress:p.total?p.completed/p.total*100:0}}}}));}}}}return true;"#,json!(model));match crate::api::evaluate(&script).await{Ok(_)=>{refresh+=1;notify.call("Notes model downloaded.".into())},Err(e)=>error.set(format!("Notes model download failed: {e}"))}busy.set(String::new());});},Icon{name:"download",size:16}if busy()=="notes"{"Downloading…"}else{"Download selected"}}}}
    }div{class:"ollama-actions",button{class:"button button-secondary",onclick:move |_|refresh+=1,Icon{name:"refresh",size:16}"Check connection"}button{class:"button button-ghost",onclick:move |_|on_setup.call(()),"Setup guide" Icon{name:"arrow-right",size:15}}}}
    crate::chatgpt::ChatGptConnection{settings,on_change,notify}
    div{class:"model-footer",Icon{name:"shield",size:18}p{"Speech models process audio in this browser. Optional ChatGPT notes send transcript text to OpenAI only after confirmation. Clearing browser storage removes speech models; your server-side meetings stay saved."}}
    }}
}
