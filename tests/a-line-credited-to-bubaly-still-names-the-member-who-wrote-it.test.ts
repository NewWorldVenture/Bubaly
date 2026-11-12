// LIBRARY-7BB2226AB6FF: any member with a login can insert an audit_logs row
// through the API with their own actor_id and metadata { actor: 'ai', title }.
// The insert policy (0380) pins family membership and actor_id = auth.uid(),
// nothing about the metadata. /family/activity then printed "Bubaly <that
// text>" with the sparkle mark and the writer's name dropped: an anonymous
// line, in words of the member's choosing, credited to the assistant in the
// household's who-changed-what trail.
//
// The assistant acts inside a person's session, so a row it writes carries
// that person's id. The line now always says whose session it was, which is
// true of the assistant's real rows and is the name of the author of a
// planted one.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeTrail, describeTrailRow, type TrailRow } from '@/lib/activity/trail';

const NAMES = new Map([['user-dad', 'Dad'], ['user-kid', 'Sam']]);

function row(over: Partial<TrailRow> = {}): TrailRow {
  return {
    id: 'a1', action: 'delete', resource: 'photos', resource_id: null,
    metadata: { actor: 'ai', title: 'deleted 40 photos from the family album' },
    created_at: '2026-11-11T12:00:00.000Z', actor_id: 'user-kid', ...over,
  };
}

describe('a line credited to Bubaly still names the member who wrote it', () => {
  it('a row a child planted as the assistant reads as theirs, not as an anonymous Bubaly line', () => {
    const line = describeTrailRow(row(), NAMES);
    expect(line.who).toBe('Bubaly, for Sam');
    expect(line.who).not.toBe('Bubaly');
    expect(line.what).toBe('deleted 40 photos from the family album');
  });

  it('the same holds for a row claiming to be a scheduled automation', () => {
    expect(describeTrailRow(row({ metadata: { actor: 'system', title: 'cleared the chore chart' } }), NAMES).who).toBe('Bubaly, for Sam');
  });

  it('the assistant\'s own row, written in a parent\'s session, says whose session', () => {
    const line = describeTrailRow(row({ actor_id: 'user-dad', action: 'create', resource: 'calendar', metadata: { actor: 'ai', title: 'Added "Dentist" to the calendar' } }), NAMES);
    expect(line).toMatchObject({ who: 'Bubaly, for Dad', byAssistant: true, what: 'Added "Dentist" to the calendar' });
  });

  it('a row with an actor who is no longer a member does not pass as Bubaly alone', () => {
    const line = describeTrailRow(row({ actor_id: 'user-who-left' }), NAMES);
    expect(line.who).toBe('Bubaly, for someone');
    expect(line.byAssistant).toBe(true);
  });

  it('a cron row, which has no session and so no actor, is Bubaly alone', () => {
    const line = describeTrailRow(row({ actor_id: null, metadata: { actor: 'system', title: 'Rolled the week onto the calendar' } }), NAMES);
    expect(line).toMatchObject({ who: 'Bubaly', byAssistant: true });
  });

  it('a member\'s ordinary row is unchanged', () => {
    expect(describeTrailRow(row({ metadata: { actor: 'member', title: 'Renamed the album' } }), NAMES)).toMatchObject({ who: 'Sam', byAssistant: false });
  });

  it('the whole trail carries the name through', () => {
    const lines = describeTrail([row({ id: 'planted' }), row({ id: 'real', actor_id: 'user-dad' })], NAMES);
    expect(lines.map((l) => [l.id, l.who])).toEqual([['planted', 'Bubaly, for Sam'], ['real', 'Bubaly, for Dad']]);
  });

  it('the policy half is written down for the owner', () => {
    const sql = readFileSync(join(process.cwd(), 'docs/owner-sql/triage/LIBRARY-7BB2226AB6FF.sql'), 'utf8');
    expect(sql).toContain('audit_insert');
    expect(sql).toContain("metadata ->> 'actor'");
  });
});
