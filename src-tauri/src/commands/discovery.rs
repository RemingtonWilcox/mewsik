use crate::db::models::LibraryTrack;
use crate::db::DbPool;
use crate::discovery::recommendations::{PlayStats, RecommendationEngine};
use tauri::State;

#[tauri::command]
pub fn get_daily_mix(db: State<'_, DbPool>) -> Result<Vec<LibraryTrack>, String> {
    let engine = RecommendationEngine::new((*db).clone());
    engine.generate_daily_mix(30)
}

#[tauri::command]
pub fn get_rediscover(db: State<'_, DbPool>) -> Result<Vec<LibraryTrack>, String> {
    let engine = RecommendationEngine::new((*db).clone());
    engine.get_rediscover(20)
}

#[tauri::command]
pub fn get_play_stats(db: State<'_, DbPool>) -> Result<PlayStats, String> {
    let engine = RecommendationEngine::new((*db).clone());
    engine.get_play_stats()
}

#[tauri::command]
pub fn get_recently_played(db: State<'_, DbPool>) -> Result<Vec<LibraryTrack>, String> {
    let engine = RecommendationEngine::new((*db).clone());
    engine.get_recently_played(12)
}
