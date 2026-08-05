use std::{collections::HashMap, fs, path::PathBuf};

use actual_sync_server::{
    load_config::Config,
    proto::{MessageEnvelope, SyncRequest, SyncResponse},
    sync_simple,
};
use prost::Message;
use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureMessage {
    id: String,
    timestamp: String,
    is_encrypted: bool,
    content_hex: String,
    envelope_hex: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SinceCase {
    since: String,
    ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateFixture {
    id: String,
    conflicting_content_hex: String,
    exact_merkle: String,
    conflicting_merkle: String,
    retained_content_hex: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestFixture {
    file_id: String,
    group_id: String,
    key_id: String,
    since: String,
    message_ids: Vec<String>,
    encoded_hex: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFixture {
    version: u32,
    messages: Vec<FixtureMessage>,
    empty_merkle: String,
    insertion_order: Vec<String>,
    merkle: String,
    read_order: Vec<String>,
    since_cases: Vec<SinceCase>,
    duplicate: DuplicateFixture,
    sync_request: RequestFixture,
    sync_response_hex: String,
    malformed_payload_hex: String,
    malformed_timestamp: String,
}

fn decode_hex(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0, "hex fixture must contain byte pairs");
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
        .collect()
}

fn encode_hex(message: &impl Message) -> String {
    message
        .encode_to_vec()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn envelope(message: &FixtureMessage) -> MessageEnvelope {
    MessageEnvelope {
        timestamp: message.timestamp.clone(),
        is_encrypted: message.is_encrypted,
        content: decode_hex(&message.content_hex),
    }
}

fn ids(messages: &[MessageEnvelope], fixtures: &[FixtureMessage]) -> Vec<String> {
    messages
        .iter()
        .map(|message| {
            fixtures
                .iter()
                .find(|fixture| fixture.timestamp == message.timestamp)
                .unwrap()
                .id
                .clone()
        })
        .collect()
}

struct TempDirectory(PathBuf);

impl TempDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("actual-crdt-golden-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDirectory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn rust_matches_the_typescript_crdt_golden_fixture() {
    let fixture: GoldenFixture =
        serde_json::from_str(include_str!("../contract/fixtures/crdt-sync-golden.json")).unwrap();
    assert_eq!(fixture.version, 1);
    let by_id = fixture
        .messages
        .iter()
        .map(|message| (message.id.as_str(), message))
        .collect::<HashMap<_, _>>();

    for message in &fixture.messages {
        let bytes = decode_hex(&message.envelope_hex);
        let decoded = MessageEnvelope::decode(bytes.as_slice()).unwrap();
        assert_eq!(decoded, envelope(message));
        assert_eq!(encode_hex(&decoded), message.envelope_hex);
    }

    let request = SyncRequest {
        messages: fixture
            .sync_request
            .message_ids
            .iter()
            .map(|id| envelope(by_id[id.as_str()]))
            .collect(),
        file_id: fixture.sync_request.file_id.clone(),
        group_id: fixture.sync_request.group_id.clone(),
        key_id: fixture.sync_request.key_id.clone(),
        since: fixture.sync_request.since.clone(),
    };
    assert_eq!(encode_hex(&request), fixture.sync_request.encoded_hex);
    assert_eq!(
        SyncRequest::decode(decode_hex(&fixture.sync_request.encoded_hex).as_slice()).unwrap(),
        request
    );

    let directory = TempDirectory::new();
    let config = Config {
        user_files: directory.0.clone(),
        ..Config::default()
    };
    let (empty, messages) =
        sync_simple::sync(&config, &[], &fixture.sync_request.since, "golden-empty").unwrap();
    assert!(messages.is_empty());
    assert_eq!(serde_json::to_string(&empty).unwrap(), fixture.empty_merkle);

    let inserted_messages = fixture
        .insertion_order
        .iter()
        .map(|id| envelope(by_id[id.as_str()]))
        .collect::<Vec<_>>();
    let (inserted, initially_new) = sync_simple::sync(
        &config,
        &inserted_messages,
        &fixture.sync_request.since,
        "golden-main",
    )
    .unwrap();
    assert!(initially_new.is_empty());
    assert_eq!(serde_json::to_string(&inserted).unwrap(), fixture.merkle);

    let (read_back_merkle, read_back) =
        sync_simple::sync(&config, &[], &fixture.sync_request.since, "golden-main").unwrap();
    assert_eq!(ids(&read_back, &fixture.messages), fixture.read_order);
    assert_eq!(
        serde_json::to_string(&read_back_merkle).unwrap(),
        fixture.merkle
    );

    let duplicate = envelope(by_id[fixture.duplicate.id.as_str()]);
    let (exact, _) = sync_simple::sync(
        &config,
        std::slice::from_ref(&duplicate),
        &fixture.sync_request.since,
        "golden-main",
    )
    .unwrap();
    assert_eq!(
        serde_json::to_string(&exact).unwrap(),
        fixture.duplicate.exact_merkle
    );
    let mut conflicting = duplicate;
    conflicting.content = decode_hex(&fixture.duplicate.conflicting_content_hex);
    let (conflict, _) = sync_simple::sync(
        &config,
        &[conflicting],
        &fixture.sync_request.since,
        "golden-main",
    )
    .unwrap();
    assert_eq!(
        serde_json::to_string(&conflict).unwrap(),
        fixture.duplicate.conflicting_merkle
    );
    let (_, retained) =
        sync_simple::sync(&config, &[], &fixture.sync_request.since, "golden-main").unwrap();
    assert_eq!(
        retained[0].content,
        decode_hex(&fixture.duplicate.retained_content_hex)
    );

    for case in &fixture.since_cases {
        let (_, messages) = sync_simple::sync(&config, &[], &case.since, "golden-main").unwrap();
        assert_eq!(ids(&messages, &fixture.messages), case.ids);
    }

    let response = SyncResponse {
        messages: read_back,
        merkle: fixture.merkle.clone(),
    };
    assert_eq!(encode_hex(&response), fixture.sync_response_hex);
    assert_eq!(
        SyncResponse::decode(decode_hex(&fixture.sync_response_hex).as_slice()).unwrap(),
        response
    );

    let malformed = decode_hex(&fixture.malformed_payload_hex);
    assert!(MessageEnvelope::decode(malformed.as_slice()).is_err());
    assert!(SyncRequest::decode(malformed.as_slice()).is_err());
    assert!(
        sync_simple::sync(
            &config,
            &[MessageEnvelope {
                timestamp: fixture.malformed_timestamp,
                is_encrypted: false,
                content: vec![1],
            }],
            &fixture.sync_request.since,
            "golden-malformed",
        )
        .is_err()
    );
}
