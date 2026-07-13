import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readBoundedRequestFormData, readBoundedRequestText } from '@/lib/server/bounded-request-body';

const routeFiles = [
  'app/api/webhooks/stripe/route.ts',
  'app/api/webhooks/money/route.ts',
  'app/api/webhooks/resend/route.ts',
  'app/api/push/subscribe/route.ts',
  'app/api/push/unsubscribe/route.ts',
  'app/api/calendar/sync/route.ts',
];

const formDataRouteFiles = [
  'app/api/guardian/status/voicemail/route.ts',
  'app/api/guardian/screen/route.ts',
  'app/api/guardian/inbound/whatsapp/route.ts',
  'app/api/guardian/inbound/voice/route.ts',
  'app/api/guardian/inbound/sms/route.ts',
  'app/api/guardian/escalate/twiml/route.ts',
  'app/api/ai/voice/transcribe/route.ts',
];

describe('bounded raw request bodies', () => {
  it('preserves the exact raw text needed by signed webhook verification', async () => {
    const body = '{"event":"payment.succeeded","note":"caf\\u00e9"}';
    const request = new Request('https://example.test', { method: 'POST', body });

    await expect(readBoundedRequestText(request, 4096)).resolves.toEqual({ ok: true, text: body });
  });

  it('rejects chunked oversized input before buffering the complete body', async () => {
    let cancelled = false;
    const request = new Request('https://example.test', {
      method: 'POST',
      duplex: 'half',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(4097)));
        },
        cancel() {
          cancelled = true;
        },
      }),
    } as RequestInit & { duplex: 'half' });

    await expect(readBoundedRequestText(request, 4096)).resolves.toEqual({ ok: false, reason: 'too_large' });
    expect(cancelled).toBe(true);
  });

  it('keeps every audited raw-body route behind the shared reader', () => {
    for (const file of routeFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('readBoundedRequestText');
      expect(source, file).not.toContain('await req.text()');
    }
  });

  it('preserves Twilio URL-encoded fields through the bounded platform parser', async () => {
    const request = new Request('https://example.test', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'CallSid=CA123&Body=hello+world',
    });
    const result = await readBoundedRequestFormData(request, 4096);
    if (!result.ok) throw new Error(`unexpected form parse failure: ${result.reason}`);
    expect(result.value.get('CallSid')).toBe('CA123');
    expect(result.value.get('Body')).toBe('hello world');
  });

  it('parses only a bounded multipart audio request', async () => {
    const form = new FormData();
    form.append('audio', new Blob(['audio bytes'], { type: 'audio/webm' }), 'speech.webm');
    const request = new Request('https://example.test', { method: 'POST', body: form });
    const result = await readBoundedRequestFormData(request, 4096);
    if (!result.ok) throw new Error(`unexpected multipart parse failure: ${result.reason}`);
    const file = result.value.get('audio');
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe('speech.webm');
  });

  it('keeps every form-data route behind the bounded parser', () => {
    for (const file of formDataRouteFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('readBoundedRequestFormData');
      expect(source, file).not.toContain('await req.formData()');
    }
  });
});
