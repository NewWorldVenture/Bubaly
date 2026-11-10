import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, bodyOf } from './helpers/source-order';
import { ONBOARDING_STEPS } from '@/lib/analytics/onboarding';
import { sessionIndexFromMs, recordableMsSinceSignup } from '@/lib/analytics/activation';

// The held 0534 (TEL-O1, TEL-O10 and the limit half of TEL-O8, as one file).
// Telemetry took any date, user, step, family, session or clock its writer
// sent; 0534 dates it on the server and keeps it its signed-in writer's.

const M = 'supabase/reserved/0534_telemetry_is_dated_by_the_server_and_written_by_its_signed_in_writer.sql';
const P = 'docs/audit/reserved/telemetry-is-dated-by-the-server-check.sql';
const W = '.github/workflows/telemetry-writer-runtime.yml';
const read = (p: string) => readFileSync(p, 'utf8');

describe('telemetry is dated by the server and written by its signed-in writer (0534)', () => {
  const sql = read(M);
  const stamp = bodyOf(sql, 'create or replace function public.telemetry_row_is_stamped_by_the_server()', '$$;');

  it('one stamp, on every telemetry table, and no second one', () => {
    expect(stamp).toContain('security invoker');
    expect(at(stamp, 'if coalesce(v_bypass, false) then')).toBeLessThan(at(stamp, 'new.created_at := now();'));
    expect(stamp).toContain('new.id := gen_random_uuid();');
    expect(sql).toContain("foreach t in array array['onboarding_events', 'activation_events', 'journey_events'] loop");
    // TEL-O10's names for the same stamp, dropped so the two never stack.
    expect(sql).toContain("execute format('drop trigger if exists %I on public.%I', t || '_created_at_is_the_servers', t);");
    expect(sql).toContain('revoke insert, update, delete, truncate on public.onboarding_events, public.activation_events from anon;');
  });

  it('the onboarding policy allows exactly the wizard\'s steps', () => {
    const policy = bodyOf(sql, 'create policy onboarding_events_insert on public.onboarding_events for insert to authenticated', ');\n');
    const steps = /step in \(([^)]*)\)/.exec(policy)?.[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    expect(steps).toEqual(ONBOARDING_STEPS.map((s) => s.key));
    expect(policy).toContain('user_id = auth.uid()');
    expect(policy).toContain("meta = '{}'::jsonb");
    expect(policy).toContain('(duration_ms is null or duration_ms between 0 and 604800000)');
  });

  it('the activation policy allows what both activation writers send', () => {
    const policy = bodyOf(sql, 'create policy activation_events_insert on public.activation_events for insert to authenticated', ');\n');
    for (const clause of ['user_id = auth.uid()', 'public.is_family_member(family_id)', 'session_id = family_id::text',
      'session_index between 1 and 3', '(ms_since_signup is null or ms_since_signup >= 0)', "meta = '{}'::jsonb"]) {
      expect(policy, clause).toContain(clause);
    }
    // What the writers compute stays inside it, from no clock to a year on.
    for (const ms of [null, 0, 3_600_000, 86_400_000, 6 * 86_400_000, 30 * 86_400_000, 365 * 86_400_000]) {
      const index = sessionIndexFromMs(ms);
      expect(index, String(ms)).toBeGreaterThanOrEqual(1);
      expect(index, String(ms)).toBeLessThanOrEqual(3);
      const recorded = recordableMsSinceSignup(ms);
      expect(recorded === null || recorded >= 0, String(ms)).toBe(true);
    }
    for (const writer of ['lib/analytics/activation-track.ts', 'lib/analytics/activation-server.ts']) {
      const src = read(writer);
      expect(src, writer).toMatch(/session_id: opts\.familyId,/);
      expect(src, writer).toContain('session_index: sessionIndexFromMs(ms),');
      expect(src, writer).toContain('ms_since_signup: recordableMsSinceSignup(ms),');
      expect(src, writer).not.toContain('meta:');
    }
  });

  it('the writers send no id, date or meta of their own', () => {
    const wizard = bodyOf(read('lib/analytics/onboarding-track.ts'), "      .from('onboarding_events')", '.then(');
    expect(wizard).toContain('.insert({ user_id: userId, session_id: session, step, phase, duration_ms: Date.now() - startedAt })');
    const journey = bodyOf(read('lib/analytics/use-journey.ts'), "void sb.from('journey_events').insert({", '}).then(');
    expect(journey).not.toMatch(/\bid:|created_at:/);
  });

  it('an account files at most 200 onboarding rows a day', () => {
    const limit = bodyOf(sql, 'create or replace function public.onboarding_events_per_account_limit()', '$$;');
    expect(limit).toContain("where e.user_id = new.user_id and e.created_at > now() - interval '1 day') >= 200 then");
    expect(limit).toContain("raise exception 'onboarding telemetry limit reached' using errcode = '42501';");
    expect(sql).toContain('create index if not exists idx_onboarding_events_user_created on public.onboarding_events (user_id, created_at);');
    // The register's cleanup deletes production rows: not in the migration.
    expect(sql).not.toMatch(/^\s*delete from/m);
  });
});

describe('the probe and its workflow', () => {
  it('the probe covers each refusal, the stamps, the limit and the writers', () => {
    const probe = read(P);
    for (const what of ["('anon filed an onboarding row', 'anon', '',", "('Ada filed an activation row for Other House', 'authenticated', ada,",
      "('Ada''s onboarding row sent as 2020', 'onboarding_events', ada,", "('Kit''s journey row sent as 2099', 'journey_events', kit,",
      "('the wizard''s row (trackOnboarding)', ada,"]) {
      expect(probe, what).toContain(what);
    }
    expect(probe).toContain("got is distinct from '42501: onboarding telemetry limit reached'");
    expect(probe).toContain('-- N1. The stamps disabled.');
    expect(probe).toContain('-- M1. The step list taken out of the onboarding policy.');
  });

  it('the workflow shows the failure, applies 0534 twice, and re-runs the released probes', () => {
    const wf = read(W);
    expect(at(wf, '- name: The released schema takes any date, user, step and family in telemetry')).toBeLessThan(at(wf, `-f ${M}\n`));
    expect(wf.split(`psql -X -v ON_ERROR_STOP=1 -q -f ${M}\n`)).toHaveLength(3);
    expect(wf).toContain("grep -qE 'CONTROL|PRECONDITION'");
    expect(wf).toContain("grep -qF 'telemetry-is-dated-by-the-server: OK'");
    for (const probe of ['definer-functions-check-their-caller', 'privileged-rpc-grants', 'plpgsql-bodies-resolve', 'rls-sweep']) {
      expect(wf, probe).toContain(`docs/audit/${probe}-check.sql`);
    }
  });
});
