import { App, Scope, setIcon } from 'obsidian';
import { safeImageUrl, type Block } from './api';

export interface LightboxItem { block: Block; element: HTMLElement }

// Matches Obsidian's own image lightbox: same markup and classes (so themes
// style it), same timing and curve, the image grows out of its tile and shrinks
// back on close, and the arrow keys step through the embed's images.
const DURATION = 200;
const EASING = 'cubic-bezier(0.4, 0, 0.22, 1)';
const BACKDROP = '0.9';

export class Lightbox {
  private containerEl!: HTMLElement;
  private bgEl!: HTMLElement;
  private titlebarEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private image!: HTMLImageElement;
  private scope: Scope;
  private isOpen = false;
  private request = 0;

  constructor(private app: App, private items: LightboxItem[], private index: number) {
    this.scope = new Scope(app.scope);
    this.scope.register([], 'Escape', () => { this.close(); return false; });
    this.scope.register([], 'ArrowLeft', () => { this.step(-1); return false; });
    this.scope.register([], 'ArrowRight', () => { this.step(1); return false; });
  }

  open(): void {
    const doc = this.items[this.index]?.element.doc ?? activeDocument;
    this.containerEl = doc.body.createDiv({ cls: 'lightbox', attr: { tabindex: '-1' } });
    this.bgEl = this.containerEl.createDiv({ cls: 'lightbox-bg' });
    const media = this.containerEl.createDiv({ cls: 'lightbox-content' }).createDiv({ cls: 'lightbox-media' });
    this.image = media.createDiv({ cls: 'media-wrapper' }).createEl('img', {
      attr: { draggable: 'false', decoding: 'async', referrerpolicy: 'no-referrer' },
    });
    this.titlebarEl = this.containerEl.createDiv({ cls: 'lightbox-titlebar' });
    this.titleEl = this.titlebarEl.createDiv({ cls: 'lightbox-titlebar-text' });
    const closeButton = this.containerEl.createDiv({ cls: 'modal-close-button mod-raised clickable-icon', attr: { 'aria-label': 'Close' } });
    setIcon(closeButton, 'x');
    closeButton.addEventListener('click', () => this.close());
    media.addEventListener('click', event => { if (event.target !== this.image) this.close(); });
    this.bgEl.style.opacity = BACKDROP;
    this.app.keymap.pushScope(this.scope);
    this.isOpen = true;
    this.show();
    this.containerEl.focus({ preventScroll: true });
    this.animateOpen();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.request++;
    this.app.keymap.popScope(this.scope);
    const origin = this.originRect();
    if (!origin || this.reducedMotion()) { this.destroy(); return; }
    const transform = this.transformTo(origin, Math.min);
    this.bgEl.style.opacity = '0';
    this.titlebarEl.style.opacity = '0';
    this.fade(this.bgEl, BACKDROP, '0');
    this.fade(this.titlebarEl, '1', '0');
    this.image.animate([{ transform: 'none' }, { transform }], { duration: DURATION, easing: EASING, fill: 'forwards' })
      .finished.then(() => this.destroy(), () => this.destroy());
  }

  private destroy(): void {
    this.containerEl.remove();
    this.items[this.index]?.element.focus({ preventScroll: true });
  }

  private step(delta: number): void {
    // Wraps around, as Obsidian's lightbox does.
    this.index = (this.index + delta + this.items.length) % this.items.length;
    this.show();
  }

  // Shows the cached grid image at once and swaps in the large size once decoded.
  private show(): void {
    const { block } = this.items[this.index]!;
    const image = block.image;
    const request = ++this.request;
    // Intrinsic size from the original keeps the frame steady when the large image swaps in.
    if (image?.width && image.height) {
      this.image.width = image.width;
      this.image.height = image.height;
    } else {
      this.image.removeAttribute('width');
      this.image.removeAttribute('height');
    }
    this.image.alt = image?.alt_text || block.title || '';
    this.image.removeAttribute('srcset');
    this.image.src = safeImageUrl(image?.medium?.src) ?? '';
    this.titleEl.setText(block.title || image?.alt_text || `${block.type} on Are.na`);
    const large = safeImageUrl(image?.large?.src);
    if (!large) return;
    const probe = new Image();
    probe.referrerPolicy = 'no-referrer';
    const large2x = safeImageUrl(image?.large?.src_2x);
    if (large2x) probe.srcset = `${large} 1x, ${large2x} 2x`;
    probe.src = large;
    probe.decode().then(() => {
      if (request !== this.request) return;
      if (probe.srcset) this.image.srcset = probe.srcset;
      this.image.src = large;
    }, () => { /* Keep the grid image. */ });
  }

  private animateOpen(): void {
    const origin = this.originRect();
    if (!origin || this.reducedMotion()) {
      this.fade(this.bgEl, '0', BACKDROP);
      return;
    }
    this.image.style.opacity = '0';
    this.bgEl.style.opacity = '0';
    this.titlebarEl.style.opacity = '0';
    const run = () => this.containerEl.win.requestAnimationFrame(() => {
      if (!this.isOpen) return;
      const transform = this.transformTo(origin, Math.max);
      this.image.style.opacity = '';
      this.bgEl.style.opacity = BACKDROP;
      this.titlebarEl.style.opacity = '';
      this.fade(this.bgEl, '0', BACKDROP);
      this.fade(this.titlebarEl, '0', '1');
      this.image.animate([{ transform }, { transform: 'none' }], { duration: DURATION, easing: EASING });
    });
    if (this.image.complete && this.image.naturalWidth > 0) run();
    else this.image.addEventListener('load', run, { once: true });
  }

  // Transform that places the full-size image over a tile's rectangle.
  private transformTo(origin: DOMRect, fit: (a: number, b: number) => number): string {
    const rect = this.image.getBoundingClientRect();
    const padding = parseFloat(getComputedStyle(this.image).paddingLeft) || 0;
    const scale = fit(origin.width / (rect.width - 2 * padding), origin.height / (rect.height - 2 * padding));
    const dx = origin.left + origin.width / 2 - (rect.left + rect.width / 2);
    const dy = origin.top + origin.height / 2 - (rect.top + rect.height / 2);
    return `translate(${dx}px, ${dy}px) scale(${scale})`;
  }

  // The current tile's on-screen rectangle, if it is visible to animate from or to.
  private originRect(): DOMRect | undefined {
    const element = this.items[this.index]?.element;
    if (!element?.isConnected) return undefined;
    const rect = element.getBoundingClientRect();
    const win = element.win;
    const visible = rect.width > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth;
    return visible ? rect : undefined;
  }

  private fade(element: HTMLElement, from: string, to: string): void {
    element.animate([{ opacity: from }, { opacity: to }], { duration: DURATION, easing: EASING });
  }

  private reducedMotion(): boolean {
    return this.containerEl.win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
}
