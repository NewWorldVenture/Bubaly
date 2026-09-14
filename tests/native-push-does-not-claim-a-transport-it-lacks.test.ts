// Native push had no transport, and said it did.
//
// `lib/server/push.ts` POSTed `https://fcm.googleapis.com/fcm/send` with an
// `Authorization: key=<FCM_SERVER_KEY>` header — the FCM LEGACY HTTP API, which
// Google shut down on 2024-06-20 along with the server keys that authenticated
// it. Probed from this repo: that URL answers 404 Not Found from Google's
// frontend. Not 401, which would mean "alive, bad credential" — 404, the path is
// gone.
//
// So the send could only fail. The part that made it a defect rather than dead
// weight is that `pushConfigured()` reported `native: true` whenever that dead
// key was set, so the admin console showed native delivery as working, and
// docs/mobile.md instructed an operator to set the key "so lib/server/push.ts
// delivers to native tokens" — an instruction that cannot succeed.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { pushConfigured } from '@/lib/server/push';

const push = readFileSync('lib/server/push.ts', 'utf8');

describe('native push does not claim a transport it lacks', () => {
  it('reports native as unavailable, whatever credentials are set', () => {
    // The old report was `Boolean(process.env.FCM_SERVER_KEY)`, so setting a
    // decommissioned credential turned the claim true.
    const before = process.env.FCM_SERVER_KEY;
    process.env.FCM_SERVER_KEY = 'AAAA-a-legacy-server-key';
    try {
      expect(pushConfigured().native).toBe(false);
    } finally {
      if (before === undefined) delete process.env.FCM_SERVER_KEY;
      else process.env.FCM_SERVER_KEY = before;
    }
  });

  it('nothing posts to the decommissioned endpoint', () => {
    const files = execSync("git ls-files 'app/**/*.ts' 'lib/**/*.ts'", { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    // Comments are stripped: push.ts explains in prose why the endpoint is gone,
    // and a guard that reads source as text has to read CODE as text.
    const code = (file: string) => readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const callers = files.filter((f) => /fcm\.googleapis\.com\/fcm\/send/.test(code(f)));
    expect(callers, 'the FCM legacy endpoint was decommissioned on 2024-06-20').toEqual([]);
  });

  it('a native device is skipped, never counted as sent', () => {
    // The counter is the honest part and has to stay honest: a registered device
    // we cannot reach is neither a delivery nor a delivery failure.
    // Searched FORWARD from the marker: `} catch {` first occurs inside
    // ensureVapid, eighty lines above, so anchoring on its first occurrence
    // sliced an empty string and the case passed on nothing.
    const start = push.indexOf('// Native FCM/APNs');
    expect(start).toBeGreaterThan(-1);
    const branch = push.slice(start, push.indexOf('} catch {', start));
    expect(branch.length).toBeGreaterThan(0);
    expect(branch).toContain('result.skipped++');
    expect(branch).not.toContain('result.sent++');
  });

  it('the setup instructions no longer tell an operator to set the dead key', () => {
    const mobile = readFileSync('docs/mobile.md', 'utf8');
    expect(mobile).not.toMatch(/Set `FCM_SERVER_KEY` so .*delivers to native tokens/);
    // And what replaced it names what native delivery would actually take, so
    // the gap is actionable rather than merely acknowledged.
    expect(mobile).toContain('HTTP v1');
    expect(mobile).toContain('messages:send');
  });
});
