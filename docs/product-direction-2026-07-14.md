# Product direction: effortless playback and evolving visual worlds

Captured from the July 14 product review. This document is the durable source of truth for the next phase; the original note is intentionally translated into testable product behavior instead of preserved as vague inspiration.

## Product thesis

Mewsik should feel like one continuous music experience, not a collection of separate pages and one-shot actions. Library files, saved streams, playlists, search results, discovery, downloads, the queue, and the visualizer must cooperate. Every surface needs one clear job, and the app should keep music moving without surprising the listener or inventing opaque recommendations.

Two parallel tracks define this phase:

1. **Effortless product flow:** setup, storage, playback, queueing, streaming, playlists, discovery, and manual control work as one understandable system.
2. **Deeper visual art direction:** each visualizer has a distinct identity, a broader evolving range, and a meaningful relationship to musical structure.

## Track A: setup and storage

### Required behavior

- Do not expose an internal application-data path as the normal download destination.
- Choose a recognizable cross-platform default, such as a dedicated `mewsik` folder inside the user's Music or Downloads directory.
- Let the user choose and later change the download folder from Settings with a native folder picker.
- Make the destination clear before or during the first download without turning every launch into a setup obstacle.
- Preserve existing completed downloads and database references. Changing the destination affects new downloads unless the user explicitly chooses a safe migration action.
- Detect missing, disconnected, read-only, or deleted destinations and explain how to repair them.
- Use normal platform conventions on Windows and macOS; never hard-code a user name or Windows-only folder.

### Acceptance criteria

- A fresh install selects a recognizable writable destination.
- The first download clearly shows where the file will be saved.
- Settings can reveal and change that destination.
- Existing files remain playable after an upgrade.
- A bad destination produces a recoverable message rather than a failed or lost download.

## Track B: continuous playback and Up Next

### Current architecture decision

The existing audio engine remains the authority. It already supports local and remote `QueueEntry` values, natural-end advancement, stream refresh/cache, playlists containing non-downloaded recordings, and honest audible-time history. The missing layer is a backend-owned continuity planner: today some pages pass a full context while Quick Picks, command search, and external search can still create fragile one-song or frontend-owned queues.

Queue planning must therefore move into the backend instead of introducing a second frontend queue. Queue entries need stable identity, origin/reason, and manual-versus-generated provenance. The first release fixes the deterministic queue contract and all entry points; lazy source resolution and a single prepared-next slot follow as separate risk-controlled phases.

### Required behavior

- Playing a local-library track, playlist item, saved stream, discovery result, or search result always establishes a playback context.
- Normal track completion advances to another playable item instead of falling silent because the initiating surface supplied only one track.
- Up Next exposes the real upcoming order and maintains a target of roughly ten playable candidates when autoplay is enabled.
- Manual actions win: **Play next**, **Add to queue**, remove, reorder, clear, select an item, repeat, and shuffle must remain predictable.
- Automatically generated candidates refill only the unpinned tail; they must not overwrite explicit user choices.
- A streamed item saved to a playlist remains streamable without requiring a download.
- Candidate selection is deterministic and explainable. Favor explicit context first, then known library/saved affinity, then closely related streamed items with usable sources.
- Avoid immediate repeats, duplicate recordings, one-artist floods, unavailable sources, and items that recently failed.
- Pre-resolve and prepare the next stream early enough to avoid an awkward end-of-track lookup pause. Do not claim true gapless playback until the audio engine demonstrably supports it.
- Record enough context and listening outcomes to improve future ordering without pretending a click or a short skip is a successful recommendation.

### Candidate priority

1. Explicitly queued items.
2. Remaining items in the active album, playlist, library list, or search/discovery shelf.
3. Saved or previously enjoyed recordings with strong artist/album/context affinity.
4. Streamable related candidates derived from real provider/catalog evidence.
5. A conservative, explainable fallback from the local library or saved catalog.

### Acceptance criteria

- Starting a single YouTube or SoundCloud search result produces a visible upcoming queue and advances on completion.
- A playlist containing non-downloaded external tracks plays them as streams.
- The next item is already resolved or being prepared before the current item ends.
- Manual queue edits survive automatic refills.
- The queue explains automatic suggestions in plain language.
- Offline or provider-failure states fall back cleanly and never loop on a broken item.

### Playback delivery phases

1. Correct queue semantics: true upcoming-only state, forced Next that advances under Repeat One, literal Play Next under shuffle, stable queue-entry IDs, manual/generated provenance, and a backend session/revision.
2. One context-aware playback start path for library, album, playlist, Discover, Quick Pick, command search, and external Search; the backend fills up to ten honest upcoming candidates.
3. Store durable recording intents and resolve sources lazily so large remote playlists start promptly and future URLs cannot expire in the queue.
4. Add bounded failure healing plus one prepared-next slot with independent cancellation.
5. Replace completion polling as the main handoff trigger and measure transition latency before claiming seamless or gapless playback.

## Track C: discovery's distinct job

- Search is for a known intent and real provider results.
- Search discovery is for current, externally sourced charts, movement, releases, editorial finds, and broader exploration.
- Personal Discover is primarily deterministic and library/listening-history driven: rotation, rediscovery, affinities, unfinished exploration, and useful bridges beyond the library.
- Internet trend data may seed exploration or autoplay candidates, but should not masquerade as a deeply personalized black-box feed.
- Every recommendation needs an inspectable reason and honest source freshness.
- Installed apps do not contain shared provider secrets or require ordinary listeners to create developer accounts. The implemented beta split keeps Apple, ListenBrainz, and Bandcamp as direct public inputs while a scheduled GitHub Actions publisher owns the optional YouTube and Last.fm delivery boundary. Those two providers are currently parked and excluded from derived shelves until their separate policy/UI gates pass. Personal history and final ranking stay local; see [Discovery provider strategy](discovery-provider-strategy-2026-07-14.md).
- Public distribution is a separate boundary from local prototyping. The current unofficial YouTube, SoundCloud, and Bandcamp search/playback/download paths cannot ship as-is; `release/provider-policy.json` blocks release until approved replacements or server-side distributed-build gates exist.

## Track D: visualizer evolution

### Shared principles

- Prism, Soma, and Signal keep distinct roles; variety must not blur them into the same renderer with different colors.
- Evolution should follow phrases, sections, energy arcs, spectrum, tempo, suspense, release, and longer-lived musical memory—not arbitrary short loops.
- Camera, topology, material, lighting, palette, and density can evolve at different time scales.
- Presets or response profiles may guide the experience, but the default should remain coherent and self-directing.
- Additions must respect measured GPU budgets and degrade intentionally on lower-end hardware.

### Soma direction

- Expand material range beyond low-opacity white: dense tissue, mineral, glass, membrane, filament, metallic, emissive, and shadowed states with real substance.
- Broaden palette and lighting conditions while retaining continuity between states.
- Add controlled topology and silhouette families, including triangle, cross/X, mandala/fractal, ring, split-cell, and asymmetric growth influences.
- Treat predefined shapes as temporary attractors or fields that the organism grows through, not stickers or flat texture overlays.
- Explore meaningful camera variation: orbit, axial rotation, macro surface study, interior/cavity view, silhouette pullback, and perspective compression.
- Preserve the compelling foreground/background foreshadowing where each appears to seed or consume the other.

### New visual foundations

Develop one or two concepts only when they are genuinely different from the existing three. Candidates must still be audio-reactive, evolving, and arrangement-aware. The audited candidates are:

- **Loom — Harmony / Weave:** a kinetic 3D ribbon manifold that moves between torus, helix, saddle, knot, and woven-cage topology. Bands own strand families, harmony changes crossing order, phrases reweave connectivity, and drops open the structure. Prototype this first using a static indexed mesh and a two- or three-pass HDR pipeline.
- **Tide — Memory / Transformation:** one persistent reaction-diffusion or vector field presented as a genuinely dimensional lit topographic surface. Bands inject stable spatial scales, BPM shapes feed/kill pulses, sections alter boundary conditions, and the field retains memory across the song. Reject it if it reads as another flat blended texture.

Each concept requires a one-page identity, performance budget, conductor model, and browser lab prototype before joining the production engine rail.

### Performance prerequisites

- Prism's prerequisite is complete: it has a reusable fixed 60 Hz scheduler, shared journey seed/source epoch, deterministic onset decisions, and a 1920 x 1080 internal-pixel ceiling.
- Give Soma an absolute pixel ceiling and measured quality tiers before increasing its raymarch topology.
- Extract Soma's shader/uniform packing before adding archetype rails so compilation and packing can be tested directly.
- Implement triangle, cross, and mandala influence as one bounded domain/archetype warp through the existing body, not four separately raymarched bodies.
- Expand material primarily at hit time; do not multiply noise work through every map, normal, AO, and shadow sample.
- Replace rare random closeups with a deterministic phrase-scale shot planner covering hero, orbit, macro, silhouette, and cavity studies.

## Delivery order

1. Make download storage user-facing, configurable, and migration-safe.
2. Make all playback starts establish an explicit context and render the real Up Next queue.
3. Add deterministic tail refill and manual-override semantics.
4. Add early next-source preparation and verify end-of-track continuity.
5. Refine personal Discover using the same listening/context model.
6. Expand Soma's material, topology, and camera state space.
7. Prototype and measure new visual foundations before promoting either one.

## Milestone status

The first delivery step is implemented on `codex/visualizer-rebuild`:

- Fresh installs use the user's Music folder under `Mewsik`, with Downloads and private app data only as fallbacks when the platform has no Music folder.
- Settings exposes the exact destination with native Change, Show folder, and Use default actions.
- A destination change is captured per new job and never redirects an in-flight download.
- Existing AppData downloads stay exactly where they are and remain linked; the UI reports them without silently migrating or deleting them.
- Missing or disconnected files become a recoverable `missing` state, restore when the drive returns, and are reconciled for the selected recording at the playback boundary so an unavailable local copy falls back to its remote source.
- Normal Downloads polling is database-only. The explicit **Check files** action runs the potentially slow filesystem scan on a blocking worker, avoiding a route-load freeze on offline network paths.
- Same-title jobs reserve output names atomically, eliminating the prior check-then-overwrite race.

The backend-owned playback context and deterministic continuation milestone is also implemented, along with the shared discovery delivery foundation and Prism's performance/determinism prerequisite. The hosted snapshot is deployed and healthy; activating YouTube or Last.fm now requires the documented consent/attribution/approval gates, not merely adding credentials.

The next implementation work is true prepared-next/prebuffered handoff, Soma's absolute pixel ceiling and measured quality tiers, and then the bounded visual-foundation prototypes described above.

## Guardrails

- Do not label guessed data as live, trending, personalized, or related.
- Do not silently move or delete existing downloads.
- Do not let autoplay erase manual queue intent.
- Do not duplicate recommendation logic independently in each page.
- Do not add visual layers solely for complexity; every pass needs an artistic and performance justification.
- Desktop is the current implementation target, but paths, layouts, and state contracts should not block future mobile work.
