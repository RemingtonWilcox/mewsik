# Discovery provider strategy

Checked against the providers' official documentation on 2026-07-14.

## Product rule

An ordinary mewsik user must never create or paste a third-party developer key. Provider secrets also must not be bundled in the Windows executable, macOS app, repository, or frontend assets; desktop clients are public clients and embedded secrets can be extracted.

For a public release, one small mewsik discovery service should:

1. hold provider credentials server-side;
2. refresh each source on its own cadence;
3. cache, normalize, attribute, and serve credential-free snapshots;
4. degrade to recent honest snapshots when a provider is slow or unavailable; and
5. keep playback/search provider logic separate from trend-ranking inputs.

The compute and bandwidth for this scheduler should be small at friend/beta scale. Provider approval, quota, and content-license terms are the real constraints.

## Provider decisions

### YouTube: preferred live movement signal

- Use documented `videos.list` requests with `chart=mostPopular`, a region, and the Music video category. This is a one-unit general read rather than an expensive `search.list` request.
- The current default allocation includes 10,000 units per day for general endpoints and a separate 100 `search.list` calls per day. Higher quota requires a compliance audit; Google does not publish a pay-as-you-go quota price.
- One IP-restricted server key can refresh cached regional snapshots for all mewsik clients. Do not put the key in the desktop app, and do not ask users to create Google projects.

Official references: [videos.list](https://developers.google.com/youtube/v3/docs/videos/list), [quota overview](https://developers.google.com/youtube/v3/getting-started), [quota audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits), and [developer policies](https://developers.google.com/youtube/terms/developer-policies).

### Last.fm: useful secondary consensus signal, pending approval

- Last.fm charts and tags can add global and genre context. A single server-held application key is the right technical model.
- The standard API terms cover noncommercial use. Commercial use requires contacting Last.fm; pricing and a fixed rate ceiling are not published.
- Attribution/linkback and HTTP-aware caching are required, stored Last.fm data is capped, and API artwork/audio is outside the standard license.

Official references: [Last.fm API](https://www.last.fm/api), [API terms](https://www.last.fm/api/tos), and [top tracks](https://www.last.fm/api/show/chart.getTopTracks).

### Spotify: not a viable public ranking source

- Current Development Mode is limited to five allowlisted users, requires the app owner to have Premium, and removes discovery inputs including New Releases and popularity fields.
- Extended Quota currently requires an established organization, a launched service, and at least 250,000 monthly active users. A proxy backend does not remove those access limits.
- Spotify's policy also conflicts with using Spotify content or derived metrics inside a cross-provider ranking/resolution product.

Do not make Spotify a dependency of mewsik discovery. A future, clearly separated Connect Spotify feature would require product/legal review and user OAuth with PKCE.

Official references: [February 2026 migration](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide), [quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes), and [developer policy](https://developer.spotify.com/policy).

### Beatport: partnership path only

- Beatport's official v4 API is for pre-approved licensees. Its default API grant is noncommercial, requires Beatport linkback, prohibits sharing credentials, and describes use on an approved domain.
- Desktop distribution and commercial use therefore require explicit written approval covering the Windows and macOS clients. Limits and pricing are not public.

Do not scrape Beatport or ship an unofficial credential. Apply for a partnership; if approved, keep its key on the mewsik service and add attributed electronic charts.

Official references: [Beatport developer portal](https://api.beatport.com/v4/docs/v4/catalog/search/) and [API terms](https://support.beatport.com/hc/en-us/articles/4414997837716-Terms-and-Conditions).

### Apple Music: strong charts, presentation constraints

- Apple's catalog API provides storefront, genre, city, most-played, and global charts. Catalog charts do not require each listener to sign in.
- Authenticated use requires a developer token signed by a Media Services private key. The private key must stay on the server; Apple does not publish a numeric rate limit or per-call price.
- Apple's content terms constrain presenting Apple metadata separately from Apple Music and using promotional feed content to promote other services. Apple-sourced cards should retain Apple attribution/linkout, and cross-provider search behavior needs written approval or legal review.

The existing public Marketing Tools snapshots can remain a beta input with honest attribution while the release model is reviewed. A production migration to the authenticated catalog API belongs in the server, not each desktop client.

Official references: [charts](https://developer.apple.com/documentation/applemusicapi/charts), [developer tokens](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens), [Media Services key](https://developer.apple.com/help/account/capabilities/create-a-media-identifier-and-private-key), and [program license](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/).

## Delivery order

1. Keep Apple Marketing Tools, ListenBrainz, and Bandcamp Daily as the no-setup beta stack with explicit source and freshness labels.
2. Add the mewsik discovery service and move snapshots behind a versioned `/discovery` response; clients keep a local last-known-good frame.
3. Add scheduled YouTube Music-category `mostPopular` snapshots by selected regions.
4. Contact Last.fm for public/commercial terms and add it only after approval.
5. Apply to Beatport for licensed desktop use.
6. Keep Spotify out of ranking unless its access and cross-service policy materially change.
