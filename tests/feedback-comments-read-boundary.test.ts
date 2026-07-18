import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// A-17 §3e slice (agent-05, PLA-0796): the feedback board's lazy-loaded comment
// thread used try/finally (no catch) and dropped the read error, so a failed
// `feedback_comments` read rendered a silent empty discussion (and the
// `comments === null` reload guard meant it never retried). It now flags the error
// (setting [] to avoid an infinite reload) and shows a retry affordance.

const src = fs.readFileSync('app/(app)/feedback/feedback-board.tsx', 'utf8');

describe('feedback comment thread surfaces a failed read (A-17 §3e)', () => {
  it('captures the read error and does not render it as an empty discussion', () => {
    expect(src).toContain("const { data, error: readErr } = await sb.from('feedback_comments')");
    expect(src).toContain('if (readErr) { setLoadError(true); setComments([]); return; }');
  });

  it('exposes a retry that reloads (comments back to null) without an infinite loop', () => {
    // Error path sets [] (so the `comments === null` reload guard does not loop),
    // and Retry sets comments back to null to re-trigger the load.
    expect(src).toContain('setLoadError(false); setComments(null);');
    expect(src).toContain('loadError && !loading');
  });
});
