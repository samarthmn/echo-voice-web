//! Migration-only escrow of legacy (pre-v3) browser-vault keys: an installation can read
//! and delete only its own record; new records are never accepted. The parent database is
//! encrypted with the OS-protected library key, and no key enters same-origin responses.
use super::*;
pub(super) fn init_schema(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS extension_vaults(installation_id TEXT PRIMARY KEY,vault_id TEXT NOT NULL,data TEXT NOT NULL);")?;
    Ok(())
}
pub(super) async fn remove(headers: HeaderMap) -> Result<StatusCode> {
    store::run(move |db| {
        let installation = authenticated(db, &headers)?;
        db.execute(
            "DELETE FROM extension_vaults WHERE installation_id=?",
            [installation],
        )?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct VaultQuery {
    #[serde(rename = "vaultId")]
    id: String,
}
pub(super) async fn read(
    headers: HeaderMap,
    Query(query): Query<VaultQuery>,
) -> Result<Json<Value>> {
    uid(&query.id)?;
    store::run(move |db| {
        let installation = authenticated(db, &headers)?;
        let existing: Option<(String, String)> = db
            .query_row(
                "SELECT vault_id,data FROM extension_vaults WHERE installation_id=?",
                [installation],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (id,data)=existing.ok_or_else(||ApiError::new(404,"This recording vault has not been registered with Echo. Unlock it with your recovery phrase."))?;
        if id != query.id {
            return Err(ApiError::new(
                409,
                "Echo has a different vault registered for this installation.",
            ));
        }
        let mut result: Value = serde_json::from_str(&data)?;
        result["libraryId"] = json!(library(db)?);
        Ok(reply(result))
    }).await
}
