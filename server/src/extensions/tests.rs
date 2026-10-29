use super::*;
use axum::body::Body;
use tower::ServiceExt;
const ORIGIN: &str = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn app() -> Router {
    Router::new()
        .nest(
            "/api",
            workspace_routes().layer(axum::middleware::from_fn(crate::security::local_access)),
        )
        .nest("/extension/v1", extension_routes())
}
async fn send(
    app: &Router,
    method: &str,
    path: &str,
    origin: &str,
    credential: Option<&str>,
    body: Vec<u8>,
    extra: &[(&str, String)],
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "localhost:3000")
        .header("origin", origin)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(c) = credential {
        req = req.header(header::AUTHORIZATION, format!("Bearer {c}"));
    }
    for (k, v) in extra {
        req = req.header(*k, v);
    }
    let response = app
        .clone()
        .oneshot(req.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    let bytes = to_bytes(response.into_body(), 16 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec();
    (status, headers, bytes)
}
async fn json_request(
    app: &Router,
    method: &str,
    path: &str,
    origin: &str,
    credential: Option<&str>,
    value: Value,
) -> (StatusCode, Value) {
    let (status, _, bytes) = send(
        app,
        method,
        path,
        origin,
        credential,
        serde_json::to_vec(&value).unwrap(),
        &[],
    )
    .await;
    let v: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| panic!("non-JSON {} {:?}", status, String::from_utf8_lossy(&bytes)));
    if path.starts_with("/extension/") || status.is_success() {
        assert_eq!(v["protocolVersion"], 1);
    }
    (status, v)
}
async fn pair(app: &Router, installation: &str) -> (String, String, String) {
    let (_, code) = json_request(
        app,
        "POST",
        "/api/extensions/pairing",
        "http://localhost:3000",
        None,
        json!({}),
    )
    .await;
    let request = json!({"code":code["code"],"installationId":installation,"name":"Test browser"});
    let (status, pending) = json_request(
        app,
        "POST",
        "/extension/v1/pairing/request",
        ORIGIN,
        None,
        request,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let claim =
        json!({"code":code["code"],"installationId":installation,"requestId":pending["requestId"]});
    let (_, v) = json_request(
        app,
        "POST",
        "/extension/v1/pairing/claim",
        ORIGIN,
        None,
        claim.clone(),
    )
    .await;
    assert_eq!(v["status"], "pending");
    let id = pending["requestId"].as_str().unwrap();
    let (status, _) = json_request(
        app,
        "POST",
        &format!("/api/extensions/requests/{id}/approve"),
        "http://localhost:3000",
        None,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, claimed) = json_request(
        app,
        "POST",
        "/extension/v1/pairing/claim",
        ORIGIN,
        None,
        claim.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, retry) = json_request(
        app,
        "POST",
        "/extension/v1/pairing/claim",
        ORIGIN,
        None,
        claim,
    )
    .await;
    assert_eq!(retry["credential"], claimed["credential"]);
    (
        claimed["credential"].as_str().unwrap().into(),
        code["code"].as_str().unwrap().into(),
        id.into(),
    )
}
fn input() -> Value {
    json!({"title":"Extension test","provider":"meet","meetingUrl":"https://meet.google.com/aaa-bbbb-ccc","consent":true,"liveTranscription":true,"sampleRate":16000,"channels":1,"createdAt":"2026-10-05T12:00:00Z"})
}
#[test]
fn live_status_snapshot_bounds_preview_and_expires_heartbeats() {
    let mut r = json!({"recordingId":"r","meetingId":"m","status":"receiving","liveTranscription":true,"generation":2,"totalFrames":640000,
            "draft":{"throughFrame":320000,"committedThroughFrame":280000,"words":[{"text":"é".repeat(1000),"provisional":true}]},
            "liveStatus":{"status":"catching-up","updatedAt":100,"generation":2}});
    let current = live_snapshot(&r, &json!({}), "library", 110);
    assert_eq!(current["status"], "catching-up");
    assert_eq!(current["preview"].as_str().unwrap().chars().count(), 600);
    assert_eq!(current["backlogSeconds"], 20.0);
    assert_eq!(
        live_snapshot(&r, &json!({}), "library", 115)["status"],
        "paused-open-echo"
    );
    r["generation"] = json!(3);
    assert_eq!(
        live_snapshot(&r, &json!({}), "library", 110)["status"],
        "paused-open-echo"
    );
    r["status"] = json!("complete");
    assert_eq!(
        live_snapshot(&r, &json!({}), "library", 110)["status"],
        "final-transcript-needed"
    );
    // Missing models, cancellation and processing failures leave saved audio ready for retry.
    for meeting in [
        json!({"status":"saved"}),
        json!({"status":"saved","error":"Cancelled"}),
        json!({"status":"error","error":"Model unavailable"}),
    ] {
        assert_eq!(
            live_snapshot(&r, &meeting, "library", 110)["status"],
            "final-transcript-needed"
        );
    }
    assert_eq!(
        live_snapshot(&r, &json!({"status":"processing"}), "library", 110)["status"],
        "finalizing"
    );
    assert_eq!(
        live_snapshot(&r, &json!({"transcripts":[{}]}), "library", 110)["status"],
        "complete"
    );
}
#[tokio::test]
async fn live_preview_ownership_status_fencing_and_connection_revocation() {
    let _guard = store::TEST_LIBRARY_LOCK.lock().await;
    let directory = crate::store::test_directory();
    store::reset_for_tests();
    std::env::set_var("ECHO_DATA_DIR", directory.path());
    crate::store::test_key();
    store::init().unwrap();
    let app = app();
    let first = Uuid::new_v4().to_string();
    let second = Uuid::new_v4().to_string();
    let (token, _, _) = pair(&app, &first).await;
    let (other, _, _) = pair(&app, &second).await;
    let id = Uuid::new_v4().to_string();
    let (code, _) = json_request(
        &app,
        "PUT",
        &format!("/extension/v1/recordings/{id}"),
        ORIGIN,
        Some(&token),
        input(),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    let path = format!("/extension/v1/recordings/{id}/live");
    let (code, preview) = json_request(&app, "GET", &path, ORIGIN, Some(&token), json!(null)).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(preview["status"], "paused-open-echo");
    assert!(preview.get("draft").is_none());
    for (credential, expected) in [
        (Some(other.as_str()), StatusCode::FORBIDDEN),
        (None, StatusCode::UNAUTHORIZED),
    ] {
        assert_eq!(
            json_request(&app, "GET", &path, ORIGIN, credential, json!(null))
                .await
                .0,
            expected
        );
    }
    assert_eq!(
        json_request(
            &app,
            "GET",
            &format!("/extension/v1/recordings/{}/live", Uuid::new_v4()),
            ORIGIN,
            Some(&token),
            json!(null)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        json_request(
            &app,
            "GET",
            &path,
            "https://hostile.example",
            Some(&token),
            json!(null)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let report = format!("/api/extensions/recordings/{id}/live-status");
    assert_eq!(
        json_request(
            &app,
            "POST",
            &report,
            "http://localhost:3000",
            None,
            json!({"ownerId":"a","generation":0,"status":"model-missing"})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        json_request(&app, "GET", &path, ORIGIN, Some(&token), json!(null))
            .await
            .1["status"],
        "model-missing"
    );
    let (_, lease) = json_request(
        &app,
        "POST",
        &format!("/api/extensions/recordings/{id}/lease"),
        "http://localhost:3000",
        None,
        json!({"ownerId":"a"}),
    )
    .await;
    for (owner, generation, expected) in [
        ("b", lease["generation"].clone(), StatusCode::CONFLICT),
        ("a", json!(0), StatusCode::CONFLICT),
        ("a", lease["generation"].clone(), StatusCode::OK),
    ] {
        assert_eq!(
            json_request(
                &app,
                "POST",
                &report,
                "http://localhost:3000",
                None,
                json!({"ownerId":owner,"generation":generation,"status":"live"})
            )
            .await
            .0,
            expected
        );
    }
    assert_eq!(
        json_request(
            &app,
            "POST",
            &report,
            ORIGIN,
            Some(&token),
            json!({"ownerId":"a","generation":lease["generation"],"status":"live"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (_, connection) = json_request(
        &app,
        "GET",
        "/extension/v1/connection",
        ORIGIN,
        Some(&token),
        json!(null),
    )
    .await;
    assert_eq!(connection["installationId"], first);
    assert!(connection.get("credential").is_none());
    assert_eq!(
        json_request(
            &app,
            "DELETE",
            "/extension/v1/connection",
            ORIGIN,
            Some(&token),
            json!(null)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        json_request(&app, "GET", &path, ORIGIN, Some(&token), json!(null))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        json_request(
            &app,
            "GET",
            "/extension/v1/connection",
            ORIGIN,
            Some(&other),
            json!(null)
        )
        .await
        .0,
        StatusCode::OK
    );
    store::reset_for_tests();
}
#[tokio::test]
async fn completed_receipts_authenticate_every_audio_block_and_manifest_digest() {
    let _guard = store::TEST_LIBRARY_LOCK.lock().await;
    let directory = crate::store::test_directory();
    store::reset_for_tests();
    std::env::set_var("ECHO_DATA_DIR", directory.path());
    crate::store::test_key();
    store::init().unwrap();
    let app = app();
    let (token, _, _) = pair(&app, &Uuid::new_v4().to_string()).await;
    let id = Uuid::new_v4().to_string();
    let route = format!("/extension/v1/recordings/{id}");
    let (_, started) = json_request(&app, "PUT", &route, ORIGIN, Some(&token), input()).await;
    let pcm = vec![1u8, 0, 2, 0, 3, 0, 4, 0];
    assert_eq!(
        send(
            &app,
            "PUT",
            &format!("{route}/chunks/0"),
            ORIGIN,
            Some(&token),
            pcm.clone(),
            &[("x-echo-frames", "4".into()), ("x-echo-sha256", hash(&pcm))]
        )
        .await
        .0,
        StatusCode::OK
    );
    let manifest = json!({"chunkCount":1,"totalFrames":4,"gaps":[],"interrupted":false});
    assert_eq!(
        json_request(
            &app,
            "POST",
            &format!("{route}/complete"),
            ORIGIN,
            Some(&token),
            manifest.clone()
        )
        .await
        .0,
        StatusCode::OK
    );
    let meeting_id = started["meetingId"].as_str().unwrap();
    let file = store::with_db(|db| {
        Ok(db.query_row(
            "SELECT file FROM audio_chunks WHERE meeting_id=?",
            [meeting_id],
            |r| r.get::<_, String>(0),
        )?)
    })
    .unwrap();
    let path = directory.path().join("audio").join(meeting_id).join(file);
    let original = fs::read(&path).unwrap();
    let mut damaged = original.clone();
    damaged[80] ^= 1; // Valid header and length, damaged authenticated body.
    fs::write(&path, &damaged).unwrap();
    for (method, suffix, body) in [
        ("GET", "", json!(null)),
        ("POST", "/complete", manifest.clone()),
        ("PUT", "", input()),
    ] {
        assert_eq!(
            json_request(
                &app,
                method,
                &format!("{route}{suffix}"),
                ORIGIN,
                Some(&token),
                body
            )
            .await
            .0,
            StatusCode::GONE
        );
    }
    assert_eq!(
        fs::read(&path).unwrap(),
        damaged,
        "verification never discards damaged evidence"
    );
    assert_eq!(
        read_chunk(
            &pcm_dir(&id).unwrap().join(format!("0-{}.pcm", hash(&pcm))),
            4,
            &hash(&pcm)
        )
        .unwrap(),
        pcm,
        "original ingest prefix remains recoverable"
    );
    fs::write(&path, &original).unwrap();
    assert_eq!(
        json_request(&app, "GET", &route, ORIGIN, Some(&token), json!(null))
            .await
            .0,
        StatusCode::OK
    );
    // Even a valid encrypted replacement must match the saved manifest.
    store::replace_protected(&path, &[0; 52]).unwrap();
    assert_eq!(
        json_request(&app, "GET", &route, ORIGIN, Some(&token), json!(null))
            .await
            .0,
        StatusCode::GONE
    );
    store::reset_for_tests();
    std::env::remove_var("ECHO_DATA_DIR");
}
#[tokio::test]
async fn pairing_durable_ingest_security_replay_recovery_tombstones_and_leases() {
    let _guard = store::TEST_LIBRARY_LOCK.lock().await;
    let directory = crate::store::test_directory();
    store::reset_for_tests();
    std::env::set_var("ECHO_DATA_DIR", directory.path());
    crate::store::test_key();
    store::init().unwrap();
    store::with_db(|db| {
        assert_eq!(
            db.query_row("PRAGMA synchronous", [], |row| row.get::<_, i64>(0))?,
            2
        );
        Ok(())
    })
    .unwrap();
    let app = app();
    let install = Uuid::new_v4().to_string();
    let (token, code, request) = pair(&app, &install).await;
    // Credentials and pairing secrets are never persisted verbatim.
    store::with_db(|db| {
        let saved: String = db.query_row(
            "SELECT credential_hash FROM extension_connections",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(saved, hash(&token));
        let saved: String =
            db.query_row("SELECT code_hash FROM extension_pairing", [], |r| r.get(0))?;
        assert_eq!(saved, hash(&code));
        Ok(())
    })
    .unwrap();
    for origin in [
        "https://hostile.example",
        "null",
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
        "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    ] {
        let (status, _, _) = send(
            &app,
            "GET",
            "/extension/v1/recordings/unknown",
            origin,
            Some(&token),
            vec![],
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    for host in [
        "attacker.example",
        "localhost:3000@attacker.example",
        "localhost:3000/evil",
        "127.0.0.1:3000?evil",
        "localhost:bad",
    ] {
        assert!(!loopback(&HeaderMap::from_iter([(
            header::HOST,
            HeaderValue::from_str(host).unwrap()
        )])));
    }
    let (status, _) = json_request(
        &app,
        "GET",
        "/api/extensions/connections",
        ORIGIN,
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, headers, _) = send(
        &app,
        "OPTIONS",
        "/extension/v1/recordings/id",
        ORIGIN,
        None,
        vec![],
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], ORIGIN);
    let claim = json!({"code":code,"requestId":request,"installationId":install});
    let (status, _) = json_request(
        &app,
        "POST",
        "/extension/v1/pairing/claim",
        "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        None,
        claim.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = json_request(
        &app,
        "POST",
        "/extension/v1/pairing/request",
        ORIGIN,
        None,
        json!({"code":code,"installationId":Uuid::new_v4().to_string(),"name":"Other"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let id = Uuid::new_v4().to_string();
    let path = format!("/extension/v1/recordings/{id}");
    let (status, r) = json_request(&app, "PUT", &path, ORIGIN, Some(&token), input()).await;
    assert_eq!(status, StatusCode::OK);
    let meeting = r["meetingId"].as_str().unwrap().to_string();
    let (_, retry) = json_request(&app, "PUT", &path, ORIGIN, Some(&token), input()).await;
    assert_eq!(retry["meetingId"], meeting);
    let mut no_consent = input();
    no_consent["consent"] = json!(false);
    let (status, _) = json_request(
        &app,
        "PUT",
        &format!("/extension/v1/recordings/{}", Uuid::new_v4()),
        ORIGIN,
        Some(&token),
        no_consent,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let mut conflict = input();
    conflict["title"] = json!("Changed");
    let (status, _) = json_request(&app, "PUT", &path, ORIGIN, Some(&token), conflict).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let other = Uuid::new_v4().to_string();
    let (other_token, _, _) = pair(&app, &other).await;
    let (status, _) = json_request(&app, "GET", &path, ORIGIN, Some(&other_token), json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let data = vec![1, 0, 2, 0, 3, 0, 4, 0];
    let extra = [
        ("x-echo-frames", "4".into()),
        ("x-echo-sha256", hash(&data)),
    ];
    let chunk_path = format!("{path}/chunks/0");
    let (status, _, _) = send(
        &app,
        "PUT",
        &format!("{path}/chunks/1"),
        ORIGIN,
        Some(&token),
        data.clone(),
        &extra,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    // Repair a file left partially written before a durable manifest commit.
    store::mkdir(&pcm_dir(&id).unwrap()).unwrap();
    fs::write(
        pcm_dir(&id).unwrap().join(format!("0-{}.pcm", hash(&data))),
        [1],
    )
    .unwrap();
    let (status, _, _) = send(
        &app,
        "PUT",
        &chunk_path,
        ORIGIN,
        Some(&token),
        data.clone(),
        &extra,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = send(
        &app,
        "PUT",
        &chunk_path,
        ORIGIN,
        Some(&token),
        data.clone(),
        &extra,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let changed = vec![5, 0, 2, 0, 3, 0, 4, 0];
    let changed_extra = [
        ("x-echo-frames", "4".into()),
        ("x-echo-sha256", hash(&changed)),
    ];
    let (status, _, _) = send(
        &app,
        "PUT",
        &chunk_path,
        ORIGIN,
        Some(&token),
        changed,
        &changed_extra,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _, _) = send(
        &app,
        "PUT",
        &chunk_path,
        ORIGIN,
        Some(&token),
        vec![1],
        &extra,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let status_path = format!("/api/extensions/recordings/{id}");
    let (_, first) = json_request(
        &app,
        "POST",
        &format!("{status_path}/lease"),
        "http://localhost:3000",
        None,
        json!({"ownerId":"tab1"}),
    )
    .await;
    let (_, renew) = json_request(
        &app,
        "POST",
        &format!("{status_path}/lease"),
        "http://localhost:3000",
        None,
        json!({"ownerId":"tab1"}),
    )
    .await;
    assert_eq!(first["generation"], renew["generation"]);
    let (status, _) = json_request(
        &app,
        "POST",
        &format!("{status_path}/lease"),
        "http://localhost:3000",
        None,
        json!({"ownerId":"tab2"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let draft = json!({"ownerId":"tab1","generation":first["generation"],"throughFrame":4,"committedThroughFrame":2,"words":[{"text":"Hi","startFrame":0,"endFrame":4,"provisional":false},{"text":"tail","startFrame":1,"endFrame":4,"provisional":true}],"language":"en","modelRevision":"large-v3"});
    let (status, _) = json_request(
        &app,
        "POST",
        &format!("{status_path}/draft"),
        "http://localhost:3000",
        None,
        draft.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mut changed_committed = draft.clone();
    changed_committed["words"][0]["text"] = json!("Changed committed word");
    let (status, _) = json_request(
        &app,
        "POST",
        &format!("{status_path}/draft"),
        "http://localhost:3000",
        None,
        changed_committed,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let mut overflow = draft.clone();
    overflow["throughFrame"] = json!(u64::MAX);
    let (status, _) = json_request(
        &app,
        "POST",
        &format!("{status_path}/draft"),
        "http://localhost:3000",
        None,
        overflow,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    store::with_db(|db| {
        let mut r = recording(db, &id)?;
        r["lease"]["expiresAt"] = json!(seconds() - 1);
        save_recording(db, &r)
    })
    .unwrap();
    let (status, _) = json_request(
        &app,
        "POST",
        &format!("{status_path}/draft"),
        "http://localhost:3000",
        None,
        draft.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (_, second) = json_request(
        &app,
        "POST",
        &format!("{status_path}/lease"),
        "http://localhost:3000",
        None,
        json!({"ownerId":"tab2"}),
    )
    .await;
    assert!(second["generation"].as_u64().unwrap() > first["generation"].as_u64().unwrap());
    assert_eq!(second["totalFrames"], 4);
    assert_eq!(second["draft"]["throughFrame"], 4);
    assert_eq!(second["draft"]["words"], draft["words"]);
    let (status, _) = json_request(
        &app,
        "POST",
        &format!("{status_path}/draft"),
        "http://localhost:3000",
        None,
        draft.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _, bytes) = send(
        &app,
        "GET",
        &format!("{status_path}/pcm?startFrame=1&frameCount=2"),
        "http://localhost:3000",
        None,
        vec![],
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, data[2..6]);
    let (status, _, _) = send(
        &app,
        "GET",
        &format!("{status_path}/pcm?startFrame=0&frameCount=320001"),
        "http://localhost:3000",
        None,
        vec![],
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let command = Uuid::new_v4().to_string();
    let control = json!({"commandId":command,"action":"pause"});
    for _ in 0..2 {
        let (status, _) = json_request(
            &app,
            "POST",
            &format!("{status_path}/controls"),
            "http://localhost:3000",
            None,
            control.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    let (_, r) = json_request(&app, "GET", &path, ORIGIN, Some(&token), json!({})).await;
    assert_eq!(r["controls"].as_array().unwrap().len(), 1);
    let (status, _) = json_request(
        &app,
        "POST",
        &format!("{path}/controls/{command}/ack"),
        ORIGIN,
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    json_request(
        &app,
        "POST",
        &format!("{status_path}/controls"),
        "http://localhost:3000",
        None,
        control,
    )
    .await;
    let (_, r) = json_request(&app, "GET", &path, ORIGIN, Some(&token), json!({})).await;
    assert!(r["controls"].as_array().unwrap().is_empty());
    // Restart retains the credential and manifest while durable upload retries keep the mapping.
    store::reset_for_tests();
    store::init().unwrap();
    let (status, claimed) = json_request(
        &app,
        "POST",
        "/extension/v1/pairing/claim",
        ORIGIN,
        None,
        claim.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(claimed["credential"], token);
    let (status, r) = json_request(&app, "GET", &path, ORIGIN, Some(&token), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(r["nextSequence"], 1);
    assert_eq!(r["meetingId"], meeting);
    assert!(store::export_library().is_err());
    let incomplete = json!({"chunkCount":2,"totalFrames":4,"gaps":[],"interrupted":false});
    let (status, _) = json_request(
        &app,
        "POST",
        &format!("{path}/complete"),
        ORIGIN,
        Some(&token),
        incomplete,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let saved_file = pcm_dir(&id).unwrap().join(format!("0-{}.pcm", hash(&data)));
    fs::write(&saved_file, [9; 8]).unwrap();
    let manifest = json!({"chunkCount":1,"totalFrames":4,"gaps":[{"atFrame":2,"pauseMs":100}],"interrupted":false});
    let (status, _) = json_request(
        &app,
        "POST",
        &format!("{path}/complete"),
        ORIGIN,
        Some(&token),
        manifest.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::GONE);
    store::replace_protected(&saved_file, &data).unwrap();
    let (status, r) = json_request(
        &app,
        "POST",
        &format!("{path}/complete"),
        ORIGIN,
        Some(&token),
        manifest.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(r["status"], "complete");
    let (status, _) = json_request(
        &app,
        "POST",
        &format!("{path}/complete"),
        ORIGIN,
        Some(&token),
        manifest.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mut bad_manifest = manifest.clone();
    bad_manifest["interrupted"] = json!(true);
    let (status, _) = json_request(
        &app,
        "POST",
        &format!("{path}/complete"),
        ORIGIN,
        Some(&token),
        bad_manifest,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _, bytes) = send(
        &app,
        "GET",
        &format!("/api/extensions/meetings/{meeting}/audio"),
        "http://localhost:3000",
        None,
        vec![],
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(&bytes[..44], &wav_header(4));
    assert_eq!(&bytes[44..], &data);
    let (status, headers, bytes) = send(
        &app,
        "GET",
        &format!("/api/extensions/meetings/{meeting}/audio"),
        "http://localhost:3000",
        None,
        vec![],
        &[("range", "bytes=42-47".into())],
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(headers[header::CONTENT_RANGE], "bytes 42-47/52");
    assert_eq!(&bytes[2..], &data[..4]);
    let (status, _) = json_request(
        &app,
        "POST",
        &format!("{status_path}/lease"),
        "http://localhost:3000",
        None,
        json!({"ownerId":"tab2"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(store::with_db(|db| Ok(recording(db, &id)?["draft"].is_object())).unwrap());
    store::update_meeting(&meeting, json!({"status":"processing"})).unwrap();
    assert!(store::with_db(|db| Ok(recording(db, &id)?["draft"].is_object())).unwrap());
    store::add_transcript(
        &meeting,
        json!({"model":"large-v3","passages":[],"vocabulary":[]}),
    )
    .unwrap();
    assert!(store::with_db(|db| Ok(recording(db, &id)?["draft"].is_null())).unwrap());
    let backup = store::export_library().unwrap();
    assert_eq!(backup["extensionRecordings"][0]["recordingId"], id);
    assert!(validate_receipts(&json!([]), backup["meetings"].as_array().unwrap()).is_err());
    let completed = store::get_meeting(&meeting).unwrap().unwrap();
    let (_, parts) =
        store::get_audio_parts(&meeting, completed["tracks"][0]["id"].as_str().unwrap()).unwrap();
    let saved_wav = fs::read(&parts[0].path).unwrap();
    fs::remove_file(&parts[0].path).unwrap();
    let (status, _) = json_request(&app, "GET", &path, ORIGIN, Some(&token), json!({})).await;
    assert_eq!(status, StatusCode::GONE);
    store::write_private(&parts[0].path, &saved_wav).unwrap();
    assert!(!backup.to_string().contains(&token));
    assert!(!backup.to_string().contains(&code));
    store::delete_meeting(&meeting).unwrap();
    assert!(!pcm_dir(&id).unwrap().exists());
    let (_, r) = json_request(&app, "GET", &path, ORIGIN, Some(&token), json!({})).await;
    assert_eq!(r["status"], "deleted");
    let (_, r) = json_request(&app, "PUT", &path, ORIGIN, Some(&token), input()).await;
    assert_eq!(r["status"], "deleted");
    let (_, r) = json_request(
        &app,
        "POST",
        &format!("{path}/complete"),
        ORIGIN,
        Some(&token),
        manifest,
    )
    .await;
    assert_eq!(r["status"], "deleted");
    assert!(store::import_library(backup).is_err());
    let tombstone_backup = store::export_library().unwrap();
    assert_eq!(
        tombstone_backup["extensionRecordings"][0]["status"],
        "deleted"
    );
    let (status, _) = json_request(
        &app,
        "DELETE",
        &format!("/api/extensions/connections/{install}"),
        "http://localhost:3000",
        None,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = json_request(&app, "GET", &path, ORIGIN, Some(&token), json!({})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = json_request(
        &app,
        "POST",
        "/extension/v1/pairing/claim",
        ORIGIN,
        None,
        claim,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let expired_install = Uuid::new_v4().to_string();
    let (_, expired_code, expired_request) = pair(&app, &expired_install).await;
    store::with_db(|db| {
        db.execute(
            "UPDATE extension_pairing SET expires=? WHERE request_id=?",
            params![seconds() - 1, expired_request],
        )?;
        Ok(())
    })
    .unwrap();
    let (status, _) = json_request(
        &app,
        "POST",
        "/extension/v1/pairing/claim",
        ORIGIN,
        None,
        json!({"code":expired_code,"requestId":expired_request,"installationId":expired_install}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, bytes) = send(
        &app,
        "PUT",
        &chunk_path,
        ORIGIN,
        Some(&token),
        vec![0; 256 * 1024 + 1],
        &extra,
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["protocolVersion"],
        1
    );
    store::reset_for_tests();
    std::env::remove_var("ECHO_DATA_DIR");
}
#[tokio::test]
async fn thirty_minute_parts_form_one_stream_and_portable_receipts_restore() {
    let _guard = store::TEST_LIBRARY_LOCK.lock().await;
    let directory = crate::store::test_directory();
    store::reset_for_tests();
    std::env::set_var("ECHO_DATA_DIR", directory.path());
    crate::store::test_key();
    store::init().unwrap();
    let app = app();
    let install = Uuid::new_v4().to_string();
    let (token, _, _) = pair(&app, &install).await;
    let id = Uuid::new_v4().to_string();
    let path = format!("/extension/v1/recordings/{id}");
    let (status, r) = json_request(&app, "PUT", &path, ORIGIN, Some(&token), input()).await;
    assert_eq!(status, StatusCode::OK);
    let meeting = r["meetingId"].as_str().unwrap().to_string();
    let block = vec![17u8; (RATE * 2) as usize];
    let tail = vec![29u8; 2];
    store::mkdir(&pcm_dir(&id).unwrap()).unwrap();
    store::write_protected(&pcm_dir(&id).unwrap().join("fixture-block.pcm"), &block).unwrap();
    store::write_protected(&pcm_dir(&id).unwrap().join("fixture-tail.pcm"), &tail).unwrap();
    store::with_db(|db| {
        let tx = db.transaction()?;
        for sequence in 0..1800 {
            tx.execute(
                "INSERT INTO extension_chunks VALUES(?,?,?,?,?)",
                params![id, sequence, RATE, hash(&block), "fixture-block.pcm"],
            )?;
        }
        tx.execute(
            "INSERT INTO extension_chunks VALUES(?,?,?,?,?)",
            params![id, 1800, 1, hash(&tail), "fixture-tail.pcm"],
        )?;
        let mut r = recording(&tx, &id)?;
        r["nextSequence"] = json!(1801);
        r["totalFrames"] = json!(PART_FRAMES + 1);
        save_recording(&tx, &r)?;
        let mut m = store::require_meeting(&tx, &meeting)?;
        m["extensionRecording"]["totalFrames"] = json!(PART_FRAMES + 1);
        store::save(&tx, &mut m)?;
        tx.commit()?;
        Ok(())
    })
    .unwrap();
    let (status, r) = json_request(
        &app,
        "POST",
        &format!("{path}/complete"),
        ORIGIN,
        Some(&token),
        json!({"chunkCount":1801,"totalFrames":PART_FRAMES+1,"gaps":[],"interrupted":false}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(r["status"], "complete");
    let m = store::get_meeting(&meeting).unwrap().unwrap();
    assert_eq!(m["tracks"].as_array().unwrap().len(), 2);
    assert_eq!(m["tracks"][0]["bytes"], 44 + PART_FRAMES * 2);
    assert_eq!(m["tracks"][1]["bytes"], 46);
    assert_eq!(m["duration"], (PART_FRAMES + 1) as f64 / RATE as f64);
    let boundary = 44 + PART_FRAMES * 2;
    let (status, _, bytes) = send(
        &app,
        "GET",
        &format!("/api/extensions/meetings/{meeting}/audio"),
        "http://localhost:3000",
        None,
        vec![],
        &[("range", format!("bytes={}-{}", boundary - 2, boundary + 1))],
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(bytes, vec![17, 17, 29, 29]);
    let backup = store::export_library().unwrap();
    assert_eq!(backup["extensionRecordings"][0]["recordingId"], id);
    let restored_directory = crate::store::test_directory();
    store::reset_for_tests();
    std::env::set_var("ECHO_DATA_DIR", restored_directory.path());
    store::test_key();
    store::import_library(backup.clone()).unwrap();
    let restored = store::get_meeting(&meeting).unwrap().unwrap();
    assert_eq!(restored["extensionRecording"], m["extensionRecording"]);
    assert_eq!(
        store::with_db(|db| Ok(recording(db, &id)?["status"].clone())).unwrap(),
        "complete"
    );
    assert_eq!(
        store::with_db(|db| Ok(db.query_row(
            "SELECT COUNT(*) FROM extension_connections",
            [],
            |r| r.get::<_, i64>(0)
        )?))
        .unwrap(),
        0
    );
    let (status, _, bytes) = send(
        &app,
        "GET",
        &format!("/api/extensions/meetings/{meeting}/audio"),
        "http://localhost:3000",
        None,
        vec![],
        &[("range", format!("bytes={}-{}", boundary - 2, boundary + 1))],
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(bytes, vec![17, 17, 29, 29]);
    let mut corrupted = backup;
    corrupted["extensionRecordings"][0]["totalFrames"] = json!(1);
    assert!(validate_receipts(
        &corrupted["extensionRecordings"],
        corrupted["meetings"].as_array().unwrap()
    )
    .is_err());
    store::delete_meeting(&meeting).unwrap();
    let tombstones = store::export_library().unwrap();
    let tombstone_directory = crate::store::test_directory();
    store::reset_for_tests();
    std::env::set_var("ECHO_DATA_DIR", tombstone_directory.path());
    store::test_key();
    store::import_library(tombstones).unwrap();
    assert_eq!(
        store::with_db(|db| Ok(recording(db, &id)?["status"].clone())).unwrap(),
        "deleted"
    );
    store::reset_for_tests();
    std::env::remove_var("ECHO_DATA_DIR");
}
#[tokio::test]
async fn start_accepts_current_and_legacy_meeting_hosts_but_rejects_lookalikes() {
    let _guard = store::TEST_LIBRARY_LOCK.lock().await;
    let directory = crate::store::test_directory();
    store::reset_for_tests();
    std::env::set_var("ECHO_DATA_DIR", directory.path());
    crate::store::test_key();
    store::init().unwrap();
    let app = app();
    let (token, _, _) = pair(&app, &Uuid::new_v4().to_string()).await;
    for (provider, host, path) in [
        ("meet", "meet.google.com", "/aaa-bbbb-ccc"),
        ("zoom", "zoom.us", "/wc/123456/join"),
        ("zoom", "us02web.zoom.us", "/wc/123456/join"),
        ("zoom", "app.zoom.com", "/wc/123456/join"),
        ("teams", "teams.microsoft.com", "/l/meetup-join/test"),
        ("teams", "teams.live.com", "/meet/test"),
        ("teams", "teams.cloud.microsoft", "/l/meetup-join/test"),
    ] {
        let mut metadata = input();
        metadata["provider"] = json!(provider);
        metadata["meetingUrl"] = json!(format!("https://{host}{path}"));
        let (status, recording) = json_request(
            &app,
            "PUT",
            &format!("/extension/v1/recordings/{}", Uuid::new_v4()),
            ORIGIN,
            Some(&token),
            metadata,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{provider} {host}");
        assert_eq!(recording["status"], "receiving");
    }
    for (provider, host) in [
        ("meet", "meet.google.com.evil.example"),
        ("zoom", "app.zoom.com.evil.example"),
        ("zoom", "evilapp.zoom.com"),
        ("zoom", "evil.zoom.com"),
        ("zoom", "zoom.us.evil.example"),
        ("zoom", "evilzoom.us"),
        ("teams", "teams.cloud.microsoft.evil.example"),
        ("teams", "evilteams.cloud.microsoft"),
        ("teams", "teams.microsoft.com.evil.example"),
        ("teams", "teams.live.com.evil.example"),
        ("teams", "app.zoom.com"),
    ] {
        let mut metadata = input();
        metadata["provider"] = json!(provider);
        metadata["meetingUrl"] = json!(format!("https://{host}/meeting/test"));
        let (status, _) = json_request(
            &app,
            "PUT",
            &format!("/extension/v1/recordings/{}", Uuid::new_v4()),
            ORIGIN,
            Some(&token),
            metadata,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{provider} {host}");
    }
    store::reset_for_tests();
    std::env::remove_var("ECHO_DATA_DIR");
}
#[tokio::test]
async fn orphan_retries_resync_files_and_directories_before_durable_ack() {
    let _guard = store::TEST_LIBRARY_LOCK.lock().await;
    let directory = crate::store::test_directory();
    store::reset_for_tests();
    std::env::set_var("ECHO_DATA_DIR", directory.path());
    crate::store::test_key();
    store::init().unwrap();
    let app = app();
    let (token, _, _) = pair(&app, &Uuid::new_v4().to_string()).await;
    let pcm = vec![1, 0, 2, 0, 3, 0, 4, 0];
    let extra = [("x-echo-frames", "4".into()), ("x-echo-sha256", hash(&pcm))];
    for fail_directory in [false, true] {
        let id = Uuid::new_v4().to_string();
        let path = format!("/extension/v1/recordings/{id}");
        let (status, _) = json_request(&app, "PUT", &path, ORIGIN, Some(&token), input()).await;
        assert_eq!(status, StatusCode::OK);
        let dir = pcm_dir(&id).unwrap();
        store::mkdir(&dir).unwrap();
        let file = dir.join(format!("0-{}.pcm", hash(&pcm)));
        // Valid content without fsync models a process death/failed prior durability attempt.
        fs::write(&file, &pcm).unwrap();
        let target = if fail_directory {
            dir.clone()
        } else {
            file.clone()
        };
        *SYNC_FAULT.lock().unwrap() = Some(SyncFault {
            path: target,
            failures_remaining: 1,
            calls: 0,
        });
        let (status, _, _) = send(
            &app,
            "PUT",
            &format!("{path}/chunks/0"),
            ORIGIN,
            Some(&token),
            pcm.clone(),
            &extra,
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(store::read_protected(&file).unwrap(), pcm);
        assert_ne!(fs::read(&file).unwrap(), pcm);
        store::with_db(|db| {
            assert_eq!(recording(db, &id)?["nextSequence"], 0);
            assert_eq!(
                db.query_row(
                    "SELECT COUNT(*) FROM extension_chunks WHERE recording_id=?",
                    [&id],
                    |row| row.get::<_, i64>(0)
                )?,
                0
            );
            Ok(())
        })
        .unwrap();
        let (status, _, _) = send(
            &app,
            "PUT",
            &format!("{path}/chunks/0"),
            ORIGIN,
            Some(&token),
            pcm.clone(),
            &extra,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let fault = SYNC_FAULT.lock().unwrap().take().unwrap();
        assert_eq!(
            fault.calls, 2,
            "retry must repeat the failed durability step"
        );
        store::with_db(|db| {
            assert_eq!(recording(db, &id)?["nextSequence"], 1);
            Ok(())
        })
        .unwrap();
    }
    for fail_directory in [false, true] {
        let id = Uuid::new_v4().to_string();
        let path = format!("/extension/v1/recordings/{id}");
        let (status, started) =
            json_request(&app, "PUT", &path, ORIGIN, Some(&token), input()).await;
        assert_eq!(status, StatusCode::OK);
        let meeting = started["meetingId"].as_str().unwrap();
        let (status, _, _) = send(
            &app,
            "PUT",
            &format!("{path}/chunks/0"),
            ORIGIN,
            Some(&token),
            pcm.clone(),
            &extra,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let dir = store::data_dir().unwrap().join("audio").join(meeting);
        store::mkdir(&dir).unwrap();
        let mut wav = wav_header(4);
        wav.extend_from_slice(&pcm);
        let file = dir.join(format!("extension-0-{}.wav", hash(&wav)));
        fs::write(&file, &wav).unwrap();
        let target = if fail_directory {
            dir.clone()
        } else {
            file.clone()
        };
        *SYNC_FAULT.lock().unwrap() = Some(SyncFault {
            path: target,
            failures_remaining: 1,
            calls: 0,
        });
        let manifest = json!({"chunkCount":1,"totalFrames":4,"gaps":[],"interrupted":false});
        let (status, _) = json_request(
            &app,
            "POST",
            &format!("{path}/complete"),
            ORIGIN,
            Some(&token),
            manifest.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(store::read_protected(&file).unwrap(), wav);
        assert_ne!(fs::read(&file).unwrap(), wav);
        store::with_db(|db| {
            assert_eq!(recording(db, &id)?["status"], "receiving");
            assert_eq!(
                db.query_row(
                    "SELECT COUNT(*) FROM audio_chunks WHERE meeting_id=?",
                    [meeting],
                    |row| row.get::<_, i64>(0)
                )?,
                0
            );
            assert!(store::require_meeting(db, meeting)?["tracks"]
                .as_array()
                .unwrap()
                .is_empty());
            Ok(())
        })
        .unwrap();
        let (status, completed) = json_request(
            &app,
            "POST",
            &format!("{path}/complete"),
            ORIGIN,
            Some(&token),
            manifest,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(completed["status"], "complete");
        let fault = SYNC_FAULT.lock().unwrap().take().unwrap();
        assert_eq!(
            fault.calls, 2,
            "reused WAV must repeat the failed durability step"
        );
        store::with_db(|db| {
            assert_eq!(
                db.query_row(
                    "SELECT COUNT(*) FROM audio_chunks WHERE meeting_id=?",
                    [meeting],
                    |row| row.get::<_, i64>(0)
                )?,
                1
            );
            Ok(())
        })
        .unwrap();
    }
    store::reset_for_tests();
    std::env::remove_var("ECHO_DATA_DIR");
}
#[test]
fn committed_temporal_ownership_allows_new_overlapping_words() {
    let old_word = json!({"text":"committed","startFrame":8,"endFrame":9,"provisional":false});
    let old = json!({"throughFrame":12,"committedThroughFrame":10,"words":[old_word]});
    let incoming = json!({"text":"new overlap","startFrame":7,"endFrame":14,"provisional":false});
    let submitted = vec![incoming.clone(), old_word.clone()];
    assert!(committed_words_match(&old, &submitted));
    let mut changed = old_word.clone();
    changed["text"] = json!("rewritten");
    assert!(!committed_words_match(&old, &[incoming.clone(), changed]));
    assert!(!committed_words_match(
        &old,
        std::slice::from_ref(&incoming)
    ));
    let invented_old =
        json!({"text":"invented prior-owned word","startFrame":5,"endFrame":6,"provisional":false});
    assert!(!committed_words_match(
        &old,
        &[invented_old, incoming, old_word]
    ));
}
#[test]
fn validated_loopback_hosts_and_ranges() {
    for host in [
        "localhost:3000",
        "127.0.0.1:3000",
        "[::1]:3000",
        "localhost",
    ] {
        assert!(
            loopback(&HeaderMap::from_iter([(
                header::HOST,
                HeaderValue::from_str(host).unwrap()
            )])),
            "{host}"
        );
    }
    assert_eq!(audio_range(Some("bytes=-8"), 52).unwrap(), (44, 51, true));
    assert_eq!(audio_range(Some("bytes=44-"), 52).unwrap(), (44, 51, true));
    assert!(audio_range(Some("bytes=52-"), 52).is_err());
    assert!(audio_range(Some("bytes=0-1,4-5"), 52).is_err());
}
