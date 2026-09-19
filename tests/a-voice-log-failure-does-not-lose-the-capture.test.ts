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
  it('has exactly two history writes', () => {
    const writes = source.match(/from\('voice_commands'\)\s*\.insert\(/g) ?? [];
    expect(writes).toHaveLength(2);
  });

  it('gives each of them a rejection handler', () => {
    // `.then(onFulfilled, onRejected)` — a bare `await`, a `.then(ok)` with one
    // argument, or a `.catch()` added later would all leave the reject path
    // open; the two-argument form is what settles it here.
    const guarded = source.match(/\}\)(?:\.select\('id'\))?\.then\(\s*\n\s*\(\{ error \}\)/g) ?? [];
    expect(guarded, 'a voice_commands insert can still reject into run()').toHaveLength(2);
  });

  it('records the failure rather than swallowing it silently', () => {
    // Best-effort is not "unobservable": both paths log, so a history that
    // stops being written is findable.
    expect(source).toContain("console.error('[voice] history write failed'");
    expect(source).toContain("console.error('[voice] failure history write failed'");
  });

  it('still reports a real command failure to the user', () => {
    // The control: making the log unable to throw must not disarm the catch
    // that reports an actual saveCapture failure.
    expect(source).toContain("toastError(describeDbError(err, tr('voiceModule.couldNotRunThatCommand')))");
  });

  it('still offers Undo on success', () => {
    // The other control: the success path, which the rejection was destroying.
    expect(source).toContain("label: 'Undo'");
  });
});
