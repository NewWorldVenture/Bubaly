// The PWA share target, pinned.
//
// The share sheet is the cheapest possible capture: a parent forwards the
// school email to Bubaly with two taps. It works only if the manifest declares
// a `share_target` whose `action` is a route that exists and whose params are
// the three the OS actually sends. Any one of those wrong and the share either
// never appears in the sheet or lands somewhere that drops the payload — and
// nothing in the build would notice, because a manifest is data.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import manifest from '@/app/manifest';

describe('the web app manifest declares a share target', () => {
  const m = manifest();

  it('sends shares to /capture over GET', () => {
    expect(m.share_target).toBeDefined();
    expect(m.share_target?.action).toBe('/capture');
    // GET, so the shared fields arrive as query params a server component reads
    // on the first paint; a POST target needs a route handler and a redirect and
    // loses the payload when the share cold-starts the app.
    expect(String(m.share_target?.method).toUpperCase()).toBe('GET');
  });

  it('names exactly the three params a share sheet fills', () => {
    expect(m.share_target?.params).toEqual({ title: 'title', text: 'text', url: 'url' });
  });

  it('points at a route that exists', () => {
    // A share target aimed at a 404 is worse than none: it appears in the OS
    // share sheet and then loses what the person shared.
    expect(() => readFileSync('app/(app)/capture/page.tsx', 'utf8')).not.toThrow();
  });

  it('leaves the rest of the manifest intact', () => {
    // The share target is additive; installability must not regress with it.
    expect(m.start_url).toBe('/dashboard');
    expect(m.display).toBe('standalone');
    expect(m.icons?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(m.shortcuts?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});

describe('/capture consumes what the share target sends', () => {
  const page = readFileSync('app/(app)/capture/page.tsx', 'utf8');

  it('reads the shared params on the server and prefills the box', () => {
    expect(page).toContain('searchParams');
    expect(page).toContain('sharedCaptureText');
    expect(page).toContain('initialText');
  });
});
