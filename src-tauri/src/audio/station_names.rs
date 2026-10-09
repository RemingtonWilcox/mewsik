// Station names on radio-browser are free text, and many stations stuff them
// with slogans, genre lists, URLs and bitrate tags. This is a port of
// `cleanStationName` in src/lib/radio/names.ts for the one surface the web
// UI cannot reach: the iOS lock screen. Keep the two in step; the tests use
// outputs of the TypeScript version as their expectations.

const MAX_CHARS: usize = 42;
const UNKNOWN_STATION: &str = "Unknown station";

fn is_word(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

fn is_edge_punctuation(ch: char, trailing: bool) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '-' | '–'
                | '—'
                | '|'
                | '•'
                | '·'
                | '~'
                | ':'
                | ';'
                | ','
                | '!'
                | '*'
                | '#'
                | '_'
                | '='
                | '+'
        )
        || (!trailing && ch == '.')
}

fn trim_edge_punctuation(text: &str) -> &str {
    text.trim_start_matches(|ch| is_edge_punctuation(ch, false))
        .trim_end_matches(|ch| is_edge_punctuation(ch, true))
}

/// True when `chars[at..]` starts a word (JS `\b` before a word character).
fn word_starts_at(chars: &[char], at: usize) -> bool {
    at < chars.len() && is_word(chars[at]) && (at == 0 || !is_word(chars[at - 1]))
}

fn starts_with_ignore_case(chars: &[char], at: usize, needle: &str) -> bool {
    let mut index = at;
    for expected in needle.chars() {
        match chars.get(index) {
            Some(ch) if ch.to_ascii_lowercase() == expected => index += 1,
            _ => return false,
        }
    }
    true
}

/// URLs (`https://…`, `www.…`) up to the next whitespace become a space.
fn strip_urls(chars: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut index = 0;
    while index < chars.len() {
        let url_here = word_starts_at(chars, index)
            && ["https://", "http://", "www."]
                .iter()
                .any(|prefix| starts_with_ignore_case(chars, index, prefix));
        if url_here {
            while index < chars.len() && !chars[index].is_whitespace() {
                index += 1;
            }
            out.push(' ');
        } else {
            out.push(chars[index]);
            index += 1;
        }
    }
    out
}

/// A format tag word inside brackets: kbps, mp3, aac, hd, live, 24/7, 128k...
fn noise_word_at(chars: &[char], at: usize) -> bool {
    if !word_starts_at(chars, at) {
        return false;
    }
    let ends_word = |end: usize| end >= chars.len() || !is_word(chars[end]);
    const WORDS: [&str; 14] = [
        "kbps", "kbit", "kb/s", "mp3", "aac", "ogg", "opus", "flac", "hd", "hq", "stream",
        "online", "live", "24/7",
    ];
    if WORDS.iter().any(|word| {
        starts_with_ignore_case(chars, at, word) && ends_word(at + word.chars().count())
    }) {
        return true;
    }
    let digits = chars[at..]
        .iter()
        .take_while(|ch| ch.is_ascii_digit())
        .count();
    (2..=3).contains(&digits)
        && chars
            .get(at + digits)
            .is_some_and(|ch| ch.eq_ignore_ascii_case(&'k'))
        && ends_word(at + digits + 1)
}

/// `(128k mp3)`, `[HD]`, `(Live Stream)` become a space.
fn strip_bracketed_noise(chars: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut index = 0;
    while index < chars.len() {
        if matches!(chars[index], '(' | '[') {
            let close = chars[index + 1..]
                .iter()
                .position(|ch| matches!(ch, ')' | ']'))
                .map(|offset| index + 1 + offset);
            if let Some(close) = close {
                if (index + 1..close).any(|at| noise_word_at(chars, at)) {
                    out.push(' ');
                    index = close + 1;
                    continue;
                }
            }
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Long all-caps names read as spam; title-case them.
fn soften_shouting(name: String) -> String {
    let letters: Vec<char> = name.chars().filter(|ch| ch.is_ascii_alphabetic()).collect();
    if letters.len() <= 10 || letters.iter().any(|ch| ch.is_ascii_lowercase()) {
        return name;
    }
    let mut previous_is_word = false;
    name.to_lowercase()
        .chars()
        .map(|ch| {
            let out = if !previous_is_word && ch.is_ascii_lowercase() {
                ch.to_ascii_uppercase()
            } else {
                ch
            };
            previous_is_word = is_word(ch);
            out
        })
        .collect()
}

fn char_len(text: &str) -> usize {
    text.chars().count()
}

/// Keeps leading " | ", " :: ", " - " (and similar) segments while they fit.
fn keep_leading_segments(name: &str) -> String {
    const SEPARATORS: [&str; 10] = ["|", "•", "·", "~", "::", "-", "--", "—", "–", "//"];
    let mut segments: Vec<String> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for token in name.split(' ') {
        if SEPARATORS.contains(&token) && !current.is_empty() {
            segments.push(current.join(" "));
            current.clear();
        } else {
            current.push(token);
        }
    }
    segments.push(current.join(" "));
    let segments: Vec<&str> = segments
        .iter()
        .map(|segment| trim_edge_punctuation(segment).trim())
        .filter(|segment| !segment.is_empty())
        .collect();

    let Some(first) = segments.first() else {
        return name.to_string();
    };
    let mut kept = first.to_string();
    for segment in &segments[1..] {
        let candidate = format!("{kept} · {segment}");
        if char_len(&candidate) > MAX_CHARS {
            break;
        }
        kept = candidate;
    }
    kept
}

/// A short, human name for a station (see `cleanStationName`).
pub fn clean_station_name(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let chars = strip_bracketed_noise(&strip_urls(&chars));
    let text: String = chars.into_iter().collect();
    let collapsed = collapse_whitespace(&text);
    let mut name = trim_edge_punctuation(&collapsed).trim().to_string();
    if name.is_empty() {
        return UNKNOWN_STATION.to_string();
    }

    name = soften_shouting(name);
    if char_len(&name) > MAX_CHARS {
        name = keep_leading_segments(&name);
    }
    if char_len(&name) > MAX_CHARS {
        let cut: String = name.chars().take(MAX_CHARS - 1).collect();
        let boundary = cut.rfind(' ').map(|byte| char_len(&cut[..byte]));
        let kept: String = match boundary {
            Some(at) if at * 2 > MAX_CHARS => cut.chars().take(at).collect(),
            _ => cut,
        };
        name = format!("{}…", trim_edge_punctuation(&kept));
    }
    if name.is_empty() {
        UNKNOWN_STATION.to_string()
    } else {
        name
    }
}

#[cfg(test)]
mod tests {
    use super::clean_station_name;

    // Expectations are the outputs of cleanStationName in names.ts.
    #[test]
    fn matches_the_typescript_cleaner() {
        let cases = [
            (
                "RADIO X :: Hip Hop, Rap, Trap, Techno, House | www.radiox.com [128kbps]",
                "RADIO X",
            ),
            ("Dutch Delite", "Dutch Delite"),
            ("SomaFM: Groove Salad (128k mp3)", "SomaFM: Groove Salad"),
            (
                "  -- Radio Paradise - Main Mix (FLAC) --  ",
                "Radio Paradise - Main Mix",
            ),
            ("https://example.com/live", "Unknown station"),
            (
                "THE BEST HITS RADIO ONLINE 24/7 - POP - DANCE - ROCK - CHILL - LOUNGE - JAZZ",
                "The Best Hits Radio Online 24/7 · Pop",
            ),
            (
                "Jazz FM | Smooth Jazz & Soul | The very best smooth jazz from around the world",
                "Jazz FM · Smooth Jazz & Soul",
            ),
            ("Radio Swiss Classic", "Radio Swiss Classic"),
            ("Antenne Bayern (Live Stream) [HD]", "Antenne Bayern"),
            (
                "A very long single-segment station name without any separators at all here",
                "A very long single-segment station name…",
            ),
            ("", "Unknown station"),
        ];
        for (raw, expected) in cases {
            assert_eq!(clean_station_name(raw), expected, "cleaning {raw:?}");
        }
    }
}
