import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

/**
 * A STOPPED CHAT TURN WRITES NOTHING MORE.
 *
 * Audit hold on #834 (2026-10-04): a client that cancelled the chat stream
 * after the first streamed action still saw a second write execute. The route
 * marked itself disconnected and stopped SENDING, but the provider's tool loop
 * went on running tools — each a write on the family's behalf — for a person
 * who had stopped the turn.
 *
 * The behaviour is proven at the provider in tests/assistant-stream.test.ts
 * (the signal is checked before every tool and every model round; a stream the
 * caller cut gets no closing summary). This file pins the route's half: the
 * stream's `cancel()` aborts a controller, that controller's signal is what the
 * provider is handed on both paths, and the non-streaming fallback is not taken
 * for a stream the person cut.
 */
const ROOT = join(__dirname, '..');
const route = readFileSync(join(ROOT, 'app/api/ai/chat/route.ts'), 'utf8');
const provider = readFileSync(join(ROOT, 'lib/ai/provider.ts'), 'utf8');

describe('the chat route hands the client\'s cancellation to the provider', () => {
  it('cancel() aborts the controller the provider is handed', () => {
    expect(route).toContain('const stopped = new AbortController();');
    expect(route).toContain('cancel() { connected = false; stopped.abort(); },');
    expect(route).toContain("provider.runToolsStream({ system, messages, tools, maxTokens: 1500, signal: stopped.signal })");
    expect(route).toContain("provider.runTools({ system, messages, tools, maxTokens: 1500, signal: stopped.signal })");
  });

  it('the non-streaming fallback is not taken for a stream the person cut', () => {
    expect(route).toContain('if (!content && actions.length === 0 && !stopped.signal.aborted) {');
  });

  it('what ran before the stop is still persisted: the insert follows the loop, unconditionally', () => {
    expect(at(route, 'for await (const ev of provider.runToolsStream(')).toBeLessThan(at(route, "await supabase.from('ai_messages').insert(["));
  });
});

describe('the provider stops at the signal, before every tool and every round', () => {
  const loop = provider.slice(provider.indexOf('async *runToolsStream('), provider.indexOf('* Retries.') > 0 ? provider.indexOf('* Retries.') : undefined);
  it('checks the signal before each model round, before each tool, and in place of a closing summary', () => {
    expect(loop.match(/if \(signal\?\.aborted\) return;/g)?.length).toBeGreaterThanOrEqual(3);
    expect(at(loop, 'for (let round = 0; round < maxRounds; round++) {')).toBeLessThan(at(loop, 'if (signal?.aborted) return;'));
    expect(at(loop, 'for (const c of calls) {')).toBeLessThan(at(loop, 'if (signal?.aborted) return;\n        let args: Record<string, unknown> = {};'));
    expect(at(loop, '} catch (streamError) {')).toBeLessThan(at(loop, 'if (signal?.aborted) return;\n        // Nothing has been written yet'));
  });
});
