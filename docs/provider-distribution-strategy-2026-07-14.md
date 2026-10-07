# Provider distribution strategy

Checked against official provider terms and documentation on 2026-07-14. This is an engineering release boundary, not legal advice.

## Decision

The current YouTube, SoundCloud, and Bandcamp sidecar integrations are local prototype features and must not ship as-is. Code signing does not change that. `release/provider-policy.json` therefore blocks every stable draft until a reviewed exact-version change closes the provider and legal blockers.

| Provider | Current prototype behavior | Distribution-safe direction |
| --- | --- | --- |
| YouTube | Unofficial InnerTube search, audio-only stream extraction, background playback, and MP3 download | Official Data API for separated/attributed discovery plus either an official visible player or ordinary link-out; no audio extraction, background-only player, conversion, or download |
| SoundCloud | Scraped web client ID, internal API calls, direct/HLS stream extraction, combined cross-provider playback, and persistent download | Written approval for this exact multi-provider product or ordinary link-out; registered credentials, attribution/permalinks, session-only caching, and no downloads if approved |
| Bandcamp | Automated page/search scraping and direct preview URL extraction | Ordinary Bandcamp search/item link-outs or a separately licensed integration; user-purchased files can be imported as local music |
| Radio Browser | Documented directory API, direct station connections, descriptive User-Agent, and click counting | Keep for beta; preserve station identity/homepage, do not record/restream/remove ads without station permission, and list the client with Radio Browser |

## Why the current paths are blocked

### YouTube

`sidecar/src/providers/youtube.ts` uses unofficial InnerTube calls and extracts audio streams; `src-tauri/src/download/mod.rs` can transcode those streams into local MP3 files. YouTube's current terms prohibit unauthorized automated access and downloading. Its API policies also prohibit separating audio/video, background-only playback, offline copies, and replacing the official player with another playback technology.

Official references: [YouTube Terms](https://www.youtube.com/static?template=terms&gl=US), [Developer Policies](https://developers.google.com/youtube/terms/developer-policies), and [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality).

### SoundCloud

`sidecar/src/providers/soundcloud.ts` and `soundcloud-fetch` recover a web client ID and internal stream endpoints. The app then mixes those results with YouTube/Bandcamp and can persist the media. SoundCloud's API terms explicitly prohibit an on-demand product combining SoundCloud with another service (using SoundCloud plus YouTube as the example), stream ripping, persistent/offline content storage, scraping, and using another client's credentials.

Official references: [SoundCloud API guide](https://developers.soundcloud.com/docs/api/) and [API Terms of Use](https://developers.soundcloud.com/docs/api/terms-of-use).

### Bandcamp

`sidecar/src/providers/bandcamp.ts` uses `bandcamp-fetch` to scrape pages and extract preview streams. Bandcamp's current acceptable-use policy prohibits automated scraping of its text, media, data, and other content. Authorized downloads flow through Bandcamp purchase/free-download delivery, not captured preview URLs.

Official references: [Bandcamp Terms](https://bandcamp.com/terms_of_use), [Acceptable Use Policy](https://get.bandcamp.help/en/articles/15263124-bandcamp-s-acceptable-use-and-moderation-policy), and [purchase downloads](https://get.bandcamp.help/en/articles/15263100-where-do-i-download-my-purchase).

### Radio Browser

The station directory is the viable public integration. Mewsik uses documented mirrors, identifies itself, records playback clicks, and connects the listener directly to the station. Radio Browser catalogs links but does not license each station's underlying programming, so recording, restreaming, ad removal, and commercial-free promises remain outside the directory's permission.

Official references: [Radio Browser API](https://docs.radio-browser.info/) and [station/client directory](https://www.radio-browser.info/add).

## Product choices

The fastest release-safe edition is local library + user-owned downloads + internet radio + playlists + Prism/Soma/Signal, with the three blocked providers disabled in both the Rust backend and sidecar. External link-outs can preserve discovery without ingesting or replaying provider media.

A future YouTube edition can add a structurally separate, provider-ordered Data API shelf behind versioned Terms/Privacy acceptance. Playback must remain in an official visible player or leave the app. SoundCloud needs written approval before engineering a registered integration. Bandcamp should remain link-out unless a supported licensed interface becomes available.

Before changing `distribution_approved` to `true`, the review must verify server-side provider gates, remote-download denial, real public Terms/Privacy, accurate README/UI claims, and the exact signed candidate. The approval is bound to one release version and a repository issue or pull request.
