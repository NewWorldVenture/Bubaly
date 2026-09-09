// §7, third symptom — "an event a parent adds by hand never reaches the family
// activity trail that an event Bubaly adds does, so the household's own record
// of who changed what has holes in it wherever a person did the work instead of
// the assistant."
//
// These cases cover the reading half: how a stored row becomes a line. The
// writing half — that a person's change lands in `audit_logs` and Bubaly's
// lands in both trails — lives alongside it once the service records them.
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeTrail, describeTrailRow, type TrailRow } from '@/lib/activity/trail';
import { trailActionFor } from '@/lib/ai/tools/execute';
import { listTools } from '@/lib/ai/tools/registry';

const NAMES = new Map([
  ['user-dad', 'Dad'],
  ['user-mom', 'Mom'],
]);

function row(over: Partial<TrailRow> = {}): TrailRow {
  return {
    id: 'a1',
    action: 'create',
    resource: 'calendar',
    resource_id: 'evt-1',
    metadata: { actor: 'member', title: 'Added "Dentist" to the calendar' },
    created_at: '2026-09-06T12:00:00.000Z',
    actor_id: 'user-dad',
    ...over,
  };
}

describe('the household trail names who changed what', () => {
  it('credits the person who did it, in the words the service recorded', () => {
    const line = describeTrailRow(row(), NAMES);
    expect(line.who).toBe('Dad');
    expect(line.what).toBe('Added "Dentist" to the calendar');
    expect(line.byAssistant).toBe(false);
  });

  it('credits Bubaly when Bubaly acted, not the signed-in user it acted for', () => {
    // The assistant runs inside a person's session, so `actor_id` is that
    // person. Only the recorded actor kind separates "Dad added it" from
    // "Bubaly added it" — which is the whole distinction the trail exists for.
    const line = describeTrailRow(row({ metadata: { actor: 'ai', title: 'Added "Dentist" to the calendar' } }), NAMES);
    expect(line.who).toBe('Bubaly');
    expect(line.byAssistant).toBe(true);
  });

  it('treats a scheduled automation as Bubaly too', () => {
    const line = describeTrailRow(row({ metadata: { actor: 'system', title: 'Rolled the week onto the calendar' }, actor_id: null }), NAMES);
    expect(line.who).toBe('Bubaly');
    expect(line.byAssistant).toBe(true);
  });

  it('keeps a former member\'s changes in the history rather than showing a uuid', () => {
    const line = describeTrailRow(row({ actor_id: 'user-who-left' }), NAMES);
    expect(line.who).toBe('Someone');
    expect(line.what).toBe('Added "Dentist" to the calendar');
  });

  it('falls back to verb and resource for a row written before titles were recorded', () => {
    // `logAudit` predates this trail and writes no metadata. Those rows are
    // still real changes; printing nothing for them would be a new hole.
    const line = describeTrailRow(row({ action: 'delete', resource: 'family_members', metadata: null }), NAMES);
    expect(line.what).toBe('removed family members');
    expect(line.who).toBe('Dad');
    expect(line.byAssistant).toBe(false);
  });

  it('prints an unknown verb as written instead of dropping the row', () => {
    const line = describeTrailRow(row({ action: 'quarantine', resource: 'documents', metadata: {} }), NAMES);
    expect(line.what).toBe('quarantine documents');
  });

  it('ignores metadata that is not shaped like a trail entry', () => {
    for (const metadata of [undefined, null, 'a string', 42, [], { title: '   ' }, { title: 7 }, { actor: 'nonsense' }]) {
      const line = describeTrailRow(row({ metadata, action: 'update', resource: 'notes' }), NAMES);
      expect(line.what).toBe('updated notes');
      expect(line.byAssistant).toBe(false);
      expect(line.who).toBe('Dad');
    }
  });

  it('keeps the order it was given, so a newest-first query stays newest-first', () => {
    const lines = describeTrail(
      [row({ id: 'a', created_at: '2026-09-06T12:00:00.000Z' }), row({ id: 'b', actor_id: 'user-mom', created_at: '2026-09-05T12:00:00.000Z' })],
      NAMES,
    );
    expect(lines.map((l) => [l.id, l.who])).toEqual([['a', 'Dad'], ['b', 'Mom']]);
  });
});

// ── Every tool that writes must be able to name what it did ─────────────────
// The executor derives the trail verb from what a tool already declares. That
// derivation is only safe while it covers every write tool, and `automate` is
// the hole: `routines.create` and `routines.pause` share it and mean opposite
// things, so a tool with that capability has to name its own verb. This fails
// the day someone adds one that does not, rather than silently dropping its
// changes out of the household's record.
describe('every write tool resolves a trail verb', () => {
  it('leaves no non-read-only tool without one', () => {
    const missing = listTools()
      .filter((t) => !t.readOnly && trailActionFor(t) === null)
      .map((t) => `${t.name} (capability: ${t.capability})`);
    expect(missing).toEqual([]);
  });

  it('records nothing for a read, however the tool is declared', () => {
    // 40 of Bubaly's tools are read-only. The trail is a log of changes; if
    // reads reached it they would bury every real change under them.
    const reads = listTools({ readOnly: true });
    expect(reads.length).toBeGreaterThan(20);
    expect(reads.filter((t) => trailActionFor(t) !== null)).toEqual([]);
  });

  it('takes the tool\'s own verb over the one its capability implies', () => {
    expect(trailActionFor({ readOnly: false, capability: 'automate', trailAction: 'create' })).toBe('create');
    expect(trailActionFor({ readOnly: false, capability: 'edit', trailAction: 'delete' })).toBe('delete');
    // An automate tool that names nothing gets nothing, rather than a guess.
    expect(trailActionFor({ readOnly: false, capability: 'automate' })).toBeNull();
    expect(trailActionFor({ readOnly: false, capability: 'edit' })).toBe('update');
  });
});

// ── Structural: one writer for the trail, none in the browser ───────────────
describe('the trail has exactly one writer', () => {
  const repo = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  // Comments quote the code they replaced, so a guard that matched them would
  // fail on its own explanation.
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('routes every household-trail write through lib/services/activity', () => {
    const writers = globSync('lib/services/**/index.ts')
      .filter((f) => /from\('audit_logs'\)\s*\.insert/.test(code(repo(f))))
      .map((f) => f.split(sep).join('/'));
    expect(writers).toEqual(['lib/services/activity/index.ts']);
  });

  it('leaves no browser write to either record', () => {
    // `agent_activity` had one — the roster's done/dismiss — and it filtered
    // `id` alone. Both records are now server-side only.
    const offenders = globSync('components/**/*.tsx')
      .filter((f) => /from\('(agent_activity|audit_logs)'\)\s*\.(insert|update|delete)/.test(code(repo(f))));
    expect(offenders).toEqual([]);
  });

  it('has a probe holding the RLS boundary the trail depends on', () => {
    // `run-probes.sh` globs docs/audit/*-check.sql, so this runs in CI's
    // Database job. Asserted here because deleting it would otherwise be silent.
    const probe = repo('docs/audit/household-trail-check.sql');
    expect(probe).toContain('audit_insert');
    expect(probe).toContain('audit_select');
  });
});
