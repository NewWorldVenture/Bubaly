import { describe, expect, it } from 'vitest';
import { parsePushDeviceKey, parsePushRegistration } from '@/lib/server/push-request';

const web = {
  platform: 'web', provider: 'webpush',
  endpoint: 'https://updates.example.test/push/abc',
  p256dh: 'A'.repeat(87), auth: 'B'.repeat(22), userAgent: 'browser',
};

describe('push registration boundary', () => {
  it('accepts valid web and native registrations', () => {
    expect(parsePushRegistration(web)).toMatchObject({ ok: true, value: { deviceKey: web.endpoint } });
    expect(parsePushRegistration({ platform: 'ios', provider: 'apns', token: 'a'.repeat(64) })).toMatchObject({ ok: true });
    expect(parsePushRegistration({ platform: 'android', provider: 'fcm', token: 'fcm:token_123' })).toMatchObject({ ok: true });
  });

  it('rejects mismatched providers, unsafe endpoints, and malformed web keys', () => {
    expect(parsePushRegistration({ ...web, provider: 'fcm' })).toMatchObject({ ok: false });
    expect(parsePushRegistration({ ...web, endpoint: 'http://updates.example.test/push' })).toMatchObject({ ok: false });
    expect(parsePushRegistration({ ...web, endpoint: 'https://user:pass@updates.example.test/push' })).toMatchObject({ ok: false });
    expect(parsePushRegistration({ ...web, p256dh: 'not base64!' })).toMatchObject({ ok: false });
    expect(parsePushRegistration({ platform: 'ios', provider: 'apns', token: 'bad\nvalue' })).toMatchObject({ ok: false });
  });

  it('rejects oversized fields and malformed bodies', () => {
    expect(parsePushRegistration({ ...web, endpoint: `https://updates.example.test/${'a'.repeat(2_050)}` })).toMatchObject({ ok: false });
    expect(parsePushRegistration({ ...web, userAgent: 'x'.repeat(401) })).toMatchObject({ ok: false });
    expect(parsePushRegistration(null)).toMatchObject({ ok: false });
    expect(parsePushRegistration({ platform: 'android', provider: 'fcm', token: '' })).toMatchObject({ ok: false });
  });

  it('uses the same strict key validation for removal', () => {
    expect(parsePushDeviceKey({ endpoint: web.endpoint })).toBe(web.endpoint);
    expect(parsePushDeviceKey({ token: 'fcm:token_123' })).toBe('fcm:token_123');
    expect(parsePushDeviceKey({ endpoint: 'http://bad.test' })).toBeNull();
    expect(parsePushDeviceKey({ endpoint: 'http://bad.test', token: 'fcm:token_123' })).toBeNull();
    expect(parsePushDeviceKey({ token: 'bad\u0000token' })).toBeNull();
  });
});
