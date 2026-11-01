import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, bodyOf } from './helpers/source-order';

// The held 0532 (OPSD-O03). activateEmergencyAction keeps one emergency at a
// time with a read and then an insert, so two managers activating at the same
// instant both got in, and the trust engine applied the union of both sessions'
// elevated domains. 0532 puts the rule on emergency_sessions itself.

const M = 'supabase/reserved/0532_one_emergency_at_a_time_per_household.sql';
const P = 'docs/audit/reserved/one-emergency-at-a-time-per-household-check.sql';
const W = '.github/workflows/emergency-session-runtime.yml';
const read = (p: string) => readFileSync(p, 'utf8');

describe('one emergency at a time per household (0532)', () => {
  const sql = read(M);
  const guard = bodyOf(sql, 'create or replace function public.one_emergency_at_a_time()', '$$;');

  it('the app keeps the rule with a read and then an insert, and is the only activation', () => {
    const actions = read('app/(app)/dashboard/trust/actions.ts');
    const activate = bodyOf(actions, 'export async function activateEmergencyAction(', 'export async function endEmergencyAction(');
    expect(at(activate, ".is('ended_at', null).gt('expires_at', new Date().toISOString()).limit(1);"))
      .toBeLessThan(at(activate, "await supabase.from('emergency_sessions').insert({"));
  });

  it('an open session refuses a second, after one activation at a time per household', () => {
    expect(guard).toContain('security definer\nset search_path = public, pg_temp');
    // Open is what the app counts: not ended, and not past its expiry.
    expect(guard).toContain('if new.ended_at is not null or new.expires_at <= now() then\n    return new;');
    expect(guard).toContain("if tg_op = 'UPDATE' and old.ended_at is null and old.expires_at > now()\n     and old.family_id = new.family_id then\n    return new;");
    expect(at(guard, "perform pg_advisory_xact_lock(hashtextextended('emergency session admission ' || new.family_id::text, 0));"))
      .toBeLessThan(at(guard, 'and s.expires_at > now()) then'));
    expect(guard).toContain("raise exception 'Emergency mode is already on for this household' using errcode = '23505';");
    // A rule of the data, not a permission: no writer is exempt.
    expect(guard).not.toContain('auth.uid()');
    expect(sql).toContain('before insert or update on public.emergency_sessions');
    expect(sql).not.toMatch(/create (unique )?index|create policy|drop policy/);
  });
});

describe('the probe and its workflow', () => {
  it('the probe measures each path, a second session, and carries its controls', () => {
    const probe = read(P);
    expect(probe).toContain("('the adult activated a second emergency', 'authenticated', adult,");
    expect(probe).toContain("('the adult reopened yesterday''s ended emergency', 'authenticated', adult,");
    expect(probe).toContain("('the server opened a second emergency', 'service_role', '',");
    expect(probe).toContain("perform dblink_send_query('c0532_other', format($q$");
    expect(probe).toContain("perform set_config('lock_timeout', '20s', true);");
    expect(probe).toContain('-- N1. The guard disabled.');
    expect(probe).toContain('-- M1. The guard firing on INSERT only.');
  });

  it('the workflow shows the failure, applies 0532 twice, and re-runs the released probes', () => {
    const wf = read(W);
    expect(at(wf, '- name: The released schema lets a household open two emergencies at once')).toBeLessThan(at(wf, `-f ${M}\n`));
    expect(wf.split(`psql -X -v ON_ERROR_STOP=1 -q -f ${M}\n`)).toHaveLength(3);
    expect(wf).toContain("grep -qE 'CONTROL|PRECONDITION'");
    expect(wf).toContain("grep -qF 'one-emergency-at-a-time-per-household: OK'");
    for (const probe of ['gated-write-tables', 'realtime-anon-stream', 'family-scoped-index', 'plpgsql-bodies-resolve', 'rls-sweep']) {
      expect(wf, probe).toContain(`docs/audit/${probe}-check.sql`);
    }
  });
});
