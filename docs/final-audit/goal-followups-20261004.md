# Goal followups — 2026-10-04

This is a source reconciliation for `codex/audit-goal-followups-20261004`, separate from the authoritative `finalaudit.md`. It preserves the October 4 read-only inventory and local verification; it does not close the goal, establish production schema state, or authorize changes to active authors' branches.

The composed source checkpoint is `295d4ed0d5d1c87cb160f632da64d8882a1e986c`: calendar commit `2699ccc8709ed7596f1d066d5275aa4830738f8a`, then bills commit `014318265eb6557ba3346a21ac65a35fc445fcbe`, merged with main `7e19a9f950f58a44956063da0f38f15eab95d7fd`. Calendar work covers complete paged windows, all-day calendar dates, DST and navigation. Bills retain month anchors and require owner confirmation for ambiguous legacy days or unknown cadence. These commits do not incorporate the separate calendar provider exception/restore/fencing stacks or the messaging/meal candidates below.

## Closed is not merged

The cached GitHub read found all six PRs **CLOSED**, with `mergedAt` and `mergeCommit` null. Neither their recorded heads nor the separately observed live branch heads were ancestors of main `7e19a9f`. These are observed October 4 heads, not an assertion that those branches cannot advance again.

| PR | Recorded closed-PR head | Observed live branch head | Integration evidence |
| --- | --- | --- | --- |
| [#834](https://github.com/NewWorldVenture/Bubaly/pull/834) | `951b98ae` | `0135f81bd91f319c381c1f45cef8e67088e029b0` | Unmerged; live messaging successor differs. |
| [#853](https://github.com/NewWorldVenture/Bubaly/pull/853) | `729d81f2` | `729d81f2` | Unmerged replay/verifier repair. |
| [#854](https://github.com/NewWorldVenture/Bubaly/pull/854) | `26c05e75` | `26c05e75` | Unmerged history-preserving alternative. |
| [#890](https://github.com/NewWorldVenture/Bubaly/pull/890) | `6baf7ca6` | `6baf7ca6` | Unmerged atomic-meal candidate. |
| [#918](https://github.com/NewWorldVenture/Bubaly/pull/918) | `b0ab762a` | `b0ab762a` | Unmerged calendar provider restore stack. |
| [#932](https://github.com/NewWorldVenture/Bubaly/pull/932) | `ab9e4620` | `4e5e31443cbdf8f2e6fc34ba8e5eee2f3af8c19b` | Unmerged recurring-bill successor differs. |

Local `git merge-base --is-ancestor <head> 7e19a9f` independently returns 1 for available recorded objects `951b98ae`, `729d81f2`, `26c05e75`, `6baf7ca6` and `ab9e4620`. The other observed heads are retained from the earlier remote inventory; they were unavailable as objects in this integration checkout. Stale local remote-tracking refs are not substituted for that live inventory. No repeated GitHub calls were made while writing this note.

## Owner decisions and migration reservations

The owner selected **preserve existing participants' access and create an empty Family Chat** on October 4. Existing history must not be adopted into a family-wide channel or exposed to future members. The #854 alternative removes history adoption; the #834 successor still has adoption behavior. Its later stop/cancellation source changes are a diff observation, not runtime acceptance. The selected history policy is now being implemented in a separate isolated messaging candidate; it is not part of this branch yet.

The owner requires the `family-media` Storage bucket to remain **PUBLIC**. This followup does not apply a private-bucket conversion or claim that public family-media exposure is resolved. Storage changes require an owner-compatible access design and separate verification.

Main's 449-file migration audit ended at namespace 0474 and proposed 0475 next. That was insufficient for allocation because unmerged and dirty candidates already occupied later numbers. The cross-worktree/live-head inventory observed reservations through 0490:

| Namespace | Observed reservation or conflict |
| --- | --- |
| 0475–0476 | Messaging [#834/#853](https://github.com/NewWorldVenture/Bubaly/pull/834) and atomic meals [#890](https://github.com/NewWorldVenture/Bubaly/pull/890) collide. |
| 0477–0481 | Other AI/memory/refund and alternative meal stacks have allocations; compose their actual sources before resequencing. |
| 0482–0487 | Calendar, AI rollout, refund, grocery/capture, assignee and restore/card candidates overlap; the former proposed 0475–0489 plan is superseded. |
| 0488 | Live bills `4e5e3144` and dirty AI privacy/allowance successor stacks independently reserve the same number. |
| 0490 | Calendar [#908](https://github.com/NewWorldVenture/Bubaly/pull/908) `e507246d`; [#913](https://github.com/NewWorldVenture/Bubaly/pull/913) `9a27a8b3` also carries 0482; [#918](https://github.com/NewWorldVenture/Bubaly/pull/918) `b0ab762a` also carries 0482/0483. |

The inventory found no allocation at 0491 before this candidate reserved it. [0491_preserve_recurring_bill_anchor.sql](../../supabase/migrations/0491_preserve_recurring_bill_anchor.sql) is present on this branch, generated with the Supabase CLI and assigned above those observed reservations. It adds nullable `due_day` with a 1–31 check, no default and no backfill. The candidate's filename audit passes with 450 files and next namespace 0492. This is a source reservation, not a globally locked namespace or production migration record. No active author's migrations were renamed or rewritten.

Read-only composition review subsequently found that active Claude [#968](https://github.com/NewWorldVenture/Bubaly/pull/968), exact head `309bb8b3b78d0ddc78faedf6868adeb4933744d4`, adds no SQL migration but changes the filename guard to reject every gap above retired high-water 0474. Running its exact guard against a disposable filename-only fixture copied from this branch at `57b9f3fdd7a88bd1b6c58cec4acc44f87d528d76` reproduces exit 1 for missing generations 0475–0490. The next-version tests disagree (0475 on #968, 0492 here). This branch's existing guard still passes; the reproduced failure belongs to future composition. Reconcile candidate numbering with the actual merge sequence and retain the final guard, rather than filling gaps with fake migrations or blindly taking a namespace already reserved by another candidate. Production catalog compatibility is still required.

The same #968 audit counter independently counts this branch's register as 14,538 unique rows: 11,700 NOT STARTED, 2,485 IN PROGRESS, 185 PASS, 159 FIXED + PASS, 9 BLOCKED. It detected two stale current-summary values (11,701/2,484); the authoritative summary is corrected without changing any row or closure credit. #968's 125 historical evidence qualifications remain active-author work and must be reconciled with newer checkpoints before integration.

The reproduced migration conflict is [published on #969](https://github.com/NewWorldVenture/Bubaly/pull/969#issuecomment-5984796221). After the decision/count documentation update, the unchanged document and migration tests pass **602/602**. An independent run of the unchanged counter from subsequently observed #968 head `bcc8edd4303cee8dfdf7964453ba547bc40c6358` passes the corrected authoritative ledger with no problems. No author branch was changed by these checks.

## Verification and remaining limits

Root's combined local source verification reports **945 tests in 22 files passed** and a full TypeScript check passed. A fresh disposable PostgreSQL **17.10** cluster executed the exact anchor migration and [fixture](../../tests/fixtures/recurring-bill-anchor.sql), including replay twice, retained null legacy February/March 28 anchors, and rejection of 0/32; the cluster was stopped. This does not test the production PostgreSQL catalog.

The browser-test overlay on source checkpoint `295d4ed` passes **23 Chromium cases**: the existing finance read-state checks and nine new actual-modal payment cases. They mount real React/UI/helpers and use synthetic intercepted SDK transport for payment writes. The complete fixture module-graph guard passes **49 checks**; scoped lint and whitespace checks pass. Payment checks cover blank March 28–30 anchors, exact family-scoped CAS predicates/payload, stale zero-row errors, missing-column/cache errors, duplicate clicks and cancellation. Creation forms, hosted RLS and live provider flows are not covered. The existing stale-write modal closes/refreshes after showing an error; it reports no success.

The preceding two-failure combined run had 943 passing tests plus the server-calendar import-graph failure and a Windows separator mismatch in the birthday exemption lookup. Those were repaired by extracting pure bill scheduling helpers and normalizing only the existing exemption lookup. The later passing counts apply to this followup's source and test overlay, not to other branches or older whole-suite/provider failures. Local Node was 24.19.0; the repository declares 24.21.0, so these local checks do not replace CI on the declared runtime.

The coordinator's current read-only production evidence matches main/build identity `7e19a9f`. This confirms source identity, **not schema application**. A current production migration ledger/catalog, effective policies/functions/triggers and relevant data preflight are still missing. The older 192-row migration ledger and migration-0177 timeout are historical observations only and cannot establish today's catalog.

Next integration steps remain: implement the selected history policy; select durable source bindings from the unmerged stacks; reserve unique migration numbers in an isolated composition without overwriting active work; replay the combined schema and its boundary/race probes; and separately obtain current production compatibility evidence. Provider exception stacks, production migration verification and overall goal completion remain open.
