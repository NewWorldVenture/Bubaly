import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { runPrepGeneration } from '@/lib/planning/prep-server';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// #771 comment 5984859545. Prep generation turns each document expiring
// within 60 days into a plan titled "Renew: <title>" in `prep_plans`, which
// every member reads (0131) — while `documents_select` keeps a sensitive
// document from anyone who is not a manager. The model-refresh cron runs on
// the service client and a parent's "Generate plans" on their session, so
// both read every document, and "Renew: Custody agreement" reached the
// children's prep page.

const NOW = new Date('2026-10-04T12:00:00Z');

function household() {
  const db = createInMemorySupabase<SupabaseClient<Database>>({
    uniques: {
      prep_plans: [['family_id', 'signal_kind', 'signal_id']],
      prep_plan_steps: [['family_id', 'plan_id', 'label']],
    },
    defaults: { prep_plans: { status: 'active' } },
  });
  db.seed('documents', [
    { id: 'doc-secure', family_id: 'f1', title: 'Custody agreement', expires_at: '2026-11-01', is_secure: true, category: 'general' },
    { id: 'doc-passport', family_id: 'f1', title: 'Passport — Dana no. 123456789', expires_at: '2026-11-10', is_secure: false, category: 'passport' },
    { id: 'doc-plain', family_id: 'f1', title: 'Library card', expires_at: '2026-11-15', is_secure: false, category: 'school' },
  ]);
  return db;
}
const titles = (db: ReturnType<typeof household>) =>
  Object.fromEntries(db.table('prep_plans').map((row) => [row.signal_id, row.title]));

describe('a prep plan for an expiring document', () => {
  it('names a sensitive document only as a private document', async () => {
    const db = household();
    const res = await runPrepGeneration(db, 'f1', null, 'UTC', NOW);
    expect(res.ok).toBe(true);
    expect(titles(db)['doc-secure']).toBe('Renew: a private document');
    expect(titles(db)['doc-passport']).toBe('Renew: a private document');
    expect(JSON.stringify(db.table('prep_plans'))).not.toMatch(/Custody|123456789/);
  });

  it('renames a plan already written with the title on the next run', async () => {
    const db = household();
    db.seed('prep_plans', [{ id: 'old', family_id: 'f1', signal_kind: 'doc_expiry', signal_id: 'doc-secure', title: 'Renew: Custody agreement', target_date: '2026-11-01', urgency: 'soon', status: 'active' }]);
    await runPrepGeneration(db, 'f1', null, 'UTC', NOW);
    expect(titles(db)['doc-secure']).toBe('Renew: a private document');
  });

  it('control: an ordinary document is still named', async () => {
    const db = household();
    await runPrepGeneration(db, 'f1', null, 'UTC', NOW);
    expect(titles(db)['doc-plain']).toBe('Renew: Library card');
  });
});
