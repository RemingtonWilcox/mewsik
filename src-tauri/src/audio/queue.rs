use rand::seq::SliceRandom;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

pub struct PlayQueue {
    tracks: Vec<QueueEntry>,
    current_index: Option<usize>,
    shuffle: bool,
    shuffle_order: Vec<usize>,
    repeat: RepeatMode,
}

impl PlayQueue {
    pub fn new() -> Self {
        Self {
            tracks: Vec::new(),
            current_index: None,
            shuffle: false,
            shuffle_order: Vec::new(),
            repeat: RepeatMode::Off,
        }
    }

    pub fn set_tracks(&mut self, tracks: Vec<QueueEntry>) {
        self.tracks = tracks;
        self.current_index = if self.tracks.is_empty() {
            None
        } else {
            Some(0)
        };
        self.regenerate_shuffle();
    }

    pub fn add(&mut self, entry: QueueEntry) {
        let current = self.current_index;
        self.tracks.push(entry);
        if self.current_index.is_none() {
            self.current_index = Some(0);
        }
        self.regenerate_shuffle_with_current(current.or(self.current_index));
    }

    pub fn insert_next(&mut self, entry: QueueEntry) {
        let current = self.current_index;
        let insert_at = self.current_index.map(|i| i + 1).unwrap_or(0);
        self.tracks.insert(insert_at, entry);
        if self.current_index.is_none() {
            self.current_index = Some(0);
        }
        self.regenerate_shuffle_with_current(current.or(self.current_index));
    }

    pub fn remove(&mut self, index: usize) {
        if index < self.tracks.len() {
            self.tracks.remove(index);
            if let Some(current) = self.current_index {
                if index < current {
                    self.current_index = Some(current - 1);
                } else if index == current && current >= self.tracks.len() {
                    self.current_index = if self.tracks.is_empty() {
                        None
                    } else {
                        Some(self.tracks.len() - 1)
                    };
                }
            }
            self.regenerate_shuffle_with_current(self.current_index);
        }
    }

    pub fn current(&self) -> Option<&QueueEntry> {
        self.current_index.and_then(|i| self.tracks.get(i))
    }

    pub fn next(&mut self) -> Option<&QueueEntry> {
        if self.tracks.is_empty() {
            return None;
        }
        match self.repeat {
            RepeatMode::One => return self.current(),
            _ => {}
        }

        if self.shuffle {
            let current = self.current_index.unwrap_or(0);
            let shuffle_pos = self
                .shuffle_order
                .iter()
                .position(|idx| *idx == current)
                .unwrap_or(0);
            let next_pos = shuffle_pos + 1;
            if next_pos >= self.shuffle_order.len() {
                if self.repeat == RepeatMode::All {
                    self.regenerate_shuffle();
                    self.current_index = self.shuffle_order.first().copied();
                } else {
                    return None;
                }
            } else {
                self.current_index = self.shuffle_order.get(next_pos).copied();
            }
        } else {
            let current = self.current_index.unwrap_or(0);
            let next_idx = current + 1;
            if next_idx >= self.tracks.len() {
                if self.repeat == RepeatMode::All {
                    self.current_index = Some(0);
                } else {
                    return None;
                }
            } else {
                self.current_index = Some(next_idx);
            }
        }

        self.current()
    }

    pub fn prev(&mut self) -> Option<&QueueEntry> {
        if self.tracks.is_empty() {
            return None;
        }
        let current = self.current_index.unwrap_or(0);
        if self.shuffle {
            let shuffle_pos = self
                .shuffle_order
                .iter()
                .position(|idx| *idx == current)
                .unwrap_or(0);
            if shuffle_pos > 0 {
                self.current_index = self.shuffle_order.get(shuffle_pos - 1).copied();
            } else if self.repeat == RepeatMode::All {
                self.current_index = self.shuffle_order.last().copied();
            }
        } else if current > 0 {
            self.current_index = Some(current - 1);
        } else if self.repeat == RepeatMode::All {
            self.current_index = Some(self.tracks.len() - 1);
        }
        self.current()
    }

    pub fn set_index(&mut self, index: usize) {
        if index < self.tracks.len() {
            self.current_index = Some(index);
        }
    }

    pub fn set_shuffle(&mut self, shuffle: bool) {
        let current = self.current_index;
        self.shuffle = shuffle;
        if shuffle {
            self.regenerate_shuffle_with_current(current);
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

    pub fn tracks(&self) -> &[QueueEntry] {
        &self.tracks
    }

    pub fn len(&self) -> usize {
        self.tracks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tracks.is_empty()
    }

    pub fn clear(&mut self) {
        self.tracks.clear();
        self.current_index = None;
        self.shuffle_order.clear();
    }

    pub fn clear_upcoming(&mut self) {
        if let Some(current) = self.current_index {
            if let Some(entry) = self.tracks.get(current).cloned() {
                self.tracks = vec![entry];
                self.current_index = Some(0);
                self.regenerate_shuffle_with_current(Some(0));
                return;
            }
        }
        self.clear();
    }

    fn regenerate_shuffle(&mut self) {
        let mut rng = rand::thread_rng();
        self.shuffle_order = (0..self.tracks.len()).collect();
        self.shuffle_order.shuffle(&mut rng);
    }

    fn regenerate_shuffle_with_current(&mut self, current: Option<usize>) {
        self.regenerate_shuffle();
        if let Some(current) = current {
            if let Some(pos) = self.shuffle_order.iter().position(|idx| *idx == current) {
                let current_idx = self.shuffle_order.remove(pos);
                self.shuffle_order.insert(0, current_idx);
            }
        }
    }

    pub fn current_index(&self) -> Option<usize> {
        self.current_index
    }
}

#[cfg(test)]
mod tests {
    use super::{PlayQueue, QueueEntry};
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

    #[test]
    fn shuffle_preserves_current_track() {
        let mut queue = PlayQueue::new();
        queue.set_tracks(vec![entry("one"), entry("two"), entry("three")]);
        queue.set_index(1);

        queue.set_shuffle(true);

        assert_eq!(
            queue.current().map(|track| track.recording_id.as_str()),
            Some("two")
        );
        assert_eq!(queue.current_index(), Some(1));
    }

    #[test]
    fn clear_upcoming_keeps_current_track_only() {
        let mut queue = PlayQueue::new();
        queue.set_tracks(vec![entry("one"), entry("two"), entry("three")]);
        queue.set_index(1);

        queue.clear_upcoming();

        assert_eq!(queue.len(), 1);
        assert_eq!(
            queue.current().map(|track| track.recording_id.as_str()),
            Some("two")
        );
        assert_eq!(queue.current_index(), Some(0));
    }
}
