import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTACT_TOPICS } from '../lib/validation';

const page = readFileSync(join(__dirname, '..', 'app/(app)/admin/support-tickets/page.tsx'), 'utf8');
const m = (name: string) => page.match(new RegExp(`const ${name}[\\s\\S]*?\\};`))![0];

describe('support-ticket admin shows the contact topic (category)', () => {
  it('labels every contact topic in the Category column', () => {
    const labels = m('CATEGORY_LABELS');
    for (const t of CONTACT_TOPICS.map((x) => x.value)) {
      // general/billing/account already existed; the new ones must be present too
      expect(labels).toMatch(new RegExp(`\\b${t}:`));
    }
  });

  it('gives the new topics a badge tone', () => {
    const tone = m('CATEGORY_TONE');
    for (const t of ['bug', 'feature', 'feedback', 'partnership', 'other']) {
      expect(tone).toMatch(new RegExp(`\\b${t}:`));
    }
  });

  it('renders the friendly label in the category cell', () => {
    expect(page).toMatch(/CATEGORY_LABELS\[ticket\.category\] \?\? ticket\.category/);
  });
});
