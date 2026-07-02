# Files hub — expandable nav + sub-pages

The **Files** item in the left navigation is now an expandable group. The parent
row still opens the File Manager; the caret reveals five sub-destinations:

| Nav item | Route | What it shows |
| --- | --- | --- |
| File Manager | `/dashboard/documents` | The existing full documents module (unchanged). |
| Cloud Storage | `/dashboard/files/cloud` | Every `documents` row for the family. |
| Secure Vault | `/dashboard/files/vault` | Rows with **`is_secure = true`**. Uploads here are flagged secure. |
| Shared Files | `/dashboard/files/shared` | Rows with `is_secure = false`. |
| Document Scanner | `/dashboard/scan` | The existing scan page (unchanged). |

## Nav mechanism

`NavItem` (`lib/constants/navigation.ts`) gains an optional `children?: NavItem[]`.
`NavEntry` (`components/app/nav-shared.tsx`) renders any parent that has children
as an `ExpandableNavEntry`: the row navigates, the caret expands/collapses, and
the group auto-expands when the current route is inside it. Both the desktop
sidebar and the mobile drawer render through `NavEntry`, so they behave the same.

## Data model

All three sub-pages reuse the existing **`documents`** table + the private
`documents` Storage bucket via `lib/storage/documents.ts`
(`uploadFamilyDocument` / `getDocumentSignedUrl` / `removeFamilyDocument`).

### Migration `0117_documents_secure.sql`
Adds `documents.is_secure boolean not null default false` and an index on
`(family_id, is_secure)`. Additive + backward-compatible; existing rows stay
non-secure (Shared). RLS is unchanged — `documents` already carries a
family-scoped policy.

## The sub-pages (`components/modules/files-hub-module.tsx`)

One shared module parameterized by `view` (`cloud` / `vault` / `shared`):

- **Summary tiles** — file count, storage used, secure count, shared count
  (`storageSummary`).
- **Folder chips** — categories with counts (`groupByCategory`), tap to filter.
- **Search + sort** — title/category search, Most recent / Name / Largest.
- **File grid** — kind-aware icons (`fileKind`), size (`formatBytes`), folder,
  date, Secure badge; per-file actions: **Open** (signed URL), **favorite**,
  **move to/from Vault** (`is_secure` toggle), **delete** (confirm + storage
  cleanup).
- **Upload** — real Storage upload; on the Vault page the row is created with
  `is_secure = true`. Validation, toasts, loading/empty/error states throughout.

Pure logic lives in `lib/files/overview.ts` and is unit-tested in
`tests/files-overview.test.ts` (9 tests).

## Seeding demo data

`supabase/seed_files_one_family.sql` (500 `documents` rows) now also sets
`is_secure` on ~30% of rows so all three sub-pages populate. Idempotent
(seeded rows live under `storage_path 'seed/files/…'` and are replaced on
re-run). Note: seeded rows have synthetic storage paths — Open/Download on a
seeded row reports a missing object by design; upload a real file to test the
full round-trip.

```bash
supabase db push          # apply migration 0117 (or run the .sql directly)
npm run db:seed:files     # or paste supabase/seed_files_one_family.sql into the SQL editor
```

Verify: expand **Files** in the sidebar → Cloud Storage shows 500 files,
Secure Vault ~150, Shared Files ~350.
