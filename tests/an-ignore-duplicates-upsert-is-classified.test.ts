import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Audit C1-S9-70 — the one upsert shape that CAN silently do nothing.
 *
 * Both write ratchets exclude upserts, because an upsert inserts or updates and
 * cannot match zero rows — except with `ignoreDuplicates: true`, where a
 * conflict resolves with no error and no row. A caller that reports what it
 * wrote from the INPUT rather than the RESULT is then wrong on every duplicate:
 * the playbook refresh toasted "Found 5 things Bubaly noticed" when every one
 * was already there.
 *
 * Every such site is listed here with how it knows what it wrote. A new one
 * fails until it is classified; a removed one fails until it is pruned.
 */
const CLASSIFIED: Record<string, { count: number; how: string }> = {
  'app/api/ai/route.ts': { count: 1, how: 'readback: re-reads the conversation with ownership' },
  'app/api/ai/chat/route.ts': { count: 1, how: 'readback: re-reads the conversation with ownership' },
  'app/(app)/dashboard/moments/page.tsx': { count: 1, how: 'best-effort log; reports nothing; error now logged' },
  'app/(app)/dashboard/playbook/playbook-actions.ts': { count: 1, how: '.select(): counts only inserted rows (fixed C1-S9-70)' },
  'app/onboarding/actions.ts': { count: 1, how: '.select() + readback of the existing token on a duplicate' },
  'lib/chores/server.ts': { count: 1, how: '.select(): returns only newly earned badges' },
  'lib/planning/prep-server.ts': { count: 1, how: 'idempotent regeneration; reports plans, not steps' },
  'lib/contact-center/urgent-delivery.ts': { count: 1, how: 'readback: verifies the notification identity' },
  'lib/marketing/automation-events.ts': { count: 1, how: '.select() claim, then reads the existing run on a duplicate' },
};

function found(): Map<string, number> {
  const out = execSync("grep -rc \"ignoreDuplicates: true\" app lib --include='*.ts' --include='*.tsx' || true", { encoding: 'utf8' });
  const m = new Map<string, number>();
  for (const line of out.trim().split('\n')) {
    const i = line.lastIndexOf(':');
    const n = Number(line.slice(i + 1));
    if (n > 0) m.set(line.slice(0, i), n);
  }
  return m;
}

describe('every ignoreDuplicates upsert knows what it actually wrote (C1-S9-70)', () => {
  const sites = found();

  it('no unclassified site', () => {
    const unknown = [...sites.keys()].filter((f) => !(f in CLASSIFIED));
    expect(unknown, 'classify how this upsert learns what it wrote').toEqual([]);
  });

  it('counts match exactly', () => {
    const off: string[] = [];
    for (const [f, { count }] of Object.entries(CLASSIFIED)) {
      if ((sites.get(f) ?? 0) !== count) off.push(`${f}: ${sites.get(f) ?? 0} != ${count}`);
    }
    expect(off, 'update CLASSIFIED to match the code').toEqual([]);
  });

  it('the playbook reports what it inserted, not what it offered', () => {
    const src = readFileSync('app/(app)/dashboard/playbook/playbook-actions.ts', 'utf8');
    expect(src).toContain("ignoreDuplicates: true })\n    .select('id');");
    expect(src).toContain('return { ok: true, added: inserted?.length ?? 0 };');
    expect(src).not.toContain('added: rows.length');
  });
});
