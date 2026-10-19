import { requestUrl } from 'obsidian';

export interface Block {
  id: number;
  type: string;
  state: string;
  title?: string | null;
  image?: {
    alt_text?: string | null;
    aspect_ratio?: number | null;
    width?: number | null;
    height?: number | null;
    medium?: { src: string; src_2x?: string; width?: number | null; height?: number | null };
    large?: { src: string; src_2x?: string } | null;
  } | null;
  source?: { url?: string | null } | null;
}
export interface Page {
  data: Block[];
  meta: { current_page: number; next_page: number | null; total_count: number; has_more_pages: boolean };
}
interface CachedPage { page: Page; etag?: string; freshUntil: number; policy: string }

export class ArenaError extends Error {}

export function hasPreview(block: Block): boolean {
  return Boolean(block && ['Image', 'Link', 'Embed', 'Attachment'].includes(block.type)
    && block.state === 'available' && Number.isInteger(block.id) && safeImageUrl(block.image?.medium?.src));
}

function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export class ArenaClient {
  private cache = new Map<string, CachedPage>();
  private pending = new Map<string, Promise<Page>>();
  private token = '';
  private generation = 0;
  private blockedUntil = 0;

  setToken(token: string): void {
    this.token = token.trim();
    this.clear();
  }

  clear(): void {
    this.generation++;
    this.cache.clear();
    this.pending.clear();
  }

  contents(channel: string, page = 1, refresh = false, per = 24): Promise<Page> {
    if (!Number.isInteger(per) || per < 1 || per > 100) return Promise.reject(new ArenaError('Items per page must be a whole number from 1 to 100.'));
    const key = `${channel}:${page}:${per}`;
    const current = this.pending.get(key);
    if (current) return current;
    const cached = this.cache.get(key);
    if (!refresh && cached && cached.freshUntil > Date.now()) return Promise.resolve(cached.page);
    if (Date.now() < this.blockedUntil) return Promise.reject(this.rateLimitError());
    const generation = this.generation;
    const promise = this.load(channel, page, key, cached, generation, per).finally(() => {
      if (generation === this.generation) this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  private rateLimitError(): ArenaError {
    return new ArenaError(`Are.na’s request limit was reached. Try again after ${new Date(this.blockedUntil).toLocaleTimeString()}.`);
  }

  async shuffle(channel: string, count: number, total: number, active: () => boolean, exclude: ReadonlySet<number> = new Set()): Promise<Block[]> {
    const selected = new Map<number, Block>();
    // Visit random pages rather than downloading the whole channel. A page supplies
    // up to 100 candidates; only fetch another when it cannot fill the selection.
    let remaining = Math.ceil(total / 100);
    const swaps = new Map<number, number>();
    const generation = this.generation;
    while (remaining > 0 && selected.size < count && active() && generation === this.generation) {
      const index = Math.floor(Math.random() * remaining);
      const page = (swaps.get(index) ?? index) + 1;
      remaining--;
      swaps.set(index, swaps.get(remaining) ?? remaining);
      swaps.delete(remaining);
      const result = await this.contents(channel, page, false, 100);
      if (!active() || generation !== this.generation) return [];
      for (const block of shuffled(result.data.filter(block => hasPreview(block) && !exclude.has(block.id)))) {
        selected.set(block.id, block);
        if (selected.size === count) break;
      }
    }
    return shuffled([...selected.values()]);
  }

  private async load(channel: string, page: number, key: string, cached: CachedPage | undefined, generation: number, per: number): Promise<Page> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    let response;
    try {
      response = await requestUrl({
        url: `https://api.are.na/v3/channels/${encodeURIComponent(channel)}/contents?page=${page}&per=${per}`,
        headers,
        throw: false,
      });
    } catch {
      throw new ArenaError('Could not reach Are.na. Check your connection and try again.');
    }
    if (generation !== this.generation) throw new ArenaError('Settings changed. Refresh this embed.');
    const h = Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), value]));
    if (response.status === 429) {
      const reset = Number(h['x-ratelimit-reset']) * 1000;
      this.blockedUntil = Number.isFinite(reset) && reset > Date.now() ? reset : Date.now() + 60_000;
      throw this.rateLimitError();
    }
    if (response.status === 401) throw new ArenaError('Add or update your personal access token in Are.na Embed settings.');
    if (response.status === 403 || response.status === 404) {
      this.cache.delete(key);
      throw new ArenaError('This channel could not be opened. Check its URL and your token’s access.');
    }
    if (response.status !== 200 && response.status !== 304) throw new ArenaError('Are.na could not load this channel. Try again shortly.');
    let result: Page;
    if (response.status === 304 && cached) {
      result = cached.page;
    } else if (response.status === 200) {
      try {
        const body = response.json as Page;
        if (!Array.isArray(body.data) || !body.meta || !Number.isInteger(body.meta.current_page)) throw new Error();
        result = body;
      } catch { throw new ArenaError('Are.na returned an unexpected response. Try again shortly.'); }
    } else { throw new ArenaError('The cached page is unavailable. Refresh this embed.'); }
    const policy = h['cache-control'] ?? cached?.policy ?? 'no-cache';
    const maxAge = Number(policy.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1] ?? 0);
    const age = Number(h.age ?? 0);
    const revalidate = Boolean(this.token) || /no-cache|no-store/i.test(policy);
    if (!/no-store/i.test(policy)) {
      // Bound memory use even when many notes/channels are opened in one session.
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, {
        page: result, etag: h.etag ?? cached?.etag, policy,
        freshUntil: revalidate ? 0 : Date.now() + Math.max(0, maxAge - age) * 1000,
      });
    } else this.cache.delete(key);
    return result;
  }
}

export function safeImageUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
