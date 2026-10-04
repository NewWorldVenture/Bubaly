import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { discoverCatchUpBoundary } from '../scripts/cron-run-history.mjs';
import { dueRoutes, SCHEDULES, tickWindow, TICK_MINUTES } from '../scripts/cron-dispatch.mjs';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const CURRENT_RUN_ID = '900000';
const TOKEN = 'synthetic-workflow-token';
const REPO = 'NewWorldVenture/Bubaly';
const WORKFLOW = readFileSync('.github/workflows/cron-dispatch.yml', 'utf8');

type Run = {
  id: number;
  event: 'schedule';
  conclusion: string | null;
  run_started_at: string;
  created_at: string;
};

function failedRun(id: number, when: Date): Run {
  const timestamp = when.toISOString();
  return { id, event: 'schedule', conclusion: 'failure', run_started_at: timestamp, created_at: timestamp };
}

function response(runs: Run[], totalCount: number, requestUrl?: URL, nextPage?: number) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (requestUrl && nextPage) {
    const next = new URL(requestUrl);
    next.searchParams.set('page', String(nextPage));
    headers.set('link', `<${next.toString()}>; rel="next"`);
  }
  return new Response(JSON.stringify({ total_count: totalCount, workflow_runs: runs }), { status: 200, headers });
}

describe('cron history pagination', () => {
  it('wires the workflow token and boundary failure gate around a normal dispatch', () => {
    const historyLookup = WORKFLOW.indexOf('run: node scripts/cron-run-history.mjs');
    const dispatch = WORKFLOW.indexOf('node scripts/cron-dispatch.mjs');
    const failureGate = WORKFLOW.indexOf("if: github.event_name == 'schedule' && steps.previous.outputs.lookup == 'failed'");
    expect(WORKFLOW).toMatch(/actions:\s*read/);
    expect(WORKFLOW).toContain('GH_TOKEN: ${{ github.token }}');
    expect(WORKFLOW).toContain("cron: '*/5 * * * *'");
    expect(WORKFLOW).toContain('scripts/cron-run-history.mjs');
    expect(historyLookup).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(historyLookup);
    expect(failureGate).toBeGreaterThan(dispatch);
  });

  it('finds the 24-hour boundary across more than 100 scheduled runs and all API pages', async () => {
    const history: Run[] = [failedRun(Number(CURRENT_RUN_ID), NOW)];
    for (let index = 1; index <= 288; index += 1) {
      history.push(failedRun(index, new Date(NOW.getTime() - index * TICK_MINUTES * 60_000)));
    }

    const pages = [history.slice(0, 100), history.slice(100, 200), history.slice(200)];
    const requests: URL[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push(url);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(init?.redirect).toBe('error');

      if (url.searchParams.get('status') === 'success') return response([], 0);
      if (url.searchParams.get('created')?.startsWith('<')) return response([], 0);
      const pageNumber = Number(url.searchParams.get('page') ?? '1');
      return response(pages[pageNumber - 1] ?? [], history.length, url, pageNumber < pages.length ? pageNumber + 1 : undefined);
    };

    const result = await discoverCatchUpBoundary({ token: TOKEN, repo: REPO, currentRunId: CURRENT_RUN_ID, fetchImpl, now: NOW });
    expect(result).toEqual({ lookup: 'ok', since: '2026-10-03T12:00:00.000Z', source: 'history' });
    expect(requests.map((url) => url.searchParams.get('page'))).toEqual([null, null, '2', '3', null]);
    expect(requests[1].searchParams.get('event')).toBe('schedule');
    expect(requests[1].searchParams.get('per_page')).toBe('100');
    expect(requests[1].searchParams.has('status')).toBe(false);
    expect(requests[1].searchParams.get('created')).toBe('>=2026-10-03T12:00:00Z');
    expect(requests[1].toString()).toContain('created=%3E%3D2026-10-03T12%3A00%3A00Z');
    expect(requests[2].searchParams.get('created')).toBe(requests[1].searchParams.get('created'));
    expect(requests[3].searchParams.get('created')).toBe(requests[1].searchParams.get('created'));
    expect(requests[4].searchParams.get('created')).toBe('<2026-10-03T12:00:00Z');

    // Historical runs define one capped catch-up window; the dispatcher does
    // not replay a separate request for every historical Actions run.
    const window = tickWindow(NOW, result.since);
    expect(window.minutes).toBe(24 * 60);
    expect(window.start.toISOString()).toBe(result.since);
    const routes = dueRoutes(NOW, SCHEDULES, TICK_MINUTES, result.since);
    expect(routes.length).toBeGreaterThan(0);
    expect(new Set(routes).size).toBe(routes.length);
    // A day-long window holds one 12:30; admin-digest — the one daily route the
    // catch-up calls again, because a second call within its occurrence sends
    // nothing more (OCCURRENCE_SAFE_DAILY) — is therefore due, once. The other
    // daily routes in that day stay Vercel's.
    expect(routes.filter((r) => r === '/api/cron/admin-digest')).toHaveLength(1);
    expect(routes).not.toContain('/api/cron/notifications');
    expect(routes).not.toContain('/api/cron/calendar-feeds');
  });

  it('uses the previous successful scheduled run without scanning the failed-history pages', async () => {
    const success = failedRun(123, new Date('2026-10-04T11:55:00.000Z'));
    success.conclusion = 'success';
    const requests: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      return response([success], 1);
    };

    const result = await discoverCatchUpBoundary({ token: TOKEN, repo: REPO, currentRunId: CURRENT_RUN_ID, fetchImpl, now: NOW });
    expect(result).toEqual({ lookup: 'ok', since: '2026-10-04T11:55:00.000Z', source: 'success' });
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get('status')).toBe('success');
  });

  it('only treats a truly empty schedule history as the first tick', async () => {
    const fetchImpl: typeof fetch = async () => response([], 0);
    const result = await discoverCatchUpBoundary({ token: TOKEN, repo: REPO, currentRunId: CURRENT_RUN_ID, fetchImpl, now: NOW });
    expect(result).toEqual({ lookup: 'ok', since: '', source: 'first-run' });
  });

  it('uses the 24-hour floor when over 1,000 older failures exist but the bounded history is empty', async () => {
    const current = failedRun(Number(CURRENT_RUN_ID), NOW);
    const oldRuns = Array.from({ length: 1_001 }, (_, index) => failedRun(index + 1, new Date(NOW.getTime() - (25 * 60 + index * TICK_MINUTES) * 60_000)));
    const apiLatestPage = [current, ...oldRuns].slice(0, 100);
    const requests: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.searchParams.get('status') === 'success') return response([], 0);
      if (url.searchParams.get('created')?.startsWith('>=')) return response([current], 1);
      // GitHub limits a search to 1,000 results; only presence matters here,
      // and one page proves older history exists without scanning to that cap.
      return response(apiLatestPage, 1_000, url, 2);
    };

    const result = await discoverCatchUpBoundary({ token: TOKEN, repo: REPO, currentRunId: CURRENT_RUN_ID, fetchImpl, now: NOW });
    expect(result).toEqual({ lookup: 'ok', since: '2026-10-03T12:00:00Z', source: 'history-capped' });
    expect(requests).toHaveLength(3);
    expect(requests[1].searchParams.get('created')).toBe('>=2026-10-03T12:00:00Z');
    expect(requests[2].searchParams.has('created')).toBe(false);
    expect(requests[2].searchParams.get('per_page')).toBe('100');
    expect(tickWindow(NOW, result.since).minutes).toBe(24 * 60);
  });

  it('uses the 24-hour floor when older history may have started late despite recent attempts', async () => {
    const current = failedRun(Number(CURRENT_RUN_ID), NOW);
    const recent = failedRun(123, new Date('2026-10-04T11:55:00.000Z'));
    const old = failedRun(122, new Date('2026-10-03T10:00:00.000Z'));
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get('status') === 'success') return response([], 0);
      if (url.searchParams.get('created')?.startsWith('>=')) return response([current, recent], 2);
      if (url.searchParams.get('created')?.startsWith('<')) return response([old], 1);
      throw new Error('Unexpected synthetic request.');
    };

    const result = await discoverCatchUpBoundary({ token: TOKEN, repo: REPO, currentRunId: CURRENT_RUN_ID, fetchImpl, now: NOW });
    expect(result).toEqual({ lookup: 'ok', since: '2026-10-03T12:00:00Z', source: 'history-capped' });
    expect(tickWindow(NOW, result.since).minutes).toBe(24 * 60);
  });

  it('treats a permission failure as an unusable boundary instead of mistaking it for a first tick', async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 });
    const result = await discoverCatchUpBoundary({ token: TOKEN, repo: REPO, currentRunId: CURRENT_RUN_ID, fetchImpl, now: NOW });
    expect(result).toMatchObject({ lookup: 'failed', since: '', source: 'failure' });
    expect(result.reason).toContain('HTTP 403');
    expect(result.reason).not.toContain(TOKEN);
  });

  it('keeps an absent-token diagnostic readable without trying to redact an empty string', async () => {
    const result = await discoverCatchUpBoundary({ token: '', repo: REPO, currentRunId: CURRENT_RUN_ID, fetchImpl: fetch, now: NOW });
    expect(result).toMatchObject({ lookup: 'failed', since: '', source: 'failure', reason: 'The workflow token is missing.' });
  });

  it('refuses a pagination link that could send the workflow token to another host', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get('status') === 'success') return response([], 0);
      return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), {
        status: 200,
        headers: { link: '<https://attacker.invalid/runs?page=2>; rel="next"' },
      });
    };
    const result = await discoverCatchUpBoundary({ token: TOKEN, repo: REPO, currentRunId: CURRENT_RUN_ID, fetchImpl, now: NOW });
    expect(result).toMatchObject({ lookup: 'failed', since: '', source: 'failure' });
    expect(result.reason).toContain('unexpected workflow-run pagination link');
  });
});
