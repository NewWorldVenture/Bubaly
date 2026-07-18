import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// A-05 (agent-05, PLA-0790): the super-admin analytics surfaces (journeys,
// onboarding-funnel) drop the Supabase `error` and render `data ?? []`, so a
// failed telemetry read renders "No activity yet" — telling the operator traffic
// is zero when the query actually errored. These guards lock in the honest
// distinction between "load failed" (MiniError) and "no data yet" (MiniEmpty).

const shell = fs.readFileSync('components/family/shell.tsx', 'utf8');
const journeys = fs.readFileSync('app/(app)/dashboard/journeys/page.tsx', 'utf8');
const funnel = fs.readFileSync('app/(app)/dashboard/onboarding-funnel/page.tsx', 'utf8');

describe('dashboard analytics read boundary', () => {
  it('ships a server-safe MiniError primitive distinct from MiniEmpty', () => {
    expect(shell).toContain('export function MiniError(');
    // Server-safe: no client-only onClick handler on the error surface.
    const miniError = shell.slice(shell.indexOf('export function MiniError('));
    expect(miniError).not.toContain('onClick');
    expect(miniError).toContain('role="alert"');
  });

  it('journeys page surfaces a failed telemetry read instead of a false-empty', () => {
    expect(journeys).toContain('const { data, error } =');
    expect(journeys).toContain('MiniError');
    // The error branch must precede the empty-rows branch.
    expect(journeys.indexOf('error ?')).toBeLessThan(journeys.indexOf('rows.length === 0'));
  });

  it('onboarding-funnel surfaces failed funnel AND activation reads', () => {
    expect(funnel).toContain('error: funnelError');
    expect(funnel).toContain('error: actError');
    expect(funnel).toContain('funnelError ?');
    expect(funnel).toContain('actError ?');
    // Each error branch precedes its corresponding empty branch.
    expect(funnel.indexOf('funnelError ?')).toBeLessThan(funnel.indexOf('funnel.startedSessions === 0'));
    expect(funnel.indexOf('actError ?')).toBeLessThan(funnel.indexOf('activation.cohorts === 0'));
  });
});
