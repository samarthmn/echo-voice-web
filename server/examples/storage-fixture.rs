//! Test-only SQLCipher fixture inspection. Never included in an application bundle.
#[cfg(debug_assertions)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use rusqlite::{
        types::{Value as SqlValue, ValueRef},
        Connection,
    };
    use serde_json::{json, Value};
    use std::{io::Read, path::PathBuf};
    if std::env::var("ECHO_TEST_MODE").as_deref() != Ok("1") {
        return Err("Test mode is required.".into());
    }
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let request: Value = serde_json::from_str(&input)?;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("tmp")
        .canonicalize()?;
    let path =
        PathBuf::from(request["path"].as_str().ok_or("Missing fixture path.")?).canonicalize()?;
    if !path.starts_with(root) {
        return Err("Only repository tmp fixtures are allowed.".into());
    }
    let bytes = STANDARD.decode(std::env::var("ECHO_TEST_STORAGE_KEY")?)?;
    if bytes.len() != 32 {
        return Err("Invalid test key.".into());
    }
    let db = Connection::open(path)?;
    db.pragma_update(
        None,
        "key",
        format!(
            "x'{}'",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        ),
    )?;
    let values = request["params"]
        .as_array()
        .ok_or("Missing parameters.")?
        .iter()
        .map(|value| match value {
            Value::Null => Ok(SqlValue::Null),
            Value::String(v) => Ok(SqlValue::Text(v.clone())),
            Value::Number(v) if v.is_i64() => Ok(SqlValue::Integer(v.as_i64().unwrap())),
            Value::Number(v) => Ok(SqlValue::Real(v.as_f64().ok_or("Invalid number.")?)),
            _ => Err("Invalid SQL fixture parameter."),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut stmt = db.prepare(request["sql"].as_str().ok_or("Missing SQL.")?)?;
    let columns = stmt.column_count();
    let mut rows = stmt.query(rusqlite::params_from_iter(values))?;
    let mut output = Vec::new();
    while let Some(row) = rows.next()? {
        let mut result = Vec::new();
        for column in 0..columns {
            result.push(match row.get_ref(column)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(v) => json!(v),
                ValueRef::Real(v) => json!(v),
                ValueRef::Text(v) => json!(std::str::from_utf8(v)?),
                ValueRef::Blob(v) => json!(STANDARD.encode(v)),
            });
        }
        output.push(result);
    }
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}
#[cfg(not(debug_assertions))]
fn main() {
    eprintln!("Storage fixture tooling requires a debug test build.");
    std::process::exit(1);
}
