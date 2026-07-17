import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// A-05 (agent-05, PLA-0791): the settings profile form loaded `profiles` with a
// dropped `error`, prefilled a BLANK phone/avatar on failure, and still marked the
// form loaded+editable. Because saveUserProfile writes `phone`/`avatar_url`
// UNCONDITIONALLY, a Save after a transient read failure silently WIPED the user's
// real phone number and avatar — a destructive write triggered by a silent read
// failure. The fix keeps the form disabled on error (no blank overwrite) + a retry.

const mod = fs.readFileSync('components/modules/settings-module.tsx', 'utf8');
const profiles = fs.readFileSync('lib/server/profiles.ts', 'utf8');

describe('settings profile read boundary (destructive-write guard)', () => {
  it('captures the profiles read error', () => {
    expect(mod).toContain("const { data, error } = await supabase.from('profiles')");
  });

  it('does NOT mark the form loaded/editable when the read failed', () => {
    // On error it must bail before setProfileLoaded(true) and flag profileError.
    const load = mod.slice(mod.indexOf("from('profiles')"), mod.indexOf('setProfileLoaded(true)'));
    expect(load).toContain('if (error)');
    expect(load).toContain('setProfileError(true)');
    expect(load).toContain('setProfileLoaded(false)');
  });

  it('guards the save path against submitting an unloaded (blank) form', () => {
    const save = mod.slice(mod.indexOf('async function saveProfile'), mod.indexOf('async function saveFamilyName'));
    expect(save).toContain('if (!profileLoaded) return;');
  });

  it('surfaces a retryable error instead of a silent blank form', () => {
    expect(mod).toContain('profileError &&');
    expect(mod).toContain('setProfileReloadKey');
    expect(mod).toContain('role="alert"');
  });

  it('documents that saveUserProfile writes phone unconditionally (why the guard matters)', () => {
    // If this ever becomes conditional, the guard is belt-and-suspenders — but as
    // long as it writes phone every time, the read-boundary guard is load-bearing.
    expect(profiles).toContain('phone: normalizePhone(input.phone)');
  });
});
