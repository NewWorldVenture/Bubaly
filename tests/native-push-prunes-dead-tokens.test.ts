import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, between } from './helpers/source-order';

/**
 * Audit C1-S6-04 / C1-S6-05 — the native push branch, which Claude-3's session 5
 * named as never audited.
 *
 * ORIGINAL FINDING: the native branch never pruned a dead token, and worse,
 * FCM's LEGACY endpoint reports a dead token in the BODY with HTTP 200, so
 * `res.ok` counted an uninstalled app's token as **sent**, forever.
 *
 * That defect is gone twice over. The parallel session replaced the legacy
 * server-key endpoint with FCM v1 and a provider-specific APNs sender (its
 * PUSH-002), which reports a dead registration as 404 + a documented
 * `UNREGISTERED` detail rather than in a 200 body. This guard was written
 * against the legacy shape and asserted its literals — `FCM_DEAD_TOKEN`,
 * `parsed.results?.[0]?.error`, `FCM_SERVER_KEY`. Re-pointing it at the
 * replacement is not a weakening: every behaviour it protected is asserted
 * below, against the code that now exists. A guard that pins a shape rather
 * than a behaviour goes red when the code improves, which teaches the next
 * reader to delete it.
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const native = strip(readFileSync('lib/server/native-push.ts', 'utf8'));
const push = strip(readFileSync('lib/server/push.ts', 'utf8'));

describe('a native push token the provider calls dead is pruned', () => {
  it('counts a send only on positive provider acknowledgement, never on a bare status', () => {
    // The heart of the original finding: the status is not the answer. FCM v1
    // must return a well-formed message name, and APNs must return exactly 200.
    expect(native).not.toContain('return response.ok;');
    expect(native).toContain("/^projects\\/[^/]+\\/messages\\/.+/.test(result.name)");
    expect(native).toContain("if (status === 200) { finish('sent'); return; }");
  });

  it('treats only the documented provider verdict as "this registration is gone"', () => {
    // FCM: a 404 alone is a permission/project/path error and must NOT prune.
    const fcm = between(native, 'async function sendFcm(', 'function apnsBearer(');
    expect(fcm).toContain("response.status === 404");
    expect(fcm).toContain("errorCode === 'UNREGISTERED'");
    expect(fcm).toContain("'type.googleapis.com/google.firebase.fcm.v1.FcmError'");
    // Both conditions, not either: the status is necessary but not sufficient.
    expect(between(fcm, "response.status === 404", "'unregistered' : 'failed'")).toContain('&&');

    // APNs: 410 AND reason Unregistered.
    expect(native).toContain("status === 410 && reason === 'Unregistered' ? 'unregistered' : 'failed'");
  });

  it('does not mistake an expired PROVIDER credential for a dead DEVICE', () => {
    // Our credential problem must never cost a family their device registration.
    expect(native).toContain("status === 403 && reason === 'ExpiredProviderToken'");
    expect(native).toContain('apnsToken = undefined');
    expect(native).toContain('if (response.status === 401 && fcmToken === credential) fcmToken = undefined;');
  });

  it('counts `pruned` only when the delete landed, like the web branch', () => {
    const branch = push.slice(at(push, 'const outcome = await sendNativePush('));
    expect(branch).toContain('const { error: pruneError }');
    expect(at(branch, 'if (pruneError)')).toBeLessThan(at(branch, 'result.pruned++'));
    expect(between(branch, 'if (pruneError)', 'result.pruned++')).toContain('result.failed++');
  });

  it('a swallowed provider throw still reaches the caller as a counted failure', () => {
    // The parallel session chose NOT to log the provider body here, and the
    // reason is sound: FCM and APNs error bodies can carry the device token and
    // the notification text. So the operator signal is the returned outcome
    // rather than a log line — which means the outcome must be `failed`, never
    // a silent `sent` or a thrown error that escapes the per-device try.
    const tail = native.slice(at(native, 'export async function sendNativePush('));
    expect(tail).toContain("} catch {");
    expect(tail.slice(at(tail, '} catch {'))).toContain("return 'failed';");
    expect(tail).not.toMatch(/console\.(log|error|warn)\(/);
    // And push.ts must map every non-sent, non-unconfigured, non-unregistered
    // outcome onto the failure counter rather than dropping it. Sliced to the
    // native branch ALONE: an earlier version of this assertion searched from
    // the native branch to end-of-file and was satisfied by the unknown-provider
    // `else result.failed++;` further down, so a mutation that made the native
    // fallthrough count `skipped` survived it. The claim is now positional.
    // `at()` searches from the start of the file, and there is a `} catch {`
    // above this branch — using it as the end bound produced an EMPTY slice
    // that every `toContain` below would have passed vacuously. Bound it by
    // searching forward from the branch instead.
    const nativeAt = at(push, 'const outcome = await sendNativePush(');
    const branch = push.slice(nativeAt, push.indexOf('} catch {', nativeAt));
    expect(branch.length, 'the native branch slice is not empty').toBeGreaterThan(100);
    expect(branch).toContain('else result.failed++;');
    // Exactly one skip in this branch, and it is the unconfigured provider.
    expect(branch.match(/result\.skipped\+\+/g)).toHaveLength(1);
    expect(branch.slice(at(branch, 'result.skipped++') - 60, at(branch, 'result.skipped++'))).toContain("'unconfigured'");
  });

  it('the web branch it was measured against still prunes the same way', () => {
    expect(at(push, 'status === 404 || status === 410')).toBeLessThan(at(push, "from('push_devices').delete()"));
  });
});

describe('the native configuration gate', () => {
  it('reports native push as available only when a provider is fully configured', async () => {
    const { nativePushConfigured } = await import('@/lib/server/native-push');
    // No FCM service-account or APNs key material is present in the test env,
    // so both must read false. A gate that returned true here would send every
    // native notification into an unconfigured provider and count it skipped.
    expect(nativePushConfigured()).toEqual({ fcm: false, apns: false });
  });
});
