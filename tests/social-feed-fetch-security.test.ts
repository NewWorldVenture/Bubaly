import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fetchPublicText } from '@/lib/server/public-calendar-fetch';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

describe('Social Feed unfurl fetch boundary', () => {
  it('revalidates redirects before following them', async () => {
    const fetchImpl = async () => new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/metadata' },
    });
    const result = await fetchPublicText('https://example.test/page', {
      maxBytes: 4096,
      label: 'Web page',
      headers: { accept: 'text/html' },
    }, fetchImpl, publicLookup);
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects oversized chunked HTML before parsing it', async () => {
    const fetchImpl = async () => new Response('x'.repeat(4097), { status: 200 });
    const result = await fetchPublicText('https://example.test/page', {
      maxBytes: 4096,
      label: 'Web page',
      headers: { accept: 'text/html' },
    }, fetchImpl, publicLookup);
    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  it('keeps the Social Feed action on the shared public fetcher', () => {
    const source = readFileSync('app/(app)/dashboard/social-feed/actions.ts', 'utf8');
    expect(source).toContain('fetchPublicText');
    expect(source).not.toContain('redirect: \'follow\'');
    expect(source).not.toContain('(await res.text()).slice');
  });
});
