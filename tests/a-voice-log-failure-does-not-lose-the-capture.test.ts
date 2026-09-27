import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A best-effort write must actually be best-effort.
 *
 * `run()` in voice-module saves the capture, then logs the command to the
 * family's voice history under a comment that states the contract:
 *
 *   "best-effort — a logging failure must not lose the thing we just created"
 *
 * The log sat inside the same `try` as the capture, awaited bare. supabase-js
 * RESOLVES an API error as `{ error }` — which the bare await ignored, matching
 * the contract — but REJECTS a transport failure. A rejection there jumped
 * straight to the catch, which told the user "Could not run that command",
 * offered no Undo for the thing that HAD been created, and wrote a `failed` row
 * into the very history it was trying to keep honest. The capture survived in
 * the database with no way back to it from the UI.
 *
 * The second insert has the same shape inside the catch, where a rejection
 * would replace the real failure with its own and lose the message the user
 * needed.
 *
 * Both now terminate their own promise with an onRejected handler, which is
 * what "best-effort" has to mean for a promise that can reject.
 *
 * This is a source assertion: `run()` is a closure inside a client component
 * with speech, toast, journey and router dependencies, so driving it would
 * measure the harness more than the fix. What it pins is exact — the two
 * history writes must not be able to reject into the surrounding control flow.
 */

const source = readFileSync('components/modules/voice-module.tsx', 'utf8');

describe('the voice history is written best-effort', () => {
  // Two sessions fixed this independently; the one on main routes both writes
  // through `recordVoiceHistory`, which settles AND catches and is called with
  // `void` so the capture is neither lost nor delayed by its own log. The
  // property asserted is that a history write cannot reject into run().

  it('sends both history writes through the best-effort helper', () => {
    expect(source.match(/void recordVoiceHistory\(/g) ?? []).toHaveLength(2);
  });

  it('has no bare awaited insert left in the command path', () => {
    expect(source).not.toMatch(/await sb\.from\('voice_commands'\)\s*\.insert\(/);
  });

  it('the helper cannot reject: it settles, and catches what settling cannot', () => {
    const helper = source.slice(source.indexOf('async function recordVoiceHistory'));
    const body = helper.slice(0, helper.indexOf('\n}\n') + 2);
    expect(body).toMatch(/await settle\(/);
    expect(body).toMatch(/try \{[\s\S]*\} catch/);
  });

  it('records the failure rather than swallowing it silently', () => {
    expect(source).toContain("console.error('[voice] history write failed'");
  });

  it('still reports a real command failure to the user', () => {
    expect(source).toContain("toastError(describeDbError(err, tr('voiceModule.couldNotRunThatCommand')))");
  });
});
