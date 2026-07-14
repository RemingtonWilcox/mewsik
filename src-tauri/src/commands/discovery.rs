use crate::db::models::LibraryTrack;
use crate::db::DbPool;
use crate::discovery::recommendations::{PlayStats, RecommendationEngine};
use crate::discovery::store::{self, DiscoveryEventInput};
use crate::discovery::v2::{SearchDiscoveryFeed, SharedDiscoveryFeedRuntime};
use chrono::Utc;
use serde_json::json;
use tauri::State;

#[tauri::command]
pub async fn get_search_discovery_feed(
    runtime: State<'_, SharedDiscoveryFeedRuntime>,
    force: Option<bool>,
) -> Result<SearchDiscoveryFeed, String> {
    Ok(runtime.get_feed(force.unwrap_or(false)).await)
}

#[tauri::command]
pub fn record_discovery_event(
    db: State<'_, DbPool>,
    item_id: String,
    event_type: String,
    section_id: Option<String>,
    snapshot_id: Option<String>,
) -> Result<(), String> {
    let item_id = item_id.trim();
    let event_type = event_type.trim().to_ascii_lowercase();
    if item_id.is_empty() || item_id.len() > 256 {
        return Err("Discovery item ID must be between 1 and 256 characters".to_string());
    }
    if !matches!(
        event_type.as_str(),
        "click" | "impression" | "hide" | "save"
    ) {
        return Err("Unsupported discovery event type".to_string());
    }
    let section_id = bounded_optional(section_id, 96, "section ID")?;
    let snapshot_id = bounded_optional(snapshot_id, 160, "snapshot ID")?;
    let entity_id = store::get_entity(&db, item_id)
        .map_err(|error| error.to_string())?
        .map(|entity| entity.id);
    let source_item_id = entity_id.is_none().then(|| item_id.to_string());
    store::record_event(
        &db,
        &DiscoveryEventInput {
            entity_id,
            source: None,
            source_item_id,
            event_type,
            occurred_at: Utc::now().timestamp(),
            context: Some(json!({
                "section_id": section_id,
                "snapshot_id": snapshot_id,
            })),
        },
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn bounded_optional(
    value: Option<String>,
    max_length: usize,
    label: &str,
) -> Result<Option<String>, String> {
    value
        .map(|value| {
            let value = value.trim().to_string();
            if value.is_empty() {
                Ok(None)
            } else if value.len() > max_length {
                Err(format!("Discovery {label} is too long"))
            } else {
                Ok(Some(value))
            }
        })
        .transpose()
        .map(Option::flatten)
}

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
