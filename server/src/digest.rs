//! Lowercase hexadecimal SHA-256 digests: the form the library stores and verifies.
//!
//! `sha2` 0.11 digests are `hybrid_array` arrays, which do not implement `LowerHex`,
//! so `format!("{:x}", ...)` no longer works on them.

use sha2::{Digest, Sha256};
use std::fmt::Write as _;

/// Encodes bytes as lowercase hex, two characters per byte.
pub(crate) fn lower_hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
            // Writing to a String cannot fail.
            let _ = write!(out, "{byte:02x}");
            out
        })
}

/// The lowercase hex SHA-256 digest of `data`.
pub(crate) fn sha256_hex(data: impl AsRef<[u8]>) -> String {
    lower_hex(&Sha256::digest(data.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_fips_180_2_test_vectors() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn pads_every_byte_to_two_digits() {
        assert_eq!(lower_hex(&[0x00, 0x0f, 0xa0, 0xff]), "000fa0ff");
    }
}
