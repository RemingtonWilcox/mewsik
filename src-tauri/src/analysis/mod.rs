//! Offline full-track analysis — the "visual score" (Phase 2a of
//! docs/visualizer-unified-plan.md). Classical DSP only, no ML deps:
//! beat grid via flux autocorrelation, section boundaries via Foote
//! novelty on a per-second self-similarity matrix, Krumhansl key
//! detection, and a loudness arc. Runs in a background thread after
//! playback starts; results are cached in SQLite per recording.

mod decode;
mod features;
mod score;
mod structure;
mod tempo;

pub use score::{analyze_file, ANALYSIS_VERSION};
