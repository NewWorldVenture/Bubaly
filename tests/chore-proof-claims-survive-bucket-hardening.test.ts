import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * lib/chores/proof-cleanup claims a proof path with an EMPTY `text/plain`
 * object in the chore-proof bucket. The bucket admits any type today (00430
 * sets only a size limit). Hardening it with allowed_mime_types without
 * text/plain would refuse every claim, and with them every proof submission
 * and every release of an upload. This holds that dependency where a
 * migration or the local config would break it; it changes nothing.
 */
const MIGRATIONS = 'supabase/migrations';
const sources = [
  ...readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).map((f) => ({ file: join(MIGRATIONS, f), text: readFileSync(join(MIGRATIONS, f), 'utf8') })),
  { file: 'supabase/config.toml', text: readFileSync('supabase/config.toml', 'utf8') },
];

/**
 * The case above reads a FILE at a time, so it has nothing to check while no
 * file names both the bucket and the column, and it is satisfied by a file
 * that names text/plain for some other bucket (0418 does, for family-media).
 * These read a STATEMENT at a time, comments removed: every statement that
 * sets `allowed_mime_types`, and the buckets it names.
 */
const BUCKET_IDS = [...new Set(sources.flatMap(({ text }) =>
  [...text.matchAll(/insert\s+into\s+storage\.buckets\s*\([^)]*\)\s*values\s*\(\s*'([^']+)'/gi)].map((m) => m[1])))];

const typeRestrictions = sources
  .filter(({ file }) => file.endsWith('.sql'))
  .flatMap(({ file, text }) => text.replace(/--[^\n]*/g, '').split(';').map((statement) => ({ file, statement })))
  .filter(({ statement }) => /storage\.buckets/i.test(statement) && /allowed_mime_types\s*(=|\))/i.test(statement))
  .map(({ file, statement }) => ({ file, statement, buckets: BUCKET_IDS.filter((id) => statement.includes(`'${id}'`)) }));

/** A restriction reaches chore-proof when it names it, or names no bucket at all. */
const reachesChoreProof = typeRestrictions.filter(({ buckets }) => buckets.includes('chore-proof') || buckets.length === 0);

describe('chore-proof claims and the bucket they live in', () => {
  it('a claim is an empty text/plain object, created without upsert', () => {
    const cleanup = readFileSync('lib/chores/proof-cleanup.ts', 'utf8');
    expect(cleanup).toContain(".upload(proofClaimPath(path), new Blob([]), { contentType: 'text/plain', upsert: false })");
  });

  it('nothing that restricts the chore-proof bucket\'s types leaves text/plain out', () => {
    const restricting = sources.filter(({ text }) => /chore-proof/.test(text) && /allowed_mime_types/i.test(text));
    for (const { file, text } of restricting) expect(text, `${file} restricts chore-proof's types`).toMatch(/text\/plain/);
  });

  it('the statements that restrict a bucket\'s types are found, each with the bucket it names', () => {
    expect(BUCKET_IDS).toContain('chore-proof');
    // 0418 is the restriction that names text/plain today: it is family-media's, not chore-proof's.
    const familyMedia = typeRestrictions.filter(({ file, buckets }) => file.includes('0418_') && buckets.includes('family-media'));
    expect(familyMedia).toHaveLength(1);
    expect(familyMedia[0].statement).toMatch(/'text\/plain'/);
    expect(typeRestrictions.length).toBeGreaterThanOrEqual(5);
  });

  it('the bucket is created with a size limit and no type list', () => {
    const created = sources.flatMap(({ text }) => text.replace(/--[^\n]*/g, '').split(';'))
      .filter((statement) => /insert\s+into\s+storage\.buckets/i.test(statement) && statement.includes("'chore-proof'"));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(/\(\s*id\s*,\s*name\s*,\s*public\s*,\s*file_size_limit\s*\)/i);
    expect(created[0]).not.toMatch(/allowed_mime_types/i);
  });

  it('no statement that sets the chore-proof bucket\'s types, by name or for every bucket, leaves text/plain out', () => {
    expect(reachesChoreProof.filter(({ statement }) => !/'text\/plain'/.test(statement)).map(({ file }) => file)).toEqual([]);
  });

  it('the local config gives the chore-proof bucket no type list without text/plain', () => {
    const config = sources.filter(({ file }) => file === 'supabase/config.toml');
    expect(config).toHaveLength(1);
    const sections = config[0].text.replace(/#[^\n]*/g, '').split(/^(?=\[)/m).filter((section) => /^\[storage\.buckets\.["']?chore-proof["']?\]/.test(section));
    expect(sections.filter((section) => /allowed_mime_types/.test(section) && !/["']text\/plain["']/.test(section))).toEqual([]);
  });
});
