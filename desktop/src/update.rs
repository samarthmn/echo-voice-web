//! Signed metadata and bounded, verified downloads; trust is compiled into qualified builds.
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri_plugin_updater::{Update, UpdaterExt};
const LIBRARY_SCHEMA: u32 = 1;
const EXTENSION_PROTOCOL: u32 = 1;
const MAX_ARTIFACT: u64 = 1024 * 1024 * 1024;

/// A failed or incomplete snapshot never reaches application replacement. Keep
/// its source lock alive through replacement; successful backup files remain on
/// disk even when installation fails and the caller restarts the old server.
pub fn replace_after_snapshot<T>(
    snapshot: impl FnOnce() -> Result<T, String>,
    replace: impl FnOnce() -> Result<(), String>,
) -> Result<T, String> {
    let saved=snapshot().map_err(|error|format!("The update was not installed because its library backup could not be verified. {error}"))?;
    replace()?;
    Ok(saved)
}

pub struct TrustConfig {
    key: String,
    endpoint: url::Url,
    target: String,
}
impl TrustConfig {
    fn from_values(
        key: Option<&str>,
        qualified: Option<&str>,
        target: &str,
    ) -> Result<Option<Self>, String> {
        if qualified != Some("true") || key.is_none_or(str::is_empty) {
            return Ok(None);
        }
        let key = key.unwrap();
        decode_key(key)?;
        if !matches!(target, "aarch64-apple-darwin" | "x86_64-unknown-linux-gnu") {
            return Err("This update target is not qualified.".into());
        }
        Ok(Some(Self {
            key: key.into(),
            endpoint: format!("https://echovoice.samarthmn.com/updates/{target}.json")
                .parse()
                .unwrap(),
            target: target.into(),
        }))
    }
    pub fn compiled() -> Result<Option<Self>, String> {
        let target = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => "aarch64-apple-darwin",
            ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
            _ => return Ok(None),
        };
        Self::from_values(
            option_env!("ECHO_UPDATER_PUBLIC_KEY"),
            option_env!("ECHO_RELEASE_QUALIFIED"),
            target,
        )
    }
}
fn decode_key(encoded: &str) -> Result<PublicKey, String> {
    let bytes = STANDARD
        .decode(encoded.trim())
        .map_err(|_| "The publisher update key is invalid.")?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "The publisher update key is invalid.")?;
    PublicKey::decode(text).map_err(|_| "The publisher update key is invalid.".into())
}
fn verify_signed_bytes(key: &str, signature: &str, bytes: &[u8]) -> Result<String, String> {
    let decoded = STANDARD
        .decode(signature.trim())
        .map_err(|_| "The update signature is invalid.")?;
    let decoded = std::str::from_utf8(&decoded).map_err(|_| "The update signature is invalid.")?;
    let signature = Signature::decode(decoded).map_err(|_| "The update signature is invalid.")?;
    decode_key(key)?
        .verify(bytes, &signature, true)
        .map_err(|_| {
            "Update verification failed. The installed app and library have not been changed."
        })?;
    Ok(signature.trusted_comment().to_owned())
}
fn trusted_url(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw).map_err(|_| "Invalid update URL.")?;
    if url.scheme() != "https"
        || url.host_str() != Some("echovoice.samarthmn.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.path().starts_with("/updates/") || url.path().starts_with("/releases/"))
    {
        return Err("The update URL is outside the trusted publisher origin.".into());
    }
    Ok(url)
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseInfo {
    target: String,
    qualified: bool,
    artifact_sha256: String,
    artifact_bytes: u64,
    extension_protocol_min: u32,
    extension_protocol_max: u32,
    library_schema_version: u32,
    library_protection_version: u32,
    library_schema_min: u32,
    library_schema_max: u32,
}
fn validate_release(value: &serde_json::Value, target: &str) -> Result<ReleaseInfo, String> {
    let info: ReleaseInfo = serde_json::from_value(value["echo"].clone())
        .map_err(|_| "The update is missing its release compatibility declaration.")?;
    trusted_url(
        value["url"]
            .as_str()
            .ok_or("Missing update download URL.")?,
    )?;
    semver::Version::parse(
        value["version"]
            .as_str()
            .ok_or("Missing app version.")?
            .trim_start_matches('v'),
    )
    .map_err(|_| "Invalid app version.")?;
    if !info.qualified
        || info.target != target
        || info.artifact_bytes == 0
        || info.artifact_bytes > MAX_ARTIFACT
        || info.artifact_sha256.len() != 64
        || !info.artifact_sha256.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("This update is unqualified or has invalid artifact metadata.".into());
    }
    if info.library_protection_version != 1 {
        return Err("This update cannot open the protected library format. Install a release that supports library protection version 1.".into());
    }
    if info.library_schema_min > LIBRARY_SCHEMA
        || info.library_schema_max < LIBRARY_SCHEMA
        || info.library_schema_version < LIBRARY_SCHEMA
    {
        return Err("This update cannot safely open this library schema. Use an explicitly verified data restore instead of rolling back.".into());
    }
    if compatibility(
        EXTENSION_PROTOCOL,
        info.extension_protocol_min,
        info.extension_protocol_max,
    ) != Compatibility::Compatible
    {
        return Err("Update the browser extension before installing this app release. Pending browser recordings remain available.".into());
    }
    Ok(info)
}
async fn fetch_bounded(url: url::Url, limit: u64) -> Result<Option<Vec<u8>>, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "Could not create the update connection.")?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "The update service is unavailable. Retry later.")?;
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err("The update service did not return a release. Retry later.".into());
    }
    if response.content_length().is_some_and(|len| len > limit) {
        return Err("The update exceeds its declared size.".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "The update download was interrupted. Retry later.")?;
        if (bytes.len() as u64).saturating_add(chunk.len() as u64) > limit {
            return Err("The update exceeds its declared size.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Some(bytes))
}
#[derive(Clone)]
pub struct PendingUpdate {
    update: Update,
    info: ReleaseInfo,
    key: String,
}
impl PendingUpdate {
    pub fn version(&self) -> &str {
        &self.update.version
    }
    pub async fn download_verified(&self) -> Result<Vec<u8>, String> {
        let bytes = fetch_bounded(
            trusted_url(self.update.download_url.as_str())?,
            self.info.artifact_bytes,
        )
        .await?
        .ok_or("The update download is empty.")?;
        if bytes.len() as u64 != self.info.artifact_bytes
            || format!("{:x}", Sha256::digest(&bytes))
                != self.info.artifact_sha256.to_ascii_lowercase()
        {
            return Err(
                "The downloaded update checksum does not match the signed release. Retry later."
                    .into(),
            );
        }
        let comment = verify_signed_bytes(&self.key, &self.update.signature, &bytes)?;
        let signed = comment
            .split('\t')
            .find_map(|item| item.strip_prefix("version:"))
            .ok_or("The update signature does not bind an app version.")?;
        let parsed = |version: &str| semver::Version::parse(version.trim_start_matches('v'));
        if parsed(signed).ok() != parsed(&self.update.version).ok() {
            return Err("The signed update version does not match this release.".into());
        }
        Ok(bytes)
    }
    pub fn install_verified(&self, bytes: Vec<u8>) -> Result<(), String> {
        self.update.install(bytes).map_err(|_|"Echo could not replace its application files. The library is unchanged; reopen Echo or install the verified package manually.".into())
    }
}
pub async fn check(app: &tauri::AppHandle) -> Result<Option<PendingUpdate>, String> {
    let trust = TrustConfig::compiled()?.ok_or_else(|| status().to_owned())?;
    let Some(bytes) = fetch_bounded(trust.endpoint.clone(), 128 * 1024).await? else {
        return Ok(None);
    };
    let signature = fetch_bounded(trusted_url(&format!("{}.sig", trust.endpoint))?, 8192)
        .await?
        .ok_or("The release metadata signature is missing.")?;
    verify_signed_bytes(
        &trust.key,
        std::str::from_utf8(&signature).map_err(|_| "Invalid release metadata signature.")?,
        &bytes,
    )?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid signed release metadata.")?;
    let info = validate_release(&value, &trust.target)?;
    let updater = app
        .updater_builder()
        .pubkey(&trust.key)
        .target(&trust.target)
        .endpoints(vec![trust.endpoint])
        .map_err(|_| "Invalid publisher update endpoint.")?
        .timeout(Duration::from_secs(15))
        .configure_client(|client| client.redirect(reqwest::redirect::Policy::none()))
        .build()
        .map_err(|_| "The updater could not initialize.")?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|_| "The updater could not check this release. Retry later.")?
    else {
        return Ok(None);
    };
    if update.raw_json != value {
        return Err(
            "The release metadata changed during verification. Retry the update check.".into(),
        );
    }
    Ok(Some(PendingUpdate {
        update,
        info,
        key: trust.key,
    }))
}
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Compatibility {
    Compatible,
    UpdateApp,
    UpdateExtension,
}
pub fn compatibility(extension_protocol: u32, min: u32, max: u32) -> Compatibility {
    if extension_protocol < min {
        Compatibility::UpdateExtension
    } else if extension_protocol > max {
        Compatibility::UpdateApp
    } else {
        Compatibility::Compatible
    }
}
pub fn status() -> &'static str {
    "Updates are unavailable in this development build. Continue using your current version until a verified release is available."
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_replacement_requires_a_completed_snapshot_and_preserves_it_after_failure() {
        use std::cell::RefCell;
        let calls = RefCell::new(Vec::new());
        let failed: Result<(), String> = replace_after_snapshot(
            || Err("disk full".into()),
            || {
                calls.borrow_mut().push("replace");
                Ok(())
            },
        );
        assert!(failed.unwrap_err().contains("not installed"));
        assert!(calls.borrow().is_empty());
        let saved = replace_after_snapshot(
            || {
                calls.borrow_mut().push("verified snapshot");
                Ok("retained snapshot")
            },
            || {
                calls.borrow_mut().push("replace");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(saved, "retained snapshot");
        assert_eq!(*calls.borrow(), ["verified snapshot", "replace"]);
        let failed = replace_after_snapshot(
            || Ok("retained snapshot"),
            || Err("installer failed".into()),
        );
        assert_eq!(failed.unwrap_err(), "installer failed");
    }
    #[test]
    fn protocol_updates_are_directional() {
        assert_eq!(compatibility(1, 1, 1), Compatibility::Compatible);
        assert_eq!(compatibility(2, 1, 1), Compatibility::UpdateApp);
        assert_eq!(compatibility(1, 2, 2), Compatibility::UpdateExtension);
    }
    // Public minisign-verify fixture; no production signing key is created.
    const KEY:&str="untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIGNATURE:&str="untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
    #[test]
    fn signed_bytes_reject_tampering_and_wrong_key() {
        use base64::Engine;
        let key = base64::engine::general_purpose::STANDARD.encode(KEY);
        let signature = base64::engine::general_purpose::STANDARD.encode(SIGNATURE);
        assert!(verify_signed_bytes(&key, &signature, b"test").is_ok());
        assert!(verify_signed_bytes(&key, &signature, b"Test").is_err());
        let wrong = base64::engine::general_purpose::STANDARD.encode(KEY.replace("7GFO3", "7GFO4"));
        assert!(verify_signed_bytes(&wrong, &signature, b"test").is_err());
    }
    #[test]
    fn publisher_configuration_remains_disabled_without_real_release_inputs() {
        assert!(TrustConfig::from_values(None, None, "aarch64-apple-darwin")
            .unwrap()
            .is_none());
        assert!(TrustConfig::from_values(
            Some("placeholder"),
            Some("true"),
            "aarch64-apple-darwin"
        )
        .is_err());
    }
    #[test]
    fn oversized_and_interrupted_downloads_fail_before_installation() {
        use std::io::{Read, Write};
        for (response, limit) in [
            (
                "HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nlarge",
                10,
            ),
            (
                "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nshort",
                10,
            ),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                stream.write_all(response.as_bytes()).unwrap();
            });
            let result = tauri::async_runtime::block_on(fetch_bounded(
                format!("http://{address}").parse().unwrap(),
                limit,
            ));
            server.join().unwrap();
            assert!(result.is_err());
        }
    }
    #[test]
    fn release_metadata_rejects_other_hosts_unqualified_releases_and_schema_rollback() {
        let mut value = serde_json::json!({"version":"1.2.3","url":"https://echovoice.samarthmn.com/releases/echo.app.tar.gz","signature":"test-signature","echo":{"target":"aarch64-apple-darwin","qualified":true,"artifactSha256":"0".repeat(64),"artifactBytes":100,"extensionProtocolMin":1,"extensionProtocolMax":1,"librarySchemaVersion":1,"libraryProtectionVersion":1,"librarySchemaMin":1,"librarySchemaMax":1}});
        assert!(validate_release(&value, "aarch64-apple-darwin").is_ok());
        value["echo"]["qualified"] = false.into();
        assert!(validate_release(&value, "aarch64-apple-darwin").is_err());
        value["echo"]["qualified"] = true.into();
        value["url"] = "https://evil.invalid/echo.app.tar.gz".into();
        assert!(validate_release(&value, "aarch64-apple-darwin").is_err());
        value["url"] = "https://echovoice.samarthmn.com/releases/echo.app.tar.gz".into();
        value["echo"]["librarySchemaMax"] = 0.into();
        assert!(validate_release(&value, "aarch64-apple-darwin").is_err());
        value["echo"]["librarySchemaMax"] = 1.into();
        value["echo"]["libraryProtectionVersion"] = 0.into();
        assert!(validate_release(&value, "aarch64-apple-darwin").is_err());
        value["echo"]
            .as_object_mut()
            .unwrap()
            .remove("libraryProtectionVersion");
        assert!(validate_release(&value, "aarch64-apple-darwin").is_err());
    }
}
