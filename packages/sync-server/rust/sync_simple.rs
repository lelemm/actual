use std::collections::BTreeMap;

use chrono::DateTime;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Deserializer, Serialize, de::Error as _};

use crate::{load_config::Config, proto::MessageEnvelope, util::paths::get_path_for_group_file};

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct TrieNode {
    #[serde(rename = "0", skip_serializing_if = "Option::is_none")]
    zero: Option<Box<TrieNode>>,
    #[serde(rename = "1", skip_serializing_if = "Option::is_none")]
    one: Option<Box<TrieNode>>,
    #[serde(rename = "2", skip_serializing_if = "Option::is_none")]
    two: Option<Box<TrieNode>>,
    #[serde(
        default,
        deserialize_with = "deserialize_hash",
        skip_serializing_if = "Option::is_none"
    )]
    hash: Option<i32>,
}

fn deserialize_hash<'de, D>(deserializer: D) -> Result<Option<i32>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<i64>::deserialize(deserializer)?;
    value
        .map(|value| {
            if (i32::MIN as i64..=u32::MAX as i64).contains(&value) {
                Ok(value as i32)
            } else {
                Err(D::Error::custom("merkle hash is outside the int32 range"))
            }
        })
        .transpose()
}

pub fn sync(
    config: &Config,
    messages: &[MessageEnvelope],
    since: &str,
    group_id: &str,
) -> Result<(TrieNode, Vec<MessageEnvelope>), Box<dyn std::error::Error>> {
    let path = get_path_for_group_file(config, group_id);
    let needs_init = !path.exists();
    let mut connection = Connection::open(path)?;
    if needs_init {
        connection.execute_batch(
            "CREATE TABLE messages_binary
               (timestamp TEXT PRIMARY KEY, is_encrypted BOOLEAN, content bytea);
             CREATE TABLE messages_merkles
               (id INTEGER PRIMARY KEY, merkle TEXT);",
        )?;
    }

    let new_messages = {
        let mut statement = connection.prepare(
            "SELECT timestamp, is_encrypted, content FROM messages_binary
             WHERE timestamp > ? ORDER BY timestamp",
        )?;
        statement
            .query_map([since], |row| {
                Ok(MessageEnvelope {
                    timestamp: row.get(0)?,
                    is_encrypted: row.get::<_, i64>(1)? == 1,
                    content: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let transaction = connection.transaction()?;
    let mut trie = get_merkle(&transaction)?;
    for message in messages {
        let changes = transaction.execute(
            "INSERT OR IGNORE INTO messages_binary (timestamp, is_encrypted, content)
             VALUES (?, ?, ?)",
            params![
                message.timestamp,
                i64::from(message.is_encrypted),
                message.content
            ],
        )?;
        if changes > 0 {
            let (millis, canonical) = parse_timestamp(&message.timestamp)
                .ok_or_else(|| format!("Invalid timestamp: {}", message.timestamp))?;
            trie = insert(trie, millis, murmur3(canonical.as_bytes()) as i32);
        }
    }
    trie = prune(trie);
    let merkle = serde_json::to_string(&trie)?;
    transaction.execute(
        "INSERT INTO messages_merkles (id, merkle) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET merkle = ?",
        params![merkle, merkle],
    )?;
    transaction.commit()?;
    Ok((trie, new_messages))
}

fn get_merkle(connection: &Connection) -> Result<TrieNode, Box<dyn std::error::Error>> {
    let value = connection
        .query_row("SELECT merkle FROM messages_merkles LIMIT 1", [], |row| {
            row.get::<_, String>(0)
        })
        .optional()?;
    Ok(match value {
        Some(value) => serde_json::from_str(&value)?,
        None => TrieNode::default(),
    })
}

fn parse_timestamp(timestamp: &str) -> Option<(i64, String)> {
    let parts = timestamp.split('-').collect::<Vec<_>>();
    let counter = parts.get(3)?.trim_start();
    let counter = counter.strip_prefix('+').unwrap_or(counter);
    let counter = counter
        .strip_prefix("0x")
        .or_else(|| counter.strip_prefix("0X"))
        .unwrap_or(counter);
    let counter_digits = counter
        .chars()
        .take_while(char::is_ascii_hexdigit)
        .collect::<String>();
    let counter = u32::from_str_radix(&counter_digits, 16).ok()?;
    if parts.len() != 5 || parts[4].len() > 16 || counter > u16::MAX.into() {
        return None;
    }
    let date = parts[..3].join("-");
    let date = DateTime::parse_from_rfc3339(&date)
        .ok()?
        .with_timezone(&chrono::Utc);
    let millis = date.timestamp_millis();
    if millis < 0 {
        return None;
    }
    Some((
        millis,
        format!(
            "{}-{counter:04X}-{:0>16}",
            date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            parts[4]
        ),
    ))
}

fn insert(mut trie: TrieNode, millis: i64, hash: i32) -> TrieNode {
    trie.hash = Some(trie.hash.unwrap_or(0) ^ hash);
    let key = to_base3(millis / 60_000);
    insert_key(&mut trie, key.as_bytes(), hash);
    trie
}

fn insert_key(trie: &mut TrieNode, key: &[u8], hash: i32) {
    let Some((&digit, rest)) = key.split_first() else {
        return;
    };
    let child = match digit {
        b'0' => &mut trie.zero,
        b'1' => &mut trie.one,
        b'2' => &mut trie.two,
        _ => return,
    };
    let node = child.get_or_insert_with(|| Box::new(TrieNode::default()));
    insert_key(node, rest, hash);
    node.hash = Some(node.hash.unwrap_or(0) ^ hash);
}

fn prune(trie: TrieNode) -> TrieNode {
    if trie.hash.unwrap_or(0) == 0 {
        return trie;
    }
    let mut children = BTreeMap::new();
    if let Some(node) = trie.zero {
        children.insert(0, node);
    }
    if let Some(node) = trie.one {
        children.insert(1, node);
    }
    if let Some(node) = trie.two {
        children.insert(2, node);
    }
    let keep_from = children.len().saturating_sub(2);
    let mut next = TrieNode {
        hash: trie.hash,
        ..TrieNode::default()
    };
    for (digit, node) in children.into_iter().skip(keep_from) {
        let node = Some(Box::new(prune(*node)));
        match digit {
            0 => next.zero = node,
            1 => next.one = node,
            2 => next.two = node,
            _ => unreachable!(),
        }
    }
    next
}

fn to_base3(mut value: i64) -> String {
    if value == 0 {
        return "0".into();
    }
    let mut output = Vec::new();
    while value > 0 {
        output.push((b'0' + (value % 3) as u8) as char);
        value /= 3;
    }
    output.iter().rev().collect()
}

fn murmur3(bytes: &[u8]) -> u32 {
    let mut hash = 0_u32;
    for chunk in bytes.chunks_exact(4) {
        let mut key = u32::from_le_bytes(chunk.try_into().unwrap());
        key = key.wrapping_mul(0xcc9e2d51).rotate_left(15);
        key = key.wrapping_mul(0x1b873593);
        hash ^= key;
        hash = hash
            .rotate_left(13)
            .wrapping_mul(5)
            .wrapping_add(0xe6546b64);
    }
    let remainder = bytes.chunks_exact(4).remainder();
    let mut key = 0_u32;
    if remainder.len() == 3 {
        key ^= u32::from(remainder[2]) << 16;
    }
    if remainder.len() >= 2 {
        key ^= u32::from(remainder[1]) << 8;
    }
    if !remainder.is_empty() {
        key ^= u32::from(remainder[0]);
        key = key.wrapping_mul(0xcc9e2d51).rotate_left(15);
        key = key.wrapping_mul(0x1b873593);
        hash ^= key;
    }
    hash ^= bytes.len() as u32;
    hash ^= hash >> 16;
    hash = hash.wrapping_mul(0x85ebca6b);
    hash ^= hash >> 13;
    hash = hash.wrapping_mul(0xc2b2ae35);
    hash ^ (hash >> 16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_javascript_timestamp_hash() {
        assert_eq!(
            murmur3(b"2015-04-24T22:23:42.123Z-1000-0123456789ABCDEF"),
            2_838_536_857
        );
        assert_eq!(
            parse_timestamp("2015-04-24T23:23:42.123+01:00-a-node")
                .unwrap()
                .1,
            "2015-04-24T22:23:42.123Z-000A-000000000000node"
        );
        assert_eq!(
            parse_timestamp("2015-04-24T22:23:42.123Z-0x10-node")
                .unwrap()
                .1,
            "2015-04-24T22:23:42.123Z-0010-000000000000node"
        );
        assert_eq!(
            parse_timestamp("2015-04-24T22:23:42.123Z-+10-node")
                .unwrap()
                .1,
            "2015-04-24T22:23:42.123Z-0010-000000000000node"
        );
        assert!(parse_timestamp("2015-04-24T22:23:42.123Z--1-node").is_none());
    }

    #[test]
    fn serializes_merkle_hashes_with_javascript_signed_int32_semantics() {
        let trie = insert(TrieNode::default(), 0, 2_838_536_857_u32 as i32);
        let json = serde_json::to_value(trie).unwrap();

        assert_eq!(json["hash"].as_i64(), Some(-1_456_430_439));
        assert_eq!(json["0"]["hash"].as_i64(), Some(-1_456_430_439));
    }

    #[test]
    fn reads_unsigned_merkle_hashes_written_by_older_rust_builds() {
        let trie: TrieNode = serde_json::from_str(r#"{"hash":2334141718}"#).unwrap();

        assert_eq!(trie.hash, Some(-1_960_825_578));
        assert_eq!(
            serde_json::to_string(&trie).unwrap(),
            r#"{"hash":-1960825578}"#
        );
    }
}
