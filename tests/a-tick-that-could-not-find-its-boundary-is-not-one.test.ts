// A cron tick that could not read its catch-up boundary must not become the
// next tick's boundary.
//
// .github/workflows/cron-dispatch.yml asks the Actions API for the previous
// successful SCHEDULED run and hands its start to the dispatcher as CRON_SINCE.
// When that lookup failed, the tick fell back to its fixed five-minute window —
// right — and then finished green — wrong: the boundary step reads only
// `status=success` runs, so the next tick took the fallback run as its
// boundary and every minute between the last real success and the fallback was
// lost for good. Last covered 03:00; the 09:07 lookup fails, the fixed window
// dispatches, green; the 12:07 lookup works and catches up from 09:07
// (review on #699, 5969190760).
//
// Three reviews shaped what the step has to tell apart. A lookup that FAILED is
// recorded as `lookup=failed`, the dispatch still runs, and a last step fails
// the run on purpose, so only a tick that knew its boundary can ever be one. A
// lookup that succeeded and found nothing — the first tick ever — is not a
// failure: it starts the chain. "Found nothing" is told apart from "found a run
// whose start is null, missing, malformed or in the future" (review
// 5970787916): the first starts the chain, the rest are failures, with the same
// two tests the dispatcher's tickWindow applies, so a boundary the step accepts
// is one the dispatcher will use. And "found nothing" is asked twice (review on
// #902, 5971121597): the success-only query is a filter over the whole history,
// so its empty answer is as true of a workflow whose every tick so far failed
// or was cancelled as of a first tick. No run at all starts the chain; runs
// with no success among them make the OLDEST one the boundary, since no
// successful tick has covered a minute after it (over-covering, never
// under-covering).
//
// The step that landed is not the shell this file first drove. #952 replaced
// it with `scripts/cron-run-history.mjs`, which asks the same questions and
// follows the API's pagination — a day of five-minute ticks is 288 runs and a
// page holds 100, so the shell's single `per_page=100` page could not see the
// oldest run of a full day — and clamps a history older than the catch-up cap
// to the 24-hour floor. These cases are the reviews' cases, run against that
// script's `discoverCatchUpBoundary` with a fake Actions API that applies the
// `status`, `event` and `created` filters and pages the way the real one does.
// The run-level half is pinned on the YAML.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, between } from './helpers/source-order';
import { tickWindow } from '../scripts/cron-dispatch.mjs';
import { discoverCatchUpBoundary } from '../scripts/cron-run-history.mjs';

const workflow = readFileSync('.github/workflows/cron-dispatch.yml', 'utf8');
const script = readFileSync('scripts/cron-run-history.mjs', 'utf8');
const BOUNDARY_STEP = 'Find the previous successful tick (catch-up boundary)';
const DISPATCH_STEP = 'Validate configuration and dispatch due routes';
const FAILING_STEP = 'A tick that could not find its boundary is not one';
const CURRENT_RUN = 424242;
const TOKEN = 'synthetic-workflow-token';
const REPO = 'NewWorldVenture/Bubaly';
const STAMP = '2026-10-03T08:58:12Z';
const NOON = new Date('2026-10-03T12:07:00Z');
/** The oldest minute the dispatcher would catch up from at noon: `CATCH_UP_MAX_MINUTES` before it. */
const FLOOR = '2026-10-02T12:07:00Z';

type Run = { id: number; conclusion: string | null; event: string; run_started_at?: string | null; created_at?: string };
/** A response body: the usual list, or any other shape the test wants to hand the script. */
type Body = { workflow_runs: Run[] } | Record<string, never> | null;

/**
 * A run as the API lists it. `created_at` is the start unless the test says
 * otherwise, and absent when there is no start to copy — a run that never
 * started still has a creation time in the real API; the cases that leave both
 * out are the reviews' bounded regressions, not observed behaviour.
 */
function run(id: number, conclusion: string | null, started: string | null | undefined, event = 'schedule', created?: string): Run {
  const r: Run = { id, conclusion, event };
  if (started !== undefined) r.run_started_at = started;
  const at = created ?? (typeof started === 'string' ? started : undefined);
  if (at !== undefined) r.created_at = at;
  return r;
}
const success = (id: number, started: string | null | undefined, event = 'schedule'): Run => run(id, 'success', started, event);
const ended = (id: number, started: string | null | undefined, conclusion = 'failure'): Run => run(id, conclusion, started);
/** The current run shows up in the unfiltered list as in progress. */
const current: Run = run(CURRENT_RUN, null, '2026-10-03T12:07:00Z');

function createdMatches(r: Run, filter: string | null): boolean {
  if (!filter) return true;
  const at = Date.parse(r.created_at ?? '');
  if (!Number.isFinite(at)) return false;
  if (filter.startsWith('>=')) return at >= Date.parse(filter.slice(2));
  if (filter.startsWith('<')) return at < Date.parse(filter.slice(1));
  throw new Error(`the fake API does not understand created=${filter}`);
}

/**
 * The Actions API, answering from a fixture body the way the real one would:
 * `status` against `conclusion`, `event`, `created` as a range over
 * `created_at`, newest first, `per_page` pages joined by a Link header, and
 * `total_count` for the whole match. A body of another shape is returned as
 * it is, so the script meets what a 403's JSON or a null would give it.
 */
function actionsApi(body: Body, opts: { forbidden?: boolean } = {}) {
  const requests: URL[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    if (opts.forbidden) {
      return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 });
    }
    const headers = new Headers({ 'content-type': 'application/json' });
    if (!body || !Array.isArray((body as { workflow_runs?: unknown }).workflow_runs)) {
      return new Response(JSON.stringify(body), { status: 200, headers });
    }
    const status = url.searchParams.get('status');
    const event = url.searchParams.get('event');
    const created = url.searchParams.get('created');
    const perPage = Number(url.searchParams.get('per_page') ?? '30');
    const page = Number(url.searchParams.get('page') ?? '1');
    const matching = (body as { workflow_runs: Run[] }).workflow_runs
      .filter((r) => (!status || r.conclusion === status) && (!event || r.event === event) && createdMatches(r, created))
      .sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''));
    const slice = matching.slice((page - 1) * perPage, page * perPage);
    if (page * perPage < matching.length) {
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      headers.set('link', `<${next.toString()}>; rel="next"`);
    }
    return new Response(JSON.stringify({ total_count: matching.length, workflow_runs: slice }), { status: 200, headers });
  };
  return { fetchImpl, requests };
}

async function boundary(body: Body, opts: { forbidden?: boolean; now?: Date } = {}) {
  const api = actionsApi(body, opts);
  const result = await discoverCatchUpBoundary({
    token: TOKEN, repo: REPO, currentRunId: String(CURRENT_RUN), fetchImpl: api.fetchImpl, now: opts.now ?? NOON,
  });
  return { ...result, requests: api.requests };
}

const FAILED = { lookup: 'failed', since: '', source: 'failure' };
const CHAIN_START = { lookup: 'ok', since: '', source: 'first-run' };
const iso = (stamp: string) => new Date(stamp).toISOString();

describe('the boundary lookup', () => {
  it('takes the previous scheduled success as the boundary', async () => {
    const r = await boundary({ workflow_runs: [success(CURRENT_RUN, '2026-10-03T12:07:00Z'), success(7, STAMP)] });
    expect(r).toMatchObject({ lookup: 'ok', since: iso(STAMP), source: 'success' });
  });

  it.each([
    ['no run at all', { workflow_runs: [] }],
    ['only this run', { workflow_runs: [current] }],
  ])('treats "no previous scheduled success" (%s) as the start of the chain, not a failure', async (_label, body) => {
    // The first tick ever, or the first after the history is gone. Failing it
    // would fail every tick for ever: no success, so never a boundary.
    const r = await boundary(body);
    expect(r).toMatchObject(CHAIN_START);
  });

  it.each([
    ['a null start', { workflow_runs: [success(7, null)] }],
    ['a missing start', { workflow_runs: [success(7, undefined)] }],
    ['a start that is not a timestamp', { workflow_runs: [success(7, 'yesterday')] }],
    ['a start in the future', { workflow_runs: [success(7, '2099-01-01T00:00:00Z')] }],
    ['a body with no run list', {}],
    ['a null body', null],
  ])('records a selected run with %s as a failed lookup — not as the start of the chain', async (_label, body) => {
    // The review's cases (5970787916). A run WAS found, so this is not the
    // first tick; its start is not something the dispatcher could use, so the
    // tick must not become a boundary. The future start in particular used to
    // pass as lookup=ok and be ignored by tickWindow — a green run with a
    // five-minute window, taken as the boundary by the next tick.
    const r = await boundary(body);
    expect(r).toMatchObject(FAILED);
    expect(r.reason).toBeTruthy();
  });

  it('takes the creation time of a success that never recorded a start — earlier, so it over-covers', async () => {
    // What the script does that the shell did not: `created_at` precedes
    // `run_started_at`, so a boundary read from it starts the window earlier
    // than the run did, never later. Skipping an unknown interval is the loss.
    const r = await boundary({ workflow_runs: [run(7, 'success', null, 'schedule', STAMP)] });
    expect(r).toMatchObject({ lookup: 'ok', since: iso(STAMP), source: 'success' });
  });

  it('records a 403 as a failed lookup, with no boundary, and names the status for the operator', async () => {
    const r = await boundary({ workflow_runs: [success(7, STAMP)] }, { forbidden: true });
    expect(r).toMatchObject(FAILED);
    expect(r.reason).toContain('HTTP 403');
    expect(r.reason).not.toContain(TOKEN);
  });

  it('applies the same validity tests as the dispatcher, so an accepted boundary is a used boundary', async () => {
    // Accepted by the lookup and used by tickWindow.
    expect((await boundary({ workflow_runs: [success(7, STAMP)] })).since).toBe(iso(STAMP));
    expect(tickWindow(NOON, iso(STAMP)).since?.toISOString()).toBe(iso(STAMP));
    // Refused by the lookup; tickWindow would have ignored each one silently.
    for (const bad of ['2099-01-01T00:00:00Z', 'yesterday']) {
      expect(await boundary({ workflow_runs: [success(7, bad)] })).toMatchObject(FAILED);
      expect(tickWindow(NOON, bad).since).toBeNull();
    }
  });
});

describe('three runs: the chain that the review described', () => {
  // Last covered 03:00 (A, success). The 09:07 tick (B) could not read its
  // boundary, dispatched five minutes, and — now — failed itself. The 12:07
  // tick (this run) asks for successes and is given A, so it catches up from
  // 03:00. A manual single-route run in between is excluded by event.
  const A = success(1, '2026-10-03T03:00:00Z');
  const manual = success(3, '2026-10-03T11:00:00Z', 'workflow_dispatch');

  it('a tick failed on purpose is invisible to the next one, which catches up from the last real success', async () => {
    const B = ended(2, '2026-10-03T09:07:00Z');
    const r = await boundary({ workflow_runs: [current, manual, B, A] });
    expect(r).toMatchObject({ lookup: 'ok', since: iso('2026-10-03T03:00:00Z'), source: 'success' });
    const window = tickWindow(NOON, r.since);
    expect(window.start.toISOString()).toBe('2026-10-03T03:00:00.000Z');
    expect(window.minutes).toBe(9 * 60 + 7);
    expect(window.note).toBeNull();
  });

  it('CONTROL: had the 09:07 tick finished green, the gap before it would have been lost', async () => {
    // The defect this fixes, kept as the negative control: the same runs with
    // B green, and the window starts at 09:07, not 03:00.
    const B = success(2, '2026-10-03T09:07:00Z');
    const r = await boundary({ workflow_runs: [current, manual, B, A] });
    expect(r).toMatchObject({ lookup: 'ok', since: iso('2026-10-03T09:07:00Z'), source: 'success' });
    expect(tickWindow(NOON, r.since).start.toISOString()).toBe('2026-10-03T09:07:00.000Z');
  });
});

describe('a history of ticks that never succeeded is not a first tick (review 5971121597)', () => {
  it("the review's chain: a 09:07 that failed and no success before it — the 12:07 tick catches up from 09:07 instead of starting the chain", async () => {
    const r = await boundary({ workflow_runs: [current, ended(2, '2026-10-03T09:07:00Z')] });
    expect(r).toMatchObject({ lookup: 'ok', since: iso('2026-10-03T09:07:00Z'), source: 'history' });
    const window = tickWindow(NOON, r.since);
    expect(window.start.toISOString()).toBe('2026-10-03T09:07:00.000Z');
    expect(window.minutes).toBe(3 * 60);
    expect(window.note).toBeNull();
  });

  it('several failed and cancelled ticks: the OLDEST is the boundary, so no minute one of them owned is skipped', async () => {
    const r = await boundary({ workflow_runs: [
      current,
      ended(4, '2026-10-03T11:02:00Z', 'cancelled'),
      ended(3, '2026-10-03T09:07:00Z'),
      // Never started, but created: its creation time counts, as above.
      run(2, 'failure', null, 'schedule', '2026-10-03T07:30:00Z'),
      ended(1, '2026-10-03T06:02:00Z', 'cancelled'),
    ] });
    expect(r).toMatchObject({ lookup: 'ok', since: iso('2026-10-03T06:02:00Z'), source: 'history' });
  });

  it('a day of failed ticks does not fit on one page: the oldest is still found, across every page', async () => {
    // 288 five-minute ticks since noon yesterday, all failed; the API hands
    // them over 100 at a time. The shell's single page saw the newest hundred
    // and would have taken the wrong "oldest" — about eight hours short.
    const ticks = Array.from({ length: 288 }, (_, i) => ended(1000 + i, new Date(NOON.getTime() - (i + 1) * 5 * 60_000).toISOString()));
    const r = await boundary({ workflow_runs: [current, ...ticks] });
    expect(r).toMatchObject({ lookup: 'ok', since: '2026-10-02T12:07:00.000Z', source: 'history' });
    expect(r.requests.filter((u) => u.searchParams.get('created') === `>=${FLOOR}`).map((u) => u.searchParams.get('page'))).toEqual([null, '2', '3']);
    expect(tickWindow(NOON, r.since).minutes).toBe(24 * 60);
  });

  it('a history older than the cap is clamped to the floor the dispatcher would clamp it to anyway', async () => {
    const r = await boundary({ workflow_runs: [current, ended(3, '2026-10-03T09:07:00Z'), ended(1, '2026-10-01T06:02:00Z')] });
    expect(r).toMatchObject({ lookup: 'ok', since: FLOOR, source: 'history-capped' });
    expect(tickWindow(NOON, r.since).minutes).toBe(24 * 60);
  });

  it('a manual run is not history for this purpose: event=schedule filters it out of both questions', async () => {
    // A green single-route run between two failed ticks neither becomes the
    // boundary (first question) nor counts as the first tick (second).
    const r = await boundary({ workflow_runs: [current, success(3, '2026-10-03T11:00:00Z', 'workflow_dispatch'), ended(2, '2026-10-03T09:07:00Z')] });
    expect(r).toMatchObject({ lookup: 'ok', since: iso('2026-10-03T09:07:00Z'), source: 'history' });
    for (const u of r.requests) expect(u.searchParams.get('event')).toBe('schedule');
  });

  it('a previous run with neither a start nor a creation time is a failed lookup, not the start of the chain', async () => {
    // Bounded regression: the API is not known to list such a run. If it did,
    // the minutes it owned cannot be placed, so the tick must not be a boundary.
    const r = await boundary({ workflow_runs: [current, success(2, null)] });
    expect(r).toMatchObject(FAILED);
  });

  it('once any tick has succeeded, the success is the boundary whatever failed before or after it', async () => {
    // The failure at 09:07 sits inside the catch-up from 03:00 anyway.
    const r = await boundary({ workflow_runs: [current, ended(2, '2026-10-03T09:07:00Z'), success(1, '2026-10-03T03:00:00Z')] });
    expect(r).toMatchObject({ lookup: 'ok', since: iso('2026-10-03T03:00:00Z'), source: 'success' });
    expect(r.requests).toHaveLength(1);
  });

  it('the first tick ever still starts the chain: the later questions are what tell it from failed history', async () => {
    const r = await boundary({ workflow_runs: [current] });
    expect(r).toMatchObject(CHAIN_START);
    // Asked in order: successes over the whole history; every scheduled run of
    // the last day; then whether anything older exists at all.
    expect(r.requests.map((u) => [u.searchParams.get('status'), u.searchParams.get('created')])).toEqual([
      ['success', null], [null, `>=${FLOOR}`], [null, null],
    ]);
  });
});

describe('the run that follows a failed lookup', () => {
  const steps = workflow.slice(at(workflow, '    steps:'));
  const names = [...steps.matchAll(/^\s*- name: (.+)$/gm)].map((m) => m[1]);

  it('dispatches first and only then fails itself, so nothing due this tick is skipped', () => {
    expect(at(names, DISPATCH_STEP)).toBeGreaterThan(at(names, BOUNDARY_STEP));
    expect(at(names, FAILING_STEP)).toBeGreaterThan(at(names, DISPATCH_STEP));
  });

  it('fails the scheduled run exactly when the lookup failed, and says why', () => {
    const last = steps.slice(at(steps, `- name: ${FAILING_STEP}`));
    expect(last).toMatch(/if: github\.event_name == 'schedule' && steps\.previous\.outputs\.lookup == 'failed'/);
    expect(last).toMatch(/::error::/);
    expect(last).toMatch(/exit 1/);
    // The dispatch step carries no such condition: a failed lookup never stops a dispatch.
    const dispatch = between(steps, `- name: ${DISPATCH_STEP}`, `- name: ${FAILING_STEP}`);
    expect(dispatch).not.toMatch(/\bif:/);
  });

  it('is excluded from the boundary query by the status filter that already existed', () => {
    // The whole fix rests on this: the first question reads successes only, so
    // a run failed on purpose is invisible to the next tick.
    const boundaryStep = between(steps, `- name: ${BOUNDARY_STEP}`, `- name: ${DISPATCH_STEP}`);
    expect(boundaryStep).toContain('run: node scripts/cron-run-history.mjs');
    expect(workflow).toMatch(/sparse-checkout: \|[\s\S]*scripts\/cron-run-history\.mjs/);
    expect(script).toContain("workflowRunsUrl({ repo, status: 'success', apiBaseUrl })");
    expect(script).toContain("url.searchParams.set('event', 'schedule')");
    expect(script).toContain("return { lookup: 'failed', since: '', source: 'failure'");
  });
});
