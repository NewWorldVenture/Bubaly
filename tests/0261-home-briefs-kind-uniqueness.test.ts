import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Static migration contracts, not PostgreSQL execution. Pin the guarded removal
// that 0258 omitted, and reject changes that could remove unrelated protection.
const raw = readFileSync('supabase/migrations/0261_home_briefs_kind_uniqueness.sql', 'utf8');
const sql = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

function hasScopedLegacyRemoval(source: string): boolean {
  const loop = source.match(/for legacy in (.*?) loop (.*?) end loop;/);
  if (!loop) return false;
  const [, query, body] = loop;
  return query.startsWith('select c.conname from pg_catalog.pg_constraint c where ')
    && query.includes("c.conrelid = brief_table and c.contype = 'u'")
    && query.includes('and cardinality(c.conkey) = 2')
    && query.includes('and c.conkey @> array[family_column, date_column]')
    && !/\bor\b/.test(query)
    && /^execute format\( 'alter table only public\.home_briefs drop constraint %i restrict', legacy\.conname \);$/.test(body);
}

const replacementGuard = sql.match(/if not exists \( select 1 from pg_catalog\.pg_index i .*? \) then raise exception '[^']*'; end if;/)?.[0] ?? '';
const unknownIndexGuard = sql.match(/if exists \( select 1 from pg_catalog\.pg_index u .*? \) then raise exception '[^']*'; end if;/)?.[0] ?? '';

describe('0261 daily/evening uniqueness repair (static contracts)', () => {
  it('keeps checks and DDL in one atomic block without swallowing errors', () => {
    expect(sql).toMatch(/^do \$migration\$ declare .* end; \$migration\$;$/);
    expect(sql.match(/\bdo \$migration\$/g)).toHaveLength(1);
    expect(sql).not.toMatch(/\bexception when\b|\breturn\b|\bcommit\b/);
    expect(sql).toContain("brief_table oid := to_regclass('public.home_briefs')");
    expect(sql).toMatch(/if brief_table is null then raise exception '[^']*'; end if;/);
    const lock = sql.indexOf('lock table only public.home_briefs in access exclusive mode;');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(sql.indexOf('select attnum into family_column'));
    expect(sql).toMatch(/if not exists \( select 1 from pg_catalog\.pg_class c where c\.oid = brief_table and c\.relkind = 'r' \) then raise exception '[^']*'; end if;/);
  });

  it.each([
    ['family_column', 'family_id', 'uuid'],
    ['date_column', 'as_of_date', 'date'],
    ['kind_column', 'kind', 'text'],
  ])('requires the expected non-null, non-dropped %s', (variable, column, type) => {
    expect(sql).toContain(`select attnum into ${variable} from pg_catalog.pg_attribute where attrelid = brief_table and attname = '${column}' and atttypid = 'pg_catalog.${type}'::regtype and attnotnull and not attisdropped;`);
    expect(sql).toMatch(/if family_column is null or date_column is null or kind_column is null then raise exception '[^']*'; end if;/);
    expect(sql.indexOf('if family_column is null')).toBeLessThan(sql.indexOf(replacementGuard));
  });

  it('requires the named replacement to belong to home_briefs and cover exactly the three key columns', () => {
    expect(replacementGuard).not.toBe('');
    expect(replacementGuard).toContain("i.indexrelid = to_regclass('public.uq_home_briefs_family_date_kind')");
    expect(replacementGuard).toContain('and i.indrelid = brief_table');
    expect(replacementGuard).toContain('and i.indnkeyatts = 3');
    expect(replacementGuard).toContain('array[i.indkey[0], i.indkey[1], i.indkey[2]] @> array[family_column, date_column, kind_column]');
    // Compare the key set: a different order or extra INCLUDE columns is valid.
    expect(replacementGuard).not.toContain('indnatts');
    expect(replacementGuard.split(') then raise exception ')[0]).not.toMatch(/\bor\b/);
    expect(sql.indexOf(replacementGuard)).toBeLessThan(sql.indexOf('for legacy in'));
  });

  it.each([
    'i.indisunique',
    'i.indisvalid',
    'i.indisready',
    'i.indislive',
    'i.indimmediate',
    'i.indpred is null',
    'i.indexprs is null',
  ])('fails closed unless the replacement satisfies %s', (condition) => {
    // These predicates must be in the raising guard, before any removal.
    expect(replacementGuard).toContain(`and ${condition}`);
  });

  it('actually removes the old two-column unique constraints without relying on their names', () => {
    expect(hasScopedLegacyRemoval(sql)).toBe(true);
    expect(sql).not.toContain('home_briefs_family_id_as_of_date_key');
    expect(sql).not.toMatch(/c\.conname\s*(?:=|like|in\s*\()/);
    // With no matching legacy constraint the loop performs no DDL, so reruns
    // and already-corrected baselines still succeed after the preconditions.
    expect(sql).toMatch(/end loop; end; \$migration\$;$/);
  });

  it.each([
    ['retaining the obsolete constraint', "execute format( 'alter table only public.home_briefs drop constraint %i restrict', legacy.conname );", 'null;'],
    ['dropping constraints on other tables', "c.conrelid = brief_table and c.contype = 'u'", "c.contype = 'u'"],
    ['dropping non-unique constraints', " and c.contype = 'u'", ''],
    ['also dropping the three-column key', ' and cardinality(c.conkey) = 2', ''],
    ['dropping unrelated unique keys', ' and c.conkey @> array[family_column, date_column]', ''],
    ['bypassing the catalog filter', 'and cardinality(c.conkey) = 2', 'and cardinality(c.conkey) = 2 or true'],
    ['broadening the target table', 'alter table only public.home_briefs drop constraint', 'alter table only public.families drop constraint'],
    ['removing dependent objects', 'drop constraint %i restrict', 'drop constraint %i cascade'],
    ['interpolating unquoted constraint names', 'drop constraint %i restrict', 'drop constraint %s restrict'],
  ])('the regression contract rejects %s', (_label, before, after) => {
    const mutated = sql.replaceAll(before, after);
    expect(mutated).not.toBe(sql);
    expect(hasScopedLegacyRemoval(mutated)).toBe(false);
  });

  it('rejects a conflicting standalone index or primary key before making any changes', () => {
    expect(unknownIndexGuard).not.toBe('');
    expect(unknownIndexGuard).toContain('where u.indrelid = brief_table and u.indisunique');
    expect(unknownIndexGuard).toContain('and u.indnkeyatts = 2');
    expect(unknownIndexGuard).toContain('array[u.indkey[0], u.indkey[1]] @> array[family_column, date_column]');
    expect(unknownIndexGuard).toContain("and not exists ( select 1 from pg_catalog.pg_constraint c where c.conrelid = brief_table and c.contype = 'u' and c.conindid = u.indexrelid and cardinality(c.conkey) = 2 and c.conkey @> array[family_column, date_column] )");
    expect(sql.indexOf(unknownIndexGuard)).toBeGreaterThan(sql.indexOf(replacementGuard));
    expect(sql.indexOf(unknownIndexGuard)).toBeLessThan(sql.indexOf('for legacy in'));
  });

  it('contains only the scoped constraint DDL and no data, index, policy or privilege changes', () => {
    expect(sql.match(/\balter table\b/g)).toHaveLength(1);
    expect(sql.match(/\bdrop constraint\b/g)).toHaveLength(1);
    expect(sql.match(/\bexecute\b/g)).toHaveLength(1);
    expect(sql).not.toMatch(/\b(?:create|insert|update|delete|truncate|grant|revoke|policy|trigger|cascade|disable|enable)\b/);
    expect(sql).not.toMatch(/\bdrop\s+(?:table|column|index|schema|type)\b/);
    expect(sql).not.toMatch(/\b(?:set_config|dblink|security definer)\b/);
  });
});
