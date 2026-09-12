import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { sendEmail } from '@/lib/server/email';

// A family address must be able to SEND, not only receive.
//
// The Contact Center's auto-reply went out as the product's FROM_EMAIL with the
// family's address in a footer line. A teacher who replied therefore reached
// Bubaly's inbox rather than the family's, and the conversation they started —
// the appointment detail the whole feature exists to capture — ended there.

const route = readFileSync('app/api/contact-center/email/route.ts', 'utf8');

afterEach(() => vi.unstubAllGlobals());

function captureSend() {
  const calls: Record<string, unknown>[] = [];
  vi.stubEnv('RESEND_API_KEY', 're_test_key');
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body));
    return new Response('{}', { status: 200 });
  }));
  return calls;
}

describe('sendEmail identity', () => {
  it('sends as the product by default, so every other caller is unchanged', async () => {
    const calls = captureSend();
    await sendEmail({ to: 'teacher@school.test', subject: 'Hi', html: '<p>Hi</p>' });
    expect(calls[0].from).toBe(process.env.EMAIL_FROM ?? 'Bubaly <onboarding@resend.dev>');
  });

  it('sends as the family when a from is given', async () => {
    const calls = captureSend();
    await sendEmail({
      to: 'teacher@school.test', subject: 'Re: Parents evening', html: '<p>Thanks</p>',
      from: 'The Smith Family <smith@bubaly.com>', replyTo: 'smith@bubaly.com',
    });
    expect(calls[0].from).toBe('The Smith Family <smith@bubaly.com>');
    expect(calls[0].reply_to).toBe('smith@bubaly.com');
  });

  it('ignores a blank from rather than sending with an empty sender', async () => {
    const calls = captureSend();
    await sendEmail({ to: 'a@b.test', subject: 's', html: '<p>h</p>', from: '' });
    expect(calls[0].from).toBeTruthy();
  });
});

describe('the Contact Center reply carries the family identity', () => {
  it('sets both from and replyTo to the family address', () => {
    const start = route.indexOf('await sendEmail({');
    expect(start).toBeGreaterThan(-1);
    const call = route.slice(start, start + 500);
    expect(call).toContain('from: `${familyLabel} <${familyAddress}>`');
    expect(call).toContain('replyTo: familyAddress');
  });

  it('derives the address from the recipient local-part that resolved the family', () => {
    // Not from a header the sender controls: the local-part is what the unique
    // index matched, so the reply cannot be made to come from another family.
    expect(route).toContain('const familyAddress = buildBubalyAddress(local);');
  });

  it('still signs the footer, so the address is visible as well as technical', () => {
    expect(route).toContain('via ${familyAddress}');
  });
});
