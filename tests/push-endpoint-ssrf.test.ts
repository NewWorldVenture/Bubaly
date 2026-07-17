import { describe, expect, it } from 'vitest';
import { parsePushRegistration, isPrivateOrReservedHost } from '@/lib/server/push-request';

// PLA-0670 SSRF guard for web-push endpoints. push_devices.endpoint is fetched
// server-side by the web-push library, so a signed-in user must not be able to
// register an endpoint that points at an internal host (cloud metadata, RFC1918,
// loopback, link-local). parseHttpsEndpoint already required https + no creds
// (blocking http metadata); this locks the added private/reserved-host rejection.

function reg(endpoint: string) {
  return parsePushRegistration({
    platform: 'web', provider: 'webpush', endpoint,
    p256dh: 'a'.repeat(20), auth: 'b'.repeat(20), deviceKey: 'dev-1',
  });
}

describe('push endpoint SSRF guard', () => {
  it('accepts a legitimate public push endpoint', () => {
    const r = reg('https://fcm.googleapis.com/fcm/send/abc123');
    expect(r.ok).toBe(true);
  });

  it('rejects private / reserved / local hosts (SSRF targets)', () => {
    for (const bad of [
      'https://169.254.169.254/latest/meta-data/',   // cloud metadata
      'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://192.168.1.10/x',
      'https://172.16.0.1/x', 'https://100.64.0.1/x', 'https://localhost/x',
      'https://foo.internal/x', 'https://[::1]/x',
    ]) {
      expect(reg(bad).ok, `should reject ${bad}`).toBe(false);
    }
  });

  it('still rejects non-https and credentialed URLs', () => {
    expect(reg('http://fcm.googleapis.com/x').ok).toBe(false);
    expect(reg('https://user:pass@fcm.googleapis.com/x').ok).toBe(false);
  });

  it('isPrivateOrReservedHost classifies hosts correctly', () => {
    for (const [h, expected] of [
      ['fcm.googleapis.com', false], ['web.push.apple.com', false], ['updates.example.test', false],
      ['172.32.0.1', false],
      ['169.254.169.254', true], ['10.0.0.1', true], ['127.0.0.1', true],
      ['192.168.0.1', true], ['172.16.0.1', true], ['172.31.255.255', true],
      ['localhost', true], ['x.local', true], ['::1', true],
    ] as const) {
      expect(isPrivateOrReservedHost(h), h).toBe(expected);
    }
  });
});
