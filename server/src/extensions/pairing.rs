//! Explicit approval, staged credentials, and retry receipts for extension pairing.
use super::*;

pub(super) fn migrate(db: &Connection) -> Result<()> {
    let columns = db
        .prepare("PRAGMA table_info(extension_pairing)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (name, definition) in [
        ("kind", "TEXT NOT NULL DEFAULT 'manual'"),
        ("activation_required", "INTEGER NOT NULL DEFAULT 0"),
        // A hash is enough to retain a committed receipt only while it is authorized.
        ("credential_hash", "TEXT"),
    ] {
        if !columns.iter().any(|column| column == name) {
            db.execute_batch(&format!(
                "ALTER TABLE extension_pairing ADD COLUMN {name} {definition}"
            ))?;
        }
    }
    Ok(())
}

struct Reservation {
    request: Option<String>,
    installation: Option<String>,
    name: Option<String>,
    origin: Option<String>,
    code_hash: String,
    expires: i64,
    state: String,
    kind: String,
    staged: bool,
    credential_hash: Option<String>,
}
fn reservation(db: &Connection, column: &str, value: &str) -> Result<Option<Reservation>> {
    debug_assert!(matches!(column, "request_id" | "code_hash"));
    Ok(db.query_row(
        &format!("SELECT request_id,installation_id,name,origin,code_hash,expires,state,kind,activation_required,credential_hash FROM extension_pairing WHERE {column}=?"),
        [value],
        |row| Ok(Reservation {
            request: row.get(0)?, installation: row.get(1)?, name: row.get(2)?,
            origin: row.get(3)?, code_hash: row.get(4)?, expires: row.get(5)?,
            state: row.get(6)?, kind: row.get(7)?, staged: row.get(8)?, credential_hash: row.get(9)?,
        }),
    ).optional()?)
}
fn current_receipt(db: &Connection, row: &Reservation) -> Result<bool> {
    Ok(row.state == "claimed" && db.query_row(
        "SELECT EXISTS(SELECT 1 FROM extension_connections WHERE installation_id=? AND origin=? AND credential_hash=?)",
        params![row.installation, row.origin, row.credential_hash], |r| r.get::<_, bool>(0),
    )?)
}
fn cleanup(db: &Connection, now: i64) -> Result<()> {
    db.execute("DELETE FROM extension_pairing WHERE expires<=? AND NOT (activation_required=1 AND state='claimed' AND EXISTS(SELECT 1 FROM extension_connections c WHERE c.installation_id=extension_pairing.installation_id AND c.origin=extension_pairing.origin AND c.credential_hash=extension_pairing.credential_hash))", [now])?;
    Ok(())
}
fn reserve_capacity(db: &Connection, origin: Option<&str>, now: i64) -> Result<()> {
    cleanup(db, now)?;
    let count: i64 = db.query_row(
        "SELECT COUNT(*) FROM extension_pairing WHERE expires>?",
        [now],
        |r| r.get(0),
    )?;
    if count >= 20 {
        return Err(ApiError::new(
            429,
            "Too many active pairing requests. Try again in five minutes.",
        ));
    }
    if let Some(origin) = origin {
        let (browser, from_origin): (i64, i64) = db.query_row(
            "SELECT COUNT(*),COALESCE(SUM(origin=?),0) FROM extension_pairing WHERE kind='browser' AND expires>?",
            params![origin, now], |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if browser >= 16 || from_origin >= 4 {
            return Err(ApiError::new(
                429,
                "Too many browser connection attempts. Try again in five minutes.",
            ));
        }
    }
    Ok(())
}
fn public_status(row: &Reservation, lib: &str) -> Value {
    json!({"requestId":row.request,"installationId":row.installation,"libraryId":lib,"status":row.state,"expiresAt":row.expires,"activationRequired":row.staged && row.state != "claimed"})
}
fn require_live(row: &Reservation, now: i64) -> Result<()> {
    if row.expires <= now {
        return Err(ApiError::new(403, "Pairing request is invalid or expired."));
    }
    Ok(())
}
fn bound_request(
    db: &Connection,
    request: &str,
    installation: &str,
    secret: &str,
    origin: &str,
) -> Result<Reservation> {
    let row = reservation(db, "request_id", request)?
        .ok_or_else(|| ApiError::new(403, "Pairing request is invalid or expired."))?;
    if row.installation.as_deref() != Some(installation)
        || row.origin.as_deref() != Some(origin)
        || row.code_hash != hash(secret)
    {
        return Err(ApiError::new(403, "Pairing request is invalid or expired."));
    }
    Ok(row)
}
fn identifying_fields<'a>(v: &'a Value, secret_key: &str) -> Result<(&'a str, &'a str, &'a str)> {
    let request = text(v, "requestId", 36)?;
    let installation = text(v, "installationId", 36)?;
    uid(request)?;
    uid(installation)?;
    Ok((request, installation, text(v, secret_key, 64)?))
}
fn credential(secret: &str, request: &str, installation: &str, lib: &str) -> String {
    hash(format!(
        "echo-extension-v1\0{secret}\0{request}\0{installation}\0{lib}"
    ))
}
fn receipt(row: &Reservation, lib: &str, credential: &str) -> Json<Value> {
    let mut value = public_status(row, lib);
    value["credential"] = json!(credential);
    if !row.staged {
        value["status"] = json!("approved");
    }
    reply(value)
}
fn require_current(db: &Connection, row: &Reservation, credential: &str) -> Result<()> {
    // A committed retry verifies authorization; it never inserts a connection.
    let present: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM extension_connections WHERE installation_id=? AND origin=? AND credential_hash=?)",
        params![row.installation, row.origin, hash(credential)], |r| r.get(0),
    )?;
    if !present || (row.staged && row.credential_hash.as_deref() != Some(hash(credential).as_str()))
    {
        return Err(ApiError::new(
            403,
            "Connection was revoked or replaced; start a new connection request.",
        ));
    }
    Ok(())
}
fn commit_connection(db: &Connection, row: &Reservation, credential: &str) -> Result<()> {
    db.execute("INSERT INTO extension_connections VALUES(?,?,?,?,?) ON CONFLICT(installation_id) DO UPDATE SET name=excluded.name,origin=excluded.origin,credential_hash=excluded.credential_hash,created_at=excluded.created_at", params![row.installation,row.name,row.origin,hash(credential),store::now()])?;
    db.execute(
        "UPDATE extension_pairing SET state='claimed',credential_hash=? WHERE request_id=?",
        params![hash(credential), row.request],
    )?;
    Ok(())
}

pub(super) async fn pair_begin(headers: HeaderMap, Json(v): Json<Value>) -> Result<Json<Value>> {
    store::run(move |db| {
    fields(&v, &["requestId", "installationId", "name", "claimSecret"])?;
    let (request, installation, secret) = identifying_fields(&v, "claimSecret")?;
    if secret.len() != 64
        || !secret
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(ApiError::bad(
            "Use a 64-character lowercase hexadecimal claim secret.",
        ));
    }
    let name = text(&v, "name", 100)?;
    let origin = extension_origin(&headers)?;
        let tx = db.transaction()?;
        let now = seconds();
        let lib = library(&tx)?;
        if let Some(row) = reservation(&tx, "request_id", request)? {
            if row.kind != "browser"
                || row.installation.as_deref() != Some(installation)
                || row.name.as_deref() != Some(name)
                || row.origin.as_deref() != Some(&origin)
                || row.code_hash != hash(secret)
            {
                return Err(ApiError::new(
                    409,
                    "The request identifier belongs to a different connection attempt.",
                ));
            }
            if row.state == "claimed" {
                require_current(&tx, &row, &credential(secret, request, installation, &lib))?;
            } else {
                require_live(&row, now)?;
            }
            return Ok(reply(public_status(&row, &lib)));
        }
        if reservation(&tx, "code_hash", &hash(secret))?.is_some() {
            return Err(ApiError::new(
                409,
                "Use a new secret for this connection attempt.",
            ));
        }
        reserve_capacity(&tx, Some(&origin), now)?;
        let expires = now + 300;
        tx.execute("INSERT INTO extension_pairing(code_hash,expires,request_id,installation_id,name,origin,state,kind,activation_required) VALUES(?,?,?,?,?,?,'pending','browser',1)", params![hash(secret),expires,request,installation,name,origin])?;
        tx.commit()?;
        Ok(reply(
            json!({"requestId":request,"installationId":installation,"libraryId":lib,"status":"pending","expiresAt":expires,"activationRequired":true}),
        ))
    }).await
}

pub(super) async fn pair_code() -> Result<Json<Value>> {
    store::run(move |db| {
        let tx = db.transaction()?;
        let now = seconds();
        reserve_capacity(&tx, None, now)?;
        let code = Uuid::new_v4().simple().to_string();
        let expires = now + 300;
        tx.execute(
            "INSERT INTO extension_pairing(code_hash,expires,state) VALUES(?,?,'available')",
            params![hash(&code), expires],
        )?;
        let lib = library(&tx)?;
        tx.commit()?;
        Ok(reply(
            json!({"code":code,"expiresAt":expires,"libraryId":lib}),
        ))
    })
    .await
}

pub(super) async fn pair_request(headers: HeaderMap, Json(v): Json<Value>) -> Result<Json<Value>> {
    store::run(move |db| {
    fields(
        &v,
        &["code", "installationId", "name", "deferredActivation"],
    )?;
    let code = text(&v, "code", 64)?;
    let installation = text(&v, "installationId", 36)?;
    uid(installation)?;
    let name = text(&v, "name", 100)?;
    let staged = match v.get("deferredActivation") {
        None => false,
        Some(Value::Bool(value)) => *value,
        _ => return Err(ApiError::bad("deferredActivation must be a boolean.")),
    };
    let origin = extension_origin(&headers)?;
        let tx = db.transaction()?;
        let mut row = reservation(&tx, "code_hash", &hash(code))?
            .filter(|r| r.kind == "manual")
            .ok_or_else(|| ApiError::new(403, "Pairing code is invalid or expired."))?;
        require_live(&row, seconds())?;
        if row.request.is_some() {
            if row.installation.as_deref() != Some(installation)
                || row.origin.as_deref() != Some(&origin)
                || row.name.as_deref() != Some(name)
                || row.staged != staged
            {
                return Err(ApiError::new(
                    409,
                    "This code already belongs to another pairing request.",
                ));
            }
        } else {
            let request = Uuid::new_v4().to_string();
            tx.execute("UPDATE extension_pairing SET request_id=?,installation_id=?,name=?,origin=?,state='pending',activation_required=? WHERE code_hash=?", params![request,installation,name,origin,staged,hash(code)])?;
            row.request = Some(request);
            row.installation = Some(installation.into());
            row.state = "pending".into();
            row.staged = staged;
        }
        let result = reply(public_status(&row, &library(&tx)?));
        tx.commit()?;
        Ok(result)
    }).await
}

pub(super) async fn request_metadata(Path(id): Path<String>) -> Result<Json<Value>> {
    uid(&id)?;
    store::run(move |db| {
        let row = reservation(db, "request_id", &id)?.ok_or_else(ApiError::not_found)?;
        let status = if row.expires <= seconds() && !current_receipt(db, &row)? {
            "expired"
        } else {
            &row.state
        };
        Ok(reply(
            json!({"requestId":row.request,"installationId":row.installation,"libraryId":library(db)?,"name":row.name,"origin":row.origin,"kind":row.kind,"status":status,"expiresAt":row.expires}),
        ))
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
        let tx = db.transaction()?;
        let mut row = reservation(&tx, "request_id", &id)?.ok_or_else(ApiError::not_found)?;
        require_live(&row, seconds())?;
        let target = if approved { "approved" } else { "rejected" };
        if row.state == "pending"
            || (!approved && matches!(row.state.as_str(), "approved" | "prepared"))
        {
            tx.execute(
                "UPDATE extension_pairing SET state=? WHERE request_id=?",
                params![target, id],
            )?;
            row.state = target.into();
        } else if !(row.state == target
            || (approved && matches!(row.state.as_str(), "prepared" | "claimed")))
        {
            return Err(ApiError::new(
                409,
                "Pairing request is no longer available.",
            ));
        }
        let response = reply(public_status(&row, &library(&tx)?));
        tx.commit()?;
        Ok(response)
    })
    .await
}

pub(super) async fn pair_claim(headers: HeaderMap, Json(v): Json<Value>) -> Result<Json<Value>> {
    store::run(move |db| {
    fields(&v, &["requestId", "installationId", "code"])?;
    let (request, installation, secret) = identifying_fields(&v, "code")?;
    let origin = extension_origin(&headers)?;
        let tx = db.transaction()?;
        let mut row = bound_request(&tx, request, installation, secret, &origin)?;
        if row.state != "claimed" || !row.staged {
            require_live(&row, seconds())?;
        }
        let lib = library(&tx)?;
        let credential = credential(secret, request, installation, &lib);
        match row.state.as_str() {
            "pending" | "rejected" | "cancelled" => return Ok(reply(public_status(&row, &lib))),
            "claimed" => require_current(&tx, &row, &credential)?,
            "approved" if row.staged => {
                tx.execute("UPDATE extension_pairing SET state='prepared',credential_hash=? WHERE request_id=?", params![hash(&credential),request])?;
                row.state = "prepared".into();
            }
            "approved" => {
                commit_connection(&tx, &row, &credential)?;
                row.state = "claimed".into();
            }
            "prepared" if row.staged => {}
            _ => return Err(ApiError::new(403, "Pairing request is unavailable.")),
        }
        tx.commit()?;
        Ok(receipt(&row, &lib, &credential))
    }).await
}

pub(super) async fn pair_activate(headers: HeaderMap, Json(v): Json<Value>) -> Result<Json<Value>> {
    store::run(move |db| {
        fields(
            &v,
            &["requestId", "installationId", "claimSecret", "libraryId"],
        )?;
        let (request, installation, secret) = identifying_fields(&v, "claimSecret")?;
        let requested_library = text(&v, "libraryId", 36)?;
        uid(requested_library)?;
        let origin = extension_origin(&headers)?;
        let tx = db.transaction()?;
        let mut row = bound_request(&tx, request, installation, secret, &origin)?;
        let lib = library(&tx)?;
        if lib != requested_library {
            return Err(ApiError::new(
                409,
                "Confirm this Echo library before connecting.",
            ));
        }
        let credential = credential(secret, request, installation, &lib);
        if row.state == "claimed" {
            if !row.staged {
                require_live(&row, seconds())?;
            }
            require_current(&tx, &row, &credential)?;
        } else {
            require_live(&row, seconds())?;
            if !row.staged
                || row.state != "prepared"
                || row.credential_hash.as_deref() != Some(hash(&credential).as_str())
            {
                return Err(ApiError::new(
                    409,
                    "Approve and prepare this connection before activating it.",
                ));
            }
            commit_connection(&tx, &row, &credential)?;
            row.state = "claimed".into();
        }
        tx.commit()?;
        Ok(receipt(&row, &lib, &credential))
    })
    .await
}

pub(super) async fn pair_cancel(headers: HeaderMap, Json(v): Json<Value>) -> Result<Json<Value>> {
    store::run(move |db| {
        fields(
            &v,
            &["requestId", "installationId", "claimSecret", "libraryId"],
        )?;
        let (request, installation, secret) = identifying_fields(&v, "claimSecret")?;
        let origin = extension_origin(&headers)?;
        let tx = db.transaction()?;
        let mut row = bound_request(&tx, request, installation, secret, &origin)?;
        let lib = library(&tx)?;
        if let Some(requested) = v.get("libraryId") {
            if requested.as_str() != Some(&lib) {
                return Err(ApiError::new(
                    409,
                    "This request belongs to another Echo library.",
                ));
            }
        }
        if row.state == "claimed" {
            let credential = credential(secret, request, installation, &lib);
            require_current(&tx, &row, &credential)?;
            // The client must save this committed receipt and use normal disconnect.
            return Ok(receipt(&row, &lib, &credential));
        }
        if !matches!(row.state.as_str(), "cancelled" | "rejected") {
            tx.execute(
                "UPDATE extension_pairing SET state='cancelled' WHERE request_id=?",
                [request],
            )?;
            row.state = "cancelled".into();
        }
        tx.commit()?;
        Ok(reply(public_status(&row, &lib)))
    })
    .await
}

pub(super) fn revoke_connection(db: &mut Connection, installation: &str) -> Result<()> {
    let tx = db.transaction()?;
    tx.execute(
        "DELETE FROM extension_connections WHERE installation_id=?",
        [installation],
    )?;
    // Explicit revocation also fences credentials prepared before the user's action.
    tx.execute("UPDATE extension_pairing SET state='cancelled' WHERE installation_id=? AND state IN ('pending','approved','prepared')", [installation])?;
    cleanup(&tx, seconds())?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_preserves_legacy_approval_state() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE extension_pairing(code_hash TEXT PRIMARY KEY,expires INTEGER NOT NULL,request_id TEXT UNIQUE,installation_id TEXT,name TEXT,origin TEXT,state TEXT NOT NULL);
            INSERT INTO extension_pairing VALUES('hashed-code',12345,'request','installation','Browser','origin','approved');").unwrap();
        init_schema(&db).unwrap();
        init_schema(&db).unwrap();
        let row = reservation(&db, "request_id", "request").unwrap().unwrap();
        assert_eq!(row.state, "approved");
        assert_eq!(row.kind, "manual");
        assert!(!row.staged);
        assert_eq!(row.credential_hash, None);
        assert_eq!(row.code_hash, "hashed-code");
    }

    #[test]
    fn expiry_boundary_releases_abandoned_slots_but_keeps_current_receipts() {
        let db = Connection::open_in_memory().unwrap();
        init_schema(&db).unwrap();
        db.execute("INSERT INTO extension_pairing(code_hash,expires,request_id,installation_id,name,origin,state,kind,activation_required,credential_hash) VALUES('secret-hash',300,'committed','installation','Browser','origin','claimed','browser',1,'credential-hash')", []).unwrap();
        db.execute("INSERT INTO extension_connections VALUES('installation','Browser','origin','credential-hash','created')", []).unwrap();
        db.execute("INSERT INTO extension_pairing(code_hash,expires,state) VALUES('abandoned',300,'cancelled')", []).unwrap();
        let live = reservation(&db, "request_id", "committed")
            .unwrap()
            .unwrap();
        assert!(require_live(&live, 299).is_ok());
        assert!(require_live(&live, 300).is_err());
        cleanup(&db, 300).unwrap();
        assert!(reservation(&db, "code_hash", "abandoned")
            .unwrap()
            .is_none());
        assert!(current_receipt(&db, &live).unwrap());
        assert!(reservation(&db, "request_id", "committed")
            .unwrap()
            .is_some());
        db.execute("DELETE FROM extension_connections", []).unwrap();
        cleanup(&db, 300).unwrap();
        assert!(reservation(&db, "request_id", "committed")
            .unwrap()
            .is_none());
    }
}
