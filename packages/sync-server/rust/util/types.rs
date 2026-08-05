use std::{
    cmp::Ordering,
    fmt,
    hash::{Hash, Hasher},
    marker::PhantomData,
};

use rusqlite::types::{FromSql, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(transparent, bound(serialize = "", deserialize = ""))]
pub struct BrandedId<T> {
    value: String,
    #[serde(skip)]
    marker: PhantomData<fn() -> T>,
}

impl<T> Clone for BrandedId<T> {
    fn clone(&self) -> Self {
        Self::new(self.value.clone())
    }
}

impl<T> fmt::Debug for BrandedId<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.value.fmt(formatter)
    }
}

impl<T> PartialEq for BrandedId<T> {
    fn eq(&self, other: &Self) -> bool {
        self.value == other.value
    }
}

impl<T> Eq for BrandedId<T> {}

impl<T> Hash for BrandedId<T> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.value.hash(state);
    }
}

impl<T> PartialOrd for BrandedId<T> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl<T> Ord for BrandedId<T> {
    fn cmp(&self, other: &Self) -> Ordering {
        self.value.cmp(&other.value)
    }
}

impl<T> BrandedId<T> {
    pub fn new(value: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            marker: PhantomData,
        }
    }

    pub fn as_str(&self) -> &str {
        &self.value
    }

    pub fn into_inner(self) -> String {
        self.value
    }
}

impl<T> AsRef<str> for BrandedId<T> {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl<T> fmt::Display for BrandedId<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.value.fmt(formatter)
    }
}

impl<T> ToSql for BrandedId<T> {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        self.value.to_sql()
    }
}

impl<T> FromSql for BrandedId<T> {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        String::column_result(value).map(Self::new)
    }
}

#[cfg(test)]
mod tests {
    use std::any::TypeId;

    use super::*;

    enum File {}
    enum Group {}

    type FileId = BrandedId<File>;
    type GroupId = BrandedId<Group>;

    #[test]
    fn branded_ids_are_distinct_types_with_string_wire_format() {
        assert_ne!(TypeId::of::<FileId>(), TypeId::of::<GroupId>());
        let id = FileId::new("budget-id");
        assert_eq!(serde_json::to_string(&id).unwrap(), r#""budget-id""#);
        assert_eq!(
            serde_json::from_str::<FileId>(r#""budget-id""#).unwrap(),
            id
        );
    }

    #[test]
    fn branded_ids_keep_the_sqlite_text_format() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute("CREATE TABLE ids (id TEXT)", [])
            .unwrap();
        connection
            .execute("INSERT INTO ids VALUES (?)", [FileId::new("budget-id")])
            .unwrap();
        let id = connection
            .query_row("SELECT id FROM ids", [], |row| row.get::<_, FileId>(0))
            .unwrap();
        assert_eq!(id.as_str(), "budget-id");
        assert_eq!(id.into_inner(), "budget-id");
    }
}
