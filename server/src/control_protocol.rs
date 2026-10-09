//! Shared, bounded launcher/server protocol. Secrets never enter browser state.
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
pub const MAX_MESSAGE: usize = 4096;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bootstrap {
    pub instance_id: String,
    pub secret: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u8,
    pub instance_id: String,
    pub nonce: String,
    pub action: String,
    pub force: bool,
    pub mac: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Status {
    pub version: u8,
    pub instance_id: String,
    pub nonce: String,
    pub workspace_url: String,
    pub active_requests: usize,
    pub active_processing: usize,
    pub shutting_down: bool,
    pub mac: String,
}
fn sign(secret: &str, text: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts secret");
    mac.update(text.as_bytes());
    format!("{:x}", mac.finalize().into_bytes())
}
fn valid(secret: &str, text: &str, signature: &str) -> bool {
    if signature.len() != 64 || !signature.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let Some(bytes) = (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&signature[i..i + 2], 16).ok())
        .collect::<Option<Vec<_>>>()
    else {
        return false;
    };
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts secret");
    mac.update(text.as_bytes());
    mac.verify_slice(&bytes).is_ok()
}
impl Request {
    fn payload(&self) -> String {
        serde_json::to_string(&(
            "request",
            self.version,
            &self.instance_id,
            &self.nonce,
            &self.action,
            self.force,
        ))
        .unwrap()
    }
    // Used by the launcher that includes this shared protocol module.
    #[allow(dead_code)]
    pub fn new(auth: &Bootstrap, action: &str, force: bool) -> Self {
        let mut request = Self {
            version: 1,
            instance_id: auth.instance_id.clone(),
            nonce: uuid::Uuid::new_v4().to_string(),
            action: action.into(),
            force,
            mac: String::new(),
        };
        request.mac = sign(&auth.secret, &request.payload());
        request
    }
    pub fn authentic(&self, auth: &Bootstrap) -> bool {
        self.version == 1
            && self.instance_id == auth.instance_id
            && uuid::Uuid::parse_str(&self.nonce).is_ok()
            && matches!(self.action.as_str(), "status" | "shutdown")
            && valid(&auth.secret, &self.payload(), &self.mac)
    }
}
impl Status {
    fn payload(&self) -> String {
        serde_json::to_string(&(
            "response",
            self.version,
            &self.instance_id,
            &self.nonce,
            &self.workspace_url,
            self.active_requests,
            self.active_processing,
            self.shutting_down,
        ))
        .unwrap()
    }
    pub fn signed(mut self, auth: &Bootstrap) -> Self {
        self.mac = sign(&auth.secret, &self.payload());
        self
    }
    // Response verification belongs to the launcher side of this protocol.
    #[allow(dead_code)]
    pub fn authentic(&self, auth: &Bootstrap, request: &Request) -> bool {
        self.version == 1
            && self.instance_id == auth.instance_id
            && self.nonce == request.nonce
            && valid(&auth.secret, &self.payload(), &self.mac)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_wrong_secret_instance_and_tampered_force() {
        let auth = Bootstrap {
            instance_id: "owner".into(),
            secret: "private".into(),
        };
        let mut r = Request::new(&auth, "shutdown", false);
        assert!(r.authentic(&auth));
        r.force = true;
        assert!(!r.authentic(&auth));
        r.force = false;
        assert!(!r.authentic(&Bootstrap {
            instance_id: "owner".into(),
            secret: "forged".into()
        }));
        r.instance_id = "other".into();
        assert!(!r.authentic(&auth));
    }
    #[test]
    fn forged_and_replayed_acknowledgements_fail() {
        let auth = Bootstrap {
            instance_id: "owner".into(),
            secret: "private".into(),
        };
        let request = Request::new(&auth, "status", false);
        let mut status = Status {
            version: 1,
            instance_id: "owner".into(),
            nonce: request.nonce.clone(),
            workspace_url: "http://localhost:3000".into(),
            active_requests: 0,
            active_processing: 0,
            shutting_down: false,
            mac: String::new(),
        }
        .signed(&auth);
        assert!(status.authentic(&auth, &request));
        assert!(!status.authentic(&auth, &Request::new(&auth, "status", false)));
        status.workspace_url = "http://evil.invalid".into();
        assert!(!status.authentic(&auth, &request));
    }
}
