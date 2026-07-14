use rand::seq::SliceRandom;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static QUEUE_SESSION_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn new_queue_session_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let sequence = QUEUE_SESSION_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    format!("queue-{timestamp:x}-{sequence:x}")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RepeatMode {
    Off,
    One,
    All,
}

#[derive(Debug, Clone)]
pub struct QueueEntry {
    pub recording_id: String,
    pub title: String,
    pub artist: String,
    pub file_path: Option<String>,
    pub source_url: Option<String>,
    pub source_headers: HashMap<String, String>,
    pub stream_mime_type: Option<String>,
    pub can_seek: bool,
    pub source: String,
    pub duration_ms: Option<i64>,
    pub cover_art: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QueueOrigin {
    Context,
    Manual,
}

#[derive(Debug, Clone)]
struct QueueOccurrence {
    entry_id: String,
    entry: QueueEntry,
    origin: QueueOrigin,
}

/// Playback queue whose `upcoming` vector is always the literal future play
/// order. The canonical vector exists only to rebuild a Repeat All cycle; it
/// is never exposed as "Up Next" because it can contain history.
pub struct PlayQueue {
    session_id: String,
    revision: u64,
    next_entry_sequence: u64,
    canonical: Vec<QueueOccurrence>,
    current: Option<QueueOccurrence>,
    upcoming: Vec<QueueOccurrence>,
    history: Vec<QueueOccurrence>,
    accept_context_appends: bool,
    shuffle: bool,
    repeat: RepeatMode,
}

impl PlayQueue {
    pub fn new() -> Self {
        Self {
            session_id: new_queue_session_id(),
            revision: 0,
            next_entry_sequence: 0,
            canonical: Vec::new(),
            current: None,
            upcoming: Vec::new(),
            history: Vec::new(),
            accept_context_appends: true,
            shuffle: false,
            repeat: RepeatMode::Off,
        }
    }

    pub fn set_tracks(&mut self, tracks: Vec<QueueEntry>, start_index: usize) {
        self.set_tracks_with_session(new_queue_session_id(), tracks, start_index);
    }

    pub fn set_tracks_with_session(
        &mut self,
        session_id: String,
        tracks: Vec<QueueEntry>,
        start_index: usize,
    ) {
        self.session_id = session_id;
        self.revision = 0;
        self.next_entry_sequence = 0;
        self.canonical = tracks
            .into_iter()
            .map(|entry| self.new_occurrence(entry, QueueOrigin::Context))
            .collect();
        self.current = None;
        self.upcoming.clear();
        self.history.clear();
        self.accept_context_appends = true;

        if self.canonical.is_empty() {
            self.bump_revision();
            return;
        }

        let start_index = start_index.min(self.canonical.len() - 1);
        self.current = self.canonical.get(start_index).cloned();
        if self.shuffle {
            self.upcoming = self
                .canonical
                .iter()
                .enumerate()
                .filter(|(index, _)| *index != start_index)
                .map(|(_, occurrence)| occurrence.clone())
                .collect();
            Self::shuffle_context_slots(&mut self.upcoming);
        } else {
            self.history = self.canonical[..start_index].to_vec();
            self.upcoming = self.canonical[start_index + 1..].to_vec();
        }
        self.bump_revision();
    }

    pub fn add(&mut self, entry: QueueEntry) {
        let occurrence = self.new_occurrence(entry, QueueOrigin::Manual);
        self.canonical.push(occurrence.clone());
        if self.current.is_none() {
            self.current = Some(occurrence);
        } else {
            self.upcoming.push(occurrence);
        }
        self.bump_revision();
    }

    pub fn append_context_if_session(
        &mut self,
        session_id: &str,
        entries: Vec<QueueEntry>,
    ) -> bool {
        if session_id != self.session_id || !self.accept_context_appends || entries.is_empty() {
            return false;
        }

        let mut appended: Vec<_> = entries
            .into_iter()
            .map(|entry| self.new_occurrence(entry, QueueOrigin::Context))
            .collect();
        if self.shuffle {
            Self::shuffle_context_slots(&mut appended);
        }
        self.canonical.extend(appended.iter().cloned());
        if self.current.is_none() {
            self.current = appended.first().cloned();
            self.upcoming.extend(appended.into_iter().skip(1));
        } else {
            // Crucially, append only touches the new tail. Existing manual and
            // context order remains stable while a background worker expands it.
            self.upcoming.extend(appended);
        }
        self.bump_revision();
        true
    }

    pub fn insert_next(&mut self, entry: QueueEntry) {
        let occurrence = self.new_occurrence(entry, QueueOrigin::Manual);
        self.canonical.push(occurrence.clone());
        if self.current.is_none() {
            self.current = Some(occurrence);
        } else {
            // Manual Play Next is pinned at the head of literal play order. A
            // later append never regenerates or reshuffles this vector.
            self.upcoming.insert(0, occurrence);
        }
        self.bump_revision();
    }

    /// Legacy wrapper: indexes the *upcoming* snapshot, never backing storage.
    pub fn remove(&mut self, index: usize) -> bool {
        let Some(entry_id) = self
            .upcoming
            .get(index)
            .map(|occurrence| occurrence.entry_id.clone())
        else {
            return false;
        };
        let session_id = self.session_id.clone();
        self.remove_entry(&session_id, &entry_id)
    }

    pub fn remove_entry(&mut self, session_id: &str, entry_id: &str) -> bool {
        if session_id != self.session_id {
            return false;
        }
        let Some(index) = self
            .upcoming
            .iter()
            .position(|occurrence| occurrence.entry_id == entry_id)
        else {
            return false;
        };

        self.upcoming.remove(index);
        self.canonical
            .retain(|occurrence| occurrence.entry_id != entry_id);
        self.bump_revision();
        true
    }

    pub fn current(&self) -> Option<&QueueEntry> {
        self.current.as_ref().map(|occurrence| &occurrence.entry)
    }

    /// Explicit user Next. Repeat One intentionally does not apply here.
    pub fn next(&mut self) -> Option<&QueueEntry> {
        self.advance(false)
    }

    /// Source completion. Repeat One applies only when completion was natural;
    /// a truncated/broken stream advances instead of looping forever.
    pub fn advance_after_completion(&mut self, natural: bool) -> Option<&QueueEntry> {
        self.advance(natural)
    }

    fn advance(&mut self, natural: bool) -> Option<&QueueEntry> {
        if self.current.is_none() {
            return None;
        }
        if natural && self.repeat == RepeatMode::One {
            return self.current();
        }

        if self.upcoming.is_empty() && self.repeat == RepeatMode::All {
            self.upcoming = self.canonical.clone();
            if self.shuffle {
                Self::shuffle_context_slots(&mut self.upcoming);
                if self.upcoming.len() > 1 {
                    if let Some(current_id) = self
                        .current
                        .as_ref()
                        .map(|occurrence| occurrence.entry_id.as_str())
                    {
                        if self.upcoming[0].entry_id == current_id {
                            self.upcoming.swap(0, 1);
                        }
                    }
                }
            }
        }

        let Some(next) = self.upcoming.first().cloned() else {
            return None;
        };
        self.upcoming.remove(0);
        if let Some(current) = self.current.replace(next) {
            self.history.push(current);
        }
        self.bump_revision();
        self.current()
    }

    pub fn prev(&mut self) -> Option<&QueueEntry> {
        if self.current.is_none() {
            return None;
        }

        if self.history.is_empty() && self.repeat == RepeatMode::All {
            let current_id = self
                .current
                .as_ref()
                .map(|occurrence| occurrence.entry_id.as_str());
            self.history = self
                .canonical
                .iter()
                .filter(|occurrence| Some(occurrence.entry_id.as_str()) != current_id)
                .cloned()
                .collect();
        }

        let Some(previous) = self.history.pop() else {
            return self.current();
        };
        if let Some(current) = self.current.replace(previous) {
            self.upcoming.insert(0, current);
        }
        self.bump_revision();
        self.current()
    }

    /// Legacy wrapper: selects by upcoming snapshot index.
    pub fn set_index(&mut self, index: usize) -> bool {
        let Some(entry_id) = self
            .upcoming
            .get(index)
            .map(|occurrence| occurrence.entry_id.clone())
        else {
            return false;
        };
        let session_id = self.session_id.clone();
        self.select_entry(&session_id, &entry_id)
    }

    pub fn select_entry(&mut self, session_id: &str, entry_id: &str) -> bool {
        if session_id != self.session_id {
            return false;
        }

        if self
            .current
            .as_ref()
            .is_some_and(|occurrence| occurrence.entry_id == entry_id)
        {
            return true;
        }

        let Some(index) = self
            .upcoming
            .iter()
            .position(|occurrence| occurrence.entry_id == entry_id)
        else {
            return false;
        };

        let selected = self.upcoming.remove(index);
        if let Some(current) = self.current.replace(selected) {
            self.history.push(current);
        }
        self.history.extend(self.upcoming.drain(..index));
        self.bump_revision();
        true
    }

    pub fn set_shuffle(&mut self, shuffle: bool) {
        if self.shuffle == shuffle {
            return;
        }
        self.shuffle = shuffle;
        if shuffle {
            // Manual slots stay pinned, including Play Next at index zero.
            Self::shuffle_context_slots(&mut self.upcoming);
            self.bump_revision();
        }
    }

    pub fn is_shuffle(&self) -> bool {
        self.shuffle
    }

    pub fn set_repeat(&mut self, mode: RepeatMode) {
        self.repeat = mode;
    }

    pub fn repeat_mode(&self) -> &RepeatMode {
        &self.repeat
    }

    pub fn clear(&mut self) {
        self.session_id = new_queue_session_id();
        self.revision = 0;
        self.next_entry_sequence = 0;
        self.canonical.clear();
        self.current = None;
        self.upcoming.clear();
        self.history.clear();
        self.accept_context_appends = false;
        self.bump_revision();
    }

    pub fn clear_upcoming(&mut self) {
        self.canonical = self.current.iter().cloned().collect();
        self.upcoming.clear();
        self.history.clear();
        // "Clear Up Next" is an ownership boundary, not a temporary empty
        // frame that a late background continuation may refill.
        self.accept_context_appends = false;
        self.bump_revision();
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn current_occurrence(&self) -> Option<(&str, &QueueEntry)> {
        self.current
            .as_ref()
            .map(|occurrence| (occurrence.entry_id.as_str(), &occurrence.entry))
    }

    pub fn upcoming_occurrences(&self) -> impl Iterator<Item = (&str, &QueueEntry)> {
        self.upcoming
            .iter()
            .map(|occurrence| (occurrence.entry_id.as_str(), &occurrence.entry))
    }

    fn new_occurrence(&mut self, entry: QueueEntry, origin: QueueOrigin) -> QueueOccurrence {
        self.next_entry_sequence = self.next_entry_sequence.saturating_add(1);
        QueueOccurrence {
            entry_id: format!("{}:{:x}", self.session_id, self.next_entry_sequence),
            entry,
            origin,
        }
    }

    fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }

    fn shuffle_context_slots(occurrences: &mut [QueueOccurrence]) {
        let mut context: Vec<_> = occurrences
            .iter()
            .filter(|occurrence| occurrence.origin == QueueOrigin::Context)
            .cloned()
            .collect();
        context.shuffle(&mut rand::thread_rng());
        let mut shuffled = context.into_iter();
        for occurrence in occurrences {
            if occurrence.origin == QueueOrigin::Context {
                if let Some(next) = shuffled.next() {
                    *occurrence = next;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{PlayQueue, QueueEntry, RepeatMode};
    use std::collections::HashMap;

    fn entry(id: &str) -> QueueEntry {
        QueueEntry {
            recording_id: id.to_string(),
            title: format!("Track {id}"),
            artist: "Artist".to_string(),
            file_path: Some(format!("/tmp/{id}.mp3")),
            source_url: None,
            source_headers: HashMap::new(),
            stream_mime_type: None,
            can_seek: true,
            source: "local".to_string(),
            duration_ms: Some(180_000),
            cover_art: None,
        }
    }

    fn upcoming_ids(queue: &PlayQueue) -> Vec<String> {
        queue
            .upcoming_occurrences()
            .map(|(_, entry)| entry.recording_id.clone())
            .collect()
    }

    #[test]
    fn snapshot_order_excludes_history() {
        let mut queue = PlayQueue::new();
        queue.set_tracks(vec![entry("one"), entry("two"), entry("three")], 0);

        assert_eq!(
            queue.next().map(|track| track.recording_id.as_str()),
            Some("two")
        );
        assert_eq!(
            queue.current().map(|track| track.recording_id.as_str()),
            Some("two")
        );
        assert_eq!(upcoming_ids(&queue), vec!["three"]);
    }

    #[test]
    fn duplicate_recordings_get_distinct_occurrence_ids() {
        let mut queue = PlayQueue::new();
        queue.set_tracks(vec![entry("same"), entry("same"), entry("same")], 0);
        let current_id = queue.current_occurrence().unwrap().0.to_string();
        let future_ids: Vec<_> = queue
            .upcoming_occurrences()
            .map(|(entry_id, _)| entry_id.to_string())
            .collect();

        assert_ne!(current_id, future_ids[0]);
        assert_ne!(future_ids[0], future_ids[1]);
    }

    #[test]
    fn repeat_one_only_applies_to_natural_completion() {
        let mut queue = PlayQueue::new();
        queue.set_tracks(vec![entry("one"), entry("two")], 0);
        queue.set_repeat(RepeatMode::One);

        assert_eq!(
            queue
                .advance_after_completion(true)
                .map(|track| track.recording_id.as_str()),
            Some("one")
        );
        assert_eq!(
            queue.next().map(|track| track.recording_id.as_str()),
            Some("two")
        );
    }

    #[test]
    fn broken_source_does_not_repeat_under_repeat_one() {
        let mut queue = PlayQueue::new();
        queue.set_tracks(vec![entry("one"), entry("two")], 0);
        queue.set_repeat(RepeatMode::One);

        assert_eq!(
            queue
                .advance_after_completion(false)
                .map(|track| track.recording_id.as_str()),
            Some("two")
        );
    }

    #[test]
    fn play_next_stays_literal_next_when_shuffle_is_enabled() {
        let mut queue = PlayQueue::new();
        queue.set_tracks(
            vec![entry("one"), entry("two"), entry("three"), entry("four")],
            0,
        );
        queue.set_shuffle(true);
        queue.insert_next(entry("priority"));
        queue.set_shuffle(false);
        queue.set_shuffle(true);

        assert_eq!(
            upcoming_ids(&queue).first().map(String::as_str),
            Some("priority")
        );
        assert_eq!(
            queue.next().map(|track| track.recording_id.as_str()),
            Some("priority")
        );
    }

    #[test]
    fn later_context_append_never_reorders_existing_upcoming() {
        let mut queue = PlayQueue::new();
        queue.set_tracks(
            vec![entry("one"), entry("two"), entry("three"), entry("four")],
            0,
        );
        queue.set_shuffle(true);
        queue.insert_next(entry("priority"));
        let before = upcoming_ids(&queue);
        let session = queue.session_id().to_string();

        assert!(queue.append_context_if_session(
            &session,
            vec![entry("five"), entry("six"), entry("seven")]
        ));

        let after = upcoming_ids(&queue);
        assert_eq!(&after[..before.len()], before.as_slice());
        assert_eq!(after[0], "priority");
    }

    #[test]
    fn stale_session_cannot_select_remove_or_append() {
        let mut queue = PlayQueue::new();
        queue.set_tracks(vec![entry("one"), entry("two")], 0);
        let entry_id = queue.upcoming_occurrences().next().unwrap().0.to_string();
        let revision = queue.revision();

        assert!(!queue.select_entry("stale", &entry_id));
        assert!(!queue.remove_entry("stale", &entry_id));
        assert!(!queue.append_context_if_session("stale", vec![entry("three")]));
        assert_eq!(queue.revision(), revision);
        assert_eq!(upcoming_ids(&queue), vec!["two"]);
    }

    #[test]
    fn identity_mutations_target_one_duplicate_occurrence() {
        let mut queue = PlayQueue::new();
        queue.set_tracks(vec![entry("same"), entry("same"), entry("same")], 0);
        let session = queue.session_id().to_string();
        let ids: Vec<_> = queue
            .upcoming_occurrences()
            .map(|(entry_id, _)| entry_id.to_string())
            .collect();

        assert!(queue.remove_entry(&session, &ids[0]));
        let remaining: Vec<_> = queue
            .upcoming_occurrences()
            .map(|(entry_id, _)| entry_id.to_string())
            .collect();
        assert_eq!(remaining, vec![ids[1].clone()]);
    }

    #[test]
    fn selecting_future_entry_moves_skipped_items_to_history_not_up_next() {
        let mut queue = PlayQueue::new();
        queue.set_tracks(
            vec![entry("one"), entry("two"), entry("three"), entry("four")],
            0,
        );
        let session = queue.session_id().to_string();
        let third_id = queue.upcoming_occurrences().nth(1).unwrap().0.to_string();

        assert!(queue.select_entry(&session, &third_id));
        assert_eq!(
            queue.current().map(|track| track.recording_id.as_str()),
            Some("three")
        );
        assert_eq!(upcoming_ids(&queue), vec!["four"]);
        assert_eq!(
            queue.prev().map(|track| track.recording_id.as_str()),
            Some("two")
        );
    }

    #[test]
    fn clear_upcoming_keeps_only_current_occurrence() {
        let mut queue = PlayQueue::new();
        queue.set_tracks(vec![entry("one"), entry("two"), entry("three")], 1);

        queue.clear_upcoming();

        assert_eq!(
            queue.current().map(|track| track.recording_id.as_str()),
            Some("two")
        );
        assert!(upcoming_ids(&queue).is_empty());
        queue.set_repeat(RepeatMode::All);
        assert_eq!(
            queue.next().map(|track| track.recording_id.as_str()),
            Some("two")
        );
    }

    #[test]
    fn clear_upcoming_rejects_late_context_from_the_same_session() {
        let mut queue = PlayQueue::new();
        queue.set_tracks(vec![entry("one"), entry("two")], 0);
        let session = queue.session_id().to_string();

        queue.clear_upcoming();

        assert!(!queue.append_context_if_session(&session, vec![entry("late")]));
        assert!(upcoming_ids(&queue).is_empty());
    }
}
