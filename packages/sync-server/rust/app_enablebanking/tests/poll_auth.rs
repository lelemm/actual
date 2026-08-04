use tokio::sync::oneshot;

use super::super::EnableBankingState;

#[tokio::test]
async fn completion_is_cached_and_resolves_the_current_waiter() {
    let state = EnableBankingState::default();
    let (sender, receiver) = oneshot::channel();
    state
        .pending
        .lock()
        .unwrap()
        .insert("state".into(), (1, sender));
    state.complete(
        "state",
        serde_json::json!({ "session_id": "session" }),
        None,
    );
    assert_eq!(receiver.await.unwrap().unwrap()["session_id"], "session");
    assert_eq!(
        state.completed.lock().unwrap()["state"]["session_id"],
        "session"
    );
}
