import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runConcierge } from '@/lib/contact-center/concierge';
import { autoReplyText, summarizeInbound, type InboundIntent } from '@/lib/contact-center/routing';
import type { AICompleteInput } from '@/lib/ai/provider';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { prepareSmsReply, SmsReplyUnavailableError } from '@/lib/contact-center/sms-reply';

const ai = vi.hoisted(() => ({ configured: vi.fn(), resolve: vi.fn(), complete: vi.fn() }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: ai.configured, resolveProvider: ai.resolve }));
vi.mock('@/lib/graph/resolve-server', () => ({ resolveInboundEntityContext: vi.fn() }));
const input = { channel: 'sms' as const, text: 'A routine family note', familyLabel: 'the Smiths' };
const validScalars = (text: string) => !/[\uD800-\uDFFF]/u.test(text);
const output = (summary: string, reply: string) => ({ text: JSON.stringify({ intent: 'personal', summary, reply }) });
const binding = { familyId: '11111111-1111-4111-8111-111111111111', channelId: '11111111-1111-4111-8111-111111111111',
  smsSid: `SM${'a'.repeat(32)}`, from: '+15555550101', to: '+15555550202', body: 'a'.repeat(138) + '😀 tail' };
function receiptTransport() {
  const rows: Record<string, unknown>[] = [], writes: string[] = [];
  const client = createClient<Database>('https://concierge-text-fixture.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (raw, init) => {
      const url = new URL(String(raw)), table = url.pathname.split('/').at(-1), method = init?.method ?? 'GET';
      expect(['ai_tool_calls', 'family_inbox_messages']).toContain(table);
      expect(init?.signal).toBeTruthy();
      if (method === 'POST') {
        expect(table).toBe('ai_tool_calls');
        writes.push(String(init?.body));
        rows.push({ created_at: '2026-09-12T12:00:00.000Z', updated_at: '2026-09-12T12:00:00.000Z', ...JSON.parse(String(init?.body)) });
      } else expect(method).toBe('GET');
      const found = table === 'family_inbox_messages' ? [] : rows;
      return Response.json(found, { status: method === 'POST' ? 201 : 200,
        headers: { 'content-range': `0-${Math.max(0, found.length - 1)}/${found.length}` } });
    } },
  });
  return { client, rows, writes };
}
beforeEach(() => {
  vi.resetAllMocks(); ai.configured.mockResolvedValue(false); ai.resolve.mockResolvedValue({ complete: ai.complete });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('ordinary concierge text stays scalar-safe at its existing UTF-16 limits', () => {
  it('summarizes an ordinary 145-unit emoji body without splitting its emoji', async () => {
    const text = 'a'.repeat(138) + '😀 tail';
    expect(text.length).toBe(145);
    const result = await runConcierge({ ...input, text });
    expect(result.summary).toBe('a'.repeat(138) + '…');
    expect(result.summary.length).toBeLessThanOrEqual(140);
    expect(validScalars(result.summary)).toBe(true);
  });

  it('preserves ordinary whitespace, truncation and ellipsis behavior', () => {
    expect(summarizeInbound('  hello\n world\t ')).toBe('hello world');
    expect(summarizeInbound('')).toBe('No message content.');
    expect(summarizeInbound('x'.repeat(145))).toBe('x'.repeat(139) + '…');
    expect(summarizeInbound('first second third', 14)).toBe('first second…');
    expect(summarizeInbound('a'.repeat(138) + '😀')).toBe('a'.repeat(138) + '😀');
    expect(summarizeInbound('a'.repeat(137) + '😀 tail')).toBe('a'.repeat(137) + '😀…');
  });

  it('replaces NUL and lone surrogates in summaries while retaining valid emoji', () => {
    expect(summarizeInbound('A\0B\ud83dC\udc00D😀')).toBe('A�B�C�D😀');
  });

  it('keeps every long-family fallback below 320 units without losing its suffix', () => {
    const intents: InboundIntent[] = ['urgent', 'appointment', 'delivery', 'sales', 'spam', 'personal', 'school', 'sports', 'other'];
    for (const intent of intents) {
      const ordinary = autoReplyText(intent, 'FamilyLabel');
      const result = autoReplyText(intent, 'N'.repeat(199) + '😀' + 'N'.repeat(1350));
      expect(result.length).toBeLessThanOrEqual(320);
      expect(validScalars(result)).toBe(true);
      const [prefix, suffix] = ordinary.split('FamilyLabel');
      expect(result.startsWith(prefix)).toBe(true);
      if (suffix) expect(result.endsWith(suffix)).toBe(true);
      else expect(result).toBe(ordinary);
    }
  });

  it('preserves complete ordinary reply content', async () => {
    const result = await runConcierge(input);
    expect(result.reply).toBe('Thanks for contacting the Smiths. I’ve passed your message along and someone will follow up.');
    expect(result.aiUsed).toBe(false); expect(ai.complete).not.toHaveBeenCalled();
  });

  it('makes an AI summary/reply crossing the boundary safe without adding an ellipsis', async () => {
    ai.configured.mockResolvedValue(true);
    ai.complete.mockResolvedValue(output('s'.repeat(139) + '😀', 'r'.repeat(319) + '😀'));
    const result = await runConcierge(input);
    expect(result.summary).toBe('s'.repeat(139)); expect(result.reply).toBe('r'.repeat(319));
    expect(validScalars(result.summary) && validScalars(result.reply)).toBe(true);
    expect(result.aiUsed).toBe(true);
  });

  it.each(['sms', 'email', 'voice'] as const)('keeps valid short AI content exact for %s', async channel => {
    ai.configured.mockResolvedValue(true); ai.complete.mockResolvedValue(output('Ready 😀', 'Thanks & <noted> 😀'));
    const result = await runConcierge({ ...input, channel });
    expect(result.summary).toBe('Ready 😀'); expect(result.reply).toBe('Thanks & <noted> 😀');
  });

  it.each(['sms', 'email'] as const)('cleans storage-invalid scalars and respects %s control semantics', async channel => {
    ai.configured.mockResolvedValue(true); ai.complete.mockResolvedValue(output('A\0B\ud83dC', 'A\0B\u0001C\udc00D'));
    const result = await runConcierge({ ...input, channel });
    expect(result.summary).toBe('A�B�C');
    expect(result.reply).toBe(channel === 'sms' ? 'A�B�C�D' : 'A�B\u0001C�D');
  });

  it('bounds the model prompt body and household label without splitting scalars', async () => {
    ai.configured.mockResolvedValue(true); ai.complete.mockResolvedValue(output('Ready', 'Noted'));
    await runConcierge({ ...input, text: 'a'.repeat(1999) + '😀 tail', familyLabel: 'F'.repeat(199) + '😀 tail' });
    const sent = ai.complete.mock.calls[0][0] as AICompleteInput;
    const prompt = sent.messages[0].content;
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('Replying on behalf of: ' + 'F'.repeat(199) + '\nMessage:\n');
    expect(prompt).toContain('\nMessage:\n' + 'a'.repeat(1999));
    expect(validScalars(String(prompt))).toBe(true);
    expect(String(prompt).split('\nMessage:\n')[1].length).toBeLessThanOrEqual(2000);
  });

  it('keeps the deterministic failure fallback and school intent precedence', async () => {
    ai.configured.mockResolvedValue(true); ai.complete.mockRejectedValue(new Error('Synthetic provider outage'));
    expect(await runConcierge(input)).toMatchObject({ aiUsed: false, summary: input.text, reply: autoReplyText('personal', input.familyLabel) });
    ai.complete.mockResolvedValue({ text: '{bad json' });
    expect((await runConcierge(input)).aiUsed).toBe(false);
    ai.complete.mockResolvedValue({ text: JSON.stringify({ intent: 'other', summary: 'School note', reply: 'Saved' }) });
    expect((await runConcierge({ ...input, text: 'The school permission slip is due tomorrow' })).intent).toBe('school');
  });

  it.each(['deterministic', 'model'])('persists exact safe %s output through the real receipt helper and installed SDK', async mode => {
    ai.configured.mockResolvedValue(mode === 'model');
    ai.complete.mockResolvedValue(output('s'.repeat(139) + '😀', 'r'.repeat(319) + '😀'));
    const fixture = receiptTransport();
    const result = await runConcierge({ ...input, text: binding.body, familyLabel: 'N'.repeat(1550) });
    const receipt = await prepareSmsReply(fixture.client, binding, async () => ({ summary: result.summary, intent: result.intent,
      reply: result.reply, locale: 'en-US', suppression: null }));
    expect(receipt.candidate.summary).toBe(result.summary); expect(receipt.candidate.reply).toBe(result.reply);
    expect(result.reply.length).toBeLessThanOrEqual(320); expect(validScalars(result.reply + result.summary)).toBe(true);
    expect(fixture.rows).toHaveLength(1); expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]).not.toMatch(/\\u(?:d[89ab][0-9a-f]{2}|d[cdef][0-9a-f]{2}|0000)/i);
  });

  it('does not start AI work for an already-cancelled call', async () => {
    const controller = new AbortController(); controller.abort();
    const result = await runConcierge({ ...input, signal: controller.signal });
    expect(result.aiUsed).toBe(false); expect(ai.configured).not.toHaveBeenCalled(); expect(ai.complete).not.toHaveBeenCalled();
  });

  it.each(['configuration', 'provider'])('stops before completion if cancelled during %s setup', async stage => {
    const controller = new AbortController(); let release!: () => void;
    ai.configured.mockResolvedValue(true);
    if (stage === 'configuration') ai.configured.mockImplementation(() => new Promise<boolean>(resolve => { release = () => resolve(true); }));
    else ai.resolve.mockImplementation(() => new Promise(resolve => { release = () => resolve({ complete: ai.complete }); }));
    const work = runConcierge({ ...input, signal: controller.signal });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    controller.abort(); release();
    expect((await work).aiUsed).toBe(false); expect(ai.complete).not.toHaveBeenCalled();
  });

  it('forwards active cancellation to the provider and keeps the existing fallback result', async () => {
    const controller = new AbortController(); ai.configured.mockResolvedValue(true);
    ai.complete.mockImplementation((request: AICompleteInput) => new Promise((_resolve, reject) => {
      expect(request.signal).toBe(controller.signal);
      request.signal!.addEventListener('abort', () => reject(new Error('Synthetic aborted request')), { once: true });
    }));
    const work = runConcierge({ ...input, signal: controller.signal });
    await vi.waitFor(() => expect(ai.complete).toHaveBeenCalledOnce()); controller.abort();
    expect(await work).toMatchObject({ aiUsed: false, summary: input.text, reply: autoReplyText('personal', input.familyLabel) });
  });

  it('does not persist a late ignored-abort provider result after the receipt factory is cancelled', async () => {
    const controller = new AbortController(), fixture = receiptTransport();
    ai.configured.mockResolvedValue(true); let release!: () => void, factorySignal: AbortSignal | undefined;
    ai.complete.mockImplementation((request: AICompleteInput) => {
      expect(request.signal).toBe(factorySignal);
      return new Promise(resolve => { release = () => resolve(output('Late model result', 'Late model reply')); });
    });
    const pending = prepareSmsReply(fixture.client, binding, async signal => {
      factorySignal = signal;
      const result = await runConcierge({ ...input, text: binding.body, signal });
      signal.throwIfAborted();
      return { summary: result.summary, intent: result.intent, reply: result.reply, locale: 'en-US', suppression: null };
    }, { signal: controller.signal });
    const settled = pending.then(() => null, error => error);
    await vi.waitFor(() => expect(ai.complete).toHaveBeenCalledOnce());
    controller.abort(); expect(await settled).toBeInstanceOf(SmsReplyUnavailableError);
    expect(factorySignal?.aborted).toBe(true);
    release(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(fixture.writes).toEqual([]); expect(fixture.rows).toEqual([]);
  });
});
