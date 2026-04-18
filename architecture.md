# cs2-gamestate-app

A Counter-Strike 2 companion utility that uses Valve's Game State Integration (GSI) to surface contextual reference material — smoke lineups, flash setups, molotov placements, and HE grenade throws — on a second monitor (or via the Steam overlay browser) while the player is in-game.

The app reacts to live game state (map, team, round phase) and to hotkey-driven user intent ("show me A-site smokes on Mirage") without the user ever needing to alt-tab out of fullscreen CS2.

---

## 1. Goals

Build a lightweight, VAC-safe reference tool that:

- Passively ingests GSI data from CS2 to know what the player is currently doing (map, team, phase, round, player stats).
- Accepts user hotkey inputs to refine context (bomb site target, utility type).
- Displays the relevant lineup content (images, GIFs, optional video links) on a second display or via the Steam overlay browser.
- Does not reduce the player's in-game FPS by more than 15 FPS.
- Is fully compliant with Valve's Terms of Service and does not trigger VAC.
- Ships as a signed Windows installer that a non-technical user can double-click.

---

## 2. Hard Requirements

1. **Performance:** Must not reduce player FPS by more than 15 FPS. This rules out anything that injects into `cs2.exe` or runs a heavy Chromium instance in the foreground.
2. **Valve TOS compliance:** Read-only GSI consumption, no memory reading, no DLL injection, no overlay rendered inside the game process, no game file modification.
3. **Display assumption:** The user has either a second monitor or uses the Steam overlay web browser (Shift+Tab). No in-game overlay rendering.
4. **Windows only for v1.** CS2 runs on Linux via Proton, but the tooling, code-signing, and GSI config path handling are Windows-first. Cross-platform can come later.
5. **Offline-tolerant:** If the cloud CDN is unreachable, cached lineups must still work.

---

## 3. Architecture

### 3.1 High-level data flow

```
    ┌──────────────────┐
    │       CS2        │
    │  (fullscreen)    │
    └────────┬─────────┘
             │ HTTP POST (GSI payload, JSON)
             │ every game-state change
             ▼
    ┌──────────────────────────────────────────┐
    │         Local Desktop App (Tauri)        │
    │                                          │
    │  ┌────────────────┐   ┌───────────────┐  │
    │  │  Rust backend  │   │ React front-  │  │
    │  │  - HTTP server │◀─▶│ end (webview) │  │
    │  │  - State FSM   │   │ - Lineup UI   │  │
    │  │  - Hotkeys     │   │ - Settings    │  │
    │  │  - Asset cache │   │               │  │
    │  └───────┬────────┘   └───────────────┘  │
    │          │                               │
    └──────────┼───────────────────────────────┘
               │ HTTPS GET (manifest + assets)
               ▼
    ┌──────────────────────────────────────────┐
    │   Cloudflare R2 + CDN (static hosting)   │
    │   - manifest.json (versioned)            │
    │   - /lineups/<map>/<site>/<utility>/...  │
    │     (WebP + GIF/MP4 assets)              │
    └──────────────────────────────────────────┘
               ▲
               │ (deploy)
    ┌──────────┴───────────────────────────────┐
    │   Content repo (GitHub)                  │
    │   - Lineup metadata in YAML/JSON         │
    │   - Asset source files                   │
    │   - CI pipeline → R2                     │
    └──────────────────────────────────────────┘
```

### 3.2 Components

**CS2 GSI producer.** CS2 reads a `gamestate_integration_*.cfg` file at launch and POSTs JSON to the configured URL on every tracked state change. The app installer is responsible for writing this file into `...\Counter-Strike Global Offensive\game\csgo\cfg\` after detecting the Steam install path via the registry.

**Local app (Tauri).** Single Windows process hosting:
- An embedded HTTP server listening on a configurable high port (default: 42069) that accepts GSI POSTs.
- A finite state machine that folds GSI payloads into a normalized match state (`Idle → MainMenu → Warmup → Live → PostRound → Finished`).
- A global hotkey listener registered at the OS level (not injected into the game).
- A local filesystem cache for manifest and assets, keyed by content hash.
- A WebView2-hosted React UI that subscribes to state changes via Tauri's IPC bridge.

**Cloud content delivery.** No dynamic backend for v1. Lineup data is a versioned JSON manifest plus image/GIF assets hosted on Cloudflare R2 behind Cloudflare's CDN. The app fetches the manifest on startup, diffs against its cached version, and pre-warms any changed assets in the background.

**Content repo.** A public (or private) Git repo containing lineup metadata in YAML and source assets. A GitHub Actions pipeline validates the schema, generates optimized WebP/MP4 assets, writes a new versioned manifest, and uploads to R2. Community contributions arrive as PRs.

### 3.3 Input channels into the local app

| Source | Transport | Payload | Frequency |
|---|---|---|---|
| CS2 GSI | HTTP POST to `localhost:<port>` | JSON (map, phase, round, team, player stats) | Every state change, ~1–10/sec during live play |
| User hotkeys | OS global shortcut → in-process event | `{action: "select_site", value: "A"}` etc. | On keypress |
| Settings UI | In-process IPC from React | Config mutations | Rare |

### 3.4 State machine

GSI payloads are noisy and redundant. Rather than reacting to raw fields, the backend reduces them into explicit states:

```
Idle ──(app launch, no CS2)──▶
MainMenu ──(map loads, phase=warmup)──▶
Warmup ──(phase=live)──▶
Live ──(round ends)──▶
PostRound ──(next round starts)──▶ Live
        ──(match ends)──▶ Finished ──▶ MainMenu
```

The React UI subscribes to `(state, map, team, selectedSite, selectedUtility)` — not to raw GSI. This makes "player left match, reset view" a single transition instead of ad-hoc payload diffing.

### 3.5 Hotkey → lineup resolution

1. User presses a configured chord (e.g. `Ctrl+Alt+A` for A-site, `Ctrl+Alt+S` for smokes).
2. Hotkey listener emits an intent event into the state store.
3. Reducer combines it with the current map and team → lookup key `{map, team, site, utility}`.
4. Lookup checks local cache; on miss, fetches asset URLs from manifest, downloads, caches.
5. UI renders the resulting lineup set.

On map change, the app pre-fetches all four `(site × utility)` combinations for the current map and team so hotkey response feels instant.

---

## 4. Tech Stack

### 4.1 Chosen stack

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Tauri 2.x** | Uses the OS-native WebView2 instead of bundling Chromium. Final binary is ~5–10 MB vs Electron's ~150 MB; idle RAM is ~30–80 MB vs ~150–400 MB. This matters because the app runs alongside a performance-sensitive game and has a hard 15-FPS budget. |
| Backend language | **Rust** (Tauri's default) | Zero-overhead HTTP server, strong typing for GSI payloads via `serde`, negligible memory footprint. |
| Local HTTP server | **`axum`** | Small, well-maintained, async, trivial to stand up one POST endpoint. |
| UI framework | **React 18 + TypeScript** | Largest component ecosystem, strong typing, good fit for a state-driven UI. |
| Build tool | **Vite** | Fast dev loop, first-class Tauri integration. |
| Styling | **Tailwind CSS** | Rapid UI iteration, no CSS-in-JS runtime cost. |
| State management | **Zustand** | Minimal boilerplate, works well with Tauri IPC events. Redux is overkill here. |
| Global hotkeys | **`tauri-plugin-global-shortcut`** | OS-level registration, no process injection, user-remappable. Stored in a local TOML config. |
| Content hosting | **Cloudflare R2 + Cloudflare CDN** | No egress fees, ~$0.015/GB storage, cached at edge. |
| Content format | **WebP** for stills, **MP4 (H.264)** for motion clips, YouTube links as optional "full tutorial" secondary. | WebP is 25–35% smaller than PNG at equivalent quality; MP4 loops faster than animated GIF and is a fraction of the size. |
| Packaging | **`tauri build`** → signed MSI | Native Windows installer, built-in updater support. |
| Auto-update | **Tauri updater plugin** | Signed update manifests, delta updates. |
| Code signing | **Windows Authenticode cert** (DigiCert, SSL.com, etc.) | Without this, SmartScreen will scare users off. Budget $100–400/year. |
| Content repo CI | **GitHub Actions** | Validates YAML schema, optimizes assets, publishes manifest + assets to R2 on merge to main. |
| Telemetry (optional) | **PostHog** self-hosted or Plausible | Privacy-friendly, opt-in only. |

### 4.2 Considered but not chosen

These were in the original spec or are common defaults. They're documented here so future contributors don't re-propose them without knowing the tradeoffs.

#### Electron (original proposal)
**Rejected for v1.** Electron bundles its own Chromium, producing ~150 MB installers and idling at 150–400 MB RAM across multiple processes. For a tool running alongside a performance-sensitive game with a hard FPS budget, this is a meaningful cost.

That said, Electron is not disqualifying — its advantages are real: mature ecosystem, more Stack Overflow coverage, easier hiring, and behavior that's identical across Windows versions (whereas WebView2 has occasional Edge-version-specific quirks). If the team hits blocking Tauri issues, falling back to Electron is acceptable; the FPS budget should still be achievable with careful renderer optimization and by avoiding heavy animations. The React UI code is portable between the two.

#### Angular (original proposal)
**Rejected.** Larger bundle size than React, steeper learning curve, and the opinionated framework provides no benefit for an app of this size. The UI has maybe 15–20 components total. React + Zustand is the right weight class.

#### AutoHotkey for user hotkeys (original proposal)
**Rejected.** Three problems: (1) AHK scripts have a history of being flagged by anticheat-adjacent scanners, which creates user anxiety even when technically VAC-safe. (2) It forces users to install and configure a second tool outside our app, which hurts the "double-click installer, done" UX goal. (3) It puts hotkey remapping outside our app, so we can't provide conflict detection, visual configuration, or per-map profiles.

Tauri's global-shortcut plugin registers hotkeys at the same OS layer AHK uses (Windows' `RegisterHotKey` API), with zero anticheat ambiguity and full UX control.

#### Express.js for the local HTTP server
**Rejected.** Pulling in Express and its dependency tree to serve one POST endpoint is over-engineered. If we were on Node, the built-in `http` module would be enough; since we're on Rust via Tauri, `axum` is the natural choice.

#### Redux / Redux Toolkit
**Rejected.** State shape here is small: a single match-state object, a settings object, and a cache. Zustand handles this in ~30 lines. Redux's middleware/devtools benefits don't justify the boilerplate at this scale.

#### Storing full video files as blobs in our own DB
**Rejected.** Video storage is expensive to serve, and lineup content is inherently static. A CDN-backed static asset layout is cheaper, faster, and simpler. If we ever need per-user features (favorites, custom lineups), those go in a proper API — but the lineup assets themselves stay static.

#### YouTube embeds as the primary content source
**Rejected as primary, kept as secondary.** YouTube embeds break when creators delete videos, change privacy, or get channel-terminated — and we'd never know until a user reports it. Embed players also take seconds to load (bad UX for a quick-reference tool) and have spotty support inside the Steam overlay browser. Self-hosted WebP/MP4 assets load in <100 ms, loop cleanly, and we control the lifecycle.

YouTube links remain as an optional "watch the full tutorial" secondary action on each lineup, where maintenance burden is outsourced to the creator.

#### Port 3000 for the GSI listener (original proposal)
**Rejected.** Port 3000 collides with nearly every JavaScript dev server and several common tools. Default to a high, uncommon port (42069 as a placeholder) and make it user-configurable. When the user changes it, the app must regenerate the GSI `.cfg` file to match.

---

## 5. Cloud / Content Pipeline

### 5.1 Why no dynamic backend (for v1)

Lineup data for a given map is effectively read-only reference material. It doesn't change per-user, per-session, or per-request. A CDN serving versioned static assets is the correct primitive. Adding an API server means adding a thing that can go down, get DDoSed, need scaling, and incur egress fees — for no user-visible benefit.

A real backend becomes justified when (and only when) we add:
- User accounts and favorites
- Community-submitted lineups with moderation
- Telemetry-driven content ranking
- Paid tiers

None of those are v1.

### 5.2 Manifest structure

`manifest.json` is a single file, versioned by content hash, that describes every lineup:

```json
{
  "schema_version": 1,
  "generated_at": "2026-04-18T00:00:00Z",
  "maps": {
    "de_mirage": {
      "sites": {
        "a": {
          "smokes": [
            {
              "id": "mirage-a-stairs-ct",
              "team": "ct",
              "name": "Stairs smoke from spawn",
              "description": "...",
              "thumbnail": "lineups/de_mirage/a/smokes/stairs-ct/thumb.webp",
              "steps": [
                { "type": "image", "url": "lineups/.../step1.webp", "caption": "..." },
                { "type": "clip",  "url": "lineups/.../throw.mp4",  "caption": "..." }
              ],
              "youtube": "https://youtube.com/watch?v=..."
            }
          ],
          "flashes": [ ... ],
          "molotovs": [ ... ],
          "hes": [ ... ]
        },
        "b": { ... }
      }
    }
  }
}
```

### 5.3 Content update pipeline

1. Contributor opens a PR to the content repo with new lineup YAML + source assets.
2. GitHub Actions validates schema, optimizes images to WebP, transcodes clips to MP4, generates thumbnails.
3. On merge to `main`, CI builds a new manifest with a fresh version string and uploads the full tree to R2.
4. Clients poll the manifest URL on startup (and optionally every N hours). On version change, they diff and pre-warm new/changed assets.

### 5.4 Cache strategy

- Assets are cached in the app's local data directory, keyed by SHA-256 of the content.
- LRU eviction once cache exceeds a configurable ceiling (default 500 MB).
- Manifest is cached with an ETag; on startup the app does a conditional GET.
- If CDN is unreachable, the last-known manifest and cached assets continue to work — offline mode is implicit.

---

## 6. GSI Configuration

The app must write a file like this into `...\Counter-Strike Global Offensive\game\csgo\cfg\gamestate_integration_cs2app.cfg`:

```
"cs2-gamestate-app"
{
    "uri"     "http://127.0.0.1:42069"
    "timeout" "5.0"
    "buffer"  "0.1"
    "throttle" "0.1"
    "heartbeat" "10.0"
    "auth"
    {
        "token" "<random-per-install-token>"
    }
    "data"
    {
        "provider"            "1"
        "map"                 "1"
        "round"               "1"
        "player_id"           "1"
        "player_state"        "1"
        "player_match_stats"  "1"
        "allplayers_id"       "0"
        "allplayers_state"    "0"
    }
}
```

Notes:
- `auth.token` is a per-install random value. The local HTTP server rejects POSTs without it, preventing other local processes from spoofing CS2.
- `allplayers_*` is intentionally disabled. Reading the full-team data stream is available only to spectators/observers in official play, and we don't need it for lineup selection. This keeps the request payload small and the feature set obviously non-competitive-advantage.
- Steam install path is resolved via `HKEY_CURRENT_USER\Software\Valve\Steam` → `SteamPath`, then scanning `libraryfolders.vdf` for the CS2 app (ID 730).

---

## 7. Security & TOS

### 7.1 VAC safety — what we do and don't do

**We do:**
- Run an HTTP server on localhost that receives GSI POSTs (officially supported by Valve).
- Register OS-level global hotkeys via `RegisterHotKey`.
- Render our UI in a separate window on a separate display (or via Steam's own overlay browser).

**We explicitly do not:**
- Read CS2 process memory.
- Inject DLLs into CS2.
- Hook DirectX or render any overlay inside the CS2 process.
- Modify any game files (other than writing our own GSI `.cfg`, which is the sanctioned mechanism).
- Automate in-game inputs.

### 7.2 Scope discipline

To stay clearly on the right side of Valve's tolerance, the feature set is restricted to *reference material triggered by user intent*. Specifically, we do not:
- React to enemy positions (we don't have them and wouldn't use them).
- Provide any real-time tactical guidance derived from opponent behavior.
- Auto-trigger lineups based on game state alone — the user always initiates with a hotkey.

This keeps the tool in the same category as existing accepted tools (stats trackers, HUD overlays, crosshair generators).

### 7.3 Local server hardening

- Bind to `127.0.0.1` only, never `0.0.0.0`.
- Require the auth token on every POST.
- Validate payload shape with `serde` before any state transition; drop malformed payloads silently.
- Rate-limit to a sane ceiling (e.g. 100 req/sec) to contain runaway clients.

### 7.4 Cloud auth (future)

For v1 there is no user auth — the CDN is public read-only, and there's nothing user-specific to protect. If and when we add accounts:
- Short-lived JWT access tokens, longer-lived refresh tokens.
- Tokens stored in the OS credential store (Windows Credential Manager via `keyring` crate), never in plain files.
- All traffic HTTPS, certificate-pinned in the client.

---

## 8. Performance Budget

The 15-FPS hard requirement drives several choices:

| Constraint | Mitigation |
|---|---|
| No Chromium co-process | Tauri uses WebView2 (already loaded by many Windows apps). |
| Idle CPU ≈ 0 | State machine is event-driven; no polling loops. Hotkey listener blocks on OS events. |
| Idle RAM ≤ 100 MB | Rust backend ~10 MB, WebView2 ~50–80 MB. |
| No stutter on GSI payload | Payloads are small (<5 KB), parsed async, pushed to UI via IPC batched at animation-frame rate. |
| No stutter on asset fetch | All fetches off the main thread; UI renders a placeholder until bytes land. |
| Second-monitor rendering | Keep animations minimal (no constant-motion backgrounds); target 60 FPS on the UI monitor without pegging the GPU. |

Measurement: include a debug build mode that logs frame times and GSI-to-render latency, and benchmark against a reference CS2 session before any release.

---

## 9. Steam Overlay Browser Support (stretch)

Users without a second monitor would access the app via Shift+Tab → Steam's built-in browser. This path has caveats:

- Steam's overlay browser is a stripped-down Chromium with no access to local files or localhost by default (it can reach localhost if the user enables it, but this is fiddly).
- IPC-based state updates don't work there — the overlay is loading a URL, not running inside Tauri.

To support this properly, v2 would add a local HTTP UI server (served by the same Tauri backend) exposing a minimal web UI at e.g. `http://127.0.0.1:42070`. The user would bookmark this URL in their Steam browser. The overlay-UI subset can be simpler than the full desktop UI.

For v1, ship second-monitor-only and note the limitation.

---

## 10. Packaging, Updates, Distribution

- **Installer:** Signed MSI produced by `tauri build`. Installer detects Steam path, writes GSI config, creates Start Menu shortcut, registers auto-start (opt-in).
- **First run:** Wizard confirms Steam/CS2 path, generates GSI token, writes `.cfg`, tests the GSI pipeline by asking the user to briefly launch CS2 and load any map.
- **Updates:** Tauri's updater plugin checks a signed update manifest on launch. Delta updates for the binary; manifest/asset updates happen independently via the content pipeline.
- **Uninstall:** Removes the GSI `.cfg` it wrote, clears local cache, leaves user settings intact unless the user opts in to full removal.
- **Distribution:** Direct download from project website; GitHub Releases as mirror. Not submitting to Microsoft Store for v1 (adds review friction for niche audience).

---

## 11. Development-mode Hardening

For production builds:
- `devtools: false` in Tauri config.
- Vite minifies and tree-shakes the renderer bundle.
- Rust backend compiled with `--release`; debug symbols stripped.
- No verbose logging in release; logs are opt-in via a flag or settings toggle.
- Error reporting (if enabled) scrubs paths, tokens, and Steam IDs before sending.

This is about hygiene, not security-through-obscurity — the GSI auth token is the actual defense against local spoofing.

---

## 12. Open Questions / Decisions to Revisit

- **Linux support:** Proton-running CS2 users exist. Tauri supports Linux; the blockers are GSI config path detection and installer format (AppImage vs .deb vs Flatpak). Defer to post-v1.
- **Content moderation:** If we accept community PRs, who reviews for accuracy? Start with a small maintainer group; consider a reputation system later.
- **Monetization:** None planned for v1. If introduced, it must not gate VAC-safety-critical code paths — freemium is fine, but the core tool stays free and transparent.
- **Telemetry:** Strongly prefer opt-in. "Which maps are most used" would help content prioritization but is not worth the trust cost of doing it silently.
- **Per-map hotkey profiles:** Nice-to-have for v2. Some players want different bindings on Mirage vs Inferno.

---

## 13. Rough Build Order

1. **Spike (1–2 weeks):** Tauri + React skeleton, `axum` HTTP listener, hardcoded fake GSI payloads, render a static lineup card. Prove the FPS impact is within budget on a real CS2 session.
2. **GSI integration:** Real config writer, Steam path detection, state machine, end-to-end live GSI → UI update.
3. **Hotkeys + intent:** Global shortcut plugin, settings UI for remapping, intent reducer.
4. **Content pipeline:** Content repo, schema, GitHub Actions, R2 upload, initial Mirage dataset (seed content).
5. **Cache + offline:** Filesystem cache, manifest diffing, pre-warm logic.
6. **Packaging:** MSI build, code signing, auto-update wiring, installer UX.
7. **Beta:** Closed beta with ~20 users, measure FPS impact in the wild, iterate.
8. **Public v1:** Public release with Mirage, Inferno, Dust II, Ancient, Nuke lineups. Other maps follow via content pipeline.