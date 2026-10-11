-- Bubaly :: 0484 - a trip links a document once, and a guest does not file
--                   paperwork
-- ----------------------------------------------------------------------------
-- Two small items from the 2026-10-10 documents audit (audit/documents-fix),
-- numbered 0484 by owner decision of 2026-10-10.
--
-- 1. vacation_documents (0070) is the join that tells a trip which passport or
--    ticket scan it carries. Nothing made the pair unique, so two quick taps on
--    "Link" (or a retried request) filed the same document on the same trip
--    twice, and the trip's documents panel listed it twice. The application
--    already treats a 23505 on this write as "already linked"
--    (lib/services/documents/index.ts); this gives it the index that answer
--    assumes. Rows with no document_id (a typed passport number, a file URL)
--    are not constrained: a unique index treats NULLs as distinct.
--
--    The index is built only over a table in which no pair is already linked
--    twice. An earlier draft collapsed duplicated pairs to their earliest row
--    first; at the coordinator's request (2026-10-10) that dedupe is replaced
--    by a refusal: the preflight vacation_documents_duplicates_refuse() raises
--    23505 naming the count and a sample of the duplicated pairs, and the
--    migration stops there having deleted nothing. The owner dedupes by hand
--    and re-runs. docs/audit/a-trip-links-a-document-once-check.sql proves the
--    refusal leaves both rows in place and that the clean path builds the index.
--
-- 2. paperwork_items (0169) is the household's paperwork queue: forms, renewals,
--    fees. /family/permissions shows it to a guest as read-only, exactly like
--    the eight resources 0464 guards, and the database let a guest file,
--    rewrite or delete every item. This adds the table to 0464's guard: the same
--    BEFORE INSERT, UPDATE or DELETE trigger, the same 42501, the same
--    service-role exemption, the same family_id column check.
--
-- Idempotent: the preflight deletes nothing and passes over a table the index
-- already keeps unique, the index is IF NOT EXISTS, and the trigger is dropped
-- if it exists before it is created.

-- ── 1. a trip links a document once ─────────────────────────────────────────
do $$
begin
  if to_regclass('public.vacation_documents') is null then
    raise exception '0484: public.vacation_documents does not exist';
  end if;
end
$$;

-- Preflight, fail-closed: a pair linked more than once is reported, with the
-- count and a sample of the pairs, and the migration stops here having changed
-- nothing. The owner dedupes by hand and re-runs. A function rather than an
-- inline block so docs/audit/a-trip-links-a-document-once-check.sql can run
-- exactly this check against duplicates it seeds.
create or replace function public.vacation_documents_duplicates_refuse()
returns void
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_pairs  bigint;
  v_extra  bigint;
  v_sample text;
begin
  select count(*),
         coalesce(sum(n) - count(*), 0),
         string_agg(format('(vacation %s, document %s) x%s', vacation_id, document_id, n), ', '
                    order by n desc, vacation_id, document_id) filter (where rn <= 5)
    into v_pairs, v_extra, v_sample
    from (select vacation_id, document_id, count(*) as n,
                 row_number() over (order by count(*) desc, vacation_id, document_id) as rn
            from public.vacation_documents
           where document_id is not null
           group by vacation_id, document_id
          having count(*) > 1) d;
  if v_pairs > 0 then
    raise exception using
      errcode = '23505',
      message = format('0484: %s (vacation_id, document_id) pair(s) are linked more than once (%s surplus row(s)); the unique index was not built and no row was deleted. Dedupe by hand, then re-run. Sample: %s',
                       v_pairs, v_extra, v_sample),
      hint = 'select vacation_id, document_id, count(*) from public.vacation_documents where document_id is not null group by 1, 2 having count(*) > 1';
  end if;
end
$fn$;

comment on function public.vacation_documents_duplicates_refuse() is
  '0484: raises 23505, naming the count and a sample of the pairs, while any (vacation_id, document_id) is linked more than once; deletes nothing. Run before vacation_documents_vacation_document_key is built.';

revoke all on function public.vacation_documents_duplicates_refuse() from public, anon, authenticated;

do $$
begin
  perform public.vacation_documents_duplicates_refuse();
end
$$;

create unique index if not exists vacation_documents_vacation_document_key
  on public.vacation_documents (vacation_id, document_id);

comment on index public.vacation_documents_vacation_document_key is
  'A document is linked to a trip once; the application reads 23505 here as "already linked" (0484).';

-- ── 2. a guest does not file paperwork ──────────────────────────────────────
do $$
begin
  if to_regclass('public.paperwork_items') is null then
    raise notice '0484: public.paperwork_items is not there -- guest guard not installed';
    return;
  end if;
  if to_regprocedure('public.household_write_is_not_a_guests()') is null then
    raise exception '0484: household_write_is_not_a_guests() (0464) is missing';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'paperwork_items' and column_name = 'family_id') then
    raise exception '0484: public.paperwork_items.family_id does not exist';
  end if;
  drop trigger if exists trg_paperwork_items_not_a_guests on public.paperwork_items;
  create trigger trg_paperwork_items_not_a_guests
    before insert or update or delete on public.paperwork_items
    for each row execute function public.household_write_is_not_a_guests();
end
$$;

-- ── self-check ───────────────────────────────────────────────────────────────
do $$
declare
  v_keys text;
begin
  select string_agg(a.attname, ',' order by k.ord)
    into v_keys
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join lateral unnest(i.indkey) with ordinality as k(attnum, ord) on true
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
   where c.relname = 'vacation_documents_vacation_document_key'
     and i.indrelid = 'public.vacation_documents'::regclass
     and i.indisunique
     and i.indpred is null
     and i.indexprs is null;
  if v_keys is distinct from 'vacation_id,document_id' then
    raise exception '0484: vacation_documents has no plain unique index on (vacation_id, document_id); found %', coalesce(v_keys, 'none');
  end if;
  if to_regprocedure('public.vacation_documents_duplicates_refuse()') is null then
    raise exception '0484: vacation_documents_duplicates_refuse() (the preflight) is missing';
  end if;

  if to_regclass('public.paperwork_items') is not null and not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.paperwork_items'::regclass
       and t.tgname = 'trg_paperwork_items_not_a_guests'
       and not t.tgisinternal
       and t.tgenabled <> 'D'
       and t.tgfoid = 'public.household_write_is_not_a_guests()'::regprocedure
  ) then
    raise exception '0484: trg_paperwork_items_not_a_guests is missing, disabled or runs another function';
  end if;

  raise notice '0484 OK: a trip links a document once; paperwork_items carries 0464''s guest guard';
end
$$;
