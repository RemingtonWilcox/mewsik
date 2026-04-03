# Mewsik UI Polish — Design Spec

**Date:** 2026-04-02
**Goal:** Fix mechanical UI bugs (overflow, padding, toast overlap) and elevate visual quality to a consistent, professional standard inspired by Spotify's desktop app.
**Scope:** Frontend only — CSS, Svelte components, layout. No backend/Rust changes.

---

## 1. Player Bar — Spotify-Style Refinement

**Files:** `src/lib/components/player/player-bar.svelte`, `src/lib/components/player/waveform-scrubber.svelte`, `src/app.css`

### Changes

- **Height:** 80px → 88px (`h-20` → `h-22` or explicit `h-[88px]`)
- **Background:** Lift from body background to create visual separation. Change from `bg-background/95` to a new lifted surface color ~`oklch(0.18 0.005 285)` with `backdrop-blur-sm` retained. Add subtle top shadow: `shadow-[0_-4px_24px_rgba(0,0,0,0.3)]`
- **Grid:** Keep 3-column grid but widen center max: `grid-cols-[minmax(0,1fr)_minmax(18rem,40rem)_auto]`
- **Album art:** 48px → 56px (`size-12` → `size-14`)
- **Track text:** Add `gap-0.5` between title and artist for breathing room
- **Remove status labels:** Delete the entire status text block ("Waveform seek", "Progress only", "Seek enabled", "Analyzing waveform"). The waveform/progress bar is self-explanatory. Keep "Live Radio" / "Connecting" / "Buffering" states as they're functional.
- **Volume slider:** Ensure visible track background (addressed in section 4)

### Waveform Scrubber

- **Brighter active peaks:** Change from `bg-primary` to `bg-primary` with added `shadow-[0_0_6px_rgba(74,222,128,0.25)]` (stronger glow)
- **More visible inactive peaks:** `bg-foreground/18` → `bg-foreground/25`
- **Scrubber container:** Increase background from `bg-muted/30` → `bg-muted/50` for more definition against the lifted player bar
- **Border:** `border-border/70` → `border-border` (full opacity)

---

## 2. Global Overflow & Padding Fixes

**Files:** `src/routes/+layout.svelte`, `src/routes/search/+page.svelte`, `src/lib/components/library/track-table.svelte`, `src/routes/stations/+page.svelte`

### Layout Container

- Main content area: Add `overflow-hidden` to the parent flex container and ensure `min-w-0` on the SidebarInset content area so flex children can't expand past viewport
- Keep `p-4 pb-24` (padding is fine, the issue is overflow not padding amount)

### Track Table (`track-table.svelte`)

- Wrap table in `overflow-hidden` container (not `overflow-auto` — we want truncation, not scrolling)
- Add `table-fixed` to `Table.Root` so columns respect width constraints
- **Title column:** Already has `truncate` — ensure parent cell has `min-w-0` and no fixed width so it gets remaining space
- **Artist column:** Replace `max-w-[220px] truncate` with a proportional approach: add `w-[18%]` to the `Table.Head` and keep `truncate` on content
- **Album column:** Same treatment as artist: `w-[18%]` + `truncate`
- **Duration column:** Keep `w-20 text-right`
- **Play button column:** Keep `w-12`
- **Actions column (playlist view):** Keep `w-32`
- Title cell inner div: ensure `min-w-0 flex-1` so flex+truncate works

### External Search Table (`search/+page.svelte`)

- Same `table-fixed` treatment
- **Source column:** `w-24` (badge only)
- **Title column:** No fixed width — gets remaining space. Inner div already has `min-w-0` + `truncate`
- **Artist column:** `w-[18%]` + `truncate` (replace `max-w-[220px]`)
- **Duration column:** Keep `w-20`
- **Actions column:** `w-28` (3 icon buttons at size-7 + gaps)
- Ensure the outer `<div class="flex flex-col gap-4">` has `min-w-0` or `overflow-hidden`

### Sidebar

- Playlist names in `app-sidebar.svelte` already get truncation via `SidebarMenuButton`'s `[&>span:last-child]:truncate`. No change needed — verified this works.

---

## 3. Radio Browser — Hybrid Layout

**File:** `src/routes/stations/+page.svelte`

### Favorites Section (when no search query)

Replace the vertical card list with a horizontal scrollable row:

```
<div class="flex gap-3 overflow-x-auto pb-2">  <!-- horizontal scroll -->
  {#each favorites as station}
    <button class="flex w-36 shrink-0 flex-col items-center gap-2 rounded-xl border border-border bg-card p-3 transition hover:border-primary/50 hover:bg-muted/50">
      <!-- Favicon 48px with play overlay on hover -->
      <!-- Station name (truncate, centered) -->
      <!-- Metadata line: country · codec (small, muted) -->
    </button>
  {/each}
</div>
```

- Card width: `w-36` (144px), `shrink-0`
- Favicon: 48px with rounded-lg, play button overlay on hover (absolute positioned, bg-black/50)
- Station name: `text-xs font-medium truncate max-w-full text-center`
- Meta line: `text-[11px] text-muted-foreground` with country · codec joined by separator
- Active station: primary border glow + "Live" indicator
- Remove favorite button: small X or heart-off icon in top-right corner on hover
- Scrollbar: use `scrollbar-thin` or hide with `no-scrollbar` class

### Search Results

Keep as a list but improve visual hierarchy:

- Favicon size: 32px → 40px (`size-8` → `size-10`)
- Replace badge soup with inline text: `{country} · {codec} · {bitrate}kbps` as a single `text-xs text-muted-foreground` line
- Active station indicator: pulsing primary-colored dot instead of just text
- Card border: add `hover:border-border/80` transition
- Keep the save-to-favorites heart button

---

## 4. Visual Polish & Contrast

**Files:** `src/app.css`, slider component, various

### Slider Tracks (Volume + any other sliders)

The shadcn Slider component's track uses `bg-muted` (`oklch(0.25)`) which is nearly identical to the background (`oklch(0.145)`) and player bar surface (`oklch(0.18)`), making sliders invisible. Fix in `src/lib/components/ui/slider/slider.svelte` line 43:

- Track background: change `bg-muted` → `bg-foreground/20` on the `slider-track` span
- Range fill: keep `bg-primary` (already visible)
- Thumb: already uses `bg-white border-ring` — adequate contrast, no change needed

### Border Definition

- `--color-border`: `oklch(0.3 0.005 285)` → `oklch(0.33 0.005 285)` — subtle bump for more definition between cards/sections

### Card Hover States

- Add `hover:border-border` (from the slightly-transparent default to full opacity) on interactive cards throughout the app

### Icon Button Consistency

- Audit all icon buttons for consistent sizing: `size-8` for standard, `size-7` for compact (table rows)
- Ensure all ghost icon buttons have visible hover background: `hover:bg-muted`

### Scrollbar Firefox Support

Add to `app.css` alongside existing webkit scrollbar styles:

```css
* {
  scrollbar-width: thin;
  scrollbar-color: oklch(0.35 0 0) transparent;
}
```

### Toast Positioning

In `+layout.svelte` or the Sonner configuration, set the toast position to render above the player bar:

- Add `position="bottom-right"` with `offset="104px"` (88px player + 16px gap) to the `<Toaster>` component
- Or use `className` / `style` to set `bottom: 104px`

---

## 5. Summary of Files to Modify

| File | Changes |
|------|---------|
| `src/app.css` | Border color bump, Firefox scrollbar, player bar surface color |
| `src/routes/+layout.svelte` | Toast offset, overflow containment on content area |
| `src/lib/components/player/player-bar.svelte` | Height, background, grid widths, album art size, remove status labels |
| `src/lib/components/player/waveform-scrubber.svelte` | Brighter peaks, more visible inactive peaks, container background |
| `src/routes/stations/+page.svelte` | Horizontal favorites row, cleaner search result cards |
| `src/routes/search/+page.svelte` | Table-fixed layout, proportional column widths, overflow containment |
| `src/lib/components/library/track-table.svelte` | Table-fixed layout, proportional column widths |
| `src/lib/components/ui/slider/` | Track visibility fix if needed |
| `src/lib/components/ui/sonner/sonner.svelte` | Toast offset positioning |

## 6. What Stays the Same

- Overall app structure (sidebar + content + bottom player)
- Color palette hue (teal/green primary accent)
- Component library (shadcn/ui primitives)
- All existing functionality — playback, search, radio, playlists, queue
- Sidebar navigation structure
- Keyboard shortcuts
