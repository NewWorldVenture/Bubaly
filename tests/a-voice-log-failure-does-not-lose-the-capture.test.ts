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
 *
 * Two sessions fixed this independently. main routed both writes through an
 * inline `recordVoiceHistory`; the audit branch (C1-S8-06) through
 * `recordVoiceCommand` in lib/voice/history.ts, which settles an ASYNC thunk
 * so a builder that throws synchronously is caught too, and which its own test
 * (tests/a-voice-failure-still-reaches-the-user.test.ts) drives against a
 * rejecting and a throwing client. The merge kept the library helper, so this
 * file pins the same properties against that name and home.
 */

const source = readFileSync('components/modules/voice-module.tsx', 'utf8');
const helperSource = readFileSync('lib/voice/history.ts', 'utf8');

describe('the voice history is written best-effort', () => {
  // Both writes go through `recordVoiceCommand`, which settles (an async thunk,
  // so a synchronous throw is settled too) and is called with `void` so the
  // capture is neither lost nor delayed by its own log. The property asserted
  // is that a history write cannot reject into run().

  it('sends both history writes through the best-effort helper', () => {
    expect(source.match(/void recordVoiceCommand\(/g) ?? []).toHaveLength(2);
  });

  it('has no bare awaited insert left in the command path', () => {
    expect(source).not.toMatch(/await sb\.from\('voice_commands'\)\s*\.insert\(/);
    expect(source).not.toMatch(/from\('voice_commands'\)\s*\.\s*insert\(/);
  });

  it('the helper cannot reject: it settles, and settles a synchronous throw too', () => {
    const helper = helperSource.slice(helperSource.indexOf('export async function recordVoiceCommand'));
    const body = helper.slice(0, helper.indexOf('\n}\n') + 2);
    expect(body).toMatch(/await settle\(/);
    // The async thunk is what turns a builder that THROWS into a settled
    // `{ error }`; without it settle is never reached.
    expect(body).toMatch(/await settle\(\(async \(\) => /);
  });

  it('records the failure rather than swallowing it silently', () => {
    expect(helperSource).toContain("console.error('[voice] command history write failed'");
  });

  it('still reports a real command failure to the user', () => {
    expect(source).toContain("toastError(describeDbError(err, tr('voiceModule.couldNotRunThatCommand')))");
  });
});
