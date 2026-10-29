use super::*;

/// Read saved vocabulary in display order using an existing database connection.
pub(super) fn vocabulary_db(db: &Connection) -> Result<Vec<Value>> {
    let mut stmt = db.prepare("SELECT data FROM vocabulary ORDER BY rowid")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
}
/// Return the shared vocabulary used during local transcription.
pub fn list_vocabulary() -> Result<Vec<Value>> {
    with_db(|db| vocabulary_db(db))
}
/// Create a validated term and aliases with a stable identity.
pub fn add_vocabulary(mut input: Value) -> Result<Value> {
    object(&input, &["term", "aliases", "enabled"])?;
    if input.get("aliases").is_none() {
        input["aliases"] = json!([]);
    }
    if input.get("enabled").is_none() {
        input["enabled"] = json!(true);
    }
    validate_vocabulary(&input, false)?;
    input["id"] = json!(id());
    with_db(|db| {
        let count: i64 = db.query_row("SELECT COUNT(*) FROM vocabulary", [], |r| r.get(0))?;
        if count >= 10000 {
            return Err(ApiError::bad(
                "Your vocabulary reached its 10,000-entry limit.",
            ));
        }
        db.execute(
            "INSERT INTO vocabulary VALUES(?,?)",
            params![input["id"].as_str(), input.to_string()],
        )?;
        Ok(input)
    })
}
/// Apply a validated vocabulary patch to an existing term.
pub fn update_vocabulary(key: &str, patch: Value) -> Result<Value> {
    valid_id(key)?;
    object(&patch, &["term", "aliases", "enabled"])?;
    with_db(|db| {
        let source: Option<String> = db
            .query_row("SELECT data FROM vocabulary WHERE id=?", [key], |r| {
                r.get(0)
            })
            .optional()?;
        let mut entry: Value = serde_json::from_str(
            &source
                .ok_or_else(|| ApiError::new(404, "This vocabulary entry could not be found."))?,
        )?;
        for (k, v) in patch
            .as_object()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
        {
            entry[k] = v.clone();
        }
        validate_vocabulary(&entry, true)?;
        db.execute(
            "UPDATE vocabulary SET data=? WHERE id=?",
            params![entry.to_string(), key],
        )?;
        Ok(entry)
    })
}
/// Remove a term without altering the snapshots attached to saved transcripts.
pub fn delete_vocabulary(key: &str) -> Result<()> {
    valid_id(key)?;
    with_db(|db| {
        if db.execute("DELETE FROM vocabulary WHERE id=?", [key])? == 0 {
            return Err(ApiError::new(
                404,
                "This vocabulary entry could not be found.",
            ));
        }
        Ok(())
    })
}
