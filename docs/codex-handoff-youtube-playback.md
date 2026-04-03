# Codex Handoff: Fix YouTube Audio Playback

## Problem

YouTube stream URL resolution now works (via youtubei.js IOS client), but audio doesn't actually play. The player UI briefly shows the track title, artist, album art, and scrubber, then it all disappears — indicating the audio engine fails to decode/play the stream.

## What was already done

1. **yt-dlp removed** — replaced with youtubei.js native `getStreamingData()` using `client: 'IOS'`
2. **Stream URL resolves successfully** — the sidecar returns a valid URL (verified with HTTP 200 response)
3. **IOS client headers added** — User-Agent mimics iOS YouTube app
4. **Format returned is `audio/mp4` (AAC)** — symphonia-all should support this

## Likely root cause

The audio engine in `src-tauri/src/audio/engine.rs` uses `http_stream.rs` to download the stream to a temp file, then feeds it to `rodio::Decoder`. The decoder likely fails because:

1. **MP4 container needs the `moov` atom** (metadata) which is typically at the END of the file. The streaming approach feeds partial data to the decoder before the full file is downloaded. rodio/symphonia may not handle streaming MP4 containers where moov hasn't arrived yet.

2. **Possible fix approaches:**
   - Wait for more data before attempting decode (increase `initial_buffer_bytes` significantly for MP4)
   - Use the fallback full-fetch path (download entire file first, then decode) for YouTube URLs
   - Request `audio/webm` (opus) format instead of `audio/mp4` — webm supports streaming decode without needing the full file. Change the sidecar's `getStreamingData` call to prefer webm.
   - Add `Range: bytes=0-` header to get the full file with Content-Length

3. **Quickest fix is probably to prefer webm/opus format** from YouTube instead of mp4/aac. In `sidecar/src/providers/youtube.ts:115`, the `getStreamingData` options could filter for webm:
   ```typescript
   const format = await yt.getStreamingData(sourceId, {
     client: 'IOS',
     type: 'audio',
     quality: 'best',
     format: 'any',  // Try changing to filter for webm/opus if possible
   });
   ```
   
   Or after getting the format, check if there's a webm alternative in the streaming data.

   **However**, the IOS client may only return MP4 formats (since iOS doesn't support webm). If so, you may need to use a different client for audio format selection or handle MP4 streaming differently.

## Key files

| File | What it does |
|------|-------------|
| `sidecar/src/providers/youtube.ts:105-154` | YouTube stream resolution — returns URL, headers, mime_type |
| `sidecar/src/index.ts:8-18` | Platform.shim.eval setup for youtubei.js |
| `src-tauri/src/audio/engine.rs:285-300` | Where remote URLs are handed to http_stream |
| `src-tauri/src/audio/http_stream.rs:196-290` | HTTP download worker + buffered file approach |
| `src-tauri/src/audio/engine.rs:420-430` | Where Decoder is created from the buffered file |
| `src-tauri/src/audio/engine.rs:505-515` | Fallback full-fetch + decode path |

## How to reproduce

1. `pnpm tauri:dev` (or build and install)
2. Go to Search, type any song name
3. Click play on a YouTube result (red "youtube" badge)
4. Track info briefly appears in player bar, then disappears
5. No audio plays

## Debugging steps

1. Add logging in `engine.rs` around the Decoder::new() calls to see the actual error
2. Check what mime_type / format the stream is in
3. Try the fallback full-fetch path to see if downloading the complete file first allows decoding
4. If MP4 is the issue, try switching to a YouTube client that returns webm/opus (like `TVHTML5_SIMPLY_EMBEDDED_PLAYER` or `WEB` with different params)

## Success criteria

- Search for a song → click play on YouTube result → audio plays within 2 seconds
- No decode errors in logs
- Track info stays in player bar during playback
- Seeking works (or is correctly marked as unavailable)

## Constraints

- Don't break SoundCloud or Bandcamp playback (they work)
- Don't reintroduce yt-dlp
- The sidecar must still build with `pnpm sidecar:build` (esbuild bundling)
- Rust must compile with `PATH="$HOME/.cargo/bin:$PATH" cargo check --manifest-path src-tauri/Cargo.toml`
