#[derive(Debug)]
pub enum FileError {
    NotFound,
    InvalidId,
    Database(rusqlite::Error),
}

impl From<rusqlite::Error> for FileError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error)
    }
}
