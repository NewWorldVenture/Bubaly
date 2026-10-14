// lib/reasoning/engine-server.ts — service-callable loader for the unified Family
// Reasoning Engine (R7). It COMPOSES the existing pure engines from live data —
// the FOI orchestrator + its ranked suggestions, the graph reasoning insights (R2),
// and the hard signals (R10) — and runs answerFamilyQuestions() to produce the one
// six-question report every surface consumes. Best-effort per source: any one that
// errors just contributes nothing (the engine treats missing input as calm).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { LocaleCode } from '@/lib/i18n/locales';
import { signalWordsFor } from '@/lib/intelligence/hard-signals';
import { managerOnlyItem } from '@/lib/ai/context/manager-only';
import { loadOperatingIndex, type SnapshotReach } from '@/lib/operating-index/server';
import { loadFamilyContext } from '@/lib/reasoning/context';
import { reasoningInsights } from '@/lib/reasoning/insights';
import {
  answerFamilyQuestions, reasoningSummary,
  type ReasoningEngineInput, type ReasoningReport, type ReasoningSignal, type ReasoningNextAction, type ReasoningReadSource,
} from '@/lib/reasoning/engine';

type DB = SupabaseClient<Database>;
type Translate = (key: string, params?: Record<string, string | number>) => string;

const IMPACT_PRIORITY: Record<string, number> = { high: 90, medium: 60, low: 35 };
const SIGNAL_HREF = '/dashboard/family-signals';

/**
 * Who a report is FOR, beyond their language. A budget-drift signal carries the
 * household's spend and cap for a budget, and household money is a parent's or
 * an adult's (lib/finance/household-money.ts readsHouseholdMoney, the held
 * 0514). The family-signals page and this report showed it to a child, a guest
 * and everyone else; for them it is left out before the six questions are
 * answered, so no answer, count or headline is built from it.
 *
 * The same goes for the operating index's next moves and the orchestrator's
 * items: "2 accounts are below zero" (the wallet) and "1 upcoming bill not
 * covered" (bills) are counts of the household's money. For anyone else an
 * item that links to a money page or touches a manager-only area
 * (managerOnlyItem, the rule the proactive AI slice applies) is left out the
 * same way.
 */
export type ReasoningViewer = { readsHouseholdMoney: boolean };

/** Every reader. The proactive AI slice composes this and filters per viewer itself. */
const EVERY_SIGNAL: ReasoningViewer = { readsHouseholdMoney: true };

type ReasoningInputs = {
  orchestrator: ReasoningEngineInput['orchestrator'];
  insights: NonNullable<ReasoningEngineInput['insights']>;
  signals: ReasoningSignal[];
  nextActions: ReasoningNextAction[];
  readErrors: ReasoningReadSource[];
};

/** The report from what was read, for `viewer`. */
function composeReport(inputs: ReasoningInputs, viewer: ReasoningViewer, now: Date): ReasoningReport {
  const everything = viewer.readsHouseholdMoney;
  const signals = everything ? inputs.signals : inputs.signals.filter((s) => s.kind !== 'budget_drift');
  const nextActions = everything ? inputs.nextActions : inputs.nextActions.filter((a) => !managerOnlyItem(a.title, a.detail, a.href));
  const orchestrator = everything || !inputs.orchestrator ? inputs.orchestrator : {
    ...inputs.orchestrator,
    answers: inputs.orchestrator.answers.map((a) => ({ ...a, items: a.items.filter((i) => !managerOnlyItem(i.label, null, i.href)) })),
  };
  const report = answerFamilyQuestions({ orchestrator, insights: inputs.insights, signals, nextActions }, now);
  return {
    ...report,
    allClear: report.allClear && inputs.readErrors.length === 0,
    readErrors: inputs.readErrors,
  };
}

/**
 * Assemble the six-question reasoning report from the family's live data.
 *
 * `tz` is the family's IANA zone. Nothing in THIS file resolves a day key with
 * it; it is carried because both sources it composes — the operating index and
 * the family context's snapshot — bound DATE columns with the family's day, and
 * a loader that defaulted it would hand them Greenwich's.
 *
 * `locale` and `t` are whoever the report is FOR, and required. A hard signal is
 * stored worded for whichever scan last wrote it — the nightly model-refresh
 * cron writes en-US, a Refresh writes the presser's language — and budget drift
 * carries money, so each signal is worded again here from its `evidence`
 * (signalWordsFor). The reasoning page passes its reader; the proactive AI
 * context slice, whose reader is the model, passes en-US explicitly.
 *
 * `reach` is whose client `sb` is (SnapshotReach), and required: composing the
 * report loads the operating index, which keeps the household's day only from
 * a client that reads the household. The proactive slice passes 'household'
 * for a manager or the system, 'member' for anyone else.
 */
export async function loadReasoningReport(
  sb: DB, familyId: string, tz: string, locale: LocaleCode, t: Translate, reach: SnapshotReach, now: Date = new Date(), viewer: ReasoningViewer = EVERY_SIGNAL,
): Promise<ReasoningReport> {
  return composeReport(await readReasoningInputs(sb, familyId, tz, locale, t, reach, now), viewer, now);
}

async function readReasoningInputs(
  sb: DB, familyId: string, tz: string, locale: LocaleCode, t: Translate, reach: SnapshotReach, now: Date,
): Promise<ReasoningInputs> {
  const readErrors: ReasoningReadSource[] = [];

  // FOI (orchestrator + ranked suggestions) — the richest single source.
  const foi = await loadOperatingIndex(sb, familyId, tz, reach, now).catch((err) => {
    console.error('[reasoning-engine] operating_index read failed', { familyId, err });
    readErrors.push('operating_index');
    return null;
  });
  const orchestrator = foi?.orchestrator ?? null;
  const nextActions: ReasoningNextAction[] = (foi?.index.suggestions ?? []).map((s) => ({
    title: s.title, detail: s.detail, href: s.href, priority: IMPACT_PRIORITY[s.impact] ?? 40,
  }));

  // Graph reasoning insights (R2) — hubs / ripple / coverage.
  const ctx = await loadFamilyContext(sb, familyId, tz).catch((err) => {
    console.error('[reasoning-engine] relationship_graph read failed', { familyId, err });
    readErrors.push('relationship_graph');
    return null;
  });
  const insights = ctx ? reasoningInsights(ctx) : [];

  // Hard signals (R10) — the harder-to-copy behavioral patterns.
  let signals: ReasoningSignal[] = [];
  try {
    const { data, error } = await sb.from('family_signals')
      .select('kind, title, detail, score, evidence').eq('family_id', familyId).eq('status', 'active')
      .order('score', { ascending: false }).limit(20);
    // Degrade to no signals (the engine treats missing input as calm), but log a
    // read error — a PostgREST failure returns { data: null, error } without
    // throwing, so a broken family_signals table would otherwise silently make
    // every reasoning surface report "all clear" on this dimension forever.
    if (error) {
      console.error('[reasoning-engine] family_signals read failed', { familyId, error });
      readErrors.push('family_signals');
    }
    signals = (data ?? []).map((s) => ({ kind: s.kind, ...signalWordsFor(s, locale, t), score: s.score, href: SIGNAL_HREF }));
  } catch (err) {
    console.error('[reasoning-engine] family_signals read threw', { familyId, err });
    readErrors.push('family_signals');
    signals = [];
  }

  return { orchestrator, insights, signals, nextActions, readErrors };
}

/**
 * Load the report and persist today's snapshot (idempotent per family/day).
 *
 * The snapshot is the HOUSEHOLD's report, so it is written only from a client
 * that reads the household: a parent's or an adult's (`viewer`), or a
 * service-role caller (the default). Anyone else's client may be given less of
 * the household by RLS (SnapshotReach), and the report it composes is theirs to
 * read, not the day the parents trend: it is returned, and neither it nor the
 * operating index under it is written.
 */
export async function loadAndSnapshotReasoning(
  sb: DB, familyId: string, userId: string | null, tz: string, locale: LocaleCode, t: Translate, now: Date = new Date(), viewer: ReasoningViewer = EVERY_SIGNAL,
): Promise<ReasoningReport> {
  const reach: SnapshotReach = viewer.readsHouseholdMoney ? 'household' : 'member';
  const inputs = await readReasoningInputs(sb, familyId, tz, locale, t, reach, now);
  if (reach === 'member') return composeReport(inputs, viewer, now);
  const report = composeReport(inputs, EVERY_SIGNAL, now);
  try {
    // Best-effort persistence — the report is returned regardless — but a
    // PostgREST write failure returns { error } without throwing, so we must
    // inspect it: a broken reasoning_snapshots table would otherwise silently
    // drop every daily snapshot and break "since yesterday" trends with no signal.
    const { error } = await sb.from('reasoning_snapshots').upsert({
      family_id: familyId,
      // NOT converted here, deliberately: `reasoning_snapshots.as_of_date` is
      // this upsert's idempotency key, and moving it changes what "already
      // snapshotted today" means for rows written under the old key. It has its
      // own entry in the write allowlist of
      // tests/family-day-not-greenwich-day.test.ts and belongs to that change,
      // not this one.
      as_of_date: now.toISOString().slice(0, 10),
      all_clear: report.allClear,
      attention_count: report.answers.filter((a) => a.status === 'attention').length,
      report: reasoningSummary(report) as never,
      created_by: userId,
    }, { onConflict: 'family_id,as_of_date' });
    if (error) console.error('[reasoning-engine] reasoning_snapshots upsert failed', { familyId, error });
  } catch (err) { console.error('[reasoning-engine] reasoning_snapshots upsert threw', { familyId, err }); }
  return report;
}
