pub mod extract_payee_name_from_remittance_info;

// TypeScript's banks/util/escape-regexp.ts maps to regex::escape at its
// Commerzbank caller. Rust additionally escapes a few harmless metacharacters;
// the shared fixture below proves identical anchored-literal matching.
#[cfg(test)]
mod tests {
    use regex::Regex;
    use serde_json::Value;

    #[test]
    fn native_regex_escape_matches_the_shared_typescript_vectors() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../contract/fixtures/gocardless-utils-golden.json"
        ))
        .unwrap();
        let test_cases = fixture["escapeCases"].as_array().unwrap();
        assert_eq!(test_cases.len(), 5);
        for test_case in test_cases {
            let id = test_case["id"].as_str().unwrap();
            let input = test_case["input"].as_str().unwrap();
            let typescript = test_case["typescriptEscaped"].as_str().unwrap();
            let native = regex::escape(input);
            assert!(
                Regex::new(&format!("^(?:{typescript})$"))
                    .unwrap()
                    .is_match(input),
                "TypeScript vector failed for {id}"
            );
            assert!(
                Regex::new(&format!("^(?:{native})$"))
                    .unwrap()
                    .is_match(input),
                "native escape failed for {id}"
            );
            if id == "rust-additional-metacharacters" {
                assert_ne!(native, typescript);
            } else {
                assert_eq!(native, typescript, "{id}");
            }
        }
    }
}
