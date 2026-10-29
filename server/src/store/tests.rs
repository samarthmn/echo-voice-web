use super::*;
#[test]
fn panic_rolls_back_and_database_remains_available() {
    let _guard = TEST_LIBRARY_LOCK.blocking_lock();
    let directory = test_directory();
    reset_for_tests();
    std::env::set_var("ECHO_DATA_DIR", directory.path());
    test_key();
    init().unwrap();
    let error = with_db::<()>(|db| {
        db.execute_batch("BEGIN; INSERT INTO preferences VALUES ('panic-test', '{}');")?;
        panic!("synthetic database panic");
    })
    .unwrap_err();
    assert_eq!(error.message, "Echo hit an internal error; retry.");
    let count = with_db(|db| {
        Ok(db.query_row(
            "SELECT count(*) FROM preferences WHERE id='panic-test'",
            [],
            |row| row.get::<_, i64>(0),
        )?)
    })
    .unwrap();
    assert_eq!(count, 0);
    reset_for_tests();
    std::env::remove_var("ECHO_DATA_DIR");
}
fn database_bytes(root: &Path) -> Vec<(String, String)> {
    // SQLite read-only WAL readers may update transient -shm read marks.
    // Authoritative database and committed WAL bytes must remain identical.
    ["workspace.sqlite", "workspace.sqlite-wal"]
        .into_iter()
        .filter_map(|name| {
            fs::read(root.join(name))
                .ok()
                .map(|bytes| (name.into(), format!("{:x}", Sha256::digest(bytes))))
        })
        .collect()
}
#[test]
fn future_plaintext_schema_is_rejected_before_export_key_creation_or_wal_changes() {
    let _guard = TEST_LIBRARY_LOCK.blocking_lock();
    let directory = test_directory();
    reset_for_tests();
    std::env::set_var("ECHO_DATA_DIR", directory.path());
    test_key();
    let root = directory.path();
    let db = Connection::open(root.join("workspace.sqlite")).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE library_schema(id INTEGER,schema_version INTEGER,min_reader_version INTEGER); INSERT INTO library_schema VALUES(1,2,2); PRAGMA user_version=2;").unwrap();
    fs::write(
        root.join(".workspace-encrypted.sqlite"),
        b"previous migration stage",
    )
    .unwrap();
    fs::create_dir(root.join("audio")).unwrap();
    fs::write(root.join("audio/legacy.wav"), b"legacy plaintext").unwrap();
    let before = database_bytes(root);
    assert!(init().unwrap_err().to_string().contains("newer Echo"));
    assert_eq!(database_bytes(root), before);
    assert_eq!(
        fs::read(root.join(".workspace-encrypted.sqlite")).unwrap(),
        b"previous migration stage"
    );
    assert_eq!(
        fs::read(root.join("audio/legacy.wav")).unwrap(),
        b"legacy plaintext"
    );
    assert!(!root.join("protection.json").exists());
    reset_for_tests();
    std::env::remove_var("ECHO_DATA_DIR");
}
#[test]
fn encrypted_schema_fence_preserves_database_and_wal_on_future_or_corrupt_metadata() {
    let _guard = TEST_LIBRARY_LOCK.blocking_lock();
    let directory = test_directory();
    reset_for_tests();
    std::env::set_var("ECHO_DATA_DIR", directory.path());
    test_key();
    init().unwrap();
    reset_for_tests();
    let root = directory.path();
    let key = LibraryKey::from_bytes([42; 32]);
    let db = Connection::open(root.join("workspace.sqlite")).unwrap();
    db.pragma_update(None, "key", key.sqlcipher_key().as_str())
        .unwrap();
    db.execute_batch(
        "PRAGMA cipher_compatibility=4; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;",
    )
    .unwrap();
    for change in ["UPDATE library_schema SET schema_version=2,min_reader_version=2; PRAGMA user_version=2", "UPDATE library_schema SET schema_version=1,min_reader_version=2; PRAGMA user_version=1", "UPDATE library_schema SET schema_version=1,min_reader_version='damaged'; PRAGMA user_version=1", "UPDATE library_schema SET min_reader_version=1; PRAGMA user_version=9"] {
            db.execute_batch(change).unwrap();let before=database_bytes(root);
            assert!(init().is_err());assert_eq!(database_bytes(root),before);reset_for_tests();
        }
    drop(db);
    std::env::remove_var("ECHO_DATA_DIR");
}
#[test]
fn legacy_database_and_files_migrate_resumably_and_wrong_keys_fail_closed() {
    let _guard = TEST_LIBRARY_LOCK.blocking_lock();
    let directory = test_directory();
    reset_for_tests();
    std::env::set_var("ECHO_DATA_DIR", directory.path());
    test_key();
    let root = directory.path();
    let audio = b"RIFF\x24\0\0\0WAVEfmt legacy-audio-secret";
    let meeting = json!({"id":"legacy","title":"Private migration title","mode":"import","consent":false,"status":"saved","createdAt":now(),"updatedAt":now(),"duration":0,"speechModel":"local","notesModel":"local","liveTranscription":false,"tracks":[{"id":"room","label":"Room","mimeType":"audio/wav","bytes":audio.len()*2,"url":"/api/meetings/legacy/audio/room"}],"transcripts":[],"notes":[],"moments":[],"gaps":[]});
    validate_meeting(&meeting).unwrap();
    let db = Connection::open(root.join("workspace.sqlite")).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE meetings(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE audio_chunks(meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,track_id TEXT NOT NULL,sequence INTEGER NOT NULL,file TEXT NOT NULL,bytes INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(meeting_id,track_id,sequence));").unwrap();
    db.execute(
        "INSERT INTO meetings VALUES('legacy',?)",
        [meeting.to_string()],
    )
    .unwrap();
    for sequence in 0..2 {
        db.execute(
            "INSERT INTO audio_chunks VALUES('legacy','room',?,?,?,?)",
            params![
                sequence,
                format!("legacy-{sequence}.chunk"),
                audio.len(),
                format!("{:x}", Sha256::digest(audio))
            ],
        )
        .unwrap();
    }
    drop(db);
    mkdir(&root.join("audio/legacy")).unwrap();
    fs::write(root.join("audio/legacy/legacy-0.chunk"), audio).unwrap();
    mkdir(&root.join("credentials")).unwrap();
    let tokens = br#"{"access_token":"private-google-token","refresh_token":"private-refresh","expires_at":42,"email":null}"#;
    fs::write(root.join("credentials/google.json"), tokens).unwrap();
    // The first audio file is durably sealed before the missing second
    // file pauses migration; retry must retain that exact ciphertext.
    assert!(init().is_err());
    let migrated = fs::read(root.join("audio/legacy/legacy-0.chunk")).unwrap();
    assert!(migrated.starts_with(b"ECHOENC1"));
    assert!(!fs::read(root.join("workspace.sqlite"))
        .unwrap()
        .starts_with(b"SQLite format 3\0"));
    fs::write(root.join("audio/legacy/legacy-1.chunk"), audio).unwrap();
    init().unwrap();
    assert_eq!(
        get_meeting("legacy").unwrap().unwrap()["title"],
        "Private migration title"
    );
    assert_eq!(
        fs::read(root.join("audio/legacy/legacy-0.chunk")).unwrap(),
        migrated
    );
    assert_eq!(
        read_protected(&root.join("credentials/google.json")).unwrap(),
        tokens
    );
    assert!(!fs::read(root.join("credentials/google.json"))
        .unwrap()
        .windows(20)
        .any(|window| window == b"private-google-token"));
    let backup = export_library().unwrap();
    assert_eq!(backup["audio"].as_array().unwrap().len(), 2);
    assert_eq!(
        STANDARD
            .decode(backup["audio"][0]["data"].as_str().unwrap())
            .unwrap(),
        audio
    );
    reset_for_tests();
    let before = fs::read(root.join("workspace.sqlite")).unwrap();
    std::env::set_var("ECHO_TEST_STORAGE_KEY", STANDARD.encode([99u8; 32]));
    assert!(init().is_err());
    assert_eq!(fs::read(root.join("workspace.sqlite")).unwrap(), before);
    std::env::remove_var("ECHO_TEST_STORAGE_KEY");
    // A missing descriptor on an encrypted library must not create a new
    // keychain entry or a new plaintext database.
    assert!(protected_storage::library_key(root).is_err());
    assert!(!root.join("protection.json").exists());
    assert_eq!(fs::read(root.join("workspace.sqlite")).unwrap(), before);
    fs::rename(
        root.join("workspace.sqlite"),
        root.join(".fixture-hidden.sqlite"),
    )
    .unwrap();
    assert!(protected_storage::library_key(root).is_err());
    assert!(!root.join("protection.json").exists());
    fs::rename(
        root.join(".fixture-hidden.sqlite"),
        root.join("workspace.sqlite"),
    )
    .unwrap();
    test_key();
    init().unwrap();
    reset_for_tests();
    std::env::remove_var("ECHO_DATA_DIR");
}
#[test]
fn migration_does_not_replace_corrupt_plaintext_or_downgrade_tampered_ciphertext() {
    let _guard = TEST_LIBRARY_LOCK.blocking_lock();
    let directory = test_directory();
    reset_for_tests();
    std::env::set_var("ECHO_DATA_DIR", directory.path());
    test_key();
    init().unwrap();
    let meeting =
        create_meeting(json!({"title":"Tamper test","mode":"import","consent":false})).unwrap();
    let audio = b"RIFF\x24\0\0\0WAVEfmt private-recording";
    let meeting_id = meeting["id"].as_str().unwrap();
    add_audio(
        meeting_id,
        audio,
        Some("room"),
        "Room",
        "audio/wav",
        Some(0),
    )
    .unwrap();
    let (_, parts) = get_audio_parts(meeting_id, "room").unwrap();
    let path = &parts[0].path;
    let original = fs::read(path).unwrap();
    let mut damaged = original.clone();
    damaged[70] ^= 1;
    fs::write(path, &damaged).unwrap();
    assert!(read_protected(path).is_err());
    assert!(export_library().is_err());
    assert!(add_audio(
        meeting_id,
        audio,
        Some("room"),
        "Room",
        "audio/wav",
        Some(0)
    )
    .is_err());
    assert_eq!(fs::read(path).unwrap(), damaged);
    // A completed library never reinterprets newly introduced plaintext.
    fs::write(path, audio).unwrap();
    reset_for_tests();
    init().unwrap();
    assert!(get_audio_parts(meeting_id, "room").is_err());
    assert_eq!(fs::read(path).unwrap(), audio);
    with_db(|db| {
        db.execute("DELETE FROM storage_protection", [])?;
        Ok(())
    })
    .unwrap();
    fs::write(path, b"incorrect-legacy-chunk").unwrap();
    reset_for_tests();
    assert!(init().is_err());
    assert_eq!(fs::read(path).unwrap(), b"incorrect-legacy-chunk");
    reset_for_tests();
    std::env::remove_var("ECHO_DATA_DIR");
}
#[test]
fn settings_migrate_to_local_and_usage_metadata_is_strict() {
    let mut legacy = defaults();
    legacy.as_object_mut().unwrap().remove("notesProvider");
    legacy.as_object_mut().unwrap().remove("chatgptModel");
    let migrated = normalized_settings(legacy).unwrap();
    assert_eq!(migrated["notesProvider"], "ollama");
    assert_eq!(migrated["chatgptModel"], "");
    assert_eq!(
        normalized_settings(json!({"notesProvider":"chatgpt"})).unwrap()["chatgptModel"],
        ""
    );
    for value in [
        json!({"notesProvider":"api-key"}),
        json!({"notesProvider":null}),
        json!({"chatgptModel":12}),
        json!({"chatgptModel":"bad\nmodel"}),
    ] {
        assert!(validate_settings(&value, false).is_err());
    }
    assert!(validate_settings(
        &json!({"notesProvider":"chatgpt","chatgptModel":"gpt-5.4"}),
        false
    )
    .is_ok());
    for usage in [
        json!({"inputTokens":-1}),
        json!({"outputTokens":1.5}),
        json!({"inputTokens":2,"cachedInputTokens":3}),
        json!({"apiKey":"never-import"}),
        json!({"inputTokens":null}),
    ] {
        assert!(validate_note_usage(&usage).is_err());
    }
    assert!(
        validate_note_usage(&json!({"inputTokens":12,"outputTokens":3,"cachedInputTokens":0}))
            .is_ok()
    );
    let mut note = json!({"model":"gpt-5.4","provider":"chatgpt","usage":{"inputTokens":12,"outputTokens":3},"transcriptVersionId":"source","summary":[],"decisions":[],"actions":[]});
    assert!(validate_notes(&note, false).is_ok());
    note["provider"] = json!("api-key");
    assert!(validate_notes(&note, false).is_err());
}

#[test]
fn retired_bot_data_survives_deletion_and_recovery() {
    let _guard = TEST_LIBRARY_LOCK.blocking_lock();
    let directory = test_directory();
    reset_for_tests();
    std::env::set_var("ECHO_DATA_DIR", directory.path());
    test_key();
    init().unwrap();
    for pending in [false, true] {
        let meeting =
            create_meeting(json!({"title":"Old data", "mode":"import", "consent":false})).unwrap();
        let key = meeting["id"].as_str().unwrap();
        let bot = directory.path().join("bot").join(key);
        fs::create_dir_all(&bot).unwrap();
        fs::write(bot.join("session.json"), b"untouched old recording").unwrap();
        reset_for_tests();
        init().unwrap();
        assert_eq!(
            fs::read(bot.join("session.json")).unwrap(),
            b"untouched old recording"
        );
        if pending {
            with_db(|db| {
                db.execute("INSERT INTO deletion_jobs(id) VALUES(?)", [key])?;
                recover(db)
            })
            .unwrap();
        } else {
            delete_meeting(key).unwrap();
        }
        assert!(get_meeting(key).unwrap().is_none());
        assert_eq!(
            fs::read(bot.join("session.json")).unwrap(),
            b"untouched old recording"
        );
    }
    reset_for_tests();
    std::env::remove_var("ECHO_DATA_DIR");
}

#[test]
fn receiving_extension_blocks_deletion_after_server_restart() {
    let _guard = TEST_LIBRARY_LOCK.blocking_lock();
    let directory = crate::store::test_directory();
    reset_for_tests();
    std::env::set_var("ECHO_DATA_DIR", directory.path());
    crate::store::test_key();
    init().unwrap();
    let meeting =
        create_meeting(json!({"title":"Still capturing","mode":"online","consent":true})).unwrap();
    let key = meeting["id"].as_str().unwrap();
    update_meeting(key, json!({"status":"recording"})).unwrap();
    let recording_id = uuid::Uuid::new_v4().to_string();
    let installation_id = uuid::Uuid::new_v4().to_string();
    let mut receipt = json!({"recordingId":recording_id,"installationId":installation_id,"meetingId":key,"status":"receiving","controls":[]});
    with_db(|db| {
        db.execute(
            "INSERT INTO extension_recordings VALUES(?,?,?,?)",
            params![recording_id, installation_id, key, receipt.to_string()],
        )?;
        Ok(())
    })
    .unwrap();
    reset_for_tests();
    init().unwrap();
    assert_eq!(get_meeting(key).unwrap().unwrap()["status"], "interrupted");
    let error = delete_meeting(key).unwrap_err();
    assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
    assert!(get_meeting(key).unwrap().is_some());
    with_db(|db| {
        let data: String = db.query_row(
            "SELECT data FROM extension_recordings WHERE recording_id=?",
            [&recording_id],
            |row| row.get(0),
        )?;
        assert_eq!(serde_json::from_str::<Value>(&data)?["status"], "receiving");
        Ok(())
    })
    .unwrap();
    // A pending recording must not block unrelated meetings or completed imports.
    let unrelated =
        create_meeting(json!({"title":"Unrelated","mode":"import","consent":true})).unwrap();
    delete_meeting(unrelated["id"].as_str().unwrap()).unwrap();
    receipt["status"] = json!("complete");
    with_db(|db| {
        db.execute(
            "UPDATE extension_recordings SET data=? WHERE recording_id=?",
            params![receipt.to_string(), recording_id],
        )?;
        Ok(())
    })
    .unwrap();
    delete_meeting(key).unwrap();
    assert!(get_meeting(key).unwrap().is_none());
    reset_for_tests();
    std::env::remove_var("ECHO_DATA_DIR");
}

#[test]
fn durable_recording_versions_backup_validation_and_recovery() {
    let _guard = TEST_LIBRARY_LOCK.blocking_lock();
    let directory = crate::store::test_directory();
    std::env::set_var("ECHO_DATA_DIR", directory.path());
    crate::store::test_key();
    init().unwrap();
    let competing = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(directory.path().join("workspace.lock"))
        .unwrap();
    assert!(fs2::FileExt::try_lock_exclusive(&competing).is_err());
    assert!(
        create_meeting(json!({"title":"No consent","mode":"in-person","consent":false})).is_err()
    );
    assert!(get_meeting("../../credentials").is_err());
    assert!(update_settings(json!({"ollamaUrl":"http://example.com"})).is_err());
    assert!(update_settings(json!({"ollamaUrl":"http://localhost:11434@evil.com"})).is_err());
    assert!(update_settings(json!({"ollamaUrl":"http://127.0.0.1:11434/path"})).is_err());
    update_settings(json!({"name":"Asha","ollamaUrl":"http://127.0.0.1:11434"})).unwrap();
    let m = create_meeting(
        json!({"title":"Roadmap","mode":"in-person","consent":true,"liveTranscription":true}),
    )
    .unwrap();
    let key = m["id"].as_str().unwrap();
    let cancelled = update_meeting(key, json!({"autoTranscribeSuppressed":true})).unwrap();
    assert_eq!(
        get_meeting(key).unwrap().unwrap()["autoTranscribeSuppressed"],
        true
    );
    assert!(validate_meeting(&cancelled).is_ok());
    assert!(update_meeting(key, json!({"autoTranscribeSuppressed":"yes"})).is_err());
    assert_eq!(
        update_meeting(key, json!({"autoTranscribeSuppressed":false})).unwrap()
            ["autoTranscribeSuppressed"],
        false
    );
    let audio = b"RIFF\x24\x00\x00\x00WAVEfmt original-audio";
    let track = add_audio(
        key,
        audio,
        Some("room"),
        "Room microphone",
        "audio/wav",
        Some(0),
    )
    .unwrap();
    assert_eq!(
        add_audio(
            key,
            audio,
            Some("room"),
            "Room microphone",
            "audio/wav",
            Some(0)
        )
        .unwrap(),
        track
    );
    assert!(add_audio(
        key,
        b"different",
        Some("room"),
        "Room microphone",
        "audio/wav",
        Some(0)
    )
    .is_err());
    assert!(add_audio(
        key,
        b"chunk",
        Some("room"),
        "Room microphone",
        "audio/wav",
        Some(2)
    )
    .is_err());
    add_audio(
        key,
        b"second-chunk",
        Some("room"),
        "Room microphone",
        "audio/wav",
        Some(1),
    )
    .unwrap();
    let (_, parts) = get_audio_parts(key, "room").unwrap();
    assert_eq!(parts.len(), 2);
    assert_eq!(read_protected(&parts[0].path).unwrap(), audio);
    assert_ne!(fs::read(&parts[0].path).unwrap(), audio);
    assert!(add_audio(
        key,
        b"<script>executable</script>",
        Some("bad"),
        "Bad file",
        "audio/wav",
        Some(0)
    )
    .is_err());
    // A browser worker can survive a server restart. Reconcile only its
    // claimed meeting, leaving genuinely abandoned jobs interrupted.
    let orphan =
        create_meeting(json!({"title":"Abandoned server work","mode":"in-person","consent":true}))
            .unwrap();
    let orphan_id = orphan["id"].as_str().unwrap();
    update_meeting(key, json!({"status":"processing"})).unwrap();
    update_meeting(orphan_id, json!({"status":"processing"})).unwrap();
    with_db(recover).unwrap();
    assert_eq!(get_meeting(key).unwrap().unwrap()["status"], "error");
    assert_eq!(resume_browser_processing(&[key.into()]).unwrap(), vec![key]);
    assert_eq!(get_meeting(key).unwrap().unwrap()["status"], "processing");
    assert!(get_meeting(key).unwrap().unwrap().get("error").is_none());
    assert_eq!(get_meeting(orphan_id).unwrap().unwrap()["status"], "error");
    update_meeting(
        key,
        json!({"status":"error","error":"The speech runtime failed."}),
    )
    .unwrap();
    assert!(resume_browser_processing(&[key.into()]).unwrap().is_empty());
    assert_eq!(
        get_meeting(key).unwrap().unwrap()["error"],
        "The speech runtime failed."
    );
    update_meeting(
        key,
        json!({"status":"error","error":PROCESSING_RESTART_ERROR}),
    )
    .unwrap();
    delete_meeting(orphan_id).unwrap();
    assert!(resume_browser_processing(&["../../credentials".into()]).is_err());
    add_vocabulary(json!({"term":"Echo Voice","aliases":["echo boys"]})).unwrap();
    let first=add_transcript(key,json!({"model":"whisper-tiny.en","passages":[{"id":"p1","start":0,"end":2,"speaker":"Speaker 1","text":"Ship Friday."}]})).unwrap();
    assert_eq!(first["status"], "ready");
    assert!(first.get("error").is_none());
    assert!(resume_browser_processing(&[key.into()]).unwrap().is_empty());
    assert_eq!(
        get_meeting(key).unwrap().unwrap()["transcripts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let first_id = first["activeTranscriptId"].clone();
    add_notes(key,json!({"model":"qwen2.5:3b","transcriptVersionId":first_id,"summary":[{"id":"s1","text":"A Friday release was proposed.","passageIds":["p1"]}],"decisions":[],"actions":[]})).unwrap();
    assert!(add_notes(key,json!({"model":"model","transcriptVersionId":first_id,"summary":[{"id":"s2","text":"Invented","passageIds":["missing"]}],"decisions":[],"actions":[]})).is_err());
    let cloud_source = json!({"provider":"chatgpt","model":"gpt-5.4","usage":{"inputTokens":100,"outputTokens":25,"cachedInputTokens":40},"transcriptVersionId":first_id,"summary":[{"id":"c1","text":"A Friday release was proposed.","passageIds":["p1"]}],"decisions":[],"actions":[]});
    let cloud_saved =
        add_generated_notes(key, cloud_source.clone(), first_id.as_str().unwrap()).unwrap();
    let mut cloud_edit = cloud_source;
    cloud_edit.as_object_mut().unwrap().remove("provider");
    cloud_edit.as_object_mut().unwrap().remove("usage");
    cloud_edit["edited"] = json!(true);
    cloud_edit["summary"][0]["text"] = json!("Reviewed release proposal.");
    let edited_notes = add_notes(key, cloud_edit).unwrap();
    assert_eq!(edited_notes["notes"][1], cloud_saved["notes"][1]);
    assert_eq!(edited_notes["notes"][2]["provider"], "chatgpt");
    assert_eq!(edited_notes["notes"][2]["usage"]["cachedInputTokens"], 40);
    let second=add_transcript(key,json!({"model":"manual-edit","passages":[{"id":"p1","start":0,"end":2,"speaker":"Asha","text":"Ship next Friday."}],"vocabulary":[]})).unwrap();
    assert_eq!(second["transcripts"].as_array().unwrap().len(), 2);
    let stale_notes = json!({"model":"gpt-5.4","provider":"chatgpt","transcriptVersionId":first_id,"summary":[],"decisions":[],"actions":[]});
    assert_eq!(
        add_generated_notes(key, stale_notes, first_id.as_str().unwrap())
            .unwrap_err()
            .status
            .as_u16(),
        409
    );
    assert_eq!(
        get_meeting(key).unwrap().unwrap()["notes"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(second["notes"][0]["transcriptVersionId"], first_id);
    assert_eq!(
        second["transcripts"][0]["passages"][0]["text"],
        "Ship Friday."
    );
    assert_eq!(
        second["transcripts"][0]["vocabulary"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(update_meeting(
        key,
        json!({"activeTranscriptId":"some-other-meeting-version"})
    )
    .is_err());
    let marked = add_moment(
        key,
        json!({"time":1,"label":"Release date","passageId":"p1","kind":"highlight"}),
    )
    .unwrap();
    let moment_id = marked["moments"][0]["id"].as_str().unwrap();
    update_moment(key, moment_id, json!({"label":"Verify release"})).unwrap();
    update_meeting(
        key,
        json!({"liveTranscription":false,"gaps":[{"start":2,"end":3,"reason":"Microphone muted"}]}),
    )
    .unwrap();
    assert!(update_meeting(key, json!({"liveTranscription":true})).is_err());
    let (markdown, _, _) = export_meeting(key, "md").unwrap();
    assert!(markdown.contains("earlier transcript"));
    assert!(markdown.contains("Microphone muted"));
    assert!(markdown.contains("Verify release"));
    let (srt, _, _) = export_meeting(key, "srt").unwrap();
    assert!(srt.contains("00:00:00,000 --> 00:00:02,000"));
    let backup = export_library().unwrap();
    assert!(backup["settings"].get("ollamaUrl").is_none());
    assert!(import_library(backup.clone()).is_err());
    update_meeting(key, json!({"status":"recording"})).unwrap();
    assert!(delete_meeting(key).is_err());
    with_db(recover).unwrap();
    let recovered = get_meeting(key).unwrap().unwrap();
    assert_eq!(recovered["status"], "interrupted");
    assert_eq!(recovered["transcripts"].as_array().unwrap().len(), 2);
    delete_meeting(key).unwrap();
    for entry in list_vocabulary().unwrap() {
        delete_vocabulary(entry["id"].as_str().unwrap()).unwrap();
    }
    assert!(!data_dir().unwrap().join("audio").join(key).exists());
    let mut malformed = backup.clone();
    malformed["credentials"] = json!({"token":"must-not-import"});
    assert!(import_library(malformed).is_err());
    let mut traversal = backup.clone();
    traversal["meetings"][0]["id"] = json!("../../credentials");
    assert!(import_library(traversal).is_err());
    let mut executable = backup.clone();
    executable["audio"][0]["data"] = json!(STANDARD.encode(b"#!/bin/sh\nrm -rf /"));
    assert!(import_library(executable).is_err());
    assert_eq!(list_meetings().unwrap().len(), 0);
    let mut legacy = backup.clone();
    legacy["settings"]
        .as_object_mut()
        .unwrap()
        .remove("notesProvider");
    legacy["settings"]
        .as_object_mut()
        .unwrap()
        .remove("chatgptModel");
    for note in legacy["meetings"][0]["notes"].as_array_mut().unwrap() {
        note.as_object_mut().unwrap().remove("provider");
        note.as_object_mut().unwrap().remove("usage");
    }
    update_settings(json!({"notesProvider":"chatgpt","chatgptModel":"gpt-5.4"})).unwrap();
    import_library(legacy).unwrap();
    assert_eq!(get_settings().unwrap()["notesProvider"], "ollama");
    assert_eq!(get_settings().unwrap()["chatgptModel"], "");
    delete_meeting(key).unwrap();
    for entry in list_vocabulary().unwrap() {
        delete_vocabulary(entry["id"].as_str().unwrap()).unwrap();
    }
    let restored = import_library(backup).unwrap();
    assert_eq!(restored["meetings"], 1);
    let restored_meeting = get_meeting(key).unwrap().unwrap();
    assert_eq!(restored_meeting["notes"][2]["provider"], "chatgpt");
    assert_eq!(
        restored_meeting["notes"][2]["usage"],
        json!({"inputTokens":100,"outputTokens":25,"cachedInputTokens":40})
    );
    assert_eq!(
        restored_meeting["notes"][2]["summary"][0]["text"],
        "Reviewed release proposal."
    );
    assert_eq!(
        get_meeting(key).unwrap().unwrap()["transcripts"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let (_, parts) = get_audio_parts(key, "room").unwrap();
    assert_eq!(read_protected(&parts[0].path).unwrap(), audio);
    assert_ne!(fs::read(&parts[0].path).unwrap(), audio);
    let unkeyed = Connection::open(directory.path().join("workspace.sqlite")).unwrap();
    assert!(unkeyed
        .query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| row
            .get::<_, u64>(0))
        .is_err());
    let disk = with_key(|key| {
        Ok(unlock_database(&directory.path().join("workspace.sqlite"), key).unwrap())
    })
    .unwrap();
    let saved: String = disk
        .query_row("SELECT data FROM meetings WHERE id=?", [key], |r| r.get(0))
        .unwrap();
    assert!(saved.contains("Ship next Friday."));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(directory.path().join("workspace.sqlite"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&parts[0].path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let pending =
        create_meeting(json!({"title":"Delete on recovery","mode":"import","consent":false}))
            .unwrap();
    let pending_id = pending["id"].as_str().unwrap();
    add_audio(
        pending_id,
        audio,
        Some("room"),
        "Room microphone",
        "audio/wav",
        Some(0),
    )
    .unwrap();
    with_db(|db| {
        db.execute("INSERT INTO deletion_jobs(id) VALUES(?)", [pending_id])?;
        recover(db)
    })
    .unwrap();
    assert!(get_meeting(pending_id).unwrap().is_none());
    assert!(!directory.path().join("audio").join(pending_id).exists());
    with_db(|db| {
        db.execute("INSERT INTO meetings VALUES('damaged','{')", [])?;
        Ok(())
    })
    .unwrap();
    assert_eq!(list_meetings().unwrap().len(), 1);
    assert!(export_library().is_err());
    with_db(|db| {
        db.execute("DELETE FROM meetings WHERE id='damaged'", [])?;
        Ok(())
    })
    .unwrap();
    DATABASE.get().unwrap().lock().unwrap().take();
    WORKSPACE_LOCK.get().unwrap().lock().unwrap().take();
    std::env::remove_var("ECHO_DATA_DIR");
}
