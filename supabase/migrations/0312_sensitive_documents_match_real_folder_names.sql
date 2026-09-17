-- Bubaly :: 0312 - the sensitive-document rule has to match what people type
--
-- `documents.category` is a FREE-TEXT folder name the person types
-- (components/modules/documents-module.tsx sets `category: form.category.trim()
-- || 'general'`), and that upload path never sets `is_secure`. So for anything
-- filed through Documents, the CATEGORY is the whole boundary.
--
-- 0266's classifier tested exact membership of a seventeen-word list. Measured
-- on a replayed database against the folder names a parent actually types:
--
--   is_sensitive_document(false, 'medical')          -> true
--   is_sensitive_document(false, 'Medical Records')  -> FALSE
--   is_sensitive_document(false, 'Tax Returns')      -> FALSE
--   is_sensitive_document(false, 'Bank Statements')  -> FALSE
--   is_sensitive_document(false, 'Passports & IDs')  -> FALSE
--   is_sensitive_document(false, 'Wills & Estate')   -> FALSE
--   is_sensitive_document(false, 'Health Insurance') -> FALSE
--
-- The last two are the ones that show it is a matching bug rather than a
-- vocabulary gap: every word in them was already on the list. A plural or a
-- second word was enough to turn the guard off.
--
-- This matters beyond one predicate. `documents_select/insert/update/delete`
-- (0266) and `document_object_is_restricted` (0303, the storage-bytes guard)
-- all decide through this function — so a passport scan filed under "Passports
-- & IDs" was readable by every child in the family, bytes included, exactly the
-- thing 0303 was written to stop.
--
-- ── the change ─────────────────────────────────────────────────────────────
--
-- Match per WORD rather than on the whole string: lowercase, split on
-- non-alphanumerics, and test each word against the list, also trying the word
-- with one trailing "s" removed. Stripping the "s" is what lets "Wills" reach
-- "will"; doing it on WORDS rather than substrings is what keeps "Kids" away
-- from the bare "id" that a substring match would have hit.
--
-- A short phrase list carries the few cases no single word does ("social
-- security", "green card", "credit card"), and the vocabulary gains the terms a
-- family vault obviously holds — birth, marriage, custody, mortgage, pension,
-- prescription, diagnosis and so on.
--
-- Over-classification is the safe direction and is chosen deliberately: a gym
-- membership filed under "Health Club" becoming adults-only is a smaller harm
-- than a child reading a diagnosis.
--
-- This is still a list, and a list is what let this through. What changed is
-- that it now matches the language people write in. lib/documents/sensitivity.ts
-- is the same rule for the browser, and tests/document-vault-boundary.test.ts
-- fails if the two drift.
--
-- IMMUTABLE is preserved: four RLS policies depend on this function, and the
-- body stays pure string work. No index references it (checked).

create or replace function public.is_sensitive_document(p_is_secure boolean, p_category text)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  with normalized as (
    select btrim(regexp_replace(lower(coalesce(p_category, '')), '[^a-z0-9]+', ' ', 'g')) as cat
  ),
  vocabulary as (
    select array[
      -- the original seventeen
      'legal', 'medical', 'health', 'financial', 'finance', 'tax', 'taxes', 'insurance',
      'passport', 'passports', 'id', 'identity', 'visa', 'bank', 'banking', 'will', 'estate',
      -- identity and status
      'ssn', 'birth', 'marriage', 'divorce', 'citizenship', 'naturalization', 'immigration',
      'custody', 'guardianship', 'attorney',
      -- money
      'mortgage', 'deed', 'loan', 'payroll', 'salary', 'pension', 'retirement',
      'investment', 'brokerage',
      -- health
      'prescription', 'diagnosis', 'therapy', 'psychiatric', 'medicare', 'medicaid',
      'license', 'licence'
    ]::text[] as words,
    array['social security', 'green card', 'credit card']::text[] as phrases
  )
  select coalesce(p_is_secure, false)
     or exists (
          select 1 from normalized n, vocabulary v
          where n.cat <> ''
            and exists (select 1 from unnest(v.phrases) as phrase where position(phrase in n.cat) > 0)
        )
     or exists (
          select 1
          from normalized n, vocabulary v,
               unnest(string_to_array(n.cat, ' ')) as token
          where token <> ''
            and (
              token = any(v.words)
              -- One trailing "s", so "Wills" reaches "will" — but "Kids" only
              -- ever reaches "kid", never the bare "id".
              or (length(token) > 1 and right(token, 1) = 's'
                  and left(token, length(token) - 1) = any(v.words))
            )
        );
$function$;

comment on function public.is_sensitive_document(boolean, text) is
  'Adults-only test for a document. Matches the category per WORD (with one trailing "s" stripped) plus a short phrase list, because category is a free-text folder name: 0266 matched the whole string exactly, so "Medical Records" and even "Health Insurance" read as ordinary. documents_select/insert/update/delete and document_object_is_restricted all decide through this.';
