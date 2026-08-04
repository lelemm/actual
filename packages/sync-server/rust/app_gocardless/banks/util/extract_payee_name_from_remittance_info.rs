pub fn extract<'a>(remittance: &'a str, patterns: &[&str]) -> &'a str {
    patterns
        .iter()
        .filter_map(|pattern| remittance.rfind(pattern))
        .max()
        .map_or(remittance, |index| remittance[..index].trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_from_the_last_relevant_marker() {
        assert_eq!(
            extract(
                "John Doe Paiement Maestro par Carte",
                &["Paiement", "Transfert"]
            ),
            "John Doe"
        );
    }
}
