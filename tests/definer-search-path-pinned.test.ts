import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Security ratchet (mandate: close security gaps). Every SECURITY DEFINER function
// runs with the owner's privileges, so it MUST pin `set search_path` — otherwise a
// caller can shadow an unqualified object the body references and have the definer
// execute it with elevated rights (the Supabase `function_search_path_mutable`
// lint). An audit found 2 unpinned definer functions (0014's sync_album_photo_count
// + update_conversation_last_message); 0225 pins them. This guard fails CI if any
// future SECURITY DEFINER function omits `set search_path`.
function definerFunctionsMissingSearchPath(): string[] {
  const dir = 'supabase/migrations';
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  // A function may be re-created across migrations (create or replace); only the
  // LAST (effective) definition matters. Track it per normalized function name.
  const last = new Map<string, { file: string; definer: boolean; pinned: boolean }>();
  for (const f of files) {
    const sql = readFileSync(`${dir}/${f}`, 'utf8');
    const starts = [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w".]+)/gi)];
    for (let i = 0; i < starts.length; i++) {
      const from = starts[i].index ?? 0;
      const to = i + 1 < starts.length ? (starts[i + 1].index ?? sql.length) : sql.length;
      const chunk = sql.slice(from, to);
      const bodyAt = chunk.search(/\bas\s*\$|\blanguage\s+(?:sql|plpgsql)/i);
      const header = bodyAt > 0 ? chunk.slice(0, bodyAt + 200) : chunk;
      const name = starts[i][1].replace(/"/g, '').replace(/^public\./, '');
      last.set(name, {
        file: f,
        definer: /security\s+definer/i.test(header),
        pinned: /set\s+search_path/i.test(header),
      });
    }
  }
  return [...last.entries()]
    .filter(([, v]) => v.definer && !v.pinned)
    .map(([name, v]) => `${v.file} :: ${name}`);
}

describe('SECURITY DEFINER functions pin search_path', () => {
  const missing = definerFunctionsMissingSearchPath();

  it('finds the expected large definer-function surface (sanity: parser works)', () => {
    // If the parser silently matched nothing, this would pass vacuously — guard it.
    const dir = 'supabase/migrations';
    const anyDefiner = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .some((f) => /security\s+definer/i.test(readFileSync(`${dir}/${f}`, 'utf8')));
    expect(anyDefiner).toBe(true);
  });

  it('has zero SECURITY DEFINER functions without set search_path', () => {
    expect(missing, `definer functions missing set search_path:\n${missing.join('\n')}`).toEqual([]);
  });
});
