import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 0257 has to be true for EVERY family, not just the next one created: a
// settings page that some households cannot open is worse than none. So the
// trigger seeds new families and the backfill catches the existing ones — and
// the function it replaces must keep doing everything 0003 made it do.
const raw = readFileSync('supabase/migrations/0257_family_ai_settings.sql', 'utf8');
const sql = raw.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const original = readFileSync('supabase/migrations/0003_functions_triggers.sql', 'utf8');

describe('0257 family AI settings', () => {
  it('stores one row per family, with the columns §11 and §12 name', () => {
    expect(sql).toContain('create table if not exists public.family_ai_settings');
    expect(sql).toContain('family_id         uuid primary key references public.families(id) on delete cascade');
    for (const column of ['behavior', 'category_behavior', 'risk_overrides', 'child_channels', 'memory_enabled']) {
      expect(sql, column).toContain(column);
    }
    expect(sql).toContain("check (behavior in ('recommend', 'prepare', 'execute'))");
  });

  it('defaults to what families already experience, so applying it changes nobody’s behaviour', () => {
    expect(sql).toMatch(/behavior\s+text not null default 'execute'/);
    expect(sql).toMatch(/enabled\s+boolean not null default true/);
    expect(sql).toMatch(/memory_enabled\s+boolean not null default true/);
  });

  it('lets members read and only managers write', () => {
    expect(sql).toMatch(/create policy family_ai_settings_select[\s\S]*?is_family_member\(family_id\)/);
    for (const command of ['insert', 'update', 'delete']) {
      const policy = sql.slice(sql.indexOf(`create policy family_ai_settings_${command}`));
      expect(policy.slice(0, policy.indexOf(';')), command).toContain('can_manage_family(family_id)');
    }
  });

  it('seeds new families and backfills the existing ones', () => {
    expect(sql).toContain('insert into public.family_ai_settings (family_id)\n  values (new.id)\n  on conflict (family_id) do nothing');
    expect(sql).toMatch(/insert into public\.family_ai_settings \(family_id\)\s+select f\.id from public\.families f\s+on conflict \(family_id\) do nothing/);
    expect(sql).toContain('create trigger on_family_created');
  });

  it('keeps everything 0003’s handle_new_family() did', () => {
    // Replacing a function is how you lose a side effect nobody was watching.
    const replaced = sql.slice(sql.indexOf('create or replace function public.handle_new_family()'));
    for (const statement of ['insert into public.family_members', 'insert into public.subscriptions', "'parent'", "interval '14 days'"]) {
      expect(replaced, statement).toContain(statement);
      expect(original, statement).toContain(statement);
    }
  });
});
