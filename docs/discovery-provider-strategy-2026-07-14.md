# Discovery provider strategy

Checked against the providers' official documentation on 2026-07-14.

## Product rule

An ordinary mewsik user must never create or paste a third-party developer key. Provider secrets also must not be bundled in the Windows executable, macOS app, repository, or frontend assets; desktop clients are public clients and embedded secrets can be extracted.

For the public beta, the shared discovery service is a scheduled, static publisher rather than an always-running API server. GitHub Actions is the credential boundary: once a provider has passed its separate policy gate, it can refresh public aggregate data and deploy a versioned JSON snapshot to GitHub Pages. The desktop app never receives those credentials. A key by itself is intentionally insufficient to activate a provider.

The implemented split is:

1. publish the two optional hosted source states at `https://remingtonwilcox.github.io/mewsik/discovery/v1/snapshot.json`, while keeping their data batches disabled until their policy gates pass;
2. keep Apple Marketing Tools, ListenBrainz, and Bandcamp Daily as direct public inputs;
3. keep library history, taste signals, interactions, and final ranking private and local;
4. refresh each source on its own cadence and label delivery as `live`, `cached`, `stale`, or `unavailable`;
5. retain a failed provider's prior batch for no more than three of that provider's cadences; and
6. keep playback/search provider logic separate from trend-ranking inputs.

The client pins the HTTPS endpoint and schema version, accepts only the two expected source IDs, caps payload and item sizes, checks timestamps and cadences, and allowlists provider link and artwork hosts. A malformed, future-dated, oversized, unknown, or over-age snapshot is rejected instead of trusted. Local developer keys remain an opt-in fallback for development; ordinary listeners never configure them.

The hourly publisher is deployed and currently returns honest `unavailable` states for both optional providers. It has no continuously running server or database bill at friend/beta scale. Provider approval, presentation rules, and content-license terms remain the real constraints.

## Provider decisions

### YouTube: parked until isolated presentation and consent exist

- Use documented `videos.list` requests with `chart=mostPopular`, a region, and the Music video category. This is a one-unit general read rather than an expensive `search.list` request.
- The current default allocation includes 10,000 units per day for general endpoints and a separate 100 `search.list` calls per day. Higher quota requires a compliance audit; Google does not publish a pay-as-you-go quota price.
- One GitHub Actions secret can eventually refresh the shared U.S. Music-category snapshot for all mewsik clients. Restrict this key to the YouTube Data API v3, but do not IP-restrict it because GitHub-hosted runner egress addresses are not stable. Send it in the `x-goog-api-key` header, never in the URL. Do not put the key in the desktop app, and do not ask users to create Google projects.
- YouTube data must not be blended into mewsik's cross-provider rank, agreement, momentum, audience, or personalized scores. The current client therefore excludes the family from every derived shelf. A future YouTube shelf must preserve provider order, remain clearly branded and separate, and avoid synthetic ranks or derived metrics.
- Before that shelf is enabled, the app needs an explicit versioned acceptance gate for mewsik's Terms and Privacy Policy. The documents must remain accessible, identify the YouTube API Services, link YouTube's Terms and Google's Privacy Policy, and disclose the data and thumbnail requests involved.
- Do not add `MEWSIK_YOUTUBE_API_KEY` or turn on its activation variable yet. Provisioning a restricted unused key is harmless; hourly API access begins only when both the secret and activation variable are configured.

Official references: [videos.list](https://developers.google.com/youtube/v3/docs/videos/list), [quota overview](https://developers.google.com/youtube/v3/getting-started), [quota audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits), and [developer policies](https://developers.google.com/youtube/terms/developer-policies).

### Last.fm: parked pending written approval and attributed UI

- Last.fm charts can add global context. A single GitHub Actions-held application key is the implemented technical model, but the family is excluded from mewsik's derived shelves while it is parked.
- The public Pages snapshot requires prior written approval under the current API terms even for a noncommercial beta. Commercial use separately requires contacting Last.fm; pricing and a fixed rate ceiling are not published.
- Requests use an identifiable User-Agent. Valid Last.fm HTTPS track/artist linkbacks are preserved, while provider artwork and audio are omitted. The remaining activation blockers are written approval plus visible powered-by attribution and linkbacks in the app.
- Do not add `MEWSIK_LASTFM_API_KEY` or turn on its activation variable before those blockers are closed.

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

1. Keep the deployed credential-free unavailable-state snapshot healthy and covered by CI.
2. Add mewsik Terms, Privacy Policy, versioned consent, and a separate unmodified YouTube shelf; complete a policy review before installing its key or enabling the provider.
3. Obtain Last.fm's written approval, add visible attribution/linkbacks, and only then install and enable its key.
4. Add more YouTube regions only after the compliant U.S. shelf, cadence, and quota are measured.
5. Apply to Beatport for licensed desktop use.
6. Keep Spotify out of ranking unless its access and cross-service policy materially changes.
