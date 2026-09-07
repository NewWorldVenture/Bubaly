'use client';

// Settings → Bubaly AI → "What Bubaly remembers" (spec §32).
//
// The Memory toggle promised "let Bubaly remember what it learns about your
// family … and use it next time" and gave a family no way to see what that
// was, correct it, or take it back — `clearAiMemory` and `forgetFact` had
// lived in the service with no caller since they were written.
//
// Only what BUBALY learned is listed. A fact a person typed into the family's
// own memory is theirs; it does not belong in a panel about what the AI keeps,
// and Clear does not touch it.
//
// M22 — ONE VIEW OF WHAT BUBALY BELIEVES. What Bubaly holds about a household
// used to be split across four screens: the facts here, the routines it
// detected on the calendar, the suggestions on the playbook, and the traits the
// autopilot learned into `family_digital_twin_profiles.metadata`, which a
// family could not see at all, let alone reset. The "Routines & traits" card
// below is that fourth surface, and the links at its foot are the other three,
// so all of it is one click apart from here.
//
// Every claim on this panel is read from a row. A routine says "Bubaly noticed
// this" only when `routine_templates.source` says it was detected; a trait
// shows a score only when the scan actually wrote one. A read that fails shows
// a retryable error, never an empty "Bubaly has learned nothing" — those are
// different facts.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Brain, Check, Loader2, Repeat, RotateCcw, Trash2, X } from 'lucide-react';
import { FACT_CATEGORY_LABELS } from '@/lib/memory/facts';
import { weekdayMaskLabel } from '@/lib/routines/detect';
import {
  clearAiMemoryAction, confirmAiMemoryAction, forgetAiMemoryAction, forgetRoutineAction,
  loadAiMemoryAction, resetMemberTraitsAction,
  type AiMemoryItem, type AiRoutineItem, type AiTraitItem,
} from '@/app/(app)/dashboard/settings/ai-actions';
import { useToast } from '@/components/ui/toast';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useTranslations } from '@/components/i18n/locale-provider';

function categoryLabel(category: string): string {
  return (FACT_CATEGORY_LABELS as Record<string, string>)[category] ?? category;
}

export function AIMemoryPanel({ canManage }: { canManage: boolean }) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [items, setItems] = useState<AiMemoryItem[] | null>(null);
  const [routines, setRoutines] = useState<AiRoutineItem[]>([]);
  const [traits, setTraits] = useState<AiTraitItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const reload = useCallback(async () => {
    const res = await loadAiMemoryAction();
    if (res.ok) {
      setItems(res.items); setRoutines(res.routines); setTraits(res.traits); setLoadError(null);
    } else setLoadError(res.error);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const act = useCallback(async (key: string, run: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) => {
    setBusy(key);
    const res = await run();
    setBusy(null);
    if (!res.ok) return toastError(res.error);
    success(done);
    await reload();
  }, [reload, success, toastError]);

  // A failed read is not an empty household. Say so, and give the family a way
  // to try again rather than a paragraph of reassurance.
  if (loadError) {
    return (
      <Card className="p-4">
        <p className="text-sm text-fg">{loadError}</p>
        <Button variant="secondary" className="mt-3" onClick={() => { setLoadError(null); void reload(); }}>
          {t('aiMemory.tryAgain')}
        </Button>
      </Card>
    );
  }
  if (!items) {
    return (
      <Card className="flex items-center gap-2 p-4 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t('aiMemory.loadingWhatBubalyRemembers')}
      </Card>
    );
  }

  const suggestions = items.filter((i) => i.kind === 'suggestion');
  const facts = items.filter((i) => i.kind === 'fact');

  return (
    <div className="space-y-4">
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <Brain className="h-4 w-4 text-brand-text" aria-hidden /> {t('aiMemory.whatBubalyRemembers')}
          </h4>
          <p id="ai-memory-hint" className="mt-1 text-sm text-muted">
            {t('aiMemory.onlyWhatBubalyWorkedOutFor')}
          </p>
        </div>
        {canManage && facts.length + suggestions.length > 0 && (
          confirmingClear ? (
            <div className="flex items-center gap-2">
              <Button
                variant="danger"
                disabled={busy !== null}
                onClick={() => {
                  setConfirmingClear(false);
                  void act('clear', async () => {
                    const res = await clearAiMemoryAction();
                    return res.ok ? { ok: true } : res;
                  }, t('aiMemory.bubalyHasForgottenWhatItLearned'));
                }}
              >
                {busy === 'clear' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />}
                {t('aiMemory.yesForgetItAll')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingClear(false)}>{t('aiMemory.cancel')}</Button>
            </div>
          ) : (
            <Button variant="secondary" disabled={busy !== null} onClick={() => setConfirmingClear(true)} aria-describedby="ai-memory-hint">
              <Trash2 className="mr-1.5 h-4 w-4" aria-hidden /> {t('aiMemory.clear')}
            </Button>
          )
        )}
      </div>

      {items.length === 0 && (
        <p className="mt-4 text-sm text-muted">{t('aiMemory.bubalyHasNotWorkedAnythingOut')}</p>
      )}

      {suggestions.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('aiMemory.waitingForYouToSayYes')}</p>
          <ul className="space-y-2">
            {suggestions.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface/40 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{item.label} — {item.value}</p>
                  <p className="text-xs text-muted">
                    {categoryLabel(item.category)}
                    {item.confidence !== null && ` · ${t('aiMemory.bubalyIsPercentSure', { percent: item.confidence })}`}
                  </p>
                </div>
                {canManage && (
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() => void act(item.id, () => confirmAiMemoryAction({ id: item.id }), t('aiMemory.savedAsAFact'))}
                      aria-label={t('aiMemory.confirmNamed', { name: item.label })}
                    >
                      <Check className="mr-1.5 h-4 w-4" aria-hidden /> {t('aiMemory.thatsRight')}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void act(item.id, () => forgetAiMemoryAction({ id: item.id, kind: 'suggestion' }), t('aiMemory.dismissed'))}
                      aria-label={t('aiMemory.dismissNamed', { name: item.label })}
                    >
                      <X className="mr-1.5 h-4 w-4" aria-hidden /> {t('aiMemory.no')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {facts.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('aiMemory.bubalyIsUsingThese')}</p>
          <ul className="space-y-2">
            {facts.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface/40 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{item.label} — {item.value}</p>
                  <p className="text-xs text-muted">{categoryLabel(item.category)}</p>
                </div>
                {canManage && (
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void act(item.id, () => forgetAiMemoryAction({ id: item.id, kind: 'fact' }), t('aiMemory.forgotten'))}
                    aria-label={t('aiMemory.forgetNamed', { name: item.label })}
                  >
                    {busy === item.id ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />}
                    {t('aiMemory.forget')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!canManage && items.length > 0 && (
        <p className="mt-3 text-xs text-muted">{t('aiMemory.onlyAParentOrAdultCan')}</p>
      )}
    </Card>

    {/* M22: the other half of what Bubaly believes — the routines it holds for
        the household and the traits the autopilot learned about each member. */}
    <Card className="p-4">
      <h4 className="flex items-center gap-2 text-sm font-semibold">
        <Repeat className="h-4 w-4 text-brand-text" aria-hidden /> {t('aiMemory.routinesAndTraits')}
      </h4>
      <p className="mt-1 text-sm text-muted">{t('aiMemory.theShapeOfYourWeekBubaly')}</p>

      <div className="mt-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('aiMemory.routinesBubalyHolds')}</p>
        {routines.length === 0 ? (
          <p className="text-sm text-muted">{t('aiMemory.noRoutinesYet')}</p>
        ) : (
          <ul className="space-y-2">
            {routines.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface/40 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{r.name}</p>
                  <p className="text-xs text-muted">
                    {weekdayMaskLabel(r.weekdayMask)}
                    {' · '}
                    {r.detected ? t('aiMemory.bubalyNoticedThis') : t('aiMemory.someoneSetThisUp')}
                    {!r.isActive && ` · ${t('aiMemory.paused')}`}
                  </p>
                </div>
                {canManage && (
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void act(`routine:${r.id}`, () => forgetRoutineAction({ id: r.id }), t('aiMemory.routineForgotten'))}
                    aria-label={t('aiMemory.forgetNamed', { name: r.name })}
                  >
                    {busy === `routine:${r.id}` ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />}
                    {t('aiMemory.forget')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('aiMemory.whatBubalyLearnedAboutEachPerson')}</p>
        {traits.length === 0 ? (
          <p className="text-sm text-muted">
            {canManage ? t('aiMemory.noTraitsYet') : t('aiMemory.onlyAParentOrAdultCanSeeTraits')}
          </p>
        ) : (
          <ul className="space-y-2">
            {traits.map((tr) => (
              <li key={tr.memberId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface/40 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{tr.memberName ?? t('aiMemory.aFamilyMember')}</p>
                  <p className="text-xs text-muted">
                    {tr.reliabilityScore === null
                      ? t('aiMemory.noScoreYet')
                      : t('aiMemory.followsThroughOnPercent', { percent: tr.reliabilityScore })}
                    {tr.sampleSize !== null && ` · ${t('aiMemory.fromNChores', { count: tr.sampleSize })}`}
                  </p>
                </div>
                {canManage && (
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void act(`trait:${tr.memberId}`, () => resetMemberTraitsAction({ memberId: tr.memberId }), t('aiMemory.traitsReset'))}
                    aria-label={t('aiMemory.resetNamed', { name: tr.memberName ?? t('aiMemory.aFamilyMember') })}
                  >
                    {busy === `trait:${tr.memberId}` ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <RotateCcw className="mr-1.5 h-4 w-4" aria-hidden />}
                    {t('aiMemory.reset')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The other three surfaces this view unifies, one click away. */}
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-xs">
        <Link href="/dashboard/knowledge" className="text-brand-text hover:underline">{t('aiMemory.openFamilyMemory')}</Link>
        <Link href="/dashboard/playbook" className="text-brand-text hover:underline">{t('aiMemory.openThePlaybook')}</Link>
        <Link href="/dashboard/calendar" className="text-brand-text hover:underline">{t('aiMemory.openTheCalendarRoutines')}</Link>
      </div>
    </Card>
    </div>
  );
}
