import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, bodyOf } from './helpers/source-order';

// The held 0526 (KIDS-O02). A subscription's episodes and a book's audio
// address reach every member's library and stream through Bubaly's own media
// route; the actions let only a parent or adult add them, but 0284's policies
// let any member write any library row, and created_by is whatever the writer
// says. 0526 puts the rule on library_feeds and library_items. Human Refresh
// retains the caller's write client and may fail under that future policy
// (tests/a-library-refresh-is-the-servers-write-and-not-a-guests.test.ts).

const M = 'supabase/reserved/0526_what_the_library_streams_is_added_by_a_parent_or_adult.sql';
const P = 'docs/audit/reserved/what-the-library-streams-is-added-by-a-parent-or-adult-check.sql';
const W = '.github/workflows/library-curation-runtime.yml';
const read = (p: string) => readFileSync(p, 'utf8');

describe('what the library streams is added by a parent or adult (0526)', () => {
  const sql = read(M);
  const feeds = bodyOf(sql, 'create or replace function public.a_library_feed_is_added_by_a_parent_or_adult()', '$$;');
  const items = bodyOf(sql, 'create or replace function public.a_library_items_audio_is_added_by_a_parent_or_adult()', '$$;');

  it('one guard per table, SECURITY DEFINER with a pinned search_path, exempting a caller with no user', () => {
    for (const body of [feeds, items]) {
      expect(body).toContain('security definer\nset search_path = public, pg_temp');
      expect(body).toContain('if me is null then\n    return new; -- service role / server-side jobs');
    }
    expect(feeds).not.toContain('media_url');
    expect(items).not.toContain('feed_url');
  });

  it('a subscription is a parent\'s or adult\'s to add, retarget or move', () => {
    expect(feeds).toContain('if not public.can_manage_family(new.family_id) then');
    expect(feeds).toContain('elsif (new.family_id, new.feed_url) is distinct from (old.family_id, old.feed_url)\n        and not (public.can_manage_family(new.family_id) and public.can_manage_family(old.family_id)) then');
  });

  it('an audio address or a feed is a parent\'s or adult\'s; a title or a link is anyone\'s', () => {
    expect(items).toContain('if (new.media_url is not null or new.feed_id is not null)\n       and not public.can_manage_family(new.family_id) then');
    expect(items).toContain('elsif (new.family_id, new.feed_id, new.media_url) is distinct from (old.family_id, old.feed_id, old.media_url)');
    expect(items).not.toContain('page_url');
  });

  it('created_by names the writer, and empties only once that account is gone', () => {
    for (const body of [feeds, items]) {
      expect(body).toContain("(tg_op = 'INSERT' and new.created_by is not null and new.created_by <> me)");
      // Null-safe: `new.created_by = me` is NULL for an emptied column, and a
      // manager's emptying would then slip through every clause.
      expect(body).toContain('and not (new.created_by is not distinct from me and public.can_manage_family(new.family_id))');
      expect(body).toContain('and not (new.created_by is null and not exists (select 1 from auth.users u where u.id = old.created_by))');
      expect(body).toContain("raise exception 'A row in the family library names the adult who added it' using errcode = '42501';");
    }
  });

  it('the triggers are BEFORE INSERT OR UPDATE, after 0481\'s guest guard, and checked in place', () => {
    expect(sql).toContain('create trigger trg_library_feeds_parent_or_adult before insert or update on public.library_feeds');
    expect(sql).toContain('create trigger trg_library_items_parent_or_adult before insert or update on public.library_items');
    // Same-event triggers fire in name order: 0464's guard answers a guest first.
    expect('trg_library_feeds_parent_or_adult' > 'trg_library_feeds_not_a_guests').toBe(true);
    expect('trg_library_items_parent_or_adult' > 'trg_library_items_not_a_guests').toBe(true);
    expect(sql).not.toMatch(/before (insert or update or )?delete|or delete on public\.library/);
    expect(sql).toContain("raise exception '0526: % of 2 library tables carry the parent-or-adult guard', n;");
    expect(sql).not.toMatch(/create policy|drop policy/);
  });
});

describe('the probe and its workflow', () => {
  it('the probe measures every role\'s writes and carries its controls', () => {
    const probe = read(P);
    for (const role of ["('teen', ", "('child', ", "('caregiver', "]) expect(probe, role).toContain(role);
    expect(probe).toContain("got := pg_temp.c0526_try('service_role', '',");
    expect(probe).toContain("guest_guard constant text := '42501: A guest can see the household but not change it';");
    expect(probe).toContain("delete from auth.users where id = '00000000-0000-4000-8526-0000000000a8';");
    expect(probe).toContain('-- N1. Both guards disabled.');
    expect(probe).toContain("-- M1. library_items' guard on INSERT only.");
  });

  it('the workflow shows the failure, applies 0526 twice, and re-runs the released probes over the cascades', () => {
    const wf = read(W);
    expect(at(wf, '- name: The released schema lets a child add and retarget what the library streams')).toBeLessThan(at(wf, `-f ${M}\n`));
    expect(wf.split(`psql -X -v ON_ERROR_STOP=1 -q -f ${M}\n`)).toHaveLength(3);
    expect(wf).toContain("grep -qE 'CONTROL|PRECONDITION'");
    expect(wf).toContain("grep -qF 'what-the-library-streams-is-added-by-a-parent-or-adult: OK'");
    for (const probe of ['an-erasure-actually-erases', 'family-delete-cascade', 'definer-functions-check-their-caller', 'plpgsql-bodies-resolve']) {
      expect(wf, probe).toContain(`docs/audit/${probe}-check.sql`);
    }
  });
});
