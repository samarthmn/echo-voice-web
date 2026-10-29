//! An installation can register and retrieve only its own browser-vault key.
//! The parent database is encrypted with the OS-protected library key. No key
//! enters same-origin status/list responses or another installation's scope.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

pub(super) fn init_schema(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS extension_vaults(installation_id TEXT PRIMARY KEY,vault_id TEXT NOT NULL,data TEXT NOT NULL);")?;
    Ok(())
}
fn validated(v: &Value) -> Result<&str> {
    fields(v, &["vaultId", "privateMaterial", "descriptor"])?;
    let id = text(v, "vaultId", 36)?;
    uid(id)?;
    let material = STANDARD
        .decode(text(v, "privateMaterial", 344)?)
        .map_err(|_| ApiError::bad("Invalid vault key."))?;
    if !(32..=256).contains(&material.len()) {
        return Err(ApiError::bad("Invalid vault key."));
    }
    let descriptor = &v["descriptor"];
    fields(descriptor, &["version", "vaultId", "publicKey", "recovery"])?;
    if descriptor["version"] != 1 || descriptor["vaultId"] != id {
        return Err(ApiError::bad("Invalid vault descriptor."));
    }
    let public = STANDARD
        .decode(text(descriptor, "publicKey", 88)?)
        .map_err(|_| ApiError::bad("Invalid vault identity."))?;
    if public.len() != 65 || public[0] != 4 {
        return Err(ApiError::bad("Invalid vault identity."));
    }
    let recovery = &descriptor["recovery"];
    fields(recovery, &["version", "nonce", "ciphertext"])?;
    if recovery["version"] != 1
        || STANDARD
            .decode(text(recovery, "nonce", 16)?)
            .ok()
            .is_none_or(|bytes| bytes.len() != 12)
        || STANDARD
            .decode(text(recovery, "ciphertext", 512)?)
            .ok()
            .is_none_or(|bytes| !(48..=384).contains(&bytes.len()))
    {
        return Err(ApiError::bad("Invalid vault recovery data."));
    }
    Ok(id)
}
pub(super) async fn save(headers: HeaderMap, Json(value): Json<Value>) -> Result<Json<Value>> {
    let id = validated(&value)?.to_string();
    store::run(move |db| {
        let tx = db.transaction()?;
        let installation = authenticated(&tx, &headers)?;
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT vault_id,data FROM extension_vaults WHERE installation_id=?",
                [&installation],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((existing_id, existing_data)) = existing {
            if existing_id != id || serde_json::from_str::<Value>(&existing_data)? != value {
                return Err(ApiError::new(409,"This installation already has a different recording vault. Its saved key has not been replaced."));
            }
        } else {
            tx.execute(
                "INSERT INTO extension_vaults(installation_id,vault_id,data) VALUES(?,?,?)",
                params![installation, id, serde_json::to_string(&value)?],
            )?;
        }
        let library_id = library(&tx)?;
        tx.commit()?;
        Ok(reply(
            json!({"vaultId":id,"libraryId":library_id,"registered":true}),
        ))
    }).await
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
