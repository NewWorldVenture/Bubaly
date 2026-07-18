// lib/reasoning/engine-server.ts — service-callable loader for the unified Family
// Reasoning Engine (R7). It COMPOSES the existing pure engines from live data —
// the FOI orchestrator + its ranked suggestions, the graph reasoning insights (R2),
// and the hard signals (R10) — and runs answerFamilyQuestions() to produce the one
// six-question report every surface consumes. Best-effort per source: any one that
// errors just contributes nothing (the engine treats missing input as calm).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { loadOperatingIndex } from '@/lib/operating-index/server';
import { loadFamilyContext } from '@/lib/reasoning/context';
import { reasoningInsights } from '@/lib/reasoning/insights';
import {
  answerFamilyQuestions, reasoningSummary,
  type ReasoningReport, type ReasoningSignal, type ReasoningNextAction, type ReasoningReadSource,
} from '@/lib/reasoning/engine';

type DB = SupabaseClient<Database>;

const IMPACT_PRIORITY: Record<string, number> = { high: 90, medium: 60, low: 35 };
const SIGNAL_HREF = '/dashboard/family-signals';

/** Assemble the six-question reasoning report from the family's live data. */
export async function loadReasoningReport(sb: DB, familyId: string, now: Date = new Date()): Promise<ReasoningReport> {
  const readErrors: ReasoningReadSource[] = [];

  // FOI (orchestrator + ranked suggestions) — the richest single source.
  const foi = await loadOperatingIndex(sb, familyId, now).catch((err) => {
    console.error('[reasoning-engine] operating_index read failed', { familyId, err });
    readErrors.push('operating_index');
    return null;
  });
  const orchestrator = foi?.orchestrator ?? null;
  const nextActions: ReasoningNextAction[] = (foi?.index.suggestions ?? []).map((s) => ({
    title: s.title, detail: s.detail, href: s.href, priority: IMPACT_PRIORITY[s.impact] ?? 40,
  }));

  // Graph reasoning insights (R2) — hubs / ripple / coverage.
  const ctx = await loadFamilyContext(sb, familyId).catch((err) => {
    console.error('[reasoning-engine] relationship_graph read failed', { familyId, err });
    readErrors.push('relationship_graph');
    return null;
  });
  const insights = ctx ? reasoningInsights(ctx) : [];

  // Hard signals (R10) — the harder-to-copy behavioral patterns.
  let signals: ReasoningSignal[] = [];
  try {
    const { data, error } = await sb.from('family_signals')
      .select('kind, title, detail, score').eq('family_id', familyId).eq('status', 'active')
      .order('score', { ascending: false }).limit(20);
    // Degrade to no signals (the engine treats missing input as calm), but log a
    // read error — a PostgREST failure returns { data: null, error } without
    // throwing, so a broken family_signals table would otherwise silently make
    // every reasoning surface report "all clear" on this dimension forever.
    if (error) {
      console.error('[reasoning-engine] family_signals read failed', { familyId, error });
      readErrors.push('family_signals');
    }
    signals = (data ?? []).map((s) => ({ kind: s.kind, title: s.title, detail: s.detail, score: s.score, href: SIGNAL_HREF }));
  } catch (err) {
    console.error('[reasoning-engine] family_signals read threw', { familyId, err });
    readErrors.push('family_signals');
    signals = [];
  }

  const report = answerFamilyQuestions({ orchestrator, insights, signals, nextActions }, now);
  return {
    ...report,
    allClear: report.allClear && readErrors.length === 0,
    readErrors,
  };
}

/** Load the report and persist today's snapshot (idempotent per family/day). */
export async function loadAndSnapshotReasoning(sb: DB, familyId: string, userId: string | null, now: Date = new Date()): Promise<ReasoningReport> {
  const report = await loadReasoningReport(sb, familyId, now);
  try {
    // Best-effort persistence — the report is returned regardless — but a
    // PostgREST write failure returns { error } without throwing, so we must
    // inspect it: a broken reasoning_snapshots table would otherwise silently
    // drop every daily snapshot and break "since yesterday" trends with no signal.
    const { error } = await sb.from('reasoning_snapshots').upsert({
      family_id: familyId,
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
