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
import { useCallback, useEffect, useState } from 'react';
import { Brain, Check, Loader2, Trash2, X } from 'lucide-react';
import { FACT_CATEGORY_LABELS } from '@/lib/memory/facts';
import {
  clearAiMemoryAction, confirmAiMemoryAction, forgetAiMemoryAction, loadAiMemoryAction,
  type AiMemoryItem,
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const reload = useCallback(async () => {
    const res = await loadAiMemoryAction();
    if (res.ok) { setItems(res.items); setLoadError(null); }
    else setLoadError(res.error);
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

  if (loadError) return <Card className="p-4 text-sm text-muted">{loadError}</Card>;
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
                  }, 'Bubaly has forgotten what it learned');
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
                    {item.confidence !== null && ` · Bubaly is ${item.confidence}% sure`}
                  </p>
                </div>
                {canManage && (
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() => void act(item.id, () => confirmAiMemoryAction({ id: item.id }), 'Saved as a fact')}
                      aria-label={`Confirm: ${item.label}`}
                    >
                      <Check className="mr-1.5 h-4 w-4" aria-hidden /> That&rsquo;s right
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void act(item.id, () => forgetAiMemoryAction({ id: item.id, kind: 'suggestion' }), 'Dismissed')}
                      aria-label={`Dismiss: ${item.label}`}
                    >
                      <X className="mr-1.5 h-4 w-4" aria-hidden /> No
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
                    onClick={() => void act(item.id, () => forgetAiMemoryAction({ id: item.id, kind: 'fact' }), 'Forgotten')}
                    aria-label={`Forget: ${item.label}`}
                  >
                    {busy === item.id ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />}
                    Forget
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
  );
}
