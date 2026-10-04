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
// Now a lookup that FAILED is recorded as `lookup=failed`, the dispatch still
// runs, and a last step fails the run on purpose, so only a tick that knew its
// boundary can ever be one. A lookup that succeeded and found nothing — the
// first tick ever — is not a failure: it starts the chain. And "found nothing"
// is told apart from "found a run whose start is null, missing, malformed or
// in the future" (review 5970787916): the first starts the chain, the rest are
// failures, with the same two tests the dispatcher's tickWindow applies, so a
// boundary the step accepts is one the dispatcher will use.
//
// And "found nothing" is asked twice (review on #902, 5971121597). The
// success-only query is a filter over the whole history, so its empty answer
// means no scheduled run has EVER succeeded — which is true of a first tick and
// just as true of a workflow whose every tick so far failed or was cancelled:
// a 09:07 whose own lookup failed and failed itself, a tick that died on a
// blank CRON_SECRET. Treating that as the first tick dispatched five minutes,
// finished green, and became the next boundary, so 09:07 to 12:07 was never
// caught up. Now a `none` from the first query asks the second: previous
// scheduled runs of any conclusion. No run at all starts the chain; runs with
// no success among them make the OLDEST usable start the boundary, since no
// successful tick has covered a minute after it (over-covering, never
// under-covering); runs with no usable start are a failed lookup.
//
// The step is shell inside YAML, so this runs that shell, byte for byte as the
// workflow carries it, under the same `bash -eo pipefail` the runner uses, with
// PATH reduced to one directory of our own: a fake `gh` that answers from a
// fixture the way the API would (the `status`/`event` filters applied, the
// step's own --jq expression evaluated by the real jq), and the three
// coreutils the step and the fake need. The machine's `gh` cannot be reached
// (review 5970791078).
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { at, between } from './helpers/source-order';
import { tickWindow } from '../scripts/cron-dispatch.mjs';

const workflow = readFileSync('.github/workflows/cron-dispatch.yml', 'utf8');
const BOUNDARY_STEP = 'Find the previous successful tick (catch-up boundary)';
const DISPATCH_STEP = 'Validate configuration and dispatch due routes';
const FAILING_STEP = 'A tick that could not find its boundary is not one';
const CURRENT_RUN = 424242;
const STAMP = '2026-10-03T08:58:12Z';

/** The `run: |` block of the named step, dedented — a YAML literal block read by indentation, no parser needed for this file. */
function stepShell(stepName: string): string {
  const lines = workflow.split('\n');
  const atStep = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  expect(atStep, `step "${stepName}" not found`).toBeGreaterThan(-1);
  const runAt = lines.findIndex((l, i) => i > atStep && /^\s*run: \|\s*$/.test(l));
  expect(runAt, `step "${stepName}" has no run: | block`).toBeGreaterThan(atStep);
  const runIndent = lines[runAt].search(/\S/);
  const body: string[] = [];
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') { body.push(''); continue; }
    if (line.search(/\S/) <= runIndent) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(indent)).join('\n');
}

type Run = { id: number; conclusion: string | null; event: string; run_started_at?: string | null };
/** A response body: the usual list, or any other shape the test wants to hand the step. */
type Body = { workflow_runs: Run[] } | Record<string, never> | null;

const success = (id: number, run_started_at: string | null | undefined, event = 'schedule'): Run =>
  run_started_at === undefined ? { id, conclusion: 'success', event } : { id, conclusion: 'success', event, run_started_at };

/**
 * `gh api <url> --jq <expr>`, answered from $FAKE_RUNS the way the API would:
 * the `status` and `event` query filters applied to `workflow_runs` when the
 * body has one, then the step's own --jq expression run by the real jq, raw
 * output like gh's. FAKE_GH=forbidden answers as a token without actions:read.
 */
const FAKE_GH = `#!/bin/bash
set -o pipefail
if [[ "$FAKE_GH" == forbidden ]]; then echo 'gh: Resource not accessible by integration (HTTP 403)' >&2; exit 1; fi
url=''; expr=''
while (( $# )); do
  case "$1" in
    api) ;;
    --jq) expr="$2"; shift ;;
    *) url="$1" ;;
  esac
  shift
done
status="$(sed -n 's/.*[?&]status=\\([^&]*\\).*/\\1/p' <<<"$url")"
event="$(sed -n 's/.*[?&]event=\\([^&]*\\).*/\\1/p' <<<"$url")"
jq -r --arg status "$status" --arg event "$event" \\
  'if (type == "object" and (.workflow_runs | type) == "array")
   then .workflow_runs |= map(select(($status == "" or .conclusion == $status) and ($event == "" or .event == $event)))
   else . end' "$FAKE_RUNS" \\
  | jq -r "$expr"
`;

let dirs: string[];
beforeEach(() => { dirs = []; });
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function toolPath(name: string): string {
  const found = ['/usr/bin', '/bin'].map((d) => join(d, name)).find((p) => existsSync(p));
  expect(found, `${name} is needed on this machine to run the step`).toBeTruthy();
  return found as string;
}

/**
 * Run the boundary step's shell against a response body. PATH is one directory
 * of our own, so neither the machine's `gh` nor anything else on it can answer.
 */
function boundaryStep(body: Body, opts: { gh?: 'present' | 'forbidden' | 'absent' } = {}): { exit: number; stdout: string; stderr: string; outputs: Record<string, string> } {
  // A fresh directory per run of the step, so a test may run it more than once.
  const dir = mkdtempSync(join(tmpdir(), 'cron-boundary-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  execFileSync('/bin/mkdir', [bin]);
  for (const tool of ['date', 'jq', 'sed']) symlinkSync(toolPath(tool), join(bin, tool));
  const gh = opts.gh ?? 'present';
  if (gh !== 'absent') {
    writeFileSync(join(bin, 'gh'), FAKE_GH);
    chmodSync(join(bin, 'gh'), 0o755);
  }
  const fixture = join(dir, 'runs.json');
  writeFileSync(fixture, JSON.stringify(body));
  const output = join(dir, 'output');
  writeFileSync(output, '');
  const errors = join(dir, 'stderr');
  let exit = 0;
  let stdout = '';
  try {
    // The step's stderr goes to a file: execFileSync hands it back only on a
    // non-zero exit, and the step exits 0 on every lookup outcome by design.
    stdout = execFileSync('/bin/bash', ['-eo', 'pipefail', '-c', `exec 2>"${errors}"\n${stepShell(BOUNDARY_STEP)}`], {
      encoding: 'utf8',
      env: {
        NODE_ENV: 'test', PATH: bin, FAKE_GH: gh, FAKE_RUNS: fixture,
        GH_TOKEN: 'fixture', REPO: 'NewWorldVenture/Bubaly', RUN_ID: String(CURRENT_RUN), GITHUB_OUTPUT: output,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failed = error as { status?: number; stdout?: string };
    exit = failed.status ?? 1;
    stdout = failed.stdout ?? '';
  }
  const stderr = readFileSync(errors, 'utf8');
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => {
    const eq = l.indexOf('=');
    return [l.slice(0, eq), l.slice(eq + 1)];
  }));
  return { exit, stdout, stderr, outputs };
}

const FAILED = { since: '', lookup: 'failed' };
const CHAIN_START = { since: '', lookup: 'ok' };

describe('the boundary step', () => {
  it('takes the previous scheduled success as the boundary', () => {
    const r = boundaryStep({ workflow_runs: [success(CURRENT_RUN, '2026-10-03T12:07:00Z'), success(7, STAMP)] });
    expect(r.exit).toBe(0);
    expect(r.outputs).toEqual({ since: STAMP, lookup: 'ok' });
    expect(r.stdout).toContain(`Previous successful tick started at ${STAMP}`);
  });

  it.each([
    ['no run at all', { workflow_runs: [] }],
    ['only this run', { workflow_runs: [success(CURRENT_RUN, '2026-10-03T12:07:00Z')] }],
  ])('treats "no previous scheduled success" (%s) as the start of the chain, not a failure', (_label, body) => {
    // The first tick ever, or the first after the history is gone. Failing it
    // would fail every tick for ever: no success, so never a boundary.
    const r = boundaryStep(body);
    expect(r.exit).toBe(0);
    expect(r.outputs).toEqual(CHAIN_START);
    expect(r.stdout).toContain('starts the chain');
  });

  it.each([
    ['a null start', { workflow_runs: [success(7, null)] }],
    ['a missing start', { workflow_runs: [success(7, undefined)] }],
    ['a start that is not a timestamp', { workflow_runs: [success(7, 'yesterday')] }],
    ['a start in the future', { workflow_runs: [success(7, '2099-01-01T00:00:00Z')] }],
    ['a body with no run list', {}],
    ['a null body', null],
  ])('records a selected run with %s as a failed lookup — not as the start of the chain', (_label, body) => {
    // The review's cases. A run WAS found, so this is not the first tick; its
    // start is not something the dispatcher could use, so the tick must not
    // become a boundary. The future start in particular used to pass as
    // lookup=ok and be ignored by tickWindow — a green run with a five-minute
    // window, taken as the boundary by the next tick.
    const r = boundaryStep(body);
    expect(r.exit, 'the step itself must not fail: the routes due this tick are still dispatched').toBe(0);
    expect(r.outputs).toEqual(FAILED);
    expect(r.stdout).toContain('this tick will not be a boundary');
    expect(r.stdout).not.toContain('starts the chain');
  });

  it('records a 403 as a failed lookup, with no boundary, and still lets the dispatch run', () => {
    const r = boundaryStep({ workflow_runs: [success(7, STAMP)] }, { gh: 'forbidden' });
    expect(r.exit).toBe(0);
    expect(r.outputs).toEqual(FAILED);
    expect(r.stdout).toContain('The previous-tick lookup failed');
    expect(r.stderr, 'the API error is left in the log for the operator').toContain('HTTP 403');
  });

  it('records an absent gh as a failed lookup — and the only gh it could have reached is the fake one', () => {
    const r = boundaryStep({ workflow_runs: [success(7, STAMP)] }, { gh: 'absent' });
    expect(r.exit).toBe(0);
    expect(r.outputs).toEqual(FAILED);
    expect(r.stderr).toMatch(/gh: command not found/);
  });

  it('applies the same validity tests as the dispatcher, so an accepted boundary is a used boundary', () => {
    const now = new Date('2026-10-03T12:07:00Z');
    // Accepted by the step and used by tickWindow.
    expect(boundaryStep({ workflow_runs: [success(7, STAMP)] }).outputs.since).toBe(STAMP);
    expect(tickWindow(now, STAMP).since?.toISOString()).toBe(new Date(STAMP).toISOString());
    // Refused by the step; tickWindow would have ignored each one silently.
    for (const bad of ['2099-01-01T00:00:00Z', 'yesterday']) {
      expect(boundaryStep({ workflow_runs: [success(7, bad)] }).outputs).toEqual(FAILED);
      expect(tickWindow(now, bad).since).toBeNull();
    }
  });
});

describe('three runs: the chain that the review described', () => {
  // Last covered 03:00 (A, success). The 09:07 tick (B) could not read its
  // boundary, dispatched five minutes, and — now — failed itself. The 12:07
  // tick (C, this run) asks for successes and is given A, so it catches up
  // from 03:00. A manual single-route run in between is excluded by event.
  const A = success(1, '2026-10-03T03:00:00Z');
  const manual = success(3, '2026-10-03T11:00:00Z', 'workflow_dispatch');
  const C = success(CURRENT_RUN, '2026-10-03T12:07:00Z');
  const noon = new Date('2026-10-03T12:07:00Z');

  it('a tick failed on purpose is invisible to the next one, which catches up from the last real success', () => {
    const B: Run = { id: 2, conclusion: 'failure', event: 'schedule', run_started_at: '2026-10-03T09:07:00Z' };
    const r = boundaryStep({ workflow_runs: [C, manual, B, A] });
    expect(r.outputs).toEqual({ since: '2026-10-03T03:00:00Z', lookup: 'ok' });
    const window = tickWindow(noon, r.outputs.since);
    expect(window.start.toISOString()).toBe('2026-10-03T03:00:00.000Z');
    expect(window.minutes).toBe(9 * 60 + 7);
    expect(window.note).toBeNull();
  });

  it('CONTROL: had the 09:07 tick finished green, the gap before it would have been lost', () => {
    // The defect this fixes, kept as the negative control: the same three
    // runs with B green, and C's window starts at 09:07, not 03:00.
    const B = success(2, '2026-10-03T09:07:00Z');
    const r = boundaryStep({ workflow_runs: [C, manual, B, A] });
    expect(r.outputs).toEqual({ since: '2026-10-03T09:07:00Z', lookup: 'ok' });
    expect(tickWindow(noon, r.outputs.since).start.toISOString()).toBe('2026-10-03T09:07:00.000Z');
  });
});

describe('a history of ticks that never succeeded is not a first tick (review 5971121597)', () => {
  // The current run shows up in the unfiltered list as in progress.
  const current: Run = { id: CURRENT_RUN, conclusion: null, event: 'schedule', run_started_at: '2026-10-03T12:07:00Z' };
  const ended = (id: number, run_started_at: string | null | undefined, conclusion = 'failure'): Run =>
    run_started_at === undefined ? { id, conclusion, event: 'schedule' } : { id, conclusion, event: 'schedule', run_started_at };
  const noon = new Date('2026-10-03T12:07:00Z');

  it("the review's chain: a 09:07 that failed and no success before it — the 12:07 tick catches up from 09:07 instead of starting the chain", () => {
    const r = boundaryStep({ workflow_runs: [current, ended(2, '2026-10-03T09:07:00Z')] });
    expect(r.exit).toBe(0);
    expect(r.outputs).toEqual({ since: '2026-10-03T09:07:00Z', lookup: 'ok' });
    expect(r.stdout).toContain('No scheduled tick has succeeded yet; the oldest recorded one started at 2026-10-03T09:07:00Z');
    expect(r.stdout, 'what the success-only lookup used to say here').not.toContain('starts the chain');
    const window = tickWindow(noon, r.outputs.since);
    expect(window.start.toISOString()).toBe('2026-10-03T09:07:00.000Z');
    expect(window.minutes).toBe(3 * 60);
    expect(window.note).toBeNull();
  });

  it('several failed and cancelled ticks: the OLDEST usable start is the boundary, so no minute one of them owned is skipped', () => {
    const r = boundaryStep({ workflow_runs: [
      current,
      ended(4, '2026-10-03T11:02:00Z', 'cancelled'),
      ended(3, '2026-10-03T09:07:00Z'),
      ended(2, null),
      ended(1, '2026-10-03T06:02:00Z', 'cancelled'),
    ] });
    expect(r.exit).toBe(0);
    expect(r.outputs).toEqual({ since: '2026-10-03T06:02:00Z', lookup: 'ok' });
  });

  it('a manual run is not history for this purpose: event=schedule filters it out of both questions', () => {
    // A green single-route run between two failed ticks neither becomes the
    // boundary (first question) nor counts as the first tick (second).
    const r = boundaryStep({ workflow_runs: [current, success(3, '2026-10-03T11:00:00Z', 'workflow_dispatch'), ended(2, '2026-10-03T09:07:00Z')] });
    expect(r.outputs).toEqual({ since: '2026-10-03T09:07:00Z', lookup: 'ok' });
  });

  it('previous scheduled runs none of whose starts is usable: a failed lookup, not the start of the chain', () => {
    const r = boundaryStep({ workflow_runs: [current, ended(2, null), ended(1, undefined)] });
    expect(r.exit).toBe(0);
    expect(r.outputs).toEqual(FAILED);
    expect(r.stdout).toContain('this tick will not be a boundary');
    expect(r.stdout).not.toContain('starts the chain');
  });

  it('once any tick has succeeded, the success is the boundary whatever failed before or after it', () => {
    // The failure at 09:07 sits inside the catch-up from 03:00 anyway.
    const r = boundaryStep({ workflow_runs: [current, ended(2, '2026-10-03T09:07:00Z'), success(1, '2026-10-03T03:00:00Z')] });
    expect(r.outputs).toEqual({ since: '2026-10-03T03:00:00Z', lookup: 'ok' });
    expect(r.stdout).toContain('Previous successful tick started at 2026-10-03T03:00:00Z');
  });

  it('the first tick ever still starts the chain: the second question is what tells it from failed history', () => {
    const r = boundaryStep({ workflow_runs: [current] });
    expect(r.outputs).toEqual(CHAIN_START);
    expect(r.stdout).toContain('starts the chain');
    // Asked in order: successes over the whole history first, every scheduled
    // run only when there was none.
    const shell = stepShell(BOUNDARY_STEP);
    expect(at(shell, 'event=schedule&per_page=100')).toBeGreaterThan(at(shell, 'status=success&event=schedule&per_page=5'));
    expect(between(shell, 'if [[ "$answer" == none ]]; then', 'event=schedule&per_page=100')).not.toContain('starts the chain');
  });
});

describe('the run that follows a failed lookup', () => {
  const steps = workflow.slice(at(workflow, '    steps:'));
  const names = [...steps.matchAll(/^\s*- name: (.+)$/gm)].map((m) => m[1]);

  it('dispatches first and only then fails itself, so nothing due this tick is skipped', () => {
    expect(at(names, DISPATCH_STEP)).toBeGreaterThan(at(names, BOUNDARY_STEP));
    expect(at(names, FAILING_STEP)).toBeGreaterThan(at(names, DISPATCH_STEP));
  });

  it('fails the run exactly when the lookup failed, and says why', () => {
    const last = steps.slice(at(steps, `- name: ${FAILING_STEP}`));
    expect(last).toMatch(/if: steps\.previous\.outputs\.lookup == 'failed'/);
    expect(last).toMatch(/::error::/);
    expect(last).toMatch(/exit 1/);
    // The dispatch step carries no such condition: a failed lookup never stops a dispatch.
    const dispatch = between(steps, `- name: ${DISPATCH_STEP}`, `- name: ${FAILING_STEP}`);
    expect(dispatch).not.toMatch(/\bif:/);
  });

  it('is excluded from the boundary query by the status filter that already existed', () => {
    // The whole fix rests on this: the query reads successes only, so a run
    // failed on purpose is invisible to the next tick.
    expect(stepShell(BOUNDARY_STEP)).toContain('status=success&event=schedule');
  });
});
