use crate::{
    api::{delete, get, patch, post, text},
    Icon,
};
use dioxus::prelude::*;
use serde_json::{json, Value};

#[component]
pub fn ChatGptConnection(
    settings: Signal<Value>,
    on_change: EventHandler<Value>,
    notify: EventHandler<String>,
) -> Element {
    let mut status = use_signal(|| Value::Null);
    let mut models = use_signal(Vec::<Value>::new);
    let mut login = use_signal(|| Value::Null);
    let mut operation = use_signal(String::new);
    let mut error = use_signal(String::new);
    let mut loading = use_signal(|| true);
    let mut refresh = use_signal(|| 0_u32);
    use_resource(move || {
        let _ = refresh();
        async move {
            match get("/chatgpt").await {
                Ok(value) => {
                    error.set(String::new());
                    if value["connected"] == true {
                        login.set(Value::Null);
                        match get("/chatgpt/models").await {
                            Ok(catalog) => models
                                .set(catalog["models"].as_array().cloned().unwrap_or_default()),
                            Err(message) => error.set(message),
                        }
                    } else if value["login"]["pending"] == true {
                        login.set(value["login"].clone());
                    } else {
                        login.set(Value::Null);
                        if let Some(message) = value["login"]["error"].as_str() {
                            error.set(message.into());
                        }
                    }
                    status.set(value);
                }
                Err(message) => {
                    status.set(Value::Null);
                    models.set(Vec::new());
                    error.set(message);
                }
            }
            loading.set(false);
        }
    });
    use_future(move || async move {
        loop {
            let _ =
                document::eval("await new Promise(resolve=>setTimeout(resolve,3000));return true;")
                    .await;
            if !login().is_null() && operation().is_empty() {
                refresh += 1;
            }
        }
    });
    let value = status();
    let connected = value["connected"] == true;
    let installed = value["installed"] == true;
    let busy = !operation().is_empty() || value["busy"] == true;
    let default = settings()["notesProvider"] == "chatgpt";
    let auth_url = text(&login(), "authUrl");
    let pending = !login().is_null();
    let account = value["account"].clone();
    let plan = text(&account, "planType");
    let provider_error = text(&value, "error");
    let limits = value["rateLimits"].clone();
    // The backend exposes only the Codex allowance snapshot, never account tokens.
    let limit = if limits["rateLimits"].is_object() {
        limits["rateLimits"].clone()
    } else {
        limits.clone()
    };
    rsx! {
        section { id:"chatgpt-connection", class:"panel chatgpt-panel", aria_label:"ChatGPT connection",
            div {class:"chatgpt-heading",
                span {class:"model-symbol",Icon{name:"sparkles",size:25}}
                div {h2 {"Bring your ChatGPT plan."}p {"Optional cloud intelligence, through the official Codex integration."}}
                span {class:if connected{"badge badge-green"}else{"badge"},if connected{"Connected"}else{"Optional connection"}}
            }
            p {class:"chatgpt-disclosure","Use an eligible plan’s Codex allowance for summaries, decisions, and action items. When you confirm a request, transcript text and speaker labels go to OpenAI. Recording and speech transcription stay on this device."}
            if !error().is_empty() {div {class:"inline-error",role:"alert",Icon{name:"alert",size:18},"{error}"}}
            if !provider_error.is_empty() {p {class:"chatgpt-status-message",role:"status","{provider_error}"}}
            if loading() {div {class:"chatgpt-status-message",role:"status",span{class:"spinner"}"Checking the local Codex helper…"}}
            else if value.is_null() {p {class:"chatgpt-status-message","Connection status is unavailable. Refresh to check again."}}
            else if !installed {
                div {class:"chatgpt-setup",
                    strong {"Set up the local sign-in helper"}
                    p {"Echo uses OpenAI’s Codex helper to manage your login. Source builds install it automatically on supported platforms. If it’s missing, install the supported version, then check again:"}
                    code {"npm install -g @openai/codex@0.160.0"}
                    p {"For a standalone binary, set ECHO_CODEX_BIN and restart Echo. Your existing Codex login is kept separate."}
                }
            } else if connected {
                div {class:"chatgpt-account",
                    div {span {class:"connection-dot ready"}strong {{text(&account,"email")}}if !plan.is_empty() {span {class:"badge","{plan} plan"}}}
                    p {"Signed in through Codex. This does not provide API credits or access to every ChatGPT feature."}
                }
                div {class:"chatgpt-model-choice",
                    label {r#for:"chatgpt-notes-model","Notes model"}
                    select {id:"chatgpt-notes-model",class:"input",value:text(&settings(),"chatgptModel"),disabled:busy,
                        onchange:move|event| {let model=event.value();spawn(async move {match patch("/settings",json!({"chatgptModel":model})).await {Ok(saved)=>{error.set(String::new());on_change.call(saved);},Err(message)=>error.set(message)}});},
                        option {value:"",selected:text(&settings(),"chatgptModel").is_empty(),"Account default"}
                        for model in models() {option {value:text(&model,"id"),selected:text(&settings(),"chatgptModel")==text(&model,"id"),{text(&model,"displayName")}}}
                    }
                    p {"Models come from your connected account. Availability and usage limits depend on your plan."}
                }
                if limit["primary"].is_object() || limit["secondary"].is_object() {
                    div {class:"chatgpt-usage",aria_label:"Codex subscription usage",
                        h3 {"Your Codex allowance"}
                        if limit["primary"].is_object() {UsageWindow{label:"Current usage window",window:limit["primary"].clone()}}
                        if limit["secondary"].is_object() {UsageWindow{label:"Longer usage window",window:limit["secondary"].clone()}}
                        p {"Reported by OpenAI. Allowances are shared with other Codex sessions; token counts on a note are not a remaining balance."}
                    }
                } else {p {class:"chatgpt-status-message","Usage information isn’t available right now. OpenAI still enforces your plan’s limits."}}
                if limits["ordinaryUsageAllowed"] == false {div {class:"inline-error",role:"alert","Included usage is currently unavailable. Check your plan or wait for its allowance to reset. Echo won’t switch to API billing."}}
            }
            if pending {
                div {class:"chatgpt-login",role:"status",
                    strong {"Finish signing in with OpenAI"}
                    p {"Open the secure sign-in page in this browser. Return here afterward; Echo will check the connection automatically."}
                    div {class:"chatgpt-actions",
                        if !auth_url.is_empty() {a {class:"button button-primary",href:"{auth_url}",target:"_blank",rel:"noopener noreferrer","Open ChatGPT sign-in" Icon{name:"arrow",size:16}}}
                        button {class:"button button-secondary",disabled:busy,onclick:move |_| {spawn(async move {operation.set("cancel".into());match delete("/chatgpt/login").await {Ok(_)=>{login.set(Value::Null);refresh+=1;},Err(message)=>error.set(message)}operation.set(String::new());});},"Cancel sign-in"}
                    }
                }
            }
            div {class:"chatgpt-actions",
                if connected {
                    button {class:if default{"button button-secondary"}else{"button button-primary"},disabled:busy||default,
                        onclick:move |_| {spawn(async move {match patch("/settings",json!({"notesProvider":"chatgpt"})).await {Ok(saved)=>{on_change.call(saved);notify.call("ChatGPT is selected for notes. Each request still asks before sending transcript text.".into());},Err(message)=>error.set(message)}});},
                        Icon{name:if default{"check"}else{"sparkles"},size:16}if default{"Default notes provider"}else{"Use ChatGPT for notes"}}
                    button {class:"button button-ghost",disabled:busy,onclick:move |_| {spawn(async move {operation.set("logout".into());error.set(String::new());match post("/chatgpt/logout",json!({})).await {Ok(_)=>{status.set(Value::Null);models.set(Vec::new());login.set(Value::Null);notify.call("ChatGPT disconnected from Echo. Your saved notes remain here.".into());refresh+=1;},Err(message)=>error.set(message)}operation.set(String::new());});},"Disconnect ChatGPT"}
                } else if installed && !pending {
                    button {class:"button button-primary",disabled:busy,onclick:move |_| {spawn(async move {operation.set("login".into());error.set(String::new());match post("/chatgpt/login",json!({})).await {Ok(response)=>{if response["pending"]==true {login.set(response);}else {login.set(Value::Null);refresh+=1;}},Err(message)=>error.set(message)}operation.set(String::new());});},
                        Icon{name:"link",size:16}if operation()=="login"{"Preparing sign-in…"}else{"Sign in with ChatGPT"}}
                }
                button {class:"button button-secondary",disabled:busy||loading(),onclick:move |_| {error.set(String::new());refresh+=1;},Icon{name:"refresh",size:16}"Refresh ChatGPT connection"}
            }
            p {class:"chatgpt-footnote",Icon{name:"shield",size:15}"Your login is managed by the local Codex helper and excluded from Echo backups. No API key is required. Ollama remains available for fully local notes."}
        }
    }
}

#[component]
fn UsageWindow(label: String, window: Value) -> Element {
    let used = window["usedPercent"].as_f64();
    let minutes = window["windowDurationMins"].as_i64();
    let title = match minutes {
        Some(n) if n >= 1440 => format!("{} day window", n / 1440),
        Some(n) if n >= 60 => format!("{} hour window", n / 60),
        Some(n) => format!("{n} minute window"),
        None => label,
    };
    let reset = window["resetsAt"].as_f64().map(|value| {
        js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(value * 1000.))
            .to_locale_string("en-US", &wasm_bindgen::JsValue::UNDEFINED)
            .as_string()
            .unwrap_or_default()
    });
    rsx! {div {class:"chatgpt-usage-window",div {strong {"{title}"}span {if let Some(used)=used {{format!("{used:.0}% used")}}else{"Usage unavailable"}}}
        if let Some(used)=used {progress {max:"100",value:used.clamp(0.,100.).to_string(),aria_label:"{title} used"}}
        if let Some(reset)=reset {small {"Resets {reset}"}}
    }}
}
