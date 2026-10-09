//! Authenticated format fence. Validate through a read-only connection before
//! WAL changes, schema writes, plaintext export or protected-file migration.
use crate::security::ApiError;
use rusqlite::{Connection, OptionalExtension};

pub(crate) const SCHEMA_VERSION: i64 = 1;
const READER_VERSION: i64 = 1;

fn invalid() -> ApiError {
    ApiError::new(503, "This library's format information is damaged or unsupported. Its saved data has not been changed. Restore a verified backup or use the matching Echo release.")
}
pub(crate) fn validate(db: &Connection) -> Result<(), ApiError> {
    let protected: Option<String> = db
        .query_row(
            "SELECT type FROM sqlite_master WHERE name='storage_protection'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| invalid())?;
    if let Some(kind) = protected {
        if kind != "table" {
            return Err(invalid());
        }
        let mut statement = db
            .prepare("SELECT id,version FROM storage_protection LIMIT 2")
            .map_err(|_| invalid())?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
            .map_err(|_| invalid())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| invalid())?;
        if rows.len() > 1 || rows.first().is_some_and(|row| *row != (1, 1)) {
            return Err(invalid());
        }
    }
    let pragma: i64 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| invalid())?;
    let kind: Option<String> = db
        .query_row(
            "SELECT type FROM sqlite_master WHERE name='library_schema'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| invalid())?;
    match kind.as_deref() {
        None if pragma == 0 => return Ok(()), // Unversioned existing Echo libraries.
        Some("table") => {}
        _ => return Err(invalid()),
    }
    let mut statement = db
        .prepare("SELECT id,schema_version,min_reader_version FROM library_schema LIMIT 2")
        .map_err(|_| invalid())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|_| invalid())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid())?;
    if rows.len() != 1 || rows[0].0 != 1 || rows[0].1 < 1 || rows[0].2 < 1 || pragma != rows[0].1 {
        return Err(invalid());
    }
    let (_, schema, reader) = rows[0];
    if schema > SCHEMA_VERSION || reader > READER_VERSION {
        return Err(ApiError::new(503, "This library needs a newer Echo release. Reopen it with that release or explicitly restore a verified backup; this version will not change it."));
    }
    if reader > schema {
        return Err(invalid());
    }
    Ok(())
}
pub(crate) fn establish(db: &mut Connection) -> Result<(), ApiError> {
    validate(db)?;
    let transaction = db.transaction()?;
    transaction.execute_batch("CREATE TABLE IF NOT EXISTS library_schema(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,min_reader_version INTEGER NOT NULL);")?;
    transaction.execute(
        "INSERT OR IGNORE INTO library_schema VALUES(1,?1,?2)",
        [SCHEMA_VERSION, READER_VERSION],
    )?;
    transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unversioned_schema_establishes_one_atomic_fence_and_rejects_corruption() {
        let mut db = Connection::open_in_memory().unwrap();
        validate(&db).unwrap();
        establish(&mut db).unwrap();
        validate(&db).unwrap();
        for update in [
            "UPDATE library_schema SET schema_version=2; PRAGMA user_version=2",
            "UPDATE library_schema SET schema_version=1,min_reader_version=2; PRAGMA user_version=1",
            "UPDATE library_schema SET schema_version='broken',min_reader_version=1",
            "DELETE FROM library_schema",
        ] {db.execute_batch(update).unwrap();assert!(validate(&db).is_err());}
        db.execute_batch("DROP TABLE library_schema").unwrap();
        assert!(validate(&db).is_err());
    }
}
