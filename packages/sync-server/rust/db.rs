use std::{
    path::Path,
    sync::{Arc, Mutex},
};

use rusqlite::Connection;

pub type Database = Arc<Mutex<Connection>>;

pub fn open_database(filename: &Path) -> rusqlite::Result<Connection> {
    Connection::open(filename)
}
