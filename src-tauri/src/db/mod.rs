pub mod migrations;
pub mod models;
pub mod queries;

use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::Path;
use std::sync::Arc;

pub type DbPool = Arc<Mutex<Connection>>;

pub fn init_db(db_path: &Path) -> Result<DbPool, rusqlite::Error> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA cache_size = -8000;
         PRAGMA busy_timeout = 5000;",
    )?;
    migrations::run_migrations(&conn)?;
    Ok(Arc::new(Mutex::new(conn)))
}

pub fn init_memory_db() -> Result<DbPool, rusqlite::Error> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;",
    )?;
    migrations::run_migrations(&conn)?;
    Ok(Arc::new(Mutex::new(conn)))
}
