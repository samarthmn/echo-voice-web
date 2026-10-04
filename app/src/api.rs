use serde_json::Value;

async fn request(method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let url = format!("/api{path}");
    let builder = gloo_net::http::RequestBuilder::new(&url)
        .method(method.parse().map_err(|_| "Invalid request")?);
    let response = match body {
        Some(value) => {
            builder
                .json(&value)
                .map_err(|e| e.to_string())?
                .send()
                .await
        }
        None => builder.send().await,
    }
    .map_err(|_| {
        "Your local server is not responding. Check that Echo is running and try again.".to_string()
    })?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|_| "The server returned an unreadable response.".to_string())?;
    if status >= 400 {
        return Err(value["error"]
            .as_str()
            .unwrap_or("Something went wrong. Please try again.")
            .to_string());
    }
    Ok(value)
}
pub async fn get(path: &str) -> Result<Value, String> {
    request("GET", path, None).await
}
pub async fn post(path: &str, value: Value) -> Result<Value, String> {
    request("POST", path, Some(value)).await
}
pub async fn patch(path: &str, value: Value) -> Result<Value, String> {
    request("PATCH", path, Some(value)).await
}
pub async fn delete(path: &str) -> Result<Value, String> {
    request("DELETE", path, None).await
}
pub fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_string()
}
pub fn time(seconds: f64) -> String {
    let n = seconds.max(0.) as u64;
    format!("{}:{:02}", n / 60, n % 60)
}

/// Stored timestamps are UTC; display the calendar date in this browser's timezone.
pub fn local_date(value: &str) -> String {
    let date = js_sys::Date::new(&wasm_bindgen::JsValue::from_str(value));
    if !date.get_time().is_finite() {
        return value.to_string();
    }
    format!(
        "{:04}-{:02}-{:02}",
        date.get_full_year(),
        date.get_month() + 1,
        date.get_date()
    )
}

pub fn local_date_time(value: &str) -> String {
    let date = js_sys::Date::new(&wasm_bindgen::JsValue::from_str(value));
    if !date.get_time().is_finite() {
        return value.to_string();
    }
    let offset = -date.get_timezone_offset() as i32;
    format!(
        "{} · {:02}:{:02}:{:02} UTC{}{:02}:{:02}",
        local_date(value),
        date.get_hours(),
        date.get_minutes(),
        date.get_seconds(),
        if offset >= 0 { "+" } else { "−" },
        offset.abs() / 60,
        offset.abs() % 60
    )
}
pub fn bytes(n: f64) -> String {
    let n = if n.is_finite() && n > 0. { n } else { 0. };
    if n < 1024. {
        format!("{n:.0} B")
    } else if n < 1048576. {
        format!("{:.1} KB", n / 1024.)
    } else if n < 1073741824. {
        format!("{:.1} MB", n / 1048576.)
    } else {
        format!("{:.1} GB", n / 1073741824.)
    }
}

/// JavaScript may successfully return `undefined`; normalize it before crossing
/// the JSON bridge, and preserve actionable browser errors as plain text.
pub async fn evaluate(script: &str) -> Result<Value, String> {
    let source = format!(
        r#"try {{ const value = await (async () => {{ {script} }})(); return {{ok:true,value:value === undefined ? null : value}}; }} catch(error) {{ return {{ok:false,error:error?.message || String(error)}}; }}"#
    );
    let result = dioxus::document::eval(&source)
        .await
        .map_err(|_| "The browser action could not finish. Please try again.".to_string())?;
    if result["ok"] == true {
        Ok(result["value"].clone())
    } else {
        Err(result["error"]
            .as_str()
            .unwrap_or("The browser action could not finish.")
            .to_string())
    }
}
