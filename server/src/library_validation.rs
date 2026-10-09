//! Validate an isolated migration or update copy before the launcher commits it.
use crate::{security::ApiError, store};
use sha2::{Digest, Sha256};
use std::path::Path;

fn verify_protected_tree(path: &Path, depth: usize) -> Result<(), ApiError> {
    let metadata = std::fs::symlink_metadata(path)?;
    if depth > 32 || metadata.file_type().is_symlink() {
        return Err(ApiError::bad(
            "The selected library contains an invalid protected file.",
        ));
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path)? {
            verify_protected_tree(&entry?.path(), depth + 1)?;
        }
    } else if metadata.is_file() {
        let mut reader = store::protected_reader(path)?;
        let mut offset = 0;
        while offset < reader.len() {
            let count = (reader.len() - offset).min(65_536) as usize;
            // Authenticate every block, including unindexed recovery audio,
            // without retaining historical plaintext or allocating a whole file.
            let _plaintext = zeroize::Zeroizing::new(reader.read_range(offset, count)?);
            offset += count as u64;
        }
    } else {
        return Err(ApiError::bad(
            "The selected library contains an invalid protected file.",
        ));
    }
    Ok(())
}

pub(crate) fn verify() -> Result<(), ApiError> {
    crate::integrations::validate_saved_credentials()?;
    crate::recovery::validate_saved_recovery()?;
    let entries = store::with_db(|db| {
        let mut entries = Vec::<(String, String, String, u64, String)>::new();
        let mut audio = db.prepare("SELECT meeting_id,file,bytes,digest FROM audio_chunks")?;
        for row in audio.query_map([], |row| {
            Ok((
                "audio".to_string(),
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
            ))
        })? {
            entries.push(row?);
        }
        let mut pcm =
            db.prepare("SELECT recording_id,file,frames*2,digest FROM extension_chunks")?;
        for row in pcm.query_map([], |row| {
            Ok((
                "extension-pcm".to_string(),
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
            ))
        })? {
            entries.push(row?);
        }
        let check: String = db.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if check != "ok" {
            return Err(ApiError::bad("The selected library failed its database integrity check. The original has not been changed."));
        }
        Ok(entries)
    })?;
    for (area, id, file, bytes, digest) in entries {
        let invalid_id = if area == "audio" {
            store::valid_id(&id).is_err()
        } else {
            uuid::Uuid::parse_str(&id).is_err()
        };
        if invalid_id
            || Path::new(&file).components().count() != 1
            || file.starts_with('.')
            || file.contains(['/', '\\'])
            || bytes > 128 * 1024 * 1024
        {
            return Err(ApiError::bad("The selected library contains an invalid audio reference. The original has not been changed."));
        }
        let path = store::data_dir().join(area).join(id).join(file);
        let data = zeroize::Zeroizing::new(store::read_protected(&path)?);
        if data.len() as u64 != bytes || format!("{:x}", Sha256::digest(data.as_slice())) != digest
        {
            return Err(ApiError::bad("The selected library contains missing or damaged audio. Restore a complete backup; the original has not been changed."));
        }
    }
    // The database references alone cannot prove the copied tree is complete:
    // offline/recovery files and optional credentials may not have indexed rows.
    for name in ["audio", "extension-pcm", "credentials", "chatgpt/auth.json"] {
        let path = store::data_dir().join(name);
        match std::fs::symlink_metadata(&path) {
            Ok(_) => verify_protected_tree(&path, 0)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::json;

    #[test]
    fn every_copied_protected_block_is_authenticated_even_without_a_database_reference() {
        let _guard = store::TEST_LIBRARY_LOCK.blocking_lock();
        let directory = store::test_directory();
        store::reset_for_tests();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        store::test_key();
        store::init().unwrap();
        for name in [
            "audio/recovery/unindexed.chunk",
            "extension-pcm/recovery/unindexed.pcm",
            "credentials/extra.json",
            "chatgpt/auth.json",
        ] {
            let path = directory.path().join(name);
            store::mkdir(path.parent().unwrap()).unwrap();
            store::write_protected(&path, &vec![42; 150_000]).unwrap();
            verify().unwrap();
            let original = std::fs::read(&path).unwrap();
            let mut damaged = original.clone();
            *damaged.last_mut().unwrap() ^= 1;
            std::fs::write(&path, &damaged).unwrap();
            assert!(verify().is_err(), "unchecked protected data: {name}");
            assert_eq!(std::fs::read(&path).unwrap(), damaged);
            std::fs::write(&path, original).unwrap();
            verify().unwrap();
        }
        let outside = directory.path().join("outside");
        std::fs::write(&outside, b"unrelated plaintext").unwrap();
        std::os::unix::fs::symlink(&outside, directory.path().join("audio/link")).unwrap();
        assert!(verify().is_err());
        assert_eq!(std::fs::read(&outside).unwrap(), b"unrelated plaintext");
        store::reset_for_tests();
        std::env::remove_var("ECHO_DATA_DIR");
    }

    #[test]
    fn copied_google_credentials_require_full_authentication_and_bounded_schema() {
        let _guard = store::TEST_LIBRARY_LOCK.blocking_lock();
        let directory = store::test_directory();
        store::reset_for_tests();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        store::test_key();
        store::init().unwrap();
        verify().unwrap();
        let path = directory.path().join("credentials/google.json");
        store::mkdir(path.parent().unwrap()).unwrap();
        let valid = serde_json::to_vec(&json!({"access_token":"synthetic-token".repeat(6000),"refresh_token":"synthetic-refresh","expires_at":42,"email":null})).unwrap();
        store::write_protected(&path, &valid).unwrap();
        verify().unwrap();
        let original = std::fs::read(&path).unwrap();
        let mut damaged = original.clone();
        *damaged.last_mut().unwrap() ^= 1;
        for bytes in [damaged, [b"ECHOENC1".as_slice(), &[0; 160]].concat()] {
            std::fs::write(&path, &bytes).unwrap();
            let error = verify().unwrap_err().to_string();
            assert!(error.contains("damaged Google credentials"));
            assert!(!error.contains("synthetic-token"));
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
        for invalid in [
            json!({"access_token":"secret"}),
            json!({"access_token":"","expires_at":42}),
            json!({"access_token":"secret","expires_at":"wrong type"}),
            json!({"access_token":"secret","expires_at":42,"unexpected":true}),
            json!({"access_token":"x".repeat(1024*1024),"expires_at":42}),
        ] {
            store::replace_protected(&path, &serde_json::to_vec(&invalid).unwrap()).unwrap();
            let bytes = std::fs::read(&path).unwrap();
            assert!(verify()
                .unwrap_err()
                .to_string()
                .contains("damaged Google credentials"));
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
        std::fs::write(&path, original).unwrap();
        verify().unwrap();
        store::reset_for_tests();
        std::env::remove_var("ECHO_DATA_DIR");
    }

    #[test]
    fn imported_legacy_ids_validate_but_traversal_and_non_uuid_extension_ids_fail() {
        let _guard = store::TEST_LIBRARY_LOCK.blocking_lock();
        let directory = store::test_directory();
        store::reset_for_tests();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        store::test_key();
        let audio = b"RIFF\x24\0\0\0WAVEfmt legacy-audio-secret";
        let meeting = json!({"id":"legacy_meeting-1","title":"Legacy backup","mode":"import","consent":false,"status":"saved","createdAt":store::now(),"updatedAt":store::now(),"duration":0,"speechModel":"local","notesModel":"local","liveTranscription":false,"tracks":[{"id":"room","label":"Room","mimeType":"audio/wav","bytes":audio.len(),"url":"/api/meetings/legacy_meeting-1/audio/room"}],"transcripts":[],"notes":[],"moments":[],"gaps":[]});
        store::import_library(json!({"format":"echo-voice-web","version":1,"exportedAt":store::now(),"meetings":[meeting],"vocabulary":[],"audio":[{"meetingId":"legacy_meeting-1","trackId":"room","sequence":0,"data":STANDARD.encode(audio)}]})).unwrap();
        verify().unwrap();
        for invalid in [
            "../outside.chunk",
            "..",
            "nested/file.chunk",
            "nested\\file.chunk",
        ] {
            let original = store::with_db(|db| {
                let file: String =
                    db.query_row("SELECT file FROM audio_chunks", [], |row| row.get(0))?;
                db.execute("UPDATE audio_chunks SET file=?", [invalid])?;
                Ok(file)
            })
            .unwrap();
            assert!(verify()
                .unwrap_err()
                .to_string()
                .contains("invalid audio reference"));
            store::with_db(|db| {
                db.execute("UPDATE audio_chunks SET file=?", [&original])?;
                Ok(())
            })
            .unwrap();
        }
        store::with_db(|db| {
            db.execute(
                "INSERT INTO extension_chunks VALUES('legacy_recording',0,1,'digest','chunk.pcm')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        assert!(verify()
            .unwrap_err()
            .to_string()
            .contains("invalid audio reference"));
        store::reset_for_tests();
        std::env::remove_var("ECHO_DATA_DIR");
    }
}
