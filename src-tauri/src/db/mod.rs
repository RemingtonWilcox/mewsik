pub mod migrations;
pub mod models;
pub mod queries;

use parking_lot::Mutex;
use rusqlite::{Connection, DatabaseName};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub type DbPool = Arc<Mutex<Connection>>;
const MAX_MIGRATION_BACKUPS: usize = 3;

#[derive(Debug, thiserror::Error)]
pub enum DbInitError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("migration backup error: {0}")]
    BackupIo(#[from] std::io::Error),
}

pub fn init_db(db_path: &Path) -> Result<DbPool, DbInitError> {
    let existing_database = match std::fs::metadata(db_path) {
        Ok(metadata) => metadata.is_file() && metadata.len() > 0,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };

    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA busy_timeout = 5000;")?;

    if existing_database {
        let current_version = migrations::current_version(&conn)?;
        let latest_version = migrations::latest_version();
        if current_version < latest_version {
            let backup_path =
                create_migration_backup(&conn, db_path, current_version, latest_version)?;
            log::info!(
                "created pre-migration database backup at {}",
                backup_path.display()
            );
        }
    }

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

fn create_migration_backup(
    conn: &Connection,
    db_path: &Path,
    current_version: i64,
    latest_version: i64,
) -> Result<PathBuf, DbInitError> {
    let parent = db_path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "database path has no parent directory",
        )
    })?;
    let backup_dir = parent.join("backups");
    std::fs::create_dir_all(&backup_dir)?;

    let prefix = migration_backup_prefix(db_path);
    let backup_path = backup_dir.join(format!(
        "{prefix}{}-v{current_version}-to-v{latest_version}.sqlite3",
        ulid::Ulid::new()
    ));

    if let Err(error) = conn.backup(DatabaseName::Main, &backup_path, None) {
        let _ = std::fs::remove_file(&backup_path);
        return Err(error.into());
    }

    prune_migration_backups(&backup_dir, &prefix, MAX_MIGRATION_BACKUPS)?;
    Ok(backup_path)
}

fn migration_backup_prefix(db_path: &Path) -> String {
    let stem = db_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("database");
    format!("{stem}.pre-migration-")
}

fn prune_migration_backups(
    backup_dir: &Path,
    prefix: &str,
    retain: usize,
) -> Result<(), std::io::Error> {
    let mut backups = Vec::new();
    for entry in std::fs::read_dir(backup_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(prefix) && name.ends_with(".sqlite3") {
            backups.push(entry.path());
        }
    }

    backups.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    let remove_count = backups.len().saturating_sub(retain);
    for path in backups.into_iter().take(remove_count) {
        std::fs::remove_file(path)?;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db_path(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("mewsik-{label}-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&root).expect("create temp database directory");
        root.join("library.db")
    }

    fn migration_backups(db_path: &Path) -> Vec<PathBuf> {
        let backup_dir = db_path.parent().unwrap().join("backups");
        let prefix = migration_backup_prefix(db_path);
        let mut files = std::fs::read_dir(backup_dir)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".sqlite3"))
            })
            .collect::<Vec<_>>();
        files.sort();
        files
    }

    #[test]
    fn pending_migrations_create_consistent_backup_before_schema_changes() {
        let db_path = temp_db_path("migration-backup");
        {
            let conn = Connection::open(&db_path).expect("create legacy database");
            conn.execute_batch(
                "CREATE TABLE legacy_marker (value TEXT NOT NULL);
                 INSERT INTO legacy_marker (value) VALUES ('before-migration');",
            )
            .expect("seed legacy database");
        }

        let db = init_db(&db_path).expect("migrate database");
        let migrated_version: i64 = db
            .lock()
            .query_row("SELECT MAX(version) FROM _migrations", [], |row| row.get(0))
            .expect("read migrated version");
        assert_eq!(migrated_version, migrations::latest_version());
        drop(db);

        let backups = migration_backups(&db_path);
        assert_eq!(backups.len(), 1);
        let backup = Connection::open(&backups[0]).expect("open migration backup");
        let marker: String = backup
            .query_row("SELECT value FROM legacy_marker", [], |row| row.get(0))
            .expect("read legacy marker from backup");
        let migration_table_exists: bool = backup
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM sqlite_master
                     WHERE type = 'table' AND name = '_migrations'
                 )",
                [],
                |row| row.get(0),
            )
            .expect("inspect backup schema");
        assert_eq!(marker, "before-migration");
        assert!(!migration_table_exists);

        init_db(&db_path).expect("reopen current database");
        assert_eq!(migration_backups(&db_path).len(), 1);

        let _ = std::fs::remove_dir_all(db_path.parent().unwrap());
    }

    #[test]
    fn backup_retention_only_removes_old_migration_backups() {
        let db_path = temp_db_path("backup-retention");
        let backup_dir = db_path.parent().unwrap().join("backups");
        std::fs::create_dir_all(&backup_dir).expect("create backup directory");
        let prefix = migration_backup_prefix(&db_path);

        for index in 0..5 {
            std::fs::write(
                backup_dir.join(format!("{prefix}{index:026}-v1-to-v2.sqlite3")),
                b"backup",
            )
            .expect("write backup fixture");
        }
        let unrelated = backup_dir.join("keep-me.sqlite3");
        std::fs::write(&unrelated, b"unrelated").expect("write unrelated fixture");

        prune_migration_backups(&backup_dir, &prefix, 3).expect("prune backups");

        assert_eq!(migration_backups(&db_path).len(), 3);
        assert!(unrelated.exists());
        let _ = std::fs::remove_dir_all(db_path.parent().unwrap());
    }
}
