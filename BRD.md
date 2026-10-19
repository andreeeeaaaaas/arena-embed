# Are.na Embed

> An Obsidian plugin that renders an Are.na channel as a live image grid inside a note, for one person collecting visual references.

**Status:** Building
**Last updated:** 2026-10-19

## How to use this document

This BRD is the source of truth for what is being built. Where it conflicts with
general conventions, house style, or a CLAUDE.md in this repo, this document wins.

- Locked Choices are non-negotiable. Do not substitute, upgrade, or suggest
  alternatives unless explicitly asked.
- Rules apply across the whole codebase, without exception.
- Not Doing means not doing. Do not implement it, do not scaffold for it.
- If a decision is not covered here and would be expensive to reverse, stop and
  ask. Add it to Open Questions rather than assuming.
- Build one item from Scope at a time unless told otherwise.
- When a decision changes, update this document before writing code against it.

---

## 1. Overview

**The problem**
References get collected in Are.na, but notes live in Obsidian. Seeing a channel's references next to the thinking about them means switching apps or downloading images into the vault, which bloats it and goes stale.

**Who it's for**
A single user who collects visual references in Are.na (a mix of public and private channels) and writes in an Obsidian vault synced between a Mac and an iPhone via iCloud.

**What it does**
A fenced `arena` code block naming a channel renders that channel's contents as a masonry grid of images, hotlinked from Are.na's CDN. Nothing is written to the vault.

Example:

    ```arena
    https://www.are.na/username/visual-references-abc123
    ```

**Why not the existing option**
Existing Obsidian/Are.na plugins either import content into the vault or may target the older v2 API. This one is display-only, uses the v3 API, and must work on mobile. Also: wanting to build it.

**Done means**
On both Mac and iPhone, an `arena` block pointing at a private channel renders that channel's first page as an image grid. Public unauthenticated responses are reused while fresh. Authenticated responses are revalidated with ETags before reuse, respecting Cache-Control. Images and API responses are never written to the vault.

**Scope**
- `arena` code block processor accepting full channel URLs or slugs
- Native command to paste a channel URL, choose an optional image count, and insert an embed
- Count stepper in the embed toolbar for Shuffle embeds
- Settings tab (personal access token, wide embeds default, click behaviour)
- Masonry image grid (default view), plus filmstrip, contact sheet and pinboard views chosen per block with `view:`
- Per-device response cache
- "Load more" pagination
- Click-through on tiles: in-Obsidian preview by default, Are.na block page optional
- Error and empty states

---

## 2. Locked Choices

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript | |
| Framework | Obsidian Plugin API | Start from the official sample plugin template |
| Styling | Plain CSS in `styles.css` | Use Obsidian CSS variables so it follows the user's theme |
| State | In-memory cache, optionally device-local storage | Never `data.json`, never the vault |
| Data | Are.na REST API v3 (`https://api.are.na`) | `GET /v3/channels/{id}/contents` |
| Auth | Are.na personal access token, `read` scope | Stored in plugin settings; optional for public channels |
| Distribution | Manual install into `.obsidian/plugins/arena-embed/`, synced by iCloud | Source in a public GitHub repo (changed from private on 2026-10-20) |
| Package manager | npm | |

**Pinned versions**
- `manifest.json`: `isDesktopOnly: false`

---

## 3. Rules

**Always**
- Make network calls with Obsidian's `requestUrl`, never `fetch` or XHR.
- Send the token only as `Authorization: Bearer <token>`, and only to `api.are.na`.
- Fetch one page at a time; load further pages only when the user asks. An explicit Shuffle click may sample random pages until the requested preview count is met or the channel is exhausted; stop requests when the embed closes.
- On a `429`, stop requesting until `X-RateLimit-Reset` and show a clear message.
- Skip blocks with `state` other than `available` (e.g. `PendingBlock`).
- Revalidate cached responses using the `ETag` / `If-None-Match` headers. Respect response Cache-Control, deduplicate concurrent requests, and do not poll in the background.

**Never**
- Use Node or Electron APIs (`fs`, `path`, `electron`, etc.). It must run on iOS.
- Write API responses or images to `data.json` or anywhere in the vault. `data.json` syncs via iCloud and frequent writes cause conflict copies.
- Log, display, or include the token in error messages.
- Enumerate all pages at startup or in the background. Shuffle may inspect additional pages only in response to a user click, stopping as soon as enough previews are found.
- Install a dependency without asking. The user approved TypeScript, esbuild, Obsidian types, and Node types as development dependencies on 2026-10-19.

**Patterns**
- Use each image's `aspect_ratio` to reserve tile space before load (no layout shift).
- Use the `medium` image size for the grid and `src_2x` for high-DPI screens. The preview shows the cached `medium` first, then swaps to `large` once decoded.
- Error states are inline in the rendered block, not modal notices.

---

## 4. Not Doing

**Non-goals**
- Not a sync or import tool. Nothing from Are.na ends up in the vault.
- Not an Are.na client. No creating, editing, connecting, or commenting.
- Not an archive. Content is only available online.

**Out of scope**
- "Freeze channel to markdown" snapshot command
- Offline image caching or downloading
- Channel search is deferred until URL insertion works; the user has requested it as an alternative insertion flow.
- Publishing to the Obsidian community plugin store
- Tests beyond manual checks on Mac and iPhone

---

## 5. Open Questions

Flag and pause on these. Do not assume an answer.

- Render Image blocks and available preview images from Link, Embed, and Attachment blocks.
- Clicking a tile opens a lightbox that matches Obsidian's native image viewer (2026-10-20): same markup, classes, timing and grow-from-tile animation, the `large` image, the block title, no carousel controls; arrow keys step through the embed's images and wrap; Esc or a click outside the image closes it. Cmd/Ctrl-click, middle-click or the setting "Clicking an image: Opens Are.na" go to the block page instead.
- Cache policy: follow response Cache-Control; authenticated responses revalidate before reuse. Use memory only initially.
- Blocks accept a URL or slug, optionally prefixed with `channel:`, and an optional `count:` integer from 1 to 100 (`per:` is still read as a legacy alias). An explicit `count:` enables Shuffle, replacing the grid with up to that many random available previews. The dialog has an optional count; blank retains Load more with 24 items per page. Cache keys include page size. Default sorting and responsive columns remain.
- Shuffle embeds show a count stepper in the toolbar. A settled change adds or removes only the difference (new images are random and not already shown), then rewrites only that block's `count:` line in its own note, once. The re-render restores the images already shown instead of reloading. If the block can't be located, the count applies to the embed until the note is reopened.
- Views (chosen 2026-10-19): `masonry` (default), `filmstrip` (one horizontally scrolling row at a fixed height), `contact-sheet` (dense uniform square crops) and `pinboard` (loosely scattered, slightly rotated, overlapping prints, stable per block). Count means the number of images in every view. The insert dialog offers the view.
- Pinboard prints can be dragged (mouse immediately, touch after a short hold so swipes still scroll). Positions are session only: kept across count re-renders, lost when the note reopens or the grid is shuffled or refreshed. Never stored in the note or `data.json`.
- Wide layout (2026-10-19): a settings toggle, overridden per block by `width: wide` or `width: normal`, lets an embed extend past the readable line width, centred in the pane. It matches the theme's wide line width (`--line-width-wide`, capped by `--max-width`, as in Minimal), or 1.2× the text width when the theme has none (into the margins only on phones), mirroring Obsidian's Bases embeds. The setting is saved in `data.json`; it changes rarely.
- Shuffle and Refresh replace the grid with one transition: preload the new images while the current tiles dim, fade the old tiles out, then stagger the new tiles in.
- Channel input accepts a full Are.na URL, either alone or after `channel:`, as well as a slug.
- Use aspect-ratio placeholders without a BlurHash dependency.
- [ ] If the vault is also pushed to Git, `data.json` (holds the token) must be gitignored. Confirm.