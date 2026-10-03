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
// first tick ever — is not a failure: it starts the chain.
//
// The step is shell inside YAML, so this runs that shell, byte for byte as the
// workflow carries it, under the same `bash -eo pipefail` the runner uses, with
// a fake `gh` on the path for each of the five ways the real one can answer.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/cron-dispatch.yml', 'utf8');
const STAMP = '2026-10-03T08:58:12Z';

/** The `run: |` block of the named step, dedented — a YAML literal block read by indentation, no parser needed for this file. */
function stepShell(stepName: string): string {
  const lines = workflow.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  expect(at, `step "${stepName}" not found`).toBeGreaterThan(-1);
  const runAt = lines.findIndex((l, i) => i > at && /^\s*run: \|\s*$/.test(l));
  expect(runAt, `step "${stepName}" has no run: | block`).toBeGreaterThan(at);
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

type Mode = 'ok' | 'empty' | 'forbidden' | 'malformed' | 'absent';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cron-boundary-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Run the boundary step's shell with a fake `gh` that answers in one of the five ways. */
function boundaryStep(mode: Mode): { exit: number; stdout: string; outputs: Record<string, string> } {
  const bin = join(dir, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  if (mode !== 'absent') {
    const gh = join(bin, 'gh');
    writeFileSync(gh, [
      '#!/usr/bin/env bash',
      `case "$FAKE_GH" in`,
      `  ok) printf '%s\\n' '${STAMP}' ;;`,
      '  empty) ;;',
      "  forbidden) echo 'gh: Resource not accessible by integration (HTTP 403)' >&2; exit 1 ;;",
      "  malformed) echo 'null' ;;",
      'esac',
    ].join('\n'));
    chmodSync(gh, 0o755);
  }
  const output = join(dir, 'output');
  writeFileSync(output, '');
  let exit = 0;
  let stdout = '';
  try {
    stdout = execFileSync('bash', ['-eo', 'pipefail', '-c', stepShell('Find the previous successful tick (catch-up boundary)')], {
      encoding: 'utf8',
      // Only the fake directory and the system shell tools: the session's own gh must not answer.
      env: { NODE_ENV: 'test', PATH: `${bin}:/usr/bin:/bin`, FAKE_GH: mode, GH_TOKEN: 'fixture', REPO: 'NewWorldVenture/Bubaly', RUN_ID: '424242', GITHUB_OUTPUT: output },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failed = error as { status?: number; stdout?: string };
    exit = failed.status ?? 1;
    stdout = failed.stdout ?? '';
  }
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => {
    const eq = l.indexOf('=');
    return [l.slice(0, eq), l.slice(eq + 1)];
  }));
  return { exit, stdout, outputs };
}

describe('the boundary step', () => {
  it('takes a well-formed previous start as the boundary', () => {
    const r = boundaryStep('ok');
    expect(r.exit).toBe(0);
    expect(r.outputs).toEqual({ since: STAMP, lookup: 'ok' });
    expect(r.stdout).toContain(`Previous successful tick started at ${STAMP}`);
  });

  it('treats "no previous scheduled success" as the start of the chain, not a failure', () => {
    // The first tick ever, or the first after the history is gone. Failing it
    // would fail every tick for ever: no success, so never a boundary.
    const r = boundaryStep('empty');
    expect(r.exit).toBe(0);
    expect(r.outputs).toEqual({ since: '', lookup: 'ok' });
    expect(r.stdout).toContain('starts the chain');
  });

  it.each<Mode>(['forbidden', 'absent', 'malformed'])('records a %s lookup as failed, with no boundary, and still lets the dispatch run', (mode) => {
    // The defect: all three used to look exactly like "empty" — a green tick
    // with a five-minute window, taken as the boundary by the next tick.
    const r = boundaryStep(mode);
    expect(r.exit, 'the step itself must not fail: the routes due this tick are still dispatched').toBe(0);
    expect(r.outputs).toEqual({ since: '', lookup: 'failed' });
    expect(r.stdout).toContain('this tick will not be a boundary');
  });
});

describe('the run that follows a failed lookup', () => {
  const steps = workflow.slice(workflow.indexOf('    steps:'));
  const names = [...steps.matchAll(/^\s*- name: (.+)$/gm)].map((m) => m[1]);

  it('dispatches first and only then fails itself, so nothing due this tick is skipped', () => {
    expect(names.indexOf('Validate configuration and dispatch due routes')).toBeGreaterThan(names.indexOf('Find the previous successful tick (catch-up boundary)'));
    expect(names.indexOf('A tick that could not find its boundary is not one')).toBeGreaterThan(names.indexOf('Validate configuration and dispatch due routes'));
  });

  it('fails the run exactly when the lookup failed, and says why', () => {
    const last = steps.slice(steps.indexOf('- name: A tick that could not find its boundary is not one'));
    expect(last).toMatch(/if: steps\.previous\.outputs\.lookup == 'failed'/);
    expect(last).toMatch(/::error::/);
    expect(last).toMatch(/exit 1/);
    // The dispatch step carries no such condition: a failed lookup never stops a dispatch.
    const dispatch = steps.slice(steps.indexOf('- name: Validate configuration and dispatch due routes'), steps.indexOf('- name: A tick that could not find its boundary is not one'));
    expect(dispatch).not.toMatch(/\bif:/);
  });

  it('is excluded from the boundary query by the status filter that already existed', () => {
    // The whole fix rests on this: the query reads successes only, so a run
    // failed on purpose is invisible to the next tick.
    expect(stepShell('Find the previous successful tick (catch-up boundary)')).toContain('status=success&event=schedule');
  });
});
