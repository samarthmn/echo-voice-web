use super::*;

/// Define initial workspace preferences for local speech and notes processing.
pub(super) fn defaults() -> Value {
    json!({"name":"","speechModel":"onnx-community/whisper-large-v3-turbo","notesModel":"qwen2.5:3b","notesProvider":"ollama","chatgptModel":"","ollamaUrl":"http://127.0.0.1:11434","language":"en","autoTranscribe":true,"retainAudio":true,"onboardingComplete":false})
}
/// Merge saved preferences with current defaults and migrate legacy provider settings.
pub(super) fn normalized_settings(saved: Value) -> Result<Value> {
    validate_settings(&saved, false)?;
    let mut settings = defaults();
    for (key, value) in saved
        .as_object()
        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
    {
        settings[key] = value.clone();
    }
    if matches!(
        settings["speechModel"].as_str(),
        Some("onnx-community/whisper-tiny.en" | "onnx-community/whisper-base")
    ) {
        settings["speechModel"] = json!("onnx-community/whisper-large-v3-turbo");
    }
    validate_settings(&settings, true)?;
    Ok(settings)
}
/// Read normalized preferences using an existing database transaction.
pub(crate) fn settings_db(db: &Connection) -> Result<Value> {
    let source: Option<String> = db
        .query_row(
            "SELECT data FROM preferences WHERE id='settings'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    normalized_settings(match source {
        Some(s) => serde_json::from_str(&s)?,
        None => json!({}),
    })
}
/// Return current workspace preferences with migrations applied.
pub fn get_settings() -> Result<Value> {
    with_db(|db| settings_db(db))
}
/// Validate preference fields and enforce local provider URLs and supported provider choices.
pub(super) fn validate_settings(v: &Value, full: bool) -> Result<()> {
    object(
        v,
        &[
            "name",
            "speechModel",
            "notesModel",
            "notesProvider",
            "chatgptModel",
            "ollamaUrl",
            "language",
            "autoTranscribe",
            "retainAudio",
            "onboardingComplete",
        ],
    )?;
    string(v, "name", 120, false)?;
    if let Some(provider) = string(v, "notesProvider", 20, full)? {
        validate_notes_provider(provider)?;
    }
    if let Some(model) = string(v, "chatgptModel", 200, false)? {
        if !model.is_empty()
            && (!model.as_bytes()[0].is_ascii_alphanumeric()
                || !model
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._:/-".contains(&c))
                || model.contains("..")
                || model.contains("//"))
        {
            return Err(ApiError::bad(
                "Choose a valid ChatGPT model, or leave it empty to use the account default.",
            ));
        }
    }
    if full && v.get("chatgptModel").is_none() {
        return Err(ApiError::bad("The ChatGPT model setting is missing."));
    }
    for key in ["speechModel", "notesModel", "language"] {
        string(v, key, 200, full || v.get(key).is_some())?;
    }
    for key in ["autoTranscribe", "retainAudio", "onboardingComplete"] {
        boolean(v, key, full)?;
    }
    if let Some(url) = string(v, "ollamaUrl", 500, full)? {
        let parsed = reqwest::Url::parse(url)
            .map_err(|_| ApiError::bad("Enter a valid local Ollama URL."))?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !matches!(
                parsed.host_str(),
                Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
            )
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.path() != "/"
        {
            return Err(ApiError::bad("The notes provider must use localhost, 127.0.0.1, or ::1 without credentials or a path."));
        }
    }
    Ok(())
}
/// Merge an allowlisted preference patch and persist the validated result.
pub fn update_settings(patch: Value) -> Result<Value> {
    validate_settings(&patch, false)?;
    with_db(|db| {
        let mut settings = settings_db(db)?;
        for (k, v) in patch
            .as_object()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
        {
            settings[k] = v.clone();
        }
        validate_settings(&settings, true)?;
        db.execute("INSERT INTO preferences VALUES('settings',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",[settings.to_string()])?;
        Ok(settings)
    })
}
