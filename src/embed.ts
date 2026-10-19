import { MarkdownRenderChild, setIcon } from 'obsidian';
import { ArenaClient, ArenaError, hasPreview, safeImageUrl, type Block } from './api';
import type { EmbedOptions } from './channel';
import { layouts, type Tile, type View } from './layouts';

// What the embed needs from the plugin.
export interface EmbedHost {
  saveCount(count: number, snapshot: Snapshot): Promise<boolean>;
  // Opens the lightbox; false means clicks should follow the link.
  preview(items: { block: Block; element: HTMLElement }[], index: number): boolean;
}

export interface Snapshot { blocks: Block[]; total: number; scroll: number; moved: [id: number, x: number, y: number, z: number][] }
interface Moved { x: number; y: number; z: number }

const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const EASE_IN = 'cubic-bezier(0.55, 0, 1, 0.45)';
const MIN_COUNT = 1;
const MAX_COUNT = 100;
// Without a theme wide line width, wide embeds grow to this multiple of the text width.
const WIDE_FACTOR = 1.2;

export class ChannelEmbed extends MarkdownRenderChild {
  private alive = false;
  private busy = false;
  private nextPage: number | null = 1;
  private tiles: Tile[] = [];
  private ids = new Set<number>();
  private grid!: HTMLElement;
  private animations = new Set<Animation>();
  private finishImageWait?: () => void;
  private status!: HTMLElement;
  private more!: HTMLButtonElement;
  private refresh!: HTMLButtonElement;
  private retry!: HTMLButtonElement;
  private loadingStatus!: HTMLElement;
  private countValue?: HTMLElement;
  private fewer?: HTMLButtonElement;
  private moreImages?: HTMLButtonElement;
  private applyTimer?: number;
  private saveTimer?: number;
  private savedCount?: number;
  private failedPage = 1;
  private failedRefresh = false;
  private failedShuffle = false;
  private total = 0;
  private per: number;
  private shuffleMode: boolean;
  private channel: string;
  private count?: number;
  private view: View;
  // Pinboard prints the user dragged, as offsets from their layout position. Session only.
  private moved = new Map<number, Moved>();
  private width?: 'wide' | 'normal';
  private wide = false;
  private stopWide?: () => void;
  private topZ = 1;

  constructor(
    container: HTMLElement, private client: ArenaClient, options: EmbedOptions,
    private host: EmbedHost, private initial?: Snapshot,
  ) {
    super(container);
    this.channel = options.channel;
    this.count = this.savedCount = options.count;
    this.view = options.view;
    this.width = options.width;
    this.per = options.count ?? 24;
    this.shuffleMode = options.count !== undefined;
  }

  onload(): void {
    this.alive = true;
    this.containerEl.empty();
    this.containerEl.addClass('arena-embed', `arena-view-${this.view}`);
    const toolbar = this.containerEl.createDiv({ cls: 'arena-toolbar' });
    toolbar.createSpan({ text: this.channel, cls: 'arena-channel-name' });
    const controls = toolbar.createDiv({ cls: 'arena-header-actions' });
    if (this.shuffleMode) this.buildStepper(controls);
    const moreLabel = this.shuffleMode ? 'Shuffle' : 'Load more';
    this.more = controls.createEl('button', {
      cls: 'arena-icon-button', attr: { type: 'button', 'aria-label': moreLabel },
    });
    setIcon(this.more, this.shuffleMode ? 'shuffle' : 'list-plus');
    this.refresh = controls.createEl('button', {
      cls: 'arena-icon-button', attr: { type: 'button', 'aria-label': 'Refresh' },
    });
    setIcon(this.refresh, 'refresh-cw');
    this.loadingStatus = controls.createSpan({ cls: 'arena-sr-only', attr: { role: 'status', 'aria-live': 'polite' } });
    this.grid = this.containerEl.createDiv({ cls: 'arena-grid' });
    this.grid.setAttribute('aria-label', `Images from ${this.channel}`);
    this.status = this.containerEl.createDiv({ cls: 'arena-status', attr: { role: 'status', 'aria-live': 'polite' } });
    const actions = this.containerEl.createDiv({ cls: 'arena-actions' });
    this.retry = actions.createEl('button', { text: 'Try again', attr: { type: 'button' } });
    this.more.hidden = true;
    this.retry.hidden = true;
    this.registerDomEvent(this.refresh, 'click', () => { void this.loadPage(1, true); });
    this.registerDomEvent(this.more, 'click', () => {
      if (this.shuffleMode) void this.shuffle();
      else if (this.nextPage !== null) void this.loadPage(this.nextPage);
    });
    this.registerDomEvent(this.retry, 'click', () => {
      if (this.failedShuffle) void this.shuffle();
      else void this.loadPage(this.failedPage, this.failedRefresh);
    });
    if (this.view === 'pinboard') this.bindDragging();
    // Plain clicks open the preview; modified clicks keep the link's behaviour.
    this.registerDomEvent(this.grid, 'click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const element = (event.target as HTMLElement).closest('.arena-tile');
      const index = this.tiles.findIndex(tile => tile.element === element);
      if (index < 0) return;
      if (this.host.preview(this.tiles.map(({ block, element }) => ({ block, element })), index)) event.preventDefault();
    });
    // Wide mode needs the note's scroller, which exists only once the embed is attached.
    // Lay out a frame later: layout changes the grid's own height, which would
    // otherwise re-trigger this observer within the same frame.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      this.containerEl.win.cancelAnimationFrame(frame);
      frame = this.containerEl.win.requestAnimationFrame(() => {
        if (this.alive && this.wide && !this.stopWide) this.startWide();
        this.layout();
      });
    });
    observer.observe(this.grid);
    this.register(() => observer.disconnect());
    if (this.initial) this.restore(this.initial);
    else void this.loadPage(1);
  }

  // Redraw what the previous render of this block showed, without fetching or fading.
  private restore({ blocks, total, scroll, moved }: Snapshot): void {
    this.initial = undefined;
    this.total = total;
    for (const [id, x, y, z] of moved) this.moved.set(id, { x, y, z });
    this.topZ = Math.max(1, ...moved.map(([, , , z]) => z));
    for (const block of blocks) this.addTile(block, false);
    this.layout();
    this.grid.scrollLeft = scroll;
    this.more.hidden = total === 0;
    this.status.setText(this.tiles.length ? `${this.tiles.length} images shown` : 'No available preview images in this channel.');
  }

  private snapshot(): Snapshot {
    return {
      blocks: this.tiles.map(tile => tile.block), total: this.total, scroll: this.grid.scrollLeft,
      moved: [...this.moved].map(([id, { x, y, z }]) => [id, x, y, z]),
    };
  }

  // The plugin-wide setting; a block's own width: line takes precedence.
  setDefaultWide(wide: boolean): void {
    const next = this.width ? this.width === 'wide' : wide;
    if (next === this.wide) return;
    this.wide = next;
    if (!next) this.stopWide?.();
    else if (this.alive) this.startWide();
  }

  // Extend past the readable line width, centred in the note pane, the way
  // Obsidian's own Bases embeds break out. On phones, only into the side margins.
  // Minimal, and themes that borrow its variables, set a wide line width for
  // images and tables. Match it so embeds line up with that content.
  private wideWidth(natural: number, inner: number): number {
    const doc = this.containerEl.doc;
    if (!getComputedStyle(doc.body).getPropertyValue('--line-width-wide').trim()) return natural * WIDE_FACTOR;
    const frame = doc.body.createDiv();
    frame.style.cssText = `position: fixed; left: 0; top: 0; visibility: hidden; pointer-events: none; width: ${inner}px;`;
    const probe = frame.createDiv();
    probe.style.cssText = 'width: var(--line-width-wide); max-width: var(--max-width, 100%);';
    const width = probe.getBoundingClientRect().width;
    frame.remove();
    return width;
  }

  private startWide(): void {
    const host = this.containerEl.closest<HTMLElement>('.cm-embed-block') ?? this.containerEl;
    const scroller = host.closest<HTMLElement>('.markdown-preview-view, .cm-scroller');
    if (!scroller || !host.parentElement) return;
    const phone = this.containerEl.doc.body.classList.contains('is-phone');
    const reset = () => {
      host.classList.remove('arena-wide-host');
      host.style.removeProperty('--arena-wide-width');
      host.style.removeProperty('--arena-wide-shift');
    };
    const update = () => {
      // Measure the block as the theme lays it out. Its parent can't be used:
      // Minimal makes the editor content full width and narrows each block.
      reset();
      const box = host.getBoundingClientRect();
      const natural = box.width;
      const style = getComputedStyle(scroller);
      const padLeft = phone ? 0 : parseFloat(style.paddingLeft);
      const inner = scroller.clientWidth - (phone ? 0 : padLeft + parseFloat(style.paddingRight));
      const width = Math.round(Math.min(this.wideWidth(natural, inner), inner));
      if (width <= natural + 1) return;
      host.style.setProperty('--arena-wide-width', `${width}px`);
      host.classList.add('arena-wide-host');
      // Centre on the text column, kept inside the pane, measured from wherever
      // the theme's margins put the widened block.
      const paneLeft = scroller.getBoundingClientRect().left + padLeft;
      const target = Math.min(paneLeft + inner - width, Math.max(paneLeft, box.left + natural / 2 - width / 2));
      host.style.setProperty('--arena-wide-shift', `${Math.round(target - host.getBoundingClientRect().left)}px`);
    };
    // Resizing the host inside this callback would re-trigger observers in the same frame.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      this.containerEl.win.cancelAnimationFrame(frame);
      frame = this.containerEl.win.requestAnimationFrame(update);
    });
    observer.observe(scroller);
    observer.observe(host.parentElement);
    update();
    this.stopWide = () => {
      this.containerEl.win.cancelAnimationFrame(frame);
      observer.disconnect();
      reset();
      this.stopWide = undefined;
    };
  }

  onunload(): void {
    this.stopWide?.();
    this.alive = false;
    this.finishImageWait?.();
    for (const animation of this.animations) animation.cancel();
    window.clearTimeout(this.applyTimer);
    window.clearTimeout(this.saveTimer);
    // Closing the note within the save delay still keeps the chosen count.
    if (this.count !== undefined && this.count !== this.savedCount) void this.host.saveCount(this.count, this.snapshot()).catch(() => false);
  }

  private buildStepper(parent: HTMLElement): void {
    const stepper = parent.createDiv({ cls: 'arena-stepper' });
    // The buttons are pointer shortcuts; keyboard users adjust the spinbutton directly.
    this.fewer = stepper.createEl('button', {
      cls: 'arena-icon-button', attr: { type: 'button', tabindex: '-1', 'aria-label': 'Fewer images' },
    });
    setIcon(this.fewer, 'minus');
    this.countValue = stepper.createSpan({
      cls: 'arena-count',
      attr: { role: 'spinbutton', tabindex: '0', 'aria-label': 'Count', 'aria-valuemin': String(MIN_COUNT), 'aria-valuemax': String(MAX_COUNT) },
    });
    this.moreImages = stepper.createEl('button', {
      cls: 'arena-icon-button', attr: { type: 'button', tabindex: '-1', 'aria-label': 'More images' },
    });
    setIcon(this.moreImages, 'plus');
    this.renderCount();
    this.bindRepeat(this.fewer, -1);
    this.bindRepeat(this.moreImages, 1);
    this.registerDomEvent(this.countValue, 'keydown', event => {
      const steps: Record<string, number> = { ArrowUp: 1, ArrowDown: -1, PageUp: 10, PageDown: -10 };
      const current = this.count ?? this.per;
      if (event.key === 'Home') this.setCount(MIN_COUNT);
      else if (event.key === 'End') this.setCount(MAX_COUNT);
      else if (event.key in steps) this.setCount(current + steps[event.key]!);
      else return;
      event.preventDefault();
    });
  }

  // Press steps once; holding repeats and speeds up.
  private bindRepeat(button: HTMLButtonElement, delta: number): void {
    let timer: number | undefined;
    const stop = () => { window.clearTimeout(timer); timer = undefined; };
    const repeat = (delay: number) => {
      timer = window.setTimeout(() => {
        if (this.setCount((this.count ?? this.per) + delta)) repeat(Math.max(40, delay * 0.8));
        else stop();
      }, delay);
    };
    this.registerDomEvent(button, 'pointerdown', event => {
      if (event.button !== 0) return;
      stop();
      if (this.setCount((this.count ?? this.per) + delta)) repeat(400);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel'] as const) this.registerDomEvent(button, type, stop);
    // Assistive technology activates buttons with a click that has no pointer press.
    this.registerDomEvent(button, 'click', event => { if (event.detail === 0) this.setCount((this.count ?? this.per) + delta); });
    this.register(stop);
  }

  private setCount(value: number): boolean {
    const next = Math.min(MAX_COUNT, Math.max(MIN_COUNT, value));
    if (next === this.count) return false;
    this.count = next;
    this.renderCount();
    window.clearTimeout(this.applyTimer);
    window.clearTimeout(this.saveTimer);
    this.applyTimer = window.setTimeout(() => { void this.applyCount(); }, 300);
    return true;
  }

  private renderCount(): void {
    const count = this.count ?? this.per;
    this.countValue?.setText(String(count));
    this.countValue?.setAttribute('aria-valuenow', String(count));
    if (this.fewer) this.fewer.disabled = count <= MIN_COUNT;
    if (this.moreImages) this.moreImages.disabled = count >= MAX_COUNT;
  }

  // Once stepping settles, add or remove only the difference, then save the
  // count a little later so a run of adjustments becomes one note edit.
  private async applyCount(): Promise<void> {
    this.applyTimer = undefined;
    if (!this.alive || this.count === undefined) return;
    if (this.busy) {
      this.applyTimer = window.setTimeout(() => { void this.applyCount(); }, 200);
      return;
    }
    const target = this.count;
    if (target !== this.per) await this.resize(target);
    if (!this.alive || this.applyTimer !== undefined) return;
    this.saveTimer = window.setTimeout(() => { void this.commitCount(); }, 800);
  }

  private async commitCount(): Promise<void> {
    this.saveTimer = undefined;
    if (!this.alive || this.count === undefined || this.count === this.savedCount) return;
    const previous = this.savedCount;
    // A successful save rewrites the block; Obsidian re-renders this embed, which
    // restores the snapshot rather than starting over. Mark it saved first so the
    // unload caused by that re-render doesn't save again.
    const count = this.count;
    this.savedCount = count;
    const saved = await this.host.saveCount(count, this.snapshot()).catch(() => false);
    if (!saved && this.savedCount === count) this.savedCount = previous;
  }

  private async resize(target: number): Promise<void> {
    this.busy = true;
    this.more.disabled = true;
    this.refresh.disabled = true;
    this.retry.hidden = true;
    this.grid.setAttribute('aria-busy', 'true');
    try {
      if (target < this.tiles.length) await this.removeTiles(this.tiles.length - target);
      else if (target > this.tiles.length) {
        this.loadingStatus.setText('Adding images');
        const blocks = await this.client.shuffle(this.channel, target - this.tiles.length, this.total, () => this.alive, this.ids);
        if (!this.alive) return;
        await this.appendTiles(blocks);
      }
      if (!this.alive) return;
      this.per = target;
      this.status.setText(this.tiles.length ? `${this.tiles.length} images shown` : 'No available preview images in this channel.');
    } catch (error) {
      if (!this.alive) return;
      this.status.setText(error instanceof ArenaError ? error.message : 'Could not add images. Try again.');
    } finally {
      this.busy = false;
      this.loadingStatus.setText('');
      if (this.alive) {
        this.more.disabled = false;
        this.refresh.disabled = false;
        this.grid.setAttribute('aria-busy', 'false');
      }
    }
  }

  private begin(button: HTMLButtonElement, icon: string, label: string): void {
    this.busy = true;
    this.more.disabled = true;
    this.refresh.disabled = true;
    this.retry.hidden = true;
    this.loadingStatus.setText(label);
    button.setAttribute('aria-label', label);
    button.classList.add('arena-is-loading');
    setIcon(button, icon);
    this.grid.setAttribute('aria-busy', 'true');
    if (this.tiles.length) this.grid.classList.add('arena-is-pending');
  }

  private end(button: HTMLButtonElement, icon: string, label: string): void {
    this.busy = false;
    button.classList.remove('arena-is-loading');
    button.setAttribute('aria-label', label);
    setIcon(button, icon);
    this.loadingStatus.setText('');
    if (!this.alive) return;
    this.grid.classList.remove('arena-is-pending');
    this.more.disabled = false;
    this.refresh.disabled = false;
    this.grid.setAttribute('aria-busy', 'false');
  }

  private async loadPage(page: number, refresh = false): Promise<void> {
    if (this.busy || !this.alive) return;
    if (refresh) this.begin(this.refresh, 'refresh-cw', 'Refreshing images');
    else {
      this.busy = true;
      this.more.disabled = true;
      this.refresh.disabled = true;
      this.retry.hidden = true;
      this.grid.setAttribute('aria-busy', 'true');
      this.status.setText('Loading…');
    }
    try {
      const result = await this.client.contents(this.channel, page, refresh, this.per);
      if (!this.alive) return;
      this.total = result.meta.total_count;
      let added: number;
      if (refresh) {
        // Refresh starts a new pagination snapshot, avoiding mixing changed pages.
        await this.replace(result.data);
        added = this.tiles.length;
      } else {
        const before = this.tiles.length;
        for (const block of result.data) this.addTile(block);
        this.layout();
        added = this.tiles.length - before;
      }
      if (!this.alive) return;
      const next = result.meta.next_page;
      this.nextPage = result.meta.has_more_pages && typeof next === 'number' && Number.isInteger(next) && next > page ? next : null;
      this.more.hidden = this.shuffleMode ? this.total === 0 : this.nextPage === null;
      if (result.meta.total_count === 0) this.status.setText('This channel is empty.');
      else if (this.tiles.length === 0) this.status.setText('No available images on this page.');
      else if (added === 0) this.status.setText('No additional images on this page.');
      else this.status.setText(`${this.tiles.length} images shown`);
    } catch (error) {
      if (!this.alive) return;
      this.status.setText(error instanceof ArenaError ? error.message : 'This embed could not be loaded. Try again.');
      this.failedPage = page;
      this.failedRefresh = refresh;
      this.failedShuffle = false;
      this.retry.hidden = false;
    } finally {
      if (refresh) this.end(this.refresh, 'refresh-cw', 'Refresh');
      else {
        this.busy = false;
        if (this.alive) {
          this.more.disabled = false;
          this.refresh.disabled = false;
          this.grid.setAttribute('aria-busy', 'false');
        }
      }
    }
  }

  private async shuffle(): Promise<void> {
    if (this.busy || !this.alive) return;
    this.begin(this.more, 'loader-circle', 'Shuffling images');
    try {
      const blocks = await this.client.shuffle(this.channel, this.per, this.total, () => this.alive);
      if (!this.alive) return;
      await this.replace(blocks);
      if (!this.alive) return;
      this.status.setText(this.tiles.length ? `${this.tiles.length} images shown` : 'No available preview images in this channel.');
    } catch (error) {
      if (!this.alive) return;
      this.status.setText(error instanceof ArenaError ? error.message : 'Could not shuffle this channel. Try again.');
      this.failedShuffle = true;
      this.retry.hidden = false;
    } finally {
      this.end(this.more, 'shuffle', 'Shuffle');
    }
  }

  private reducedMotion(): boolean {
    return this.containerEl.win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private play(element: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions): Promise<void> {
    const animation = element.animate(keyframes, options);
    this.animations.add(animation);
    return animation.finished.then(() => undefined, () => undefined).finally(() => this.animations.delete(animation));
  }

  private exit(tiles: Tile[]): Promise<void[]> {
    const reduced = this.reducedMotion();
    return Promise.all(tiles.map(({ element }) => this.play(element, reduced
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.96)' }],
    { duration: reduced ? 100 : 140, easing: EASE_IN, fill: 'forwards' })));
  }

  // Stagger tiles in from the top, while the grid height follows.
  private async enter(tiles: Tile[]): Promise<void> {
    const reduced = this.reducedMotion();
    this.grid.classList.add('arena-is-swapping');
    this.layout();
    const ordered = [...tiles].sort((a, b) =>
      parseFloat(a.element.style.top) - parseFloat(b.element.style.top) || parseFloat(a.element.style.left) - parseFloat(b.element.style.left));
    await Promise.all(ordered.map(({ element }, index) => {
      element.classList.remove('arena-tile-incoming');
      return this.play(element, reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 0, transform: 'translateY(8px) scale(0.97)' }, { opacity: 1, transform: 'none' }],
      { duration: reduced ? 160 : 320, delay: reduced ? 0 : Math.min(index * 20, 200), easing: EASE_OUT, fill: 'backwards' });
    }));
    this.grid.classList.remove('arena-is-swapping');
  }

  private createIncoming(blocks: Block[], ids: Set<number>): Tile[] {
    const tiles: Tile[] = [];
    for (const block of blocks) {
      if (!hasPreview(block) || ids.has(block.id)) continue;
      const tile = this.createTile(block, false);
      if (!tile) continue;
      ids.add(block.id);
      tile.element.classList.add('arena-tile-incoming');
      tiles.push(tile);
    }
    return tiles;
  }

  // Swap the whole grid: decode the incoming images while the current tiles stay
  // dimmed, fade the old tiles out, then stagger the new ones in.
  private async replace(blocks: Block[]): Promise<void> {
    const outgoing = this.tiles;
    const ids = new Set<number>();
    const incoming = this.createIncoming(blocks, ids);
    this.place(incoming);
    await this.decode(incoming);
    if (!this.alive) return;
    await this.exit(outgoing);
    if (!this.alive) return;
    for (const { element } of outgoing) element.remove();
    this.grid.classList.remove('arena-is-pending');
    this.tiles = incoming;
    this.ids = ids;
    this.moved.clear();
    this.topZ = 1;
    await this.enter(incoming);
  }

  // Masonry places each tile from the ones before it, so trimming or extending
  // the end of the list leaves every other tile where it is.
  private async removeTiles(count: number): Promise<void> {
    const removed = this.tiles.splice(this.tiles.length - count);
    for (const { block } of removed) { this.ids.delete(block.id); this.moved.delete(block.id); }
    await this.exit(removed);
    for (const { element } of removed) element.remove();
    if (!this.alive) return;
    this.grid.classList.add('arena-is-swapping');
    this.layout();
    await new Promise(resolve => setTimeout(resolve, this.reducedMotion() ? 0 : 320));
    this.grid.classList.remove('arena-is-swapping');
  }

  private async appendTiles(blocks: Block[]): Promise<void> {
    const incoming = this.createIncoming(blocks, this.ids);
    this.tiles.push(...incoming);
    this.place(this.tiles);
    await this.decode(incoming);
    if (!this.alive) return;
    await this.enter(incoming);
  }

  // A stalled image must not hold the controls indefinitely.
  private decode(tiles: Tile[]): Promise<void> {
    const images = tiles.flatMap(({ element }) => Array.from(element.querySelectorAll('img')));
    return new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer);
        if (this.finishImageWait === finish) this.finishImageWait = undefined;
        resolve();
      };
      const timer = setTimeout(finish, 8000);
      this.finishImageWait = finish;
      void Promise.allSettled(images.map(img => img.decode())).then(finish);
    });
  }

  private addTile(block: Block, fadeOnLoad = true): void {
    if (!hasPreview(block) || this.ids.has(block.id)) return;
    const tile = this.createTile(block, fadeOnLoad);
    if (!tile) return;
    this.ids.add(block.id);
    this.tiles.push(tile);
  }

  private createTile(block: Block, fadeOnLoad: boolean): Tile | undefined {
    const image = block.image;
    const src = safeImageUrl(image?.medium?.src);
    if (!image || !src) return undefined;
    const ratio = image.aspect_ratio ?? ((image.width && image.height) ? image.width / image.height : 1);
    const title = block.title || image.alt_text || `${block.type} on Are.na`;
    const tile = this.grid.createEl('a', {
      cls: 'arena-tile',
      attr: { href: `https://www.are.na/block/${block.id}`, target: '_blank', rel: 'noopener noreferrer', 'aria-label': title },
    });
    const img = tile.createEl('img', {
      attr: { alt: image.alt_text || block.title || '', loading: fadeOnLoad ? 'lazy' : 'eager', decoding: 'async', referrerpolicy: 'no-referrer' },
    });
    if (fadeOnLoad) {
      img.style.opacity = '0';
      img.addEventListener('load', () => {
        img.style.opacity = '';
        if (this.alive) void this.play(img, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: EASE_OUT });
      }, { once: true });
    }
    const src2x = safeImageUrl(image.medium?.src_2x);
    if (src2x) img.srcset = `${src} 1x, ${src2x} 2x`;
    img.addEventListener('error', () => {
      img.hidden = true;
      tile.createSpan({ text: 'Image unavailable', cls: 'arena-image-error' });
    }, { once: true });
    img.src = src;
    return { element: tile, ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 1, block };
  }

  private layout(): void {
    const height = this.place(this.tiles);
    if (height !== undefined) this.grid.style.height = `${height}px`;
  }

  private place(tiles: Tile[]): number | undefined {
    const width = this.grid.clientWidth;
    if (width <= 0) return undefined;
    let height = layouts[this.view](tiles, width);
    for (const tile of tiles) {
      const moved = this.moved.get(tile.block.id);
      if (!moved) continue;
      const style = tile.element.style;
      const left = Math.min(width - parseFloat(style.width), Math.max(0, parseFloat(style.left) + moved.x));
      const top = Math.max(0, parseFloat(style.top) + moved.y);
      Object.assign(style, { left: `${left}px`, top: `${top}px`, zIndex: String(moved.z) });
      height = Math.max(height, top + parseFloat(style.height) + 12);
    }
    return height;
  }

  // Pinboard prints can be moved. Mouse and pen drag after a few pixels; touch
  // needs a short hold so swiping still scrolls the note. A press that never
  // becomes a drag still opens the block.
  private bindDragging(): void {
    interface Drag { tile: Tile; pointerId: number; touch: boolean; x: number; y: number; left: number; top: number; active: boolean; timer?: number }
    let drag: Drag | undefined;
    let swallowClick = false;
    const activate = (current: Drag) => {
      current.active = true;
      current.tile.element.classList.add('arena-is-dragging');
      try { current.tile.element.setPointerCapture(current.pointerId); } catch { /* Pointer already released. */ }
    };
    const finish = () => {
      if (!drag) return;
      window.clearTimeout(drag.timer);
      const { tile, active } = drag;
      drag = undefined;
      if (!active) return;
      swallowClick = true;
      tile.element.classList.remove('arena-is-dragging');
      this.layout();
    };
    this.registerDomEvent(this.grid, 'pointerdown', event => {
      swallowClick = false;
      if (event.button !== 0 || !event.isPrimary || drag) return;
      const element = (event.target as HTMLElement).closest('.arena-tile');
      const tile = this.tiles.find(candidate => candidate.element === element);
      if (!tile || element?.classList.contains('arena-tile-incoming')) return;
      const touch = event.pointerType === 'touch';
      const current: Drag = {
        tile, pointerId: event.pointerId, touch, x: event.clientX, y: event.clientY,
        left: parseFloat(tile.element.style.left), top: parseFloat(tile.element.style.top), active: false,
      };
      drag = current;
      if (touch) current.timer = window.setTimeout(() => { if (drag === current) activate(current); }, 350);
      else event.preventDefault();
    });
    this.registerDomEvent(this.grid, 'pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.active) {
        if (Math.hypot(dx, dy) < (drag.touch ? 8 : 4)) return;
        // Moving before the hold completes means the finger is scrolling.
        if (drag.touch) { window.clearTimeout(drag.timer); drag = undefined; return; }
        activate(drag);
      }
      const { tile } = drag;
      const id = tile.block.id;
      const previous = this.moved.get(id) ?? { x: 0, y: 0, z: 0 };
      const style = tile.element.style;
      const left = Math.min(this.grid.clientWidth - parseFloat(style.width), Math.max(0, drag.left + dx));
      const top = Math.max(0, drag.top + dy);
      const z = previous.z === this.topZ ? previous.z : ++this.topZ;
      // Offsets are relative to the layout position, so prints follow resizes.
      this.moved.set(id, { x: previous.x + left - parseFloat(style.left), y: previous.y + top - parseFloat(style.top), z });
      Object.assign(style, { left: `${left}px`, top: `${top}px`, zIndex: String(z) });
      const bottom = top + parseFloat(style.height) + 12;
      if (bottom > parseFloat(this.grid.style.height)) this.grid.style.height = `${bottom}px`;
    });
    this.registerDomEvent(this.grid, 'pointerup', finish);
    this.registerDomEvent(this.grid, 'pointercancel', finish);
    this.registerDomEvent(this.grid, 'touchmove', event => { if (drag?.active) event.preventDefault(); }, { passive: false });
    this.registerDomEvent(this.grid, 'contextmenu', event => { if (drag?.touch) event.preventDefault(); });
    this.registerDomEvent(this.grid, 'dragstart', event => event.preventDefault());
    this.registerDomEvent(this.grid, 'click', event => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
    }, { capture: true });
  }
}
