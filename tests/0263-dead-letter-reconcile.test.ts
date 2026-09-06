import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// `claim_ai_runs` is the only thing that notices a worker died. Its recovery
// half flipped the run row to `failed` and touched nothing else, so an
// abandoned run left the legacy status column saying "approved", its steps
// still `executing`, §10's request ledger still `executing`, and a timeline
// that simply stopped. A family whose worker died was shown a page claiming
// Bubaly was still working — indefinitely.
//
// The behavioural proof is docs/audit/dead-letter-reconcile-check.sql, which
// runs the real function against a real Postgres. This locks the shape so the
// four writes cannot be dropped by a later edit of the function.
const raw = readFileSync('supabase/migrations/0263_dead_letter_reconcile.sql', 'utf8');
const sql = raw.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
const proof = readFileSync('docs/audit/dead-letter-reconcile-check.sql', 'utf8');

describe('0263 dead-letter reconcile', () => {
  it('rewrites the one function that notices a dead worker', () => {
    expect(sql).toContain('create or replace function public.claim_ai_runs(p_limit integer default 10, p_lease_seconds integer default 120)');
  });

  it('captures the runs it dead-letters, rather than flipping and forgetting', () => {
    expect(sql).toMatch(/with recovered as \([\s\S]*?returning id, state, plan_id, request_id, family_id\s*\)/);
    expect(sql).toMatch(/select coalesce\(array_agg\(id\) filter \(where state = 'failed'\), '\{\}'\) into v_dead/);
  });

  it('moves the legacy status column the product actually renders', () => {
    expect(sql).toContain("status = case when attempt >= max_attempts then 'failed' else status end");
  });

  it('fails the steps left mid-flight and leaves finished ones alone', () => {
    const steps = sql.slice(sql.indexOf('update public.ai_plan_steps'));
    expect(steps).toContain("set status = 'failed'");
    expect(steps).toMatch(/and s\.status in \('executing', 'verifying', 'queued', 'ready'\)/);
  });

  it('resolves the request ledger without overwriting a request that already ended', () => {
    const req = sql.slice(sql.indexOf('update public.ai_requests'));
    expect(req).toContain("set status = 'failed'");
    expect(req).toMatch(/and q\.status not in \('completed', 'partially_completed', 'failed', 'cancelled'\)/);
  });

  it('says so on the timeline', () => {
    expect(sql).toMatch(/insert into public\.ai_run_events[\s\S]*?'run_failed'/);
  });

  it('leaves the claiming half alone — a lease token stays a uuid, and attempt still advances', () => {
    const claim = sql.slice(sql.indexOf('with candidates as'));
    expect(claim).toContain('lease_owner = gen_random_uuid()');
    expect(claim).not.toContain('gen_random_uuid()::text');
    expect(claim).toContain('attempt = r.attempt + 1');
  });

  it('keeps the function service-role only, as 0253 left it', () => {
    expect(sql).toContain('revoke all on function public.claim_ai_runs(integer, integer) from public, anon, authenticated');
    expect(sql).toContain('grant execute on function public.claim_ai_runs(integer, integer) to service_role');
  });

  it('ships a proof that asserts all four, not just the run row', () => {
    for (const claim of [
      'legacy status left as',
      'in-flight step left as',
      'a finished step was rewritten to',
      'request ledger left as',
      'expected one run_failed event',
    ]) {
      expect(proof, claim).toContain(claim);
    }
  });
});
