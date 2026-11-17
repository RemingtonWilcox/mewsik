//! Shoutcast/Icecast in-band metadata ("ICY"). When a request carries
//! `Icy-MetaData: 1` the server answers with `icy-metaint: N` and inserts a
//! metadata block after every N audio bytes: one length byte (x16) and then
//! text such as `StreamTitle='Artist - Song';`. `IcyReader` removes those
//! blocks so the decoder only sees audio, and reports each new title.

use std::io::{self, Read};

/// Upper bound for `icy-metaint`; real servers use 8 KiB to 64 KiB.
const MAX_METAINT: usize = 1 << 20;

pub fn parse_metaint(header: Option<&str>) -> Option<usize> {
    let value: usize = header?.trim().parse().ok()?;
    (value > 0 && value <= MAX_METAINT).then_some(value)
}

pub struct IcyReader<R, F> {
    inner: R,
    metaint: usize,
    until_meta: usize,
    last_title: Option<String>,
    on_title: F,
}

impl<R: Read, F: FnMut(String)> IcyReader<R, F> {
    pub fn new(inner: R, metaint: usize, on_title: F) -> Self {
        Self {
            inner,
            metaint,
            until_meta: metaint,
            last_title: None,
            on_title,
        }
    }

    /// Reads one metadata block. `Ok(false)` means the stream ended.
    fn read_block(&mut self) -> io::Result<bool> {
        let mut len = [0u8; 1];
        if !read_full(&mut self.inner, &mut len)? {
            return Ok(false);
        }
        let size = len[0] as usize * 16;
        if size > 0 {
            let mut block = vec![0u8; size];
            if !read_full(&mut self.inner, &mut block)? {
                return Ok(false);
            }
            if let Some(title) = stream_title(&block) {
                if self.last_title.as_deref() != Some(title.as_str()) {
                    self.last_title = Some(title.clone());
                    (self.on_title)(title);
                }
            }
        }
        self.until_meta = self.metaint;
        Ok(true)
    }
}

impl<R: Read, F: FnMut(String)> Read for IcyReader<R, F> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.until_meta == 0 && !self.read_block()? {
            return Ok(0);
        }
        let want = buf.len().min(self.until_meta);
        let got = self.inner.read(&mut buf[..want])?;
        self.until_meta -= got;
        Ok(got)
    }
}

/// Fills `buf` completely; `Ok(false)` on a clean end of stream.
fn read_full(reader: &mut impl Read, buf: &mut [u8]) -> io::Result<bool> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => return Ok(false),
            Ok(n) => filled += n,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
            Err(err) => return Err(err),
        }
    }
    Ok(true)
}

/// The `StreamTitle` of one metadata block, cleaned up. Blank titles and
/// placeholders (`-`, `Unknown`) count as no title.
pub fn stream_title(block: &[u8]) -> Option<String> {
    let end = block.iter().position(|&b| b == 0).unwrap_or(block.len());
    let bytes = &block[..end];
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        // Older servers send Latin-1.
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    };
    let start = text.find("StreamTitle='")? + "StreamTitle='".len();
    let rest = &text[start..];
    // Titles may contain apostrophes; the field ends at `';`.
    let value = match rest.find("';") {
        Some(stop) => &rest[..stop],
        None => rest.trim_end_matches('\''),
    };
    let title = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = title.trim_matches(|c: char| c == '-' || c.is_whitespace());
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("unknown") {
        return None;
    }
    Some(title.trim().to_string())
}

/// Splits `Artist - Song` into its halves. Titles without the separator are
/// left whole (often a show or mix name).
pub fn split_title(title: &str) -> (Option<String>, Option<String>) {
    for sep in [" - ", " – ", " — "] {
        if let Some((artist, track)) = title.split_once(sep) {
            let (artist, track) = (artist.trim(), track.trim());
            if !artist.is_empty() && !track.is_empty() {
                return (Some(artist.to_string()), Some(track.to_string()));
            }
        }
    }
    (None, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(text: &str) -> Vec<u8> {
        let mut bytes = text.as_bytes().to_vec();
        let padded = bytes.len().div_ceil(16) * 16;
        bytes.resize(padded, 0);
        let mut out = vec![(padded / 16) as u8];
        out.extend(bytes);
        out
    }

    #[test]
    fn strips_metadata_and_reports_titles_once() {
        let mut stream = Vec::new();
        stream.extend(b"AAAA");
        stream.extend(block(
            "StreamTitle='Goupil. - MAKE 'EM BACKUP';StreamUrl='';",
        ));
        stream.extend(b"BBBB");
        stream.extend(block("StreamTitle='Goupil. - MAKE 'EM BACKUP';"));
        stream.extend(b"CCCC");
        stream.push(0);
        stream.extend(b"DD");
        let mut titles = Vec::new();
        let mut audio = Vec::new();
        {
            let mut reader = IcyReader::new(&stream[..], 4, |t| titles.push(t));
            let mut buf = [0u8; 3];
            loop {
                let n = reader.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                audio.extend_from_slice(&buf[..n]);
            }
        }
        assert_eq!(audio, b"AAAABBBBCCCCDD");
        assert_eq!(titles, vec!["Goupil. - MAKE 'EM BACKUP".to_string()]);
    }

    #[test]
    fn ignores_blank_titles_and_reads_latin1() {
        assert_eq!(stream_title(b"StreamTitle='';"), None);
        assert_eq!(stream_title(b"StreamTitle=' - ';"), None);
        assert_eq!(
            stream_title(b"StreamTitle='Beyonc\xe9 - Halo';").as_deref(),
            Some("Beyoncé - Halo")
        );
    }

    #[test]
    fn splits_artist_and_song() {
        assert_eq!(
            split_title("ROLAND JONES - DEMONZ (feat. TRIPLE TIX)"),
            (
                Some("ROLAND JONES".into()),
                Some("DEMONZ (feat. TRIPLE TIX)".into())
            )
        );
        assert_eq!(split_title("Liquid Drum and Bass Mix 280"), (None, None));
    }

    #[test]
    fn metaint_must_be_sane() {
        assert_eq!(parse_metaint(Some("16000")), Some(16000));
        assert_eq!(parse_metaint(Some("0")), None);
        assert_eq!(parse_metaint(Some("abc")), None);
        assert_eq!(parse_metaint(None), None);
    }
}
