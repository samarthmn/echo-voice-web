//! One-approval browser pairing (protocol v2) and single-use Echo-initiated intents.
//! Only SHA-256 digests of claim secrets, credentials, and intents are stored.
use super::*;
use rand::{rngs::OsRng, RngCore};
use std::sync::{Mutex, OnceLock};

/// A request stays decidable for this long; decided rows are kept as long again for claim retries.
const REQUEST_SECONDS: i64 = 600;
const INTENT_SECONDS: i64 = 120;
const MAX_INTENTS: usize = 32;
static INTENTS: OnceLock<Mutex<Vec<(String, i64)>>> = OnceLock::new();

fn hex_secret<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    let s = text(v, key, 64)?;
    if s.len() != 64
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(ApiError::bad(format!(
            "Use a 64-character lowercase hexadecimal {key}."
        )));
    }
    Ok(s)
}
/// Compare digests without an early exit on the first differing byte.
fn equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |v, (x, y)| v | (x ^ y)) == 0
}
fn cleanup(db: &Connection, now: i64) -> Result<()> {
    db.execute(
        "DELETE FROM extension_pairing WHERE expires<=?",
        [now - REQUEST_SECONDS],
    )?;
    Ok(())
}
/// Delete pairing rows that outlived their retry window even when no extension calls again.
pub(crate) async fn cleanup_loop() {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
    loop {
        interval.tick().await;
        if let Err(error) = store::run(|db| cleanup(db, seconds())).await {
            tracing::warn!(%error, "Could not clean up expired extension pairing requests");
        }
    }
}
struct RequestRow {
    installation: String,
    name: String,
    origin: String,
    digest: String,
    expires: i64,
    state: String,
}
fn row(db: &Connection, id: &str) -> Result<Option<RequestRow>> {
    Ok(db.query_row("SELECT installation_id,name,origin,code_hash,expires,state FROM extension_pairing WHERE request_id=?", [id], |r| Ok(RequestRow { installation:r.get(0)?, name:r.get(1)?, origin:r.get(2)?, digest:r.get(3)?, expires:r.get(4)?, state:r.get(5)? })).optional()?)
}
/// An approval given in time stays claimable until cleanup, so a lost claim response can be retried.
fn status(row: &RequestRow, now: i64) -> &str {
    match row.state.as_str() {
        "approved" | "claimed" => "approved",
        _ if row.expires <= now => "expired",
        "cancelled" => "rejected",
        state => state,
    }
}
fn intents() -> Result<std::sync::MutexGuard<'static, Vec<(String, i64)>>> {
    INTENTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| ApiError::new(500, "Echo hit an internal error; retry."))
}
fn consume_intent(value: &str, now: i64) -> Result<bool> {
    let mut intents = intents()?;
    intents.retain(|(_, expires)| *expires > now);
    let digest = hash(value);
    let found = intents
        .iter()
        .position(|(stored, _)| equal(stored, &digest));
    Ok(found.map(|index| intents.swap_remove(index)).is_some())
}
/// Issue a single-use, two-minute token that pre-approves one Echo-initiated pairing.
pub(super) async fn intent() -> Result<Json<Value>> {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let value = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let now = seconds();
    let expires = now + INTENT_SECONDS;
    let mut intents = intents()?;
    intents.retain(|(_, expiry)| *expiry > now);
    if intents.len() >= MAX_INTENTS {
        intents.remove(0);
    }
    intents.push((hash(&value), expires));
    Ok(Json(json!({"intent":value,"expiresAt":expires})))
}
/// Unauthenticated discovery probe; reads only the library identifier.
pub(super) async fn hello() -> Result<Json<Value>> {
    store::run(|db| {
        Ok(Json(
            json!({"service":"echo-voice","protocolVersion":2,"libraryId":library(db)?}),
        ))
    })
    .await
}
pub(super) async fn pair(headers: HeaderMap, Json(v): Json<Value>) -> Result<Json<Value>> {
    fields(&v, &["installationId", "name", "claimSecret", "intent"])?;
    let installation = text(&v, "installationId", 36)?.to_owned();
    uid(&installation)?;
    let name = text(&v, "name", 100)?.to_owned();
    let digest = hash(hex_secret(&v, "claimSecret")?);
    let intent = match v.get("intent") {
        Some(_) => Some(hex_secret(&v, "intent")?.to_owned()),
        None => None,
    };
    let origin = extension_origin(&headers)?;
    store::run(move |db| {
        let tx = db.transaction()?;
        let now = seconds();
        cleanup(&tx, now)?;
        let lib = library(&tx)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT request_id FROM extension_pairing WHERE code_hash=?",
                [&digest],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            // Idempotent retry: the same installation, origin, and secret get the same live request.
            let item = row(&tx, &id)?.ok_or_else(ApiError::not_found)?;
            let state = status(&item, now);
            if item.installation != installation
                || item.origin != origin
                || item.expires <= now
                || state == "rejected"
            {
                return Err(ApiError::new(409, "Use a new claim secret."));
            }
            return Ok(Json(
                json!({"requestId":id,"status":state,"expiresAt":item.expires,"libraryId":lib}),
            ));
        }
        let (total, from_origin): (i64, i64) = tx.query_row(
            "SELECT COUNT(*),COALESCE(SUM(origin=?),0) FROM extension_pairing WHERE expires>?",
            params![origin, now],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if total >= 16 || from_origin >= 4 {
            return Err(ApiError::new(
                429,
                "Too many browser connection attempts. Try again in ten minutes.",
            ));
        }
        let approved = match intent {
            Some(ref value) => consume_intent(value, now)?,
            None => false,
        };
        tx.execute(
            "UPDATE extension_pairing SET state='cancelled' WHERE installation_id=? AND state='pending'",
            [&installation],
        )?;
        let id = Uuid::new_v4().to_string();
        let expires = now + REQUEST_SECONDS;
        let state = if approved { "approved" } else { "pending" };
        tx.execute(
            "INSERT INTO extension_pairing(code_hash,expires,request_id,installation_id,name,origin,state) VALUES(?,?,?,?,?,?,?)",
            params![digest, expires, id, installation, name, origin, state],
        )?;
        tx.commit()?;
        Ok(Json(
            json!({"requestId":id,"status":state,"expiresAt":expires,"libraryId":lib}),
        ))
    })
    .await
}
fn refused(state: &str) -> Response {
    (StatusCode::FORBIDDEN, Json(json!({"status":state}))).into_response()
}
pub(super) async fn claim(headers: HeaderMap, Json(v): Json<Value>) -> Result<Response> {
    fields(&v, &["requestId", "installationId", "claimSecret"])?;
    let id = text(&v, "requestId", 36)?.to_owned();
    uid(&id)?;
    let installation = text(&v, "installationId", 36)?.to_owned();
    uid(&installation)?;
    let secret = hex_secret(&v, "claimSecret")?.to_owned();
    let origin = extension_origin(&headers)?;
    store::run(move |db| {
        let tx = db.transaction()?;
        let now = seconds();
        cleanup(&tx, now)?;
        let digest = hash(&secret);
        let Some(item) = row(&tx, &id)?.filter(|r| {
            r.installation == installation && r.origin == origin && equal(&r.digest, &digest)
        }) else {
            tx.commit()?;
            return Ok(refused("unknown"));
        };
        match status(&item, now) {
            "approved" => {}
            "pending" => {
                tx.commit()?;
                return Ok(Json(json!({"status":"pending"})).into_response());
            }
            state => {
                let response = refused(state);
                tx.commit()?;
                return Ok(response);
            }
        }
        let lib = library(&tx)?;
        let credential = hash(format!(
            "echo-extension-v2\0{secret}\0{id}\0{installation}\0{lib}"
        ));
        if item.state == "approved" {
            tx.execute(
                "INSERT INTO extension_connections(installation_id,name,origin,credential_hash,created_at) VALUES(?,?,?,?,?) ON CONFLICT(installation_id) DO UPDATE SET name=excluded.name,origin=excluded.origin,credential_hash=excluded.credential_hash,created_at=excluded.created_at",
                params![installation, item.name, origin, hash(&credential), store::now()],
            )?;
            tx.execute(
                "UPDATE extension_pairing SET state='claimed' WHERE request_id=?",
                [&id],
            )?;
        }
        tx.commit()?;
        Ok(Json(json!({"status":"approved","credential":credential,"libraryId":lib})).into_response())
    })
    .await
}
/// Cancel an undecided or unclaimed request; unknown or mismatched requests are ignored.
pub(super) async fn cancel(
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(v): Json<Value>,
) -> Result<StatusCode> {
    fields(&v, &["installationId", "claimSecret"])?;
    let installation = text(&v, "installationId", 36)?.to_owned();
    uid(&installation)?;
    uid(&id)?;
    let digest = hash(hex_secret(&v, "claimSecret")?);
    let origin = extension_origin(&headers)?;
    store::run(move |db| {
        if let Some(item) = row(db, &id)? {
            if item.installation == installation
                && item.origin == origin
                && equal(&item.digest, &digest)
                && item.state != "claimed"
            {
                db.execute(
                    "UPDATE extension_pairing SET state='cancelled' WHERE request_id=?",
                    [&id],
                )?;
            }
        }
        cleanup(db, seconds())?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}
pub(super) async fn request_metadata(Path(id): Path<String>) -> Result<Json<Value>> {
    uid(&id)?;
    store::run(move |db| {
        let item = row(db,&id)?.ok_or_else(ApiError::not_found)?;
        Ok(reply(json!({"requestId":id,"installationId":item.installation,"libraryId":library(db)?,"name":item.name,"origin":item.origin,"status":status(&item,seconds()),"expiresAt":item.expires})))
    }).await
}
pub(super) async fn approve(Path(id): Path<String>) -> Result<Json<Value>> {
    decision(id, true).await
}
pub(super) async fn reject(Path(id): Path<String>) -> Result<Json<Value>> {
    decision(id, false).await
}
async fn decision(id: String, approved: bool) -> Result<Json<Value>> {
    uid(&id)?;
    store::run(move |db| {
        let item = row(db, &id)?.ok_or_else(ApiError::not_found)?;
        if item.expires <= seconds() {
            return Err(ApiError::new(403, "Pairing request expired."));
        }
        let target = if approved { "approved" } else { "rejected" };
        let repeated = item.state == target || (approved && item.state == "claimed");
        if item.state == "pending" || (!approved && item.state == "approved") {
            db.execute(
                "UPDATE extension_pairing SET state=? WHERE request_id=?",
                params![target, id],
            )?;
        } else if !repeated {
            return Err(ApiError::new(
                409,
                "Pairing request is no longer available.",
            ));
        }
        Ok(reply(
            json!({"requestId":id,"status":target,"libraryId":library(db)?,"expiresAt":item.expires}),
        ))
    })
    .await
}
pub(super) fn revoke_connection(db: &mut Connection, installation: &str) -> Result<()> {
    let tx = db.transaction()?;
    tx.execute(
        "DELETE FROM extension_connections WHERE installation_id=?",
        [installation],
    )?;
    tx.execute("UPDATE extension_pairing SET state='cancelled' WHERE installation_id=? AND state IN ('pending','approved','claimed')", [installation])?;
    cleanup(&tx, seconds())?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
pub(super) fn expire_intents_for_test() {
    if let Ok(mut intents) = intents() {
        for (_, expiry) in intents.iter_mut() {
            *expiry = 0;
        }
    }
}
