// Liveness has to be honest: the client may only open a websocket for a table
// the database really publishes, and a published table's DELETEs have to be
// able to reach the subscriber that asked for them.
//
// Three lists have to agree — the publication in SQL, the replica identities in
// SQL, and `lib/realtime/published-tables.ts` in the browser. Nothing else holds
// them together: Realtime accepts a channel on an unpublished table and simply
// never fires, so drift is invisible at runtime and looks exactly like a quiet
// household. Same shape as tests/document-vault-boundary.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  REALTIME_TABLES,
  DELETE_LIVE_TABLES,
  DELETE_BLIND_ACCEPTED,
  TRANCHE_0269,
  realtimeChannelFor,
  deletesAreLive,
} from '@/lib/realtime/published-tables';

const DIR = 'supabase/migrations';
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql'));
const SQL = Object.fromEntries(FILES.map((f) => [f, readFileSync(`${DIR}/${f}`, 'utf8')]));

/** Every table any migration adds to `supabase_realtime`, in SQL's own words. */
function publishedInMigrations(): string[] {
  const found = new Set<string>();
  for (const src of Object.values(SQL)) {
    if (!/alter publication/i.test(src)) continue;
    for (const m of src.matchAll(/alter publication supabase_realtime add table\s+([a-z_.]+)\s*;/gi)) {
      found.add(m[1].replace(/^public\./, ''));
    }
    // The guarded form executes `format(... %I)` over a declared array.
    for (const block of src.split(/\bdo \$/i)) {
      if (!/alter publication supabase_realtime add table.*%I/is.test(block)) continue;
      const arr = /tbls\s+text\[\]\s*:=\s*array\s*\[([\s\S]*?)\]/i.exec(block);
      for (const t of arr?.[1].matchAll(/'([a-z_]+)'/g) ?? []) found.add(t[1]);
    }
  }
  return [...found].sort();
}

/** Every table any migration gives `replica identity full`. */
function replicaIdentityFullInMigrations(): string[] {
  const found = new Set<string>();
  for (const src of Object.values(SQL)) {
    for (const m of src.matchAll(/alter table\s+(?:public\.)?([a-z_]+)\s+replica identity full/gi)) {
      found.add(m[1]);
    }
    for (const block of src.split(/\bdo \$/i)) {
      if (!/replica identity full/i.test(block) || !/%I/.test(block)) continue;
      const arr = /tbls\s+text\[\]\s*:=\s*array\s*\[([\s\S]*?)\]/i.exec(block);
      for (const t of arr?.[1].matchAll(/'([a-z_]+)'/g) ?? []) found.add(t[1]);
    }
  }
  return [...found].sort();
}

/** Tables the browser hard-deletes rows from (soft deletes are UPDATEs). */
function hardDeletedByClient(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.name === 'node_modules' ? []
        : e.isDirectory() ? walk(`${dir}/${e.name}`)
        : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []);
  for (const file of ['app', 'components', 'lib'].flatMap(walk)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/from\('([a-z_]+)'\)\s*\.delete\(\)/g)) found.add(m[1]);
  }
  return found;
}

/**
 * Every migration statement that adds to the publication, as a raw count, so the
 * PARSER can be checked against the SQL rather than trusted.
 *
 * `publishedInMigrations()` understands two shapes: a bare `add table x;` and a
 * `format(... %I)` over a `tbls text[] := array[...]`. A future migration written
 * a third way would be silently invisible to it — the drift test would pass while
 * the client's list and the database disagreed, which is the same false-green
 * this whole file exists to prevent.
 */
function unparsedPublicationBlocks(): string[] {
  const bad: string[] = [];
  for (const [name, src] of Object.entries(SQL)) {
    for (const block of src.split(/\bdo \$/i)) {
      for (const hit of block.matchAll(/alter publication supabase_realtime add table/gi)) {
        // Judge THIS statement, not the chunk around it: 0093 formats an
        // unrelated `CREATE TRIGGER %I_updated_at` in the same block, and an
        // earlier version of this check read that `%I` as a dynamic publication
        // add and flagged a file that parses perfectly well.
        const stmt = block.slice(hit.index, hit.index + 80);
        if (/^alter publication supabase_realtime add table\s+(?:public\.)?[a-z_]+\s*;/i.test(stmt)) continue;
        if (!/%I/.test(stmt)) { bad.push(name); continue; }
        const arr = /tbls\s+text\[\]\s*:=\s*array\s*\[([\s\S]*?)\]/i.exec(block);
        if (![...(arr?.[1].matchAll(/'([a-z_]+)'/g) ?? [])].length) bad.push(name);
      }
    }
  }
  return [...new Set(bad)];
}

describe('the drift parser understands every migration it reads', () => {
  it('leaves no publication statement unparsed', () => {
    // If this fails, the parser above needs teaching — NOT the list below
    // trimming. A shape it cannot read is drift it cannot see.
    expect(unparsedPublicationBlocks(), 'publication statements in a shape the parser does not understand').toEqual([]);
  });

  it('agrees with a real database', () => {
    // Ground truth from replaying every migration into PGlite and reading
    // pg_publication_tables: 51 tables before 0269, 61 after. A parser that
    // drifts from Postgres is worth no more than no parser at all.
    expect(publishedInMigrations()).toHaveLength(61);
    expect(REALTIME_TABLES.size).toBe(61);
  });
});

describe('the publication is one list, not three', () => {
  it('the client subscribes to exactly the tables the migrations publish', () => {
    expect([...REALTIME_TABLES].sort()).toEqual(publishedInMigrations());
  });

  it('the client and the migrations agree on which DELETEs are live', () => {
    expect([...DELETE_LIVE_TABLES].sort()).toEqual(replicaIdentityFullInMigrations());
  });

  it('0269 publishes the tranche it names', () => {
    for (const t of TRANCHE_0269) expect(REALTIME_TABLES.has(t), `${t} left the publication`).toBe(true);
    expect(SQL['0269_realtime_liveness_tranche.sql']).toBeDefined();
  });

  it('still publishes the surfaces two people share', () => {
    // A guard against the SQL and the TypeScript being edited down together.
    for (const t of ['family_messages', 'grocery_items', 'calendar_events', 'todo_items', 'notifications']) {
      expect(publishedInMigrations()).toContain(t);
    }
  });
});

describe('a published table cannot be silently DELETE-blind', () => {
  it('replica identity full is only spent on published tables', () => {
    for (const t of DELETE_LIVE_TABLES) expect(REALTIME_TABLES.has(t), `${t} is not published`).toBe(true);
  });

  it('every published table the client deletes from has decided about DELETE', () => {
    // family_id is never part of a primary key here, so under the default
    // replica identity the DELETE old-tuple has no family_id and the
    // subscription filter cannot match. A published table with a delete path is
    // either REPLICA IDENTITY FULL or listed as knowingly blind — never neither.
    const undecided = [...hardDeletedByClient()]
      .filter((t) => REALTIME_TABLES.has(t))
      .filter((t) => !DELETE_LIVE_TABLES.has(t) && !DELETE_BLIND_ACCEPTED.has(t));
    expect(undecided, `published, deletable, and no DELETE story: ${undecided.join(', ')}`).toEqual([]);
  });

  it('0269 gives replica identity full to the tranche members with a delete path', () => {
    for (const t of ['grocery_items', 'todo_items', 'calendar_events', 'chore_assignments', 'notifications']) {
      expect(deletesAreLive(t), `${t} would drop DELETEs`).toBe(true);
    }
  });

  it('does not spend WAL on tranche members with no delete path', () => {
    for (const t of ['family_messages', 'family_conversations', 'grocery_lists', 'todo_lists', 'marketplace_bids']) {
      expect(DELETE_LIVE_TABLES.has(t), `${t} pays full-row WAL for nothing`).toBe(false);
    }
  });
});

describe('no channel is opened for a table that can never fire', () => {
  it('refuses a subscribed-but-unpublished table', () => {
    for (const t of ['medications', 'transactions', 'vacation_packing_items', 'documents']) {
      expect(realtimeChannelFor(t, 'fam-1'), `${t} still opens a dead socket`).toBeNull();
    }
  });

  it('still opens one for a published table, unchanged', () => {
    expect(realtimeChannelFor('grocery_items', 'fam-1'))
      .toEqual({ name: 'grocery_items:fam-1', filter: 'family_id=eq.fam-1' });
  });

  it('the hook opens no channel it did not get from the shared decision', () => {
    // The predicate above is the real decision; this proves the hook obeys it
    // rather than building a channel name of its own.
    const hook = readFileSync('lib/hooks/use-realtime-query.ts', 'utf8');
    expect(hook).toContain('realtimeChannelFor(table, familyId)');
    expect(hook).toContain('if (!spec) return;');
    expect(hook).toContain('.channel(spec.name)');
    expect(hook).not.toMatch(/\.channel\(`\$\{table\}/);
  });
});

describe('the bespoke subscriptions are gated too', () => {
  // Five channels sit outside the hook because they filter on conversation_id
  // or listing_id. The hook's gate cannot reach them, so each one asks the same
  // shared list directly.
  it.each([
    ['components/modules/concierge-calls-module.tsx', 'concierge_calls'],
    ['components/modules/billing-module.tsx', 'subscriptions'],
    ['components/app/app-context.tsx', 'family_members'],
    ['components/marketplace/negotiation-panel.tsx', 'marketplace_negotiation_rounds'],
  ])('%s refuses to open a channel on an unpublished table', (file, table) => {
    expect(REALTIME_TABLES.has(table), `${table} is now published; drop the guard`).toBe(false);
    const src = readFileSync(file, 'utf8');
    expect(src).toContain(`if (!isRealtimePublished('${table}')) return;`);
  });

  it('leaves the ones 0269 publishes subscribing as before', () => {
    // Messages and the bell are fixed by publishing, not by silencing.
    for (const t of ['family_messages', 'family_conversations', 'notifications', 'marketplace_bids']) {
      expect(REALTIME_TABLES.has(t)).toBe(true);
    }
    expect(readFileSync('components/modules/messages-module.tsx', 'utf8'))
      .toContain("table: 'family_messages'");
    expect(readFileSync('components/app/notification-bell.tsx', 'utf8'))
      .toContain("table: 'notifications'");
  });

  it('leaves the presence channel alone — it needs no publication', () => {
    const src = readFileSync('components/modules/messages-module.tsx', 'utf8');
    const presence = src.slice(src.indexOf('presence:family:'));
    expect(presence.slice(0, 400)).not.toContain('isRealtimePublished');
  });
});
