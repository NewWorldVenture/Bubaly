// Ask Bubaly — the shared entry (§16) and the client contract it speaks.
//
// The pure parts get real unit tests: the suggested prompts, the intake
// parser, the browser submit helpers over a fake fetch, and the command bar's
// mapping of the assistant fallback onto a concierge request. The component
// itself has no DOM harness in this repo, so its invariants — 16px input,
// 44px submit target, navigation-vs-request split, inline clarification — are
// pinned as a source contract.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_AI_REQUEST_TEXT_CHARS, answerAIRequest, parseAIRequestIntake, runPagePath, submitAIRequest,
} from '@/lib/ai/chat-request';
import { MAX_SUGGESTIONS, SUGGESTED_PROMPTS, moduleFromPathname, suggestedPromptsFor } from '@/lib/concierge/suggested-prompts';
import { toCommandBarResults } from '@/components/app/command-bar';
import { FEATURE_CATALOG_BY_KEY } from '@/lib/constants/feature-catalog';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('suggested prompts', () => {
  it('offers the six §16 prompts, in order, on Home', () => {
    expect(SUGGESTED_PROMPTS).toEqual([
      'Plan our week', 'Take care of dinner', 'Organize our weekend', 'What are we forgetting?', 'Prepare for our trip', 'Help us save money',
    ]);
    expect(suggestedPromptsFor('/home').map((p) => p.text)).toEqual([...SUGGESTED_PROMPTS]);
    expect(suggestedPromptsFor(null).map((p) => p.text)).toEqual([...SUGGESTED_PROMPTS]);
  });

  it('leads with the module\'s prompts, fills with defaults, never repeats, and caps at six', () => {
    const meals = suggestedPromptsFor('/dashboard/meals/plan');
    expect(meals).toHaveLength(MAX_SUGGESTIONS);
    expect(meals[0]).toEqual({ text: 'Plan dinners for this week', module: 'meals' });
    expect(meals.slice(3).every((p) => p.module === null)).toBe(true);
    const texts = meals.map((p) => p.text.toLowerCase());
    expect(new Set(texts).size).toBe(texts.length);

    // "Help us save money" is both a finance prompt and a default: it appears once.
    const finance = suggestedPromptsFor('/dashboard/billing').map((p) => p.text);
    expect(finance.filter((t) => t === 'Help us save money')).toHaveLength(1);
    expect(finance).toHaveLength(MAX_SUGGESTIONS);
  });

  it('names the module for the context envelope and stays quiet elsewhere', () => {
    expect(moduleFromPathname('/dashboard/calendar')).toBe('calendar');
    expect(moduleFromPathname('/dashboard/calendar/?view=week')).toBe('calendar');
    expect(moduleFromPathname('/dashboard/trips/abc')).toBe('trips');
    expect(moduleFromPathname('/dashboard/homework')).toBe('school');
    expect(moduleFromPathname('/home')).toBeNull();
    expect(moduleFromPathname('/dashboard')).toBeNull();
    expect(moduleFromPathname(undefined)).toBeNull();
  });
});

describe('parseAIRequestIntake', () => {
  it('normalizes a full body', () => {
    expect(parseAIRequestIntake({
      text: '  Plan our week ', conversationId: ' 123e4567-e89b-12d3-a456-426614174000 ',
      context: { module: 'calendar', entityIds: ['123e4567-e89b-12d3-a456-426614174000', 'nope'] },
      answers: { 'Which weekend?': ' this one ', '': 'x', blank: '  ' },
    })).toEqual({
      ok: true,
      value: {
        text: 'Plan our week', conversationId: '123e4567-e89b-12d3-a456-426614174000',
        context: { module: 'calendar', entityIds: ['123e4567-e89b-12d3-a456-426614174000'] },
        answers: { 'Which weekend?': 'this one' },
      },
    });
  });

  it('rejects the invalid shapes with stable codes', () => {
    expect(parseAIRequestIntake(null)).toEqual({ ok: false, error: 'invalid_body' });
    expect(parseAIRequestIntake([])).toEqual({ ok: false, error: 'invalid_body' });
    expect(parseAIRequestIntake({ text: '  ' })).toEqual({ ok: false, error: 'text_required' });
    expect(parseAIRequestIntake({ text: 'x'.repeat(MAX_AI_REQUEST_TEXT_CHARS + 1) })).toEqual({ ok: false, error: 'text_too_long' });
    expect(parseAIRequestIntake({ text: 'hi', conversationId: 'nope' })).toEqual({ ok: false, error: 'conversation_invalid' });
  });

  it('treats an absent or empty context/answers as null', () => {
    const parsed = parseAIRequestIntake({ text: 'hi', context: {}, answers: {} });
    expect(parsed).toEqual({ ok: true, value: { text: 'hi', conversationId: null, context: null, answers: null } });
  });
});

describe('browser helpers', () => {
  function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('posts to /api/ai/requests and returns the 202 body', async () => {
    const data = { requestId: 'req-1', runId: 'run-1', planId: 'plan-1', outcome: 'plan', summary: 'Done.', redirect: '/dashboard/concierge/runs/run-1' };
    const { impl, calls } = fakeFetch(202, data);
    const result = await submitAIRequest({ text: 'Plan our week', context: { module: 'calendar' } }, impl);
    expect(result).toEqual({ ok: true, data });
    expect(calls[0].url).toBe('/api/ai/requests');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ text: 'Plan our week', context: { module: 'calendar' } });
  });

  it('surfaces the route\'s error copy, code and Retry-After', async () => {
    const { impl } = fakeFetch(429, { error: 'Too many requests. Please try again shortly.', code: 'rate_limited' }, { 'retry-after': '12' });
    expect(await submitAIRequest({ text: 'x' }, impl)).toEqual({ ok: false, status: 429, error: 'Too many requests. Please try again shortly.', code: 'rate_limited', retryAfter: 12 });
  });

  it('never throws on a network failure', async () => {
    const impl = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await submitAIRequest({ text: 'x' }, impl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(0);
    vi.restoreAllMocks();
  });

  it('answers a run through its own control route', async () => {
    const { impl, calls } = fakeFetch(202, { requestId: 'req-1', runId: 'run-1', planId: 'plan-2', outcome: 'plan', summary: 'Sorted.', redirect: runPagePath('run-1') });
    const result = await answerAIRequest('run-1', 'This one', impl);
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe('/api/ai/runs/run-1/answer');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ answer: 'This one' });
    expect(runPagePath('a b')).toBe('/dashboard/concierge/runs/a%20b');
  });
});

describe('command bar', () => {
  it('turns the assistant fallback into a request and leaves navigation, captures and intents alone', () => {
    const mapped = toCommandBarResults([
      { kind: 'navigate', href: '/dashboard/calendar', label: 'Calendar', score: 100 },
      { kind: 'capture', captureKind: 'task', text: 'pay rent', label: 'Task: “pay rent”', explicit: true },
      { kind: 'assistant', query: 'plan our week', label: 'Ask the assistant: “plan our week”' },
    ]);
    expect(mapped[0]).toMatchObject({ kind: 'navigate', href: '/dashboard/calendar' });
    expect(mapped[1]).toMatchObject({ kind: 'capture', captureKind: 'task' });
    expect(mapped[2]).toEqual({ kind: 'request', text: 'plan our week', label: 'Ask Bubaly: “plan our week”' });
    expect(mapped.map((r) => r.kind)).toEqual(['navigate', 'capture', 'request']);
  });

  it('files the request from the bar, never the old assistant deep link', () => {
    const source = read('components/app/command-bar.tsx');
    expect(source).toContain("submitAIRequest({ text: r.text");
    expect(source).not.toContain('/dashboard/assistant?q=');
  });
});

describe('AskBubaly component contract', () => {
  const source = read('components/concierge/ask-bubaly.tsx');

  it('is a client component that posts to the request route and lands on the run page', () => {
    expect(source.startsWith("'use client'")).toBe(true);
    expect(source).toContain("from '@/lib/ai/chat-request'");
    expect(source).toContain('submitAIRequest({');
    expect(source).toContain('answerAIRequest(inline.runId');
    expect(source).toContain('router.push(data.redirect)');
    expect(source).toContain('suggestedPromptsFor(pathname)');
    expect(source).toContain('How can I help your family?');
  });

  it('keeps page names routing through the shared command router', () => {
    expect(source).toContain("from '@/lib/command-bar/route'");
    expect(source).toContain("top.kind === 'navigate'");
  });

  it('is mobile-first: a 16px input and a 44px submit target on touch', () => {
    const inputTag = source.slice(source.indexOf('<input'), source.indexOf('/>', source.indexOf('<input')));
    expect(inputTag).toContain('text-base');
    expect(inputTag).toContain('h-12');
    const submit = source.slice(source.indexOf('aria-label="Ask Bubaly"'), source.indexOf('</button>', source.indexOf('aria-label="Ask Bubaly"')));
    expect(submit).toContain('h-11 w-11');
    expect(submit).toContain('coarse:min-h-11');
  });

  it('shows loading, error, and the inline clarification / answer states, and never renders a model chain of thought', () => {
    expect(source).toContain('role="status"');
    expect(source).toContain('role="alert"');
    expect(source).toContain("inline?.kind === 'clarification'");
    expect(source).toContain("inline?.kind === 'answer' || inline?.kind === 'recommendation'");
    expect(source).not.toMatch(/reasoning|chain[_ -]of[_ -]thought/i);
  });

  it('is what the Home Ask bar renders', () => {
    const askBar = read('components/home/ask-bar.tsx');
    expect(askBar).toContain("from '@/components/concierge/ask-bubaly'");
    expect(askBar).toContain('<AskBubaly variant="hero" />');
  });
});

describe('feature catalog', () => {
  it('gates the concierge behind one ai-requests entry at the Basic tier', () => {
    expect(FEATURE_CATALOG_BY_KEY['ai-requests']).toMatchObject({ label: 'Ask Bubaly', defaultTier: 'basic', href: '/dashboard/concierge/runs' });
  });
});
