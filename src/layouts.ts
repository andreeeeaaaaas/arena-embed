import type { Block } from './api';

export interface Tile { element: HTMLAnchorElement; ratio: number; block: Block }

export const VIEWS = ['masonry', 'filmstrip', 'contact-sheet', 'pinboard'] as const;
export type View = typeof VIEWS[number];

// Each layout positions tiles absolutely and returns the grid height. A tile's
// position depends only on the tiles before it, so adding or removing tiles at
// the end never moves the others.
export const layouts: Record<View, (tiles: Tile[], width: number) => number> = {
  masonry(tiles, width) {
    const gap = 10;
    const columns = Math.max(1, Math.min(8, Math.floor((width + gap) / 190)));
    const tileWidth = (width - gap * (columns - 1)) / columns;
    const heights = Array<number>(columns).fill(0);
    for (const tile of tiles) {
      const column = heights.indexOf(Math.min(...heights));
      const height = tileWidth / tile.ratio;
      position(tile, column * (tileWidth + gap), heights[column]!, tileWidth, height);
      heights[column] = heights[column]! + height + gap;
    }
    return Math.max(0, Math.max(...heights) - gap);
  },

  // One row at a fixed height; the grid scrolls sideways.
  filmstrip(tiles, width) {
    const gap = 10;
    const height = Math.round(Math.min(220, Math.max(150, width * 0.45)));
    let left = 0;
    for (const tile of tiles) {
      const tileWidth = Math.min(width, height * tile.ratio);
      position(tile, left, 0, tileWidth, height);
      left += tileWidth + gap;
    }
    return tiles.length ? height : 0;
  },

  // Uniform square cells, row by row; images are cropped to fill them.
  'contact-sheet'(tiles, width) {
    const gap = 6;
    const columns = Math.max(3, Math.floor((width + gap) / 126));
    const cell = (width - gap * (columns - 1)) / columns;
    tiles.forEach((tile, index) => {
      position(tile, (index % columns) * (cell + gap), Math.floor(index / columns) * (cell + gap), cell, cell);
    });
    return tiles.length ? Math.ceil(tiles.length / columns) * (cell + gap) - gap : 0;
  },

  // Masonry loosened up: varied sizes, jittered positions, overlaps and a slight
  // tilt. Seeded by block id so each print keeps its place across renders.
  pinboard(tiles, width) {
    const frame = 12;
    const columns = Math.max(2, Math.min(7, Math.floor(width / 200)));
    const cell = width / columns;
    const heights = Array<number>(columns).fill(0);
    for (const tile of tiles) {
      const random = seeded(tile.block.id);
      const column = heights.indexOf(Math.min(...heights));
      const tileWidth = cell * (0.78 + random() * 0.2);
      const height = (tileWidth - frame) / tile.ratio + frame;
      const left = Math.min(width - tileWidth, Math.max(0, column * cell + (cell - tileWidth) / 2 + (random() - 0.5) * cell * 0.3));
      const top = heights[column]! === 0 ? random() * 8 : heights[column]! - 20 + random() * 14;
      position(tile, left, top, tileWidth, height);
      tile.element.style.setProperty('--arena-tilt', `${((random() - 0.5) * 7).toFixed(2)}deg`);
      heights[column] = top + height;
    }
    return tiles.length ? Math.max(...heights) + 12 : 0;
  },
};

function position(tile: Tile, left: number, top: number, width: number, height: number): void {
  Object.assign(tile.element.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
}

// mulberry32
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
