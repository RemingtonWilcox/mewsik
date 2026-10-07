//! Standalone runner for the visual-score analyzer — dev tool for
//! validating analysis output against real tracks without the app.
//! Usage: cargo run --example analyze -- <audio file>

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: analyze <audio file>");
    let started = std::time::Instant::now();
    match mewsik_lib::analysis::analyze_file(std::path::Path::new(&path)) {
        Ok(score) => {
            println!("analyzed in {:.1}s", started.elapsed().as_secs_f32());
            println!(
                "duration {:.1}s | bpm {:.1} (conf {:.2}) | key pc{} {} (conf {:.2})",
                score.duration_ms as f32 / 1000.0,
                score.bpm,
                score.beat_confidence,
                score.key.pitch_class,
                score.key.mode,
                score.key.confidence
            );
            println!("sections:");
            for s in &score.sections {
                println!(
                    "  {:>6.1}s – {:>6.1}s  {:<10} energy {:.2}",
                    s.start_ms as f32 / 1000.0,
                    s.end_ms as f32 / 1000.0,
                    s.label,
                    s.energy
                );
            }
            println!("drops: {:?}", score.drops);
        }
        Err(e) => {
            eprintln!("analysis failed: {}", e);
            std::process::exit(1);
        }
    }
}
