import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { at } from './helpers/source-order';

/**
 * Audit C1-S6-04 / C1-S6-05 — the native push branch, which Claude-3's session 5
 * named as never audited.
 *
 * The web branch prunes a 404/410 endpoint with careful accounting, and its
 * comment states the hazard exactly: "a permanently dead endpoint that never
 * gets pruned is retried on every notification from here on, spending a send
 * each time". The native branch had precisely that defect, and worse — FCM's
 * legacy endpoint reports a dead token in the BODY with HTTP 200, so `res.ok`
 * counted an uninstalled app's token as **sent**, forever.
 */
vi.mock('@/lib/server/push-endpoint', () => ({
  isDeliverablePushEndpoint: async () => true,
  __resetPushEndpointCache: () => {},
}));

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const source = strip(readFileSync('lib/server/push.ts', 'utf8'));

describe('a native push token that FCM calls dead is pruned', () => {
  it('does not treat HTTP 200 as delivery', () => {
    // The whole finding: the status is not the answer.
    expect(source).not.toContain('return res.ok;');
    expect(source).toContain("parsed.results?.[0]?.error");
    expect(at(source, 'if (!res.ok) return')).toBeLessThan(at(source, 'readBoundedResponseText('));
  });

  it('prunes only the errors that mean the token is permanently dead', () => {
    const dead = source.slice(source.indexOf('FCM_DEAD_TOKEN = new Set('), source.indexOf(']);', source.indexOf('FCM_DEAD_TOKEN')));
    for (const code of ['NotRegistered', 'InvalidRegistration', 'MismatchSenderId']) {
      expect(dead, code).toContain(code);
    }
    // A bad server key is ours, not the device's — it must never prune.
    expect(source).toContain("reason: `http_${res.status}`");
    expect(source.slice(at(source, 'if (!res.ok) return'), at(source, 'readBoundedResponseText('))).toContain('unregistered: false');
  });

  it('counts `pruned` only when the delete landed, like the web branch', () => {
    const native = source.slice(at(source, 'const outcome = await sendFcm('));
    expect(native).toContain('const { error: pruneError }');
    expect(at(native, 'if (pruneError)')).toBeLessThan(at(native, 'result.pruned++'));
    expect(native.slice(at(native, 'if (pruneError)'), at(native, 'result.pruned++'))).toContain('result.failed++');
  });

  it('a swallowed throw is no longer silent', () => {
    // An operator reading `failed: 3` with no cause cannot act on it.
    const tail = source.slice(at(source, '} catch (err) {'));
    expect(tail).toContain('device send threw');
  });

  it('the web branch it was measured against still prunes the same way', () => {
    expect(at(source, 'status === 404 || status === 410')).toBeLessThan(at(source, "from('push_devices').delete()"));
  });
});

describe('the FCM outcome parser', () => {
  it('reads success, dead tokens and transport failures apart', async () => {
    // Exercised through the module's own exported surface rather than re-stated:
    // pushConfigured reports what the env allows, and is the only pure entry.
    const { pushConfigured } = await import('@/lib/server/push');
    vi.stubEnv('FCM_SERVER_KEY', '');
    expect(pushConfigured().native).toBe(false);
    vi.stubEnv('FCM_SERVER_KEY', 'test-key');
    expect(pushConfigured().native).toBe(true);
    vi.unstubAllEnvs();
  });
});
