use crate::db::models::SearchResultItem;
use crate::db::queries;
use crate::db::DbPool;
use tauri::State;

#[tauri::command]
pub fn search_library(
    db: State<'_, DbPool>,
    query: String,
) -> Result<Vec<SearchResultItem>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    queries::search_recordings(&db, &query, 50).map_err(|e| e.to_string())
}
