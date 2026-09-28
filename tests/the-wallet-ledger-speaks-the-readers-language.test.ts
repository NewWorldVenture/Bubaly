import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { txnStatusKey, txnTypeKey, txnTypeLabel } from '@/lib/wallet/activity';

// P-34. A child's wallet page, read in German, still said "saved", "Target:",
// "Target 40%", "Ask AI Money Coach", "Top-up · Today, 11:44 AM" and "Parent
// top-up"; the activity page listed every type and status in English, and the
// wallet's section tabs were English on all 23 wallet pages. Found
// while retesting DATA-023 on a local production build with the reader's
// language set to de-DE. The i18n scanner could not see most of them: JSX text
// after an expression, and labels held in a map outside the component.

const COMPLETE = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const catalogue = (code: string): Record<string, string> =>
  JSON.parse(readFileSync(`lib/i18n/messages/${code}.json`, 'utf8'));
const code = (path: string) =>
  readFileSync(path, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');

const TYPES = ['gift_received', 'parent_top_up', 'allowance', 'chore_reward', 'babysitter_payment', 'card_spend', 'card_refund',
  'goal_transfer', 'bucket_transfer', 'transfer', 'withdrawal', 'fee', 'adjustment', 'reversal'];
const STATUSES = ['pending', 'requires_parent_approval', 'processing', 'completed', 'failed', 'reversed', 'cancelled'];

describe('the wallet ledger speaks the reader’s language', () => {
  it('every transaction type and status has a key in every complete catalogue', () => {
    const keys = [...TYPES.map(txnTypeKey), ...STATUSES.map(txnStatusKey), 'walletTxn.allTypes'];
    expect(keys.every(Boolean)).toBe(true);
    for (const c of COMPLETE) {
      const cat = catalogue(c);
      for (const key of keys) expect(cat[key as string], `${c} ${key}`).toBeTruthy();
    }
    // The English label is still the fallback for a value no key names.
    expect(txnTypeKey('something_new')).toBeNull();
    expect(txnTypeLabel('something_new')).toBe('something new');
  });

  it('the child wallet page renders no English of its own', () => {
    const src = code('components/wallet/child-detail-view.tsx');
    for (const english of ['Target:', 'Target {', '} saved', "'Ask AI Money Coach'", "'Thinking…'", "'Parent top-up'",
      "'Sent to a parent for approval'", "'Approved — enjoy!'", "'Allowed'", "'Delegated'", "'Emergency'"]) {
      expect(src, english).not.toContain(english);
    }
    // "Today, 11:44 AM" came from the en-US-bound formatter.
    expect(src).not.toMatch(/import \{[^}]*\bfmtRelative\b[^}]*\} from '@\/lib\/utils\/format'/);
    expect(src).toContain('useFormat()');
    expect(src).toMatch(/txnTypeKey\(tx\.type\)/);
  });

  it('the activity page names types and statuses from the catalogue', () => {
    const src = code('components/wallet/activity-view.tsx');
    expect(src).not.toContain("'All types'");
    expect(src).not.toMatch(/\{txnTypeLabel\(tx\.type\)\}/);
    expect(src).not.toMatch(/\$\{tx\.status\.replace\(/);
    expect(src).toMatch(/txnTypeKey\(type\)/);
    expect(src).toMatch(/txnStatusKey\(status\)/);
  });

  it('the wallet’s section tabs, on every wallet page, are named from the catalogue', () => {
    const src = code('components/wallet/wallet-subnav.tsx');
    expect(src).not.toMatch(/label: '/);
    const keys = [...src.matchAll(/labelKey: '([^']+)'/g)].map((m) => m[1]);
    expect(keys).toHaveLength(11);
    for (const c of COMPLETE) {
      const cat = catalogue(c);
      for (const key of [...keys, 'walletSubnav.label']) expect(cat[key], `${c} ${key}`).toBeTruthy();
    }
  });

  it('a top-up without a description stores none, not English', () => {
    const src = code('app/(app)/wallet/actions.ts');
    expect(src).not.toContain("|| 'Parent top-up'");
    expect(src).toContain('description: input.description?.trim() || null');
  });

  it('the split sentence is one template, not English glued to fragments', () => {
    for (const c of COMPLETE) {
      const s = catalogue(c)['childDetail.targetSplit'];
      for (const hole of ['{spend}', '{save}', '{give}', '{invest}']) expect(s, `${c} ${hole}`).toContain(hole);
    }
  });
});
