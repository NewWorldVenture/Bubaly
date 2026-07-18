import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// A-05 (agent-05, PLA-0794): family-module's load() wrapped its reads in a
// try/catch and rendered <ErrorState onRetry> only when it caught a throw — but
// Supabase query errors DON'T throw (they resolve as { data: null, error }), so a
// failed PRIMARY `families` read fell through to setFamily(null) and rendered a
// degraded "Your Family / Address: Not set" hub, making the ErrorState effectively
// dead code for the most common failure. The fix wires the primary read's error
// into loadError so the existing retryable ErrorState actually fires.

const mod = fs.readFileSync('components/modules/family-module.tsx', 'utf8');

describe('family hub surfaces a failed primary read (A-05)', () => {
  it('checks the families read error and sets loadError before rendering a degraded hub', () => {
    const load = mod.slice(mod.indexOf('const load = useCallback'), mod.indexOf('useEffect(() => { void load()'));
    expect(load).toContain('if (fam.error)');
    expect(load).toContain('setLoadError(');
    // The error gate must precede the setFamily fallthrough.
    expect(load.indexOf('if (fam.error)')).toBeLessThan(load.indexOf('setFamily(fam.data ?? null)'));
  });

  it('still renders the retryable ErrorState when loadError is set', () => {
    expect(mod).toContain('if (loadError) return <ErrorState message={loadError} onRetry=');
  });

  it('keeps the family edit modal gated on a non-null family (no blank-overwrite)', () => {
    // Regression-lock: EditFamilyModal must only open with a loaded family, so an
    // errored read can never present a blank editable form that nulls address/cover.
    expect(mod).toContain('editOpen && family && (');
  });
});
