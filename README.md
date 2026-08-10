# Fast Giphy

A macOS menu bar app for searching GIFs. Click the tray icon, type a query, click a GIF, and the link lands on your clipboard.

Built with [Tauri 2](https://tauri.app) — a Rust backend plus the system WebKit view, so the bundle is a few MB instead of the ~250MB an Electron build costs.

## Requirements

- Rust (`asdf set rust 1.96.0`, or rustup)
- Xcode Command Line Tools
- Node, for the Tauri CLI and the icon generator

## Run

```bash
npm install
npm run dev
```

On first launch, paste a Giphy API key (free at https://developers.giphy.com — create an app, choose the API option, not SDK). The key is stored in `~/Library/Application Support/com.fastgiphy.app/config.json`.

## Install for real

```bash
npm run build
```

Produces `src-tauri/target/release/bundle/macos/Fast Giphy.app` and a `.dmg` alongside it. Drag the `.app` to `/Applications`, then add it under System Settings → General → Login Items so it starts with the machine. Locally built apps carry no quarantine flag, so it opens on a normal double-click.

## Usage

- **Click the menu bar icon** — opens the popup below the icon; click again or press `Esc` to close. It also hides when it loses focus.
- **Type to search** — 350ms debounce; an empty query shows trending GIFs.
- **Click a GIF** — copies the direct `.gif` URL and closes the popup.
- **Shift-click a GIF** — copies the Giphy page URL instead.
- **⚙** — change the API key or quit.

## Layout

```
src/                  frontend: plain HTML/CSS/JS, no bundler
src-tauri/src/lib.rs  tray, popup positioning, config, clipboard commands
src-tauri/icons/      generated — do not edit by hand
scripts/gen-icons.mjs draws the icons from code (SDF rasterizer + PNG encoder)
```

Icons are generated, not committed as hand-made art: `node scripts/gen-icons.mjs` redraws every size, including the `.icns`.

## Implementation notes

- Results render in a 2-column grid with unlimited rows. Pages of 24 load via an `IntersectionObserver` on a sentinel 400px ahead of the scroll position, so only what you scroll toward is fetched.
- Thumbnails use Giphy's `fixed_width_downsampled` render (~200px wide, reduced frame count) and `loading="lazy"`. The full-resolution URL is only ever copied, never loaded.
- Each `img` gets explicit `width`/`height` from the API so the grid doesn't reflow as GIFs arrive.
- A generation counter invalidates in-flight requests when the query changes, so a slow response from an old search is discarded rather than appended.
- The popup is positioned from the tray icon's rect, converted to physical pixels via the window's scale factor and clamped to the monitor so it can't run off a display edge.
- The frontend has no Rust access beyond five explicit commands (`get_config`, `set_config`, `copy_text`, `hide_window`, `quit_app`). The capability file grants only `clipboard-manager:allow-write-text` — the app can write the clipboard but never read it. A CSP restricts network access to `api.giphy.com` and images to `*.giphy.com`.
- `macOSPrivateApi` is on, which the transparent/blurred popup requires. That rules out Mac App Store distribution but is irrelevant for a locally built app.
