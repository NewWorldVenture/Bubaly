import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { at } from './helpers/source-order';

/**
 * Audit C3-S5-03.
 *
 * The push-endpoint guard checked the hostname as a STRING and never resolved
 * it, so `https://localtest.me/x` — an ordinary public name whose A record is
 * 127.0.0.1 — was accepted as a push endpoint. The server POSTs to that
 * endpoint on its own notification schedule with no further say from the user,
 * which makes it a blind SSRF primitive that repeats.
 *
 * These tests drive the resolver rather than the network: a test that needs DNS
 * to answer is a test that fails on a train.
 */
const resolved = vi.hoisted(() => ({ answer: [] as { address: string; family: 4 | 6 }[], throws: false }));

vi.mock('@/lib/server/public-document-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/public-document-fetch')>();
  return {
    ...actual,
    // isPublicDocumentAddress stays REAL: the point of the fix is that the push
    // path uses the document fetcher's address rules, so stubbing them would
    // test a copy of the thing this finding is about.
    resolvePublicAddresses: vi.fn(async () => {
      if (resolved.throws) throw new Error('resolution failed');
      return resolved.answer;
    }),
  };
});

const { __resetPushEndpointCache, isDeliverablePushEndpoint } = await import('@/lib/server/push-endpoint');

const v4 = (address: string) => [{ address, family: 4 as const }];

describe('a push endpoint is checked against where it actually resolves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPushEndpointCache();
    resolved.answer = [];
    resolved.throws = false;
  });

  it('refuses a public hostname whose A record is internal', async () => {
    resolved.answer = v4('127.0.0.1');
    expect(await isDeliverablePushEndpoint('https://localtest.me/x')).toBe(false);
  });

  it('refuses cloud metadata behind a public name', async () => {
    resolved.answer = v4('169.254.169.254');
    expect(await isDeliverablePushEndpoint('https://push.example.com/x')).toBe(false);
  });

  it('accepts a genuinely public endpoint', async () => {
    resolved.answer = v4('142.250.72.196');
    expect(await isDeliverablePushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
  });

  it('refuses a host that answers with one public AND one internal address', async () => {
    // Half the connections would reach the internal one, which is not a guard.
    resolved.answer = [...v4('142.250.72.196'), ...v4('10.0.0.5')];
    expect(await isDeliverablePushEndpoint('https://split.example.com/x')).toBe(false);
  });

  it('fails closed when the name will not resolve', async () => {
    resolved.throws = true;
    expect(await isDeliverablePushEndpoint('https://nowhere.example.com/x')).toBe(false);
  });

  it('refuses the string cases without needing DNS at all', async () => {
    resolved.answer = v4('142.250.72.196'); // would pass if it ever asked
    expect(await isDeliverablePushEndpoint('https://localhost/x')).toBe(false);
    expect(await isDeliverablePushEndpoint('https://127.0.0.1/x')).toBe(false);
    expect(await isDeliverablePushEndpoint('https://10.0.0.5/x')).toBe(false);
    expect(await isDeliverablePushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(await isDeliverablePushEndpoint('not a url')).toBe(false);
  });

  it('caches per hostname instead of resolving on every notification', async () => {
    const { resolvePublicAddresses } = await import('@/lib/server/public-document-fetch');
    resolved.answer = v4('142.250.72.196');
    await isDeliverablePushEndpoint('https://fcm.googleapis.com/a');
    await isDeliverablePushEndpoint('https://fcm.googleapis.com/b');
    expect(vi.mocked(resolvePublicAddresses)).toHaveBeenCalledTimes(1);
  });
});

describe('both ends of the push path use it', () => {
  it('registration checks before the row is written', () => {
    const route = readFileSync('app/api/push/subscribe/route.ts', 'utf8');
    expect(at(route, 'isDeliverablePushEndpoint(')).toBeLessThan(at(route, "from('push_devices').upsert("));
  });

  it('the send re-checks before handing the endpoint to web-push', () => {
    const push = readFileSync('lib/server/push.ts', 'utf8');
    expect(at(push, 'isDeliverablePushEndpoint(')).toBeLessThan(at(push, 'webpush.sendNotification('));
  });
});
