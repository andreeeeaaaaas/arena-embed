# Are.na Embed

An Obsidian plugin that displays an Are.na channel as a live masonry image grid. Image, Link, Embed, and Attachment blocks appear when they have an available preview image. Images remain remote; the plugin creates no vault attachments.

## Build

Requires Node.js and npm for development only. The plugin runtime uses no Node or Electron APIs.

```sh
npm ci
npm run build
```

The TypeScript and esbuild setup is adapted from the [official Obsidian sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin). There are no additional runtime libraries.

## Install

Copy `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/arena-embed/` directory. Reload Obsidian and enable **Are.na Embed** in Community plugins. The release ZIP contains the `arena-embed/` folder ready to copy.

For a private channel, open the plugin settings, paste an Are.na personal access token with `read` scope, and click **Save**. The token is saved in the plugin's `data.json`. If your vault is versioned in Git, add `.obsidian/plugins/arena-embed/data.json` to the vault's `.gitignore` before entering a token. The source repository's ignore rule does not change your vault's Git configuration.

When the plugin folder syncs to iPhone through iCloud, enable it there too if necessary.

## Embed a channel

Run **Are.na Embed: Embed channel** from the command palette, paste a channel URL, optionally set a **Count** (1–100) and **View**, and select **Insert embed**. Or enter a block directly:

````markdown
```arena
channel: https://www.are.na/username/channel-slug
count: 6
view: filmstrip
```
````

A bare slug or `channel: channel-slug` also works. `count:`, `view:` and `width:` are optional. `per:` is still read as an older name for `count:`. Full URLs must identify a channel, not a profile or individual block.

An explicit `count:` sets the initial page size and enables **Shuffle**, plus a **− count +** stepper in the toolbar. Press to step, hold to repeat, or focus the number and use the arrow keys (Page Up/Down steps by 10). When you stop, only the difference changes: fewer removes images from the end, more adds random images not already shown, and the rest stay where they are. Shortly after, the stepper rewrites the block's `count:` line in the note; the re-rendered embed keeps the same images. If the block can't be located, for example in a hover preview, the new count applies only until the note is reopened.

Each Shuffle click replaces the grid with up to that many random available previews. Shuffle samples random pages, fetching more only when needed to fill the count. If the channel contains fewer previews, it shows those. Repeated shuffles may include images seen before.

Without `count:`, the embed uses **Load more** with 24 channel items per page. Leave the dialog’s count blank for that behavior. The initial page may contain fewer previews than requested when some items have no image.

The first page loads automatically. For embeds without `count:`, **Load more** requests one additional page; pages without preview images do not trigger further requests. Clicking a tile opens it in a lightbox that works like Obsidian's own image viewer: the image grows out of its tile, the left and right arrow keys move between the embed's images, and Esc or a click outside the image closes it. Cmd-click (Ctrl-click on Windows) opens the Are.na block page instead; set **Clicking an image** to **Opens Are.na** in settings to make that the default. **Refresh** restarts at the first page. Shuffle and Refresh keep the current images visible, dimmed, until the new ones have loaded, then fade the old tiles out and stagger the new ones in. With Reduce Motion on, this is a short fade. The grid resizes to the note width.

## Views

- `masonry` (default): columns of uncropped images.
- `filmstrip`: one row at a fixed height that scrolls sideways and snaps to images. Keeps the embed short in a note.
- `contact-sheet`: a dense grid of square crops for scanning.
- `pinboard`: overlapping, slightly tilted prints. Each image keeps its place and tilt across renders; hovering or focusing one straightens it and brings it to the front. Drag prints to rearrange them (on touch, hold briefly first). Moved positions last until you reopen the note, Shuffle or Refresh.

## Wide embeds

Turn on **Wide embeds** in settings to let every embed extend past Obsidian's readable line width, centred in the note pane. With the Minimal theme it matches Minimal's **wide line width** setting, like wide images and tables; with other themes it is 20% wider than the text. Wider embeds can fit an extra column and take less height. On phones they extend only into the side margins. Add `width: wide` or `width: normal` to a block to override the setting for that embed.

## Cache behavior

- Channel responses stay in memory, separately on each device, with at most 100 cached pages. Closing Obsidian or disabling the plugin clears them.
- Public requests without a token reuse fresh responses according to `Cache-Control`. Authenticated requests revalidate before reuse using `ETag` / `If-None-Match`.
- A `304` response reuses existing channel data but still counts as an API request.
- Identical simultaneous requests share one request. There is no background polling.
- A rate-limit response pauses new requests until Are.na's reset time. Retry is manual.
- Images load directly from their remote URLs. The webview may use its ordinary image cache outside the vault; the plugin does not provide offline storage.

## Current scope

URL insertion, optional shuffle count with toolbar stepper, settings, four views, pagination, click-through, memory caching, and inline errors are implemented. Native search through your own channels is deferred to a later pass.

## Manual verification

Completed during development: TypeScript and production build, public v3 response inspection, and headless Chrome layout checks using the renderer with a minimal Obsidian shim and a real public API response.

Still required in actual Obsidian on Mac and iPhone:

- Insert a URL in Reading view and Live Preview; reopen the note.
- Set a token and open a private channel.
- Check ETag revalidation and request sharing for two identical embeds.
- Load more, refresh, and open a tile.
- Check invalid token, missing channel, offline, and rate-limit states.
- Confirm no images or response files are written to the vault.
- Confirm plugin installation and settings sync through iCloud.

Headless Chrome checks do not establish compatibility with iOS WebKit or Obsidian's rendering lifecycle.
