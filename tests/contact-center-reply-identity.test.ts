import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('EMAIL_FROM', undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function captureSend() {
  const calls: Record<string, unknown>[] = [];
  vi.stubEnv('RESEND_API_KEY', 'synthetic-email-test-key');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    expect(url).toBe('https://api.resend.com/emails');
    calls.push(JSON.parse(init.body));
    return new Response('{}', { status: 200 });
  }));
  return calls;
}

describe('sendEmail identity', () => {
  it('uses the configured product sender by default', async () => {
    vi.stubEnv('EMAIL_FROM', 'Product <notifications@example.test>');
    const calls = captureSend();
    const { sendEmail } = await import('@/lib/server/email');
    await sendEmail({ to: 'teacher@school.test', subject: 'Hi', html: '<p>Hi</p>' });
    expect(calls[0].from).toBe('Product <notifications@example.test>');
  });

  it('retains the optional explicit sender and separate reply-to address', async () => {
    const calls = captureSend();
    const { sendEmail } = await import('@/lib/server/email');
    await sendEmail({
      to: 'teacher@school.test', subject: 'Re: Parents evening', html: '<p>Thanks</p>',
      from: 'The Smith Family <smith@bubaly.com>', replyTo: 'smith@bubaly.com',
    });
    expect(calls[0].from).toBe('The Smith Family <smith@bubaly.com>');
    expect(calls[0].reply_to).toBe('smith@bubaly.com');
  });

  it('uses the product default when an explicit sender is blank', async () => {
    const calls = captureSend();
    const { sendEmail } = await import('@/lib/server/email');
    await sendEmail({ to: 'a@b.test', subject: 's', html: '<p>h</p>', from: '' });
    expect(calls[0].from).toBe('Bubaly <onboarding@resend.dev>');
  });
});

describe('family reply sender compatibility', () => {
  it.each([
    [undefined, 'Bubaly <onboarding@resend.dev>'],
    ['Product <notifications@example.test>', 'Product <notifications@example.test>'],
    ['notifications@mail.bubaly.com', 'notifications@mail.bubaly.com'],
    ['notifications@bubaly.com.evil.test', 'notifications@bubaly.com.evil.test'],
    ['invalid configured sender', 'invalid configured sender'],
  ])('preserves the configured sender %s when its exact domain does not match', async (configured, expected) => {
    vi.stubEnv('EMAIL_FROM', configured);
    const calls = captureSend();
    const { sendEmail, familyReplySender } = await import('@/lib/server/email');
    await sendEmail({
      to: 'teacher@school.test', subject: 'Reply', html: '<p>Thanks</p>',
      from: familyReplySender('The Smith Family', 'smith@bubaly.com'), replyTo: 'smith@bubaly.com',
    });
    expect(calls[0].from).toBe(expected);
    expect(calls[0].reply_to).toBe('smith@bubaly.com');
  });

  it.each(['Bubaly <notifications@BUBALY.COM>', 'notifications@bubaly.com'])('uses a family sender with the same configured domain (%s)', async configured => {
    vi.stubEnv('EMAIL_FROM', configured);
    const calls = captureSend();
    const { sendEmail, familyReplySender } = await import('@/lib/server/email');
    await sendEmail({
      to: 'teacher@school.test', subject: 'Reply', html: '<p>Thanks</p>',
      from: familyReplySender('The Smith Family', 'smith@BuBaLy.CoM'), replyTo: 'smith@BuBaLy.CoM',
    });
    expect(calls[0].from).toBe('"The Smith Family" <smith@BuBaLy.CoM>');
    expect(calls[0].reply_to).toBe('smith@BuBaLy.CoM');
  });

  it.each(['Smith\r\nBcc: other@example.test', 'Smith\nFamily', 'Smith <other@example.test>', 'Smith > Family', 'Smith\u0000Family', 'Smith\u2028Family'])('omits unsafe display name %j without changing the family mailbox', async label => {
    vi.stubEnv('EMAIL_FROM', 'Bubaly <notifications@bubaly.com>');
    const { familyReplySender } = await import('@/lib/server/email');
    expect(familyReplySender(label, 'smith@bubaly.com')).toBe('smith@bubaly.com');
  });

  it('quotes commas, double quotes and backslashes in a safe display name', async () => {
    vi.stubEnv('EMAIL_FROM', 'Bubaly <notifications@bubaly.com>');
    const { familyReplySender } = await import('@/lib/server/email');
    expect(familyReplySender('Smith, "Home" \\ Team', 'smith@bubaly.com'))
      .toBe('"Smith, \\"Home\\" \\\\ Team" <smith@bubaly.com>');
  });

  it('uses the bare family mailbox for an empty label', async () => {
    vi.stubEnv('EMAIL_FROM', 'Bubaly <notifications@bubaly.com>');
    const { familyReplySender } = await import('@/lib/server/email');
    expect(familyReplySender('   ', 'smith@bubaly.com')).toBe('smith@bubaly.com');
  });

  it.each(['smith@bubaly.com\r\nBcc: other@example.test', 'smith@bubaly.com\n', 'Smith <smith@bubaly.com>', 'smith@bubaly.com,other@bubaly.com', 'smith@bubaly.com.evil.test'])('does not substitute an invalid or different-domain family mailbox %j', async address => {
    vi.stubEnv('EMAIL_FROM', 'Bubaly <notifications@bubaly.com>');
    const { familyReplySender } = await import('@/lib/server/email');
    expect(familyReplySender('Smith', address)).toBe('Bubaly <notifications@bubaly.com>');
  });
});
