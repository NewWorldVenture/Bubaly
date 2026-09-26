import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from './helpers/jsx-a11y-scan';
import { readsAsSentence, sentenceTemplates } from './helpers/sentence-templates';

// I18N-003's last blind spot: an English sentence built as a template literal
// anywhere the regex scanner does not look (a ternary, a return, an object
// property, an array, an ordinary call). Measured with the tree held fixed at
// 859579d3: 117. The ratchet only goes down; it goes up only if the walker gets
// stricter, and the commit that raises it says so.
// Batch 1 (admin, command center, memories, marketplace, blog, feedback):
// 117 -> 92.
// Batch 2 (dashboards, billing, declutter, marketplace panels, assistant,
// concierge, focus, care, career), 92 -> 57.
// Batch 3 (insurance renewals, inventory, language, moving, sleep, screen
// time, subscriptions, trust, watchlist and more), 57 -> 27.
// Batch 4 (the assistants page, approval expiry, the assistant's chips,
// refill badges, wallet, sync, social and the rest), 27 -> 0. It is a zero
// guard now: a new English sentence template fails here.
//
// Not counted, on purpose: app/api (prompts for the model), a thrown Error (a
// log line and the error boundary), a translator's own argument, class lists,
// URLs and queries, and an AI system prompt.
const CEILING = 0;

describe('English sentence templates on the signed-in and public surface do not grow', () => {
  const files = sourceFiles().filter((f) => !f.startsWith('app/api/'));
  const sites = files.flatMap((f) => sentenceTemplates(f));

  it('scans the real tree (guards the guard)', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it(`has no more than ${CEILING}`, () => {
    expect(sites.length, sites.map((s) => `${s.file}:${s.line} ${s.text}`).join('\n')).toBeLessThanOrEqual(CEILING);
  });

  it('and the ceiling is kept tight', () => {
    expect(CEILING - sites.length, `lower CEILING to ${sites.length}`).toBe(0);
  });
});

describe('the walker sees a sentence wherever it is built', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentences-'));
  const count = (body: string) => {
    const file = join(dir, `f${Math.random().toString(36).slice(2)}.tsx`);
    writeFileSync(file, `export function F({ n, tr, cls }: any) {\n${body}\n}\n`);
    return sentenceTemplates(file).length;
  };

  it('in a ternary, a return, a property, an array and a call', () => {
    expect(count('return n ? `Due in ${n} days` : null;')).toBe(1);
    expect(count('const o = { text: `You have ${n} unread messages` };')).toBe(1);
    expect(count('const a = [`${n} already on the list`];')).toBe(1);
    expect(count('setError(`Sync failed (${n})`);')).toBe(1);
  });

  it('but not a class list, a URL, a translator argument or a thrown error', () => {
    expect(count('return <div className={`flex items-center gap-2 ${cls}`} />;')).toBe(0);
    expect(count('const url = `/dashboard/chores?id=${n}`;')).toBe(0);
    expect(count('return tr(`nav.${n}`);')).toBe(0);
    expect(count('throw new Error(`Failed to load chore ${n}`);')).toBe(0);
  });

  it('reads prose, not identifiers', () => {
    expect(readsAsSentence('Expires in \u0000 days')).toBe(true);
    expect(readsAsSentence('bg-brand text-sm')).toBe(false);
    expect(readsAsSentence('\u0000-\u0000')).toBe(false);
  });
});
