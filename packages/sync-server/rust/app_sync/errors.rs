use serde_json::Value;

pub const FILE_NOT_FOUND_MESSAGE: &str = "File does not exist or you don't have access to it";

#[derive(Debug)]
pub enum FileError {
    NotFound { details: Value },
    Generic { message: String, details: Value },
    Database(rusqlite::Error),
}

impl FileError {
    pub fn not_found(details: Option<Value>) -> Self {
        Self::NotFound {
            details: details.unwrap_or_else(|| Value::Object(Default::default())),
        }
    }

    pub fn generic(message: impl Into<String>, details: Option<Value>) -> Self {
        Self::Generic {
            message: message.into(),
            details: details.unwrap_or_else(|| Value::Object(Default::default())),
        }
    }
}

impl From<rusqlite::Error> for FileError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error)
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::Value;

    use super::{FILE_NOT_FOUND_MESSAGE, FileError};

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        version: usize,
        file_not_found: FileNotFoundFixture,
        generic: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct FileNotFoundFixture {
        message: String,
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct Case {
        id: String,
        message: Option<String>,
        argument: Argument,
        details: Value,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "kebab-case")]
    enum Argument {
        Omitted,
        Null,
        String,
        Object,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!(
            "../../contract/fixtures/app-sync-errors-golden.json"
        ))
        .unwrap()
    }

    fn details(test_case: &Case) -> Option<Value> {
        match test_case.argument {
            Argument::Omitted => None,
            Argument::Null | Argument::String | Argument::Object => Some(test_case.details.clone()),
        }
    }

    #[test]
    fn matches_every_file_not_found_constructor_form() {
        let fixture = fixture();
        assert_eq!(fixture.version, 1);
        assert_eq!(fixture.file_not_found.message, FILE_NOT_FOUND_MESSAGE);
        for test_case in fixture.file_not_found.cases {
            match FileError::not_found(details(&test_case)) {
                FileError::NotFound { details } => {
                    assert_eq!(details, test_case.details, "{}", test_case.id)
                }
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn matches_every_generic_constructor_form() {
        for test_case in fixture().generic {
            let expected_message = test_case.message.clone().unwrap();
            match FileError::generic(expected_message.clone(), details(&test_case)) {
                FileError::Generic { message, details } => {
                    assert_eq!(message, expected_message, "{}", test_case.id);
                    assert_eq!(details, test_case.details, "{}", test_case.id);
                }
                _ => unreachable!(),
            }
        }
    }
}
