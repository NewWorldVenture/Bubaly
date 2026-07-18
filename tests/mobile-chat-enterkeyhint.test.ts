import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// M-031: chat composers that SUBMIT on plain Enter must tell the mobile
// keyboard so — enterKeyHint="send" turns the return key into "Send" on
// iOS/Android. Messages (input), Assistant (expanded textarea + bar input),
// and Concierge (textarea) all Enter-submit. The Kitchen AI-Chef textarea is
// deliberately excluded: it submits on Cmd/Ctrl+Enter only (plain Enter is a
// newline), so a "send" hint there would lie.
const COMPOSERS: Array<[string, number]> = [
  ['components/modules/messages-module.tsx', 1],
  ['components/modules/assistant-module.tsx', 2],
  ['components/modules/concierge-module.tsx', 1],
];

describe('Enter-submitting chat composers hint "send" (M-031)', () => {
  it('every Enter-submit composer carries enterKeyHint="send"', () => {
    for (const [file, count] of COMPOSERS) {
      const src = readFileSync(file, 'utf8');
      const hints = (src.match(/enterKeyHint="send"/g) ?? []).length;
      expect(hints, `${file} should have ${count} send hint(s)`).toBe(count);
    }
  });

  it('the kitchen chef textarea stays hint-free (Cmd/Ctrl+Enter submit)', () => {
    const src = readFileSync('components/modules/kitchen-dashboard.tsx', 'utf8');
    expect(src).toContain("e.key === 'Enter' && (e.metaKey || e.ctrlKey)");
    expect(src).not.toContain('enterKeyHint="send"');
  });
});
