use regex::Regex;
use serde_json::Value;

use super::integration_bank;
use crate::util::title::title;

pub const INSTITUTION_IDS: &[&str] = &["BOURSORAMA_BOUSFRPP"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let info = transaction
        .get("remittanceInformationUnstructuredArray")
        .and_then(Value::as_array)
        .map(|lines| {
            lines
                .iter()
                .filter_map(Value::as_str)
                .map(|line| line.split('\\').next().unwrap_or_default())
                .filter(|line| !line.starts_with("Réf : "))
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    edited["remittanceInformationUnstructuredArray"] =
        Value::Array(info.iter().cloned().map(Value::String).collect());

    let card =
        Regex::new(r"^CARTE (?P<date>\d{2}/\d{2}/\d{2}) (?P<payee>.+?)(?: \d+)?(?: CB\*\d{4})?$")
            .expect("valid bank pattern");
    let withdrawal =
        Regex::new(r"^RETRAIT DAB (?P<date>\d{2}/\d{2}/\d{2}) (?P<location>.+?) CB\*\d{4,}")
            .expect("valid bank pattern");
    let credit = Regex::new(r"^AVOIR (?P<date>\d{2}/\d{2}/\d{2}) (?P<payee>.+?) CB\*\d{4,}")
        .expect("valid bank pattern");

    let matching = |pattern: &Regex| {
        info.iter()
            .find(|line| pattern.is_match(line))
            .map(String::as_str)
    };
    let other_lines = |matching: &str| {
        info.iter()
            .filter(|line| line.as_str() != matching)
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join(" ")
    };
    let mut payee = String::new();
    let mut notes = String::new();

    if let Some(line) = matching(&card) {
        let captures = card.captures(line)?;
        payee = title(&captures["payee"]);
        notes = format!("Carte {}", &captures["date"]);
        append_notes(&mut notes, &other_lines(line));
    } else if let Some(line) = info.iter().find(|line| line.starts_with("ECH PRET:")) {
        payee = "Prêt bancaire".into();
        notes = line.clone();
    } else if let Some(line) = matching(&withdrawal) {
        let captures = withdrawal.captures(line)?;
        payee = "Retrait DAB".into();
        notes = format!("Retrait {} {}", &captures["date"], &captures["location"]);
        append_notes(&mut notes, &other_lines(line));
    } else if let Some(line) = matching(&credit) {
        let captures = credit.captures(line)?;
        payee = title(&captures["payee"]);
        notes = format!("Avoir {}", &captures["date"]);
        append_notes(&mut notes, &other_lines(line));
    } else if let Some(line) = info.iter().find(|line| line.starts_with("VIR INST ")) {
        payee = title(line.trim_start_matches("VIR INST "));
        notes = other_lines(line);
    } else if let Some(line) = info
        .iter()
        .find(|line| line.starts_with("PRLV SEPA ") || line.starts_with("VIR SEPA "))
    {
        payee = title(
            line.strip_prefix("PRLV SEPA ")
                .or_else(|| line.strip_prefix("VIR SEPA "))
                .unwrap_or_default(),
        );
        notes = other_lines(line);
    } else if let Some(line) = info.iter().find(|line| line.starts_with("VIR ")) {
        payee = title(&other_lines(line));
        notes = line.trim_start_matches("VIR ").into();
    } else if let Some(first) = info.first() {
        let trailing_number = Regex::new(r" \d+$").expect("valid bank pattern");
        payee = title(&trailing_number.replace(first, ""));
        notes = info
            .iter()
            .skip(1)
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join(" ");
    }

    edited["payeeName"] = Value::String(payee);
    edited["notes"] = Value::String(notes);
    integration_bank::normalize_transaction_with(transaction, &edited)
}

fn append_notes(notes: &mut String, additional: &str) {
    if !additional.is_empty() {
        notes.push(' ');
        notes.push_str(additional);
    }
}
