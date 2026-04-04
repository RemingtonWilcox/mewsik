<p align="center">
  <img src="src-tauri/icons/mewsik-logo.svg" width="128" height="128" alt="mewsik logo">
</p>

<h1 align="center">mewsik</h1>

<p align="center">
  A free, open-source desktop music player that searches and plays music from YouTube, SoundCloud, and Bandcamp in one place. Built with Tauri, Svelte, and Rust.
</p>

<p align="center">
  <a href="https://github.com/RemingtonWilcox/mewsik/releases/latest">Download for macOS</a>
</p>

---

## Features

- **Search everything at once** - YouTube, SoundCloud, and Bandcamp results in a single search
- **Stream instantly** - Click a song and it plays, no account needed
- **Build your library** - Save songs to your library, download for offline playback
- **Radio stations** - Browse 30,000+ internet radio stations by genre
- **Discover** - Listening stats, recently played, and personalized recommendations
- **Playlists** - Create and manage playlists from any source
- **Keyboard shortcuts** - `Cmd+K` for quick search, `Space` for play/pause

## Screenshot

<img src="docs/screenshot.png" alt="mewsik screenshot" width="800">

## Install

### macOS (Apple Silicon)

Download the latest `.dmg` from the [Releases page](https://github.com/RemingtonWilcox/mewsik/releases/latest):

**[mewsik_0.1.0_aarch64.dmg](https://github.com/RemingtonWilcox/mewsik/releases/download/v0.1.0/mewsik_0.1.0_aarch64.dmg)**

1. Download the `.dmg`
2. Open it and drag **mewsik** to your Applications folder
3. On first launch, macOS may block it - right-click the app and select **Open**, then click **Open** in the dialog

> **Note:** This release is for Apple Silicon Macs (M1/M2/M3/M4). Intel Mac and Windows support coming soon.

### Build from Source

#### Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [pnpm](https://pnpm.io/) v9+
- [Rust](https://rustup.rs/) (latest stable)
- macOS: Xcode Command Line Tools (`xcode-select --install`)

#### Steps

```bash
# Clone the repo
git clone https://github.com/RemingtonWilcox/mewsik.git
cd mewsik

# Install dependencies
pnpm install

# Run in development mode
pnpm tauri:dev

# Build for production
pnpm tauri:build
```

The built app will be at `src-tauri/target/release/bundle/macos/mewsik.app` and the installer DMG at `src-tauri/target/release/bundle/dmg/`.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Desktop framework** | [Tauri v2](https://tauri.app/) |
| **Frontend** | [Svelte 5](https://svelte.dev/) + [SvelteKit](https://kit.svelte.dev/) |
| **UI components** | [shadcn-svelte](https://shadcn-svelte.com/) + [Tailwind CSS v4](https://tailwindcss.com/) |
| **Backend** | Rust (Tauri commands) |
| **Audio engine** | [rodio](https://github.com/RustAudio/rodio) + [Symphonia](https://github.com/pdeljanov/Symphonia) |
| **Database** | SQLite via [rusqlite](https://github.com/rusqlite/rusqlite) |
| **External sources** | Node.js sidecar with [youtubei.js](https://github.com/LuanRT/YouTube.js), [soundcloud-fetch](https://github.com/patrickkfkan/soundcloud-fetch), [bandcamp-fetch](https://github.com/patrickkfkan/bandcamp-fetch) |

## Project Structure

```
mewsik/
  src/                    # Svelte frontend
    routes/               # Pages (library, search, stations, etc.)
    lib/
      components/         # UI components
      state/              # Svelte stores (player, library, search)
      api/                # Tauri command bindings
  src-tauri/              # Rust backend
    src/
      audio/              # Audio engine (playback, streaming, buffering)
      commands/           # Tauri commands (search, playback, downloads)
      sources/            # External source providers + sidecar manager
      db/                 # SQLite database (models, queries, migrations)
      download/           # Download manager
  sidecar/                # Node.js sidecar for external sources
    src/
      providers/          # YouTube, SoundCloud, Bandcamp providers
```

## How It Works

mewsik runs a Rust backend with a Svelte frontend inside a Tauri window. For external music sources (YouTube, SoundCloud, Bandcamp), a Node.js sidecar process handles search and stream URL resolution via provider-specific libraries. The Rust audio engine streams audio via HTTP, buffers it to a temp file, and decodes with Symphonia. All metadata and library state is stored in a local SQLite database.

## Contributing

Contributions are welcome. The app is actively in development - check the [issues](https://github.com/RemingtonWilcox/mewsik/issues) for open tasks.

## License

MIT
