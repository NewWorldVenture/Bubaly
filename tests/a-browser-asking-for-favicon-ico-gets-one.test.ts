// Pages name their icons in <head>, but a browser still asks for /favicon.ico
// wherever there is no page to read them from (a file or JSON opened in a tab),
// and link unfurlers and search engines ask for it first. bubaly.com answered
// 404, which the 2026-09-27 page audit's interaction pass logged as a console
// error on the signed-in pages. The middleware already skipped the path, as if
// the file were there; now it is.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('/favicon.ico', () => {
  const ico = readFileSync('public/favicon.ico');

  it('is an icon file holding the brand icon at 16, 32 and 48 px', () => {
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // 1 = icon
    const count = ico.readUInt16LE(4);
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const entry = 6 + 16 * i;
      const size = ico.readUInt8(entry) || 256;
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      const png = ico.subarray(offset, offset + length);
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      // Each image is the brand icon of that size, byte for byte.
      expect(png.equals(readFileSync(`public/icons/icon-${size}.png`))).toBe(true);
      sizes.push(size);
    }
    expect(sizes).toEqual([16, 32, 48]);
  });

  it('is served as a static file, never run through the middleware', () => {
    expect(readFileSync('middleware.ts', 'utf8')).toMatch(/\(\?!_next\/static\|_next\/image\|favicon\.ico\|/);
  });
});
