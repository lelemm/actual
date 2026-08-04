mod lower_case;
mod specials;

pub fn title(value: &str) -> String {
    let lower = value.to_lowercase();
    let characters = lower.char_indices().collect::<Vec<_>>();
    let mut output = String::with_capacity(lower.len());
    let mut cursor = 0;
    let mut first_word = true;

    while cursor < characters.len() {
        let (byte, character) = characters[cursor];
        if !character.is_alphanumeric() {
            output.push(character);
            cursor += 1;
            continue;
        }

        let start = byte;
        let mut end_cursor = cursor + 1;
        while end_cursor < characters.len() {
            let character = characters[end_cursor].1;
            if character.is_alphanumeric() || character == '\'' || character == '’' {
                end_cursor += 1;
            } else {
                break;
            }
        }
        let end = characters
            .get(end_cursor)
            .map(|(byte, _)| *byte)
            .unwrap_or(lower.len());
        let word = &lower[start..end];
        let forced = first_word
            || characters[..cursor]
                .iter()
                .rev()
                .find(|(_, character)| !character.is_whitespace())
                .is_some_and(|(_, character)| ".()!?;:\"-".contains(*character));
        if forced || !lower_case::WORDS.contains(&word) {
            let mut word_characters = word.chars();
            if let Some(first) = word_characters.next() {
                output.extend(first.to_uppercase());
                output.push_str(word_characters.as_str());
            }
        } else {
            output.push_str(word);
        }
        first_word = false;
        cursor = end_cursor;
    }

    for special in specials::WORDS {
        output = replace_word_case_insensitive(&output, special);
    }
    output
}

fn replace_word_case_insensitive(value: &str, replacement: &str) -> String {
    let needle = replacement.to_lowercase();
    let lower = value.to_lowercase();
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find(&needle) {
        let start = cursor + relative;
        let end = start + needle.len();
        let bounded = value[..start]
            .chars()
            .next_back()
            .is_none_or(|character| !character.is_alphanumeric())
            && value[end..]
                .chars()
                .next()
                .is_none_or(|character| !character.is_alphanumeric());
        if bounded {
            output.push_str(&value[cursor..start]);
            output.push_str(replacement);
            cursor = end;
        } else {
            let next = value[start..].chars().next().unwrap().len_utf8();
            output.push_str(&value[cursor..start + next]);
            cursor = start + next;
        }
    }
    output.push_str(&value[cursor..]);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_lower_words_punctuation_and_specials() {
        assert_eq!(title("THE LORD OF THE RINGS"), "The Lord of the Rings");
        assert_eq!(title("UTILITY COMPANY S.P.A."), "Utility Company S.P.A.");
        assert_eq!(title("github and node.js API"), "GitHub and Node.js API");
    }
}
