export function parseChannel(source: string): string {
  const lines = source.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error('Enter one Are.na channel URL or slug.');
  let value = lines[0]!.replace(/^channel:\s*/, '').trim();
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('Enter a valid Are.na channel URL.'); }
    if (!['are.na', 'www.are.na'].includes(url.hostname) || url.username || url.password || url.port) {
      throw new Error('Use a channel URL from are.na.');
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || ['block', 'blocks', 'settings', 'developers', 'search'].includes(parts[0]!)) {
      throw new Error('Paste a channel URL, rather than a profile or block URL.');
    }
    value = parts[1]!;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    throw new Error('Enter a channel slug or a full Are.na channel URL.');
  }
  return value;
}

import { VIEWS, type View } from './layouts';

export interface EmbedOptions { channel: string; count?: number; view: View; width?: 'wide' | 'normal' }

// `per:` was the original name for `count:`; existing notes still use it.
const COUNT_LINE = /^(count|per):/;

export function parseCount(value: string): number {
  if (!/^\d+$/.test(value.trim())) throw new Error('Count must be a whole number from 1 to 100.');
  const count = Number(value);
  if (count < 1 || count > 100) throw new Error('Count must be a whole number from 1 to 100.');
  return count;
}

const VIEW_LINE = /^view:/;
const WIDTH_LINE = /^width:/;

export function parseView(value: string): View {
  const view = value.trim().toLowerCase();
  if (!(VIEWS as readonly string[]).includes(view)) throw new Error('Use view: masonry, filmstrip, contact-sheet or pinboard.');
  return view as View;
}

export function parseEmbed(source: string): EmbedOptions {
  const lines = source.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const counts = lines.filter(line => COUNT_LINE.test(line));
  const views = lines.filter(line => VIEW_LINE.test(line));
  if (counts.length > 1) throw new Error('Use only one count: line.');
  const widths = lines.filter(line => WIDTH_LINE.test(line));
  if (views.length > 1) throw new Error('Use only one view: line.');
  if (widths.length > 1) throw new Error('Use only one width: line.');
  const width = widths[0]?.replace(WIDTH_LINE, '').trim().toLowerCase();
  if (width !== undefined && width !== 'wide' && width !== 'normal') throw new Error('Use width: wide or width: normal.');
  return {
    channel: parseChannel(lines.filter(line => !COUNT_LINE.test(line) && !VIEW_LINE.test(line) && !WIDTH_LINE.test(line)).join('\n')),
    width,
    count: counts.length ? parseCount(counts[0]!.replace(COUNT_LINE, '')) : undefined,
    view: views.length ? parseView(views[0]!.replace(VIEW_LINE, '')) : 'masonry',
  };
}

export function embedMarkdown(input: string, count?: number, view: View = 'masonry', width?: 'wide' | 'normal'): string {
  parseChannel(input);
  if (count !== undefined) parseCount(String(count));
  return '```arena\nchannel: ' + input.trim().replace(/^channel:\s*/, '')
    + (count === undefined ? '' : '\ncount: ' + count)
    + (view === 'masonry' ? '' : '\nview: ' + view)
    + (width === undefined ? '' : '\nwidth: ' + width) + '\n```';
}
