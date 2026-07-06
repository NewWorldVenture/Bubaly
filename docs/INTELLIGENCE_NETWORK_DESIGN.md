# Family Intelligence Network — Aggregation Design (DRAFT for sign-off)

> Status: **proposal, not built.** The consent model, k-anonymity gate, and
> contribution preview are shipped (migrations `0132`, `lib/network/*`). The
> cross-family **aggregation pipeline** described here is deliberately unbuilt —
> it decides what data leaves a household, so it needs an explicit yes on the
> guarantees below before any code lands.

## 1. Goal

Let families benefit from anonymized, aggregate patterns across similar households
("families with kids in the 6–9 band typically start passport renewals ~6 months
before travel") **without any raw family data ever leaving the family**, and
without any insight being traceable to an individual household.

The defining constraint: this must be a *net privacy positive*. If we can't make
it provably safe, we don't ship it.

## 2. Privacy guarantees (the non-negotiables)

1. **Opt-in, off by default.** Already enforced: `network_consent.enabled` defaults
   `false`; `visibleInsights()` returns `[]` unless enabled.
2. **Granular scopes.** A family contributes only the categories it toggled
   (`timing`, `benchmarks`, `recommendations`). Enforced in `visibleInsights`.
3. **Coarse by construction.** Only banded, non-PII features are ever computed —
   age *bands*, count *bands*, habit *bands* (`lib/network/contribution.ts`).
   No names, birthdays, addresses, free text, amounts, or precise counts. Ever.
4. **k-anonymity floor.** No insight is shown or stored unless it is supported by
   at least **K = 20** distinct families (`K_ANONYMITY_FLOOR`, enforced by
   `isSuppressed` / `visibleInsights`). A cohort under K is dropped, not shown.
5. **Aggregate-only egress.** The only thing that ever crosses the family boundary
   is a per-family **feature vector of coarse bands** (see §4), written to a
   family-owned row. Aggregation reads those, never the source tables.
6. **Differential-privacy-lite.** Published aggregate counts get small calibrated
   noise (±) so that adding/removing one family can't be inferred from a delta.
7. **Reversible + forgettable.** Turning off consent deletes the family's
   contribution row immediately; the next aggregation run recomputes without it.

## 3. What we do NOT do

- No raw rows, identifiers, or free text leave `family_id` scope.
- No per-family insight is ever shown ("your neighbor does X").
- No selling/sharing to third parties. No cross-linking to external datasets.
- No location precision beyond a coarse region band (if ever added).

## 4. Data model (proposed — `0133`)

Two new tables. One is family-owned (the coarse contribution); one holds only
suppressed-safe aggregates.

```
network_contributions            -- family-owned; the ONLY egress surface
  family_id      uuid pk  fk families
  cohort_key     text            -- coarse cohort bucket, e.g. "kids:6-9|size:3-4"
  features       jsonb           -- coarse bands only (validated against a whitelist)
  scopes         jsonb           -- snapshot of consented scopes at write time
  updated_at     timestamptz
  -- RLS: family-scoped (a family can see/delete only its own row)

network_aggregates               -- service-written; already k-anonymized
  id             uuid pk
  scope          text            -- timing | benchmarks | recommendations
  cohort_key     text
  metric         text            -- e.g. "passport_renewal_lead_days_p50"
  value          numeric
  cohort_size    integer         -- always >= K (rows below K are never written)
  computed_at    timestamptz
  -- RLS: readable by any family whose consent.enabled AND scope opted-in
```

`features` is validated on write against an allowlist of banded keys — a bad
writer cannot smuggle raw values in.

## 5. Pipeline (proposed cron `network-aggregate`)

Runs daily, service role:

1. **Contribute.** For each family with `consent.enabled`, recompute the coarse
   feature vector (reuse `computeContribution` + the banding helpers) and upsert
   `network_contributions`. Families that opted out have their row deleted.
2. **Aggregate.** Group contributions by `(scope, cohort_key, metric)`. For each
   group: if `count(distinct family) < K` → **skip** (never written). Else compute
   the statistic, add DP noise, write/replace the `network_aggregates` row.
3. **Serve.** `visibleInsights()` maps `network_aggregates` rows a family is
   entitled to (opted-in scope) into `InsightCandidate`s; the k-floor is re-checked
   at read time as defense-in-depth.

Everything flows through the gate that already exists — the cron cannot bypass
`isSuppressed`.

## 6. Threat model (and mitigations)

| Threat | Mitigation |
|---|---|
| Re-identify a family from a small cohort | K-floor (≥20) + DP noise; cohorts keyed on coarse bands only |
| Differencing attack (compare runs to isolate one family) | DP noise on published counts; replace-in-place, no per-run deltas exposed |
| Malicious writer smuggles PII into `features` | Server-side allowlist validation of banded keys; no free text |
| Consent revoked but data lingers | Opt-out deletes the contribution row; aggregates recomputed without it |
| Insider/DB dump | `network_aggregates` holds only ≥K aggregates; `network_contributions` holds only coarse bands, no identifiers |

## 7. Open decisions for you

1. **K value.** 20 is the proposed floor. Higher (50/100) = safer but fewer
   insights early. Your call.
2. **DP noise budget.** How much accuracy to trade for the differencing guarantee.
3. **Cohort granularity.** Which band combinations define a "similar family"
   (kids bands × household size × region?). Finer = more relevant, smaller cohorts.
4. **Region.** Do we include any geography band at all? (Default proposal: **no**.)
5. **Launch gating.** Hold insights behind a "network has ≥N families" global
   threshold so early adopters never see thin data.

## 8. Rollout

1. Sign-off on §2 guarantees + §7 decisions.
2. Migration `0133` (the two tables + RLS + `features` allowlist check).
3. `lib/network/aggregate.ts` (pure: grouping, k-suppression, DP noise) + tests.
4. `network-aggregate` cron (service role) wired to the pure core.
5. Flip real `InsightCandidate`s on in `/dashboard/intelligence` (currently `[]`).

Nothing in steps 2–5 begins until step 1.
