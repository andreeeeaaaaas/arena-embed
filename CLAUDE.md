# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Obsidian plugin Are.na Tools, id `arena-tools` (named 2026-10-24; earlier Are.na Viewer, Are.na Embed, then arenaview) that renders an Are.na channel as a live masonry image grid from an `arena` code block. Display-only: nothing is written to the vault.

`BRD.md` is the source of truth and overrides general conventions. Read it before changing behaviour. Locked Choices, Rules, and Not Doing are binding; if a decision isn't covered and is expensive to reverse, stop and ask, and update the BRD before coding against a changed decision.

## Commands

- `npm ci`: install dev dependencies
- `npm run build`: `tsc --noEmit` type check, then minified esbuild bundle to `main.js`
- `npm run dev`: esbuild watch mode with inline sourcemaps (no type check)

There is no linter and no test suite; the BRD rules out tests beyond manual checks on Mac and iPhone (see README "Manual verification").

## Release

Keep `version` in sync in `manifest.json` and `package.json`. Releases are `releases/arena-tools-<version>.zip` containing an `arena-tools/` folder with `main.js`, `manifest.json`, and `styles.css`, and a GitHub release `<version>` with those three files attached (`gh release create`). `main.js` and `releases/` are build output and gitignored.

## Architecture

- `src/main.ts`: plugin entry. Registers the `arena` code block processor, the "Embed channel" command (`InsertChannelModal`), and the token settings tab. Tracks live `ChannelEmbed`s so a token change can unload them and clear visible private content. `saveCount` rewrites only the block's `count:` line via `getSectionInfo` + `vault.process`, refusing if the block moved; a successful save makes Obsidian re-render the embed, so the embed first stores a `Snapshot` in `handoffs` (keyed by note, channel and count, 10s expiry) that the new instance restores without fetching.
- `src/channel.ts`: pure parsing. `parseEmbed` accepts one channel line (slug, URL, optionally prefixed `channel:`) plus optional `count:` (1–100; `per:` is a legacy alias). An explicit count switches the embed to Shuffle mode; otherwise Load more with 24 per page. `embedMarkdown` builds the block the modal inserts; the modal writes `width:` only when it differs from the Default width setting.
- `src/api.ts`: `ArenaClient`, a single instance shared by all embeds.
  - Cache key is `channel:page:per`; in-memory only, max 100 entries, FIFO eviction.
  - Concurrent identical requests share one promise via `pending`.
  - `generation` counter invalidates in-flight work when the token changes or the plugin unloads.
  - Public responses honour `Cache-Control` max-age; authenticated or `no-cache` responses always revalidate with `If-None-Match`. `no-store` is not cached.
  - A `429` sets `blockedUntil` from `X-RateLimit-Reset` and rejects all requests until then.
  - `shuffle()` samples random pages at `per=100` without replacement (swap map) and stops once enough previews are found or the `active()` callback reports the embed closed.
  - `hasPreview` / `safeImageUrl` gate which blocks render (Image, Link, Embed, Attachment; `state === 'available'`; https image URL).
- `src/embed.ts`: `ChannelEmbed` (`MarkdownRenderChild`). Owns toolbar, grid, status, and retry. Every async path checks `this.alive` after awaiting. Layout is manual absolute positioning via `layouts[view]`, recomputed by a `ResizeObserver`; tile size comes from `aspect_ratio` so there's no layout shift. Shuffle and Refresh both go through `replace()`: build incoming tiles hidden, decode their images (8s cap) while old tiles dim, fade old out, then stagger new in with a height transition. Shuffle embeds get a toolbar stepper (spinbutton): 300ms after stepping stops, `resize()` removes tail tiles or appends random unseen ones (masonry placement depends only on earlier tiles, so the rest don't move); 800ms later it saves the count.
- `src/layouts.ts`: one function per `view:` (`masonry`, `filmstrip`, `contact-sheet`, `pinboard`) that positions tiles absolutely and returns the grid height. Keep the invariant that a tile's position depends only on earlier tiles; incremental count changes rely on it. Pinboard randomness is seeded by block id so prints stay put; its tilt is a `--arena-tilt` custom property feeding the CSS `rotate` property, which composes with the WAAPI `transform` animations.
- Wide mode (`startWide` in `src/embed.ts`): widens the host (`.cm-embed-block` in Live Preview, the block element in Reading view), measuring the host itself with wide styles removed (Minimal makes `.cm-content` full width and narrows each block, so the parent width is wrong) and centring on the text column, via `--arena-wide-width` / `--arena-wide-shift` on `.arena-wide-host`, sized to the theme's `--line-width-wide` / `--max-width` (Minimal) via a hidden probe, else `WIDE_FACTOR` (1.2×) the text width, capped by `.markdown-preview-view` / `.cm-scroller`, like Obsidian's Bases embeds. All ResizeObserver work is deferred to the next frame to avoid observer loops.
- Pinboard dragging (`bindDragging`): offsets from layout position in `moved`, applied in `place()`, carried in `Snapshot`, cleared by `replace()`.
- `src/lightbox.ts`: `Lightbox`, a re-creation of Obsidian's internal image lightbox (not public API) using its `.lightbox*` classes, 200ms `cubic-bezier(0.4, 0, 0.22, 1)` timing and FLIP open/close from the tile. Keys go through `app.keymap.pushScope`. Opened via `EmbedHost.preview` (the plugin checks the click setting). Shows the cached `medium` image, swaps to `large` after `decode()`.
- `styles.css`: plain CSS with Obsidian variables; `.is-mobile` raises touch targets to 44px.

## Constraints that shape the code

- Network only via Obsidian `requestUrl`, never `fetch`/XHR. No Node or Electron APIs: it must run on iOS.
- Token only as `Authorization: Bearer` to `api.are.na`; never in errors or logs.
- Never write responses or images to `data.json` or the vault. `data.json` holds only the token (it syncs via iCloud).
- Fetch one page at a time on user action; no background enumeration or polling.
- Errors render inline in the block (`.arena-status`), not as notices.
- Don't add dependencies without asking.
