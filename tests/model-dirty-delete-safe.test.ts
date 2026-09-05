import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Migration 0249: deleting a family cascades to the ten tables that carry
// trg_mark_model_dirty; each cascaded DELETE fired the trigger with the
// vanished family id and its INSERT into family_model_dirty violated the FK,
// so no family with members could be deleted. Reproduced and fixed on a
// PGlite replay (0001–0005 + 0134 [+ 0249]); this guards the shape of the fix.
const fix = readFileSync('supabase/migrations/0249_model_dirty_delete_safe.sql', 'utf8');
const original = readFileSync('supabase/migrations/0134_model_dirty.sql', 'utf8');

describe('0249 mark_model_dirty is delete-safe', () => {
  it('redefines the same trigger function (security definer, same search_path)', () => {
    expect(fix).toContain('create or replace function public.mark_model_dirty()');
    expect(fix).toContain('security definer');
    expect(fix).toContain('set search_path = public');
    expect(original).toContain('create or replace function public.mark_model_dirty()');
  });
  it('skips ids whose family is gone and tolerates the FK race', () => {
    expect(fix).toContain('if not exists (select 1 from public.families f where f.id = v_family) then');
    expect(fix).toContain('exception when foreign_key_violation then');
  });
  it('keeps the dirty-marking upsert for live families', () => {
    expect(fix).toContain('insert into public.family_model_dirty (family_id, dirty, reason, marked_at)');
    expect(fix).toContain('on conflict (family_id) do update set dirty = true, reason = excluded.reason, marked_at = now()');
  });
  it('does not re-attach or detach triggers (0134 owns the table list)', () => {
    expect(fix).not.toMatch(/create trigger|drop trigger/i);
    expect(original).toContain("'family_members','pets','vehicles','school_classes','teams'");
  });
});
