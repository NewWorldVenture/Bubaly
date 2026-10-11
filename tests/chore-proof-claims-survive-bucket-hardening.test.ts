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

describe('chore-proof claims and the bucket they live in', () => {
  it('a claim is an empty text/plain object, created without upsert', () => {
    const cleanup = readFileSync('lib/chores/proof-cleanup.ts', 'utf8');
    expect(cleanup).toContain(".upload(proofClaimPath(path), new Blob([]), { contentType: 'text/plain', upsert: false })");
  });

  it('nothing that restricts the chore-proof bucket\'s types leaves text/plain out', () => {
    const restricting = sources.filter(({ text }) => /chore-proof/.test(text) && /allowed_mime_types/i.test(text));
    for (const { file, text } of restricting) expect(text, `${file} restricts chore-proof's types`).toMatch(/text\/plain/);
  });
});
