'use client';

// Settings → "Bubaly AI": what the family lets Bubaly do on its own (spec §11,
// §12).
//
// The dial is per category, and a category IS a trust domain, so what a parent
// chooses here is the same string the tool gate reads on every execution —
// there is no translation layer to drift. Three levels, in the family's words:
//
//   Recommend  Bubaly suggests, and never acts.
//   Prepare    Bubaly gets the work ready; a person releases it.
//   Execute    Bubaly does it — within the permissions the role already has,
//              which is why "execute" is not "anything goes": money moves,
//              document sharing and every high-risk tool still stop for a
//              person.
//
// Only a parent or adult can change any of this; a child sees the settings
// read-only, which is deliberate — knowing what Bubaly may do is not the same
// as being able to widen it.
import { useCallback, useEffect, useState } from 'react';
import { Bot, Check, Loader2, Moon, ShieldCheck } from 'lucide-react';
import { AI_CATEGORIES, type AICategory } from '@/lib/ai/categories';
import type { AISettings } from '@/lib/ai/family-settings';
import type { AutonomyBehavior } from '@/lib/trust/engine';
import { loadAISettingsAction, saveAISettingsAction } from '@/app/(app)/dashboard/settings/ai-actions';
import { isManager, type MemberRole } from '@/lib/constants/roles';
import { useToast } from '@/components/ui/toast';
import { Card } from '@/components/ui/card';
import { AIMemoryPanel } from '@/components/settings/ai-memory';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

const LEVELS: { value: AutonomyBehavior; label: string; hint: string }[] = [
  { value: 'recommend', label: 'Recommend', hint: 'Suggests only' },
  { value: 'prepare', label: 'Prepare', hint: 'Gets it ready for you' },
  { value: 'execute', label: 'Execute', hint: 'Does it, within permissions' },
];

/** 0–23, the two columns `family_ai_settings` stores. */
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);

function LevelPicker({
  value, onChange, disabled, name, describedBy,
}: {
  value: AutonomyBehavior;
  onChange: (next: AutonomyBehavior) => void;
  disabled: boolean;
  name: string;
  describedBy?: string;
}) {
  return (
    <div className="inline-flex rounded-lg border border-border p-0.5" role="radiogroup" aria-label={name} aria-describedby={describedBy}>
      {LEVELS.map((level) => (
        <button
          key={level.value}
          type="button"
          role="radio"
          aria-checked={value === level.value}
          disabled={disabled}
          onClick={() => onChange(level.value)}
          title={level.hint}
          className={cn(
            'min-h-9 rounded-md px-3 text-sm transition-colors disabled:opacity-60',
            value === level.value ? 'bg-brand text-white' : 'text-muted hover:bg-surface-2',
          )}
        >
          {level.label}
        </button>
      ))}
    </div>
  );
}

export function AISettingsPanel({ role }: { role: MemberRole | null | undefined }) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const canManage = isManager(role);

  const [settings, setSettings] = useState<AISettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadAISettingsAction().then((res) => {
      if (!alive) return;
      if (res.ok) setSettings(res.settings);
      else setLoadError(res.error);
    });
    return () => { alive = false; };
  }, []);

  /**
   * Save one field, optimistically. On failure the server's answer replaces
   * the guess: a settings page that keeps showing a change the database
   * refused is how a family ends up believing Bubaly may do something it
   * may not.
   */
  const save = useCallback(async (field: string, patch: Parameters<typeof saveAISettingsAction>[0], optimistic: (prev: AISettings) => AISettings) => {
    setSettings((prev) => (prev ? optimistic(prev) : prev));
    setSaving(field);
    const res = await saveAISettingsAction(patch);
    setSaving(null);
    if (res.ok) { setSettings(res.settings); success('Saved'); }
    else { toastError(res.error); const reload = await loadAISettingsAction(); if (reload.ok) setSettings(reload.settings); }
  }, [success, toastError]);

  if (loadError) return <Card className="p-4 text-sm text-muted">{loadError}</Card>;
  if (!settings) {
    return (
      <Card className="flex items-center gap-2 p-4 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t('aiSettings.loadingWhatBubalyMayDo')}
      </Card>
    );
  }

  const categoryLevel = (category: AICategory): AutonomyBehavior =>
    settings.categoryBehavior[category.domain] ?? settings.behavior;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-base font-semibold"><Bot className="h-4 w-4 text-brand-text" aria-hidden /> {t('aiSettings.bubalyAi')}</h3>
            <p className="mt-1 text-sm text-muted">{t('aiSettings.whatBubalyMayDoWithout')}</p>
          </div>
          <Button
            variant={settings.enabled ? 'secondary' : 'primary'}
            disabled={!canManage || saving === 'enabled'}
            onClick={() => save('enabled', { enabled: !settings.enabled }, (prev) => ({ ...prev, enabled: !prev.enabled }))}
          >
            {settings.enabled ? 'Switch Bubaly off' : 'Switch Bubaly on'}
          </Button>
        </div>
        {!settings.enabled && (
          <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-sm">
            {t('aiSettings.bubalyIsSwitchedOffItWill')}
          </p>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold">{t('aiSettings.everythingElse')}</h4>
            <p id="default-behavior-hint" className="text-sm text-muted">{t('aiSettings.theLevelBubalyUsesWhereYou')}</p>
          </div>
          <LevelPicker
            name="Default autonomy"
            describedBy="default-behavior-hint"
            value={settings.behavior}
            disabled={!canManage || saving === 'behavior'}
            onChange={(behavior) => save('behavior', { behavior }, (prev) => ({ ...prev, behavior }))}
          />
        </div>
      </Card>

      <Card className="divide-y divide-border p-0">
        {AI_CATEGORIES.map((category) => (
          <div key={category.domain} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">{category.label}</p>
              <p id={`ai-cat-${category.domain}`} className="text-sm text-muted">{category.description}</p>
            </div>
            <LevelPicker
              name={`${category.label} autonomy`}
              describedBy={`ai-cat-${category.domain}`}
              value={categoryLevel(category)}
              disabled={!canManage || saving === category.domain}
              onChange={(behavior) => save(
                category.domain,
                { categoryBehavior: { ...settings.categoryBehavior, [category.domain]: behavior } },
                (prev) => ({ ...prev, categoryBehavior: { ...prev.categoryBehavior, [category.domain]: behavior } }),
              )}
            />
          </div>
        ))}
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-brand-text" aria-hidden /> {t('aiSettings.memory')}</h4>
            <p id="memory-hint" className="text-sm text-muted">
              {t('aiSettings.letBubalyRememberWhatItLearns')}
            </p>
          </div>
          <Button
            variant="secondary"
            aria-describedby="memory-hint"
            disabled={!canManage || saving === 'memory'}
            onClick={() => save('memory', { memoryEnabled: !settings.memoryEnabled }, (prev) => ({ ...prev, memoryEnabled: !prev.memoryEnabled }))}
          >
            {settings.memoryEnabled ? <><Check className="mr-1.5 h-4 w-4" aria-hidden /> On</> : 'Off'}
          </Button>
        </div>
      </Card>

      {/* §32's Communication block. Until this existed the quiet-hours columns
          had a service writer and no surface, so the setting a family would
          look for was one nobody could reach. */}
      <Card className="p-4">
        <h4 className="flex items-center gap-2 text-sm font-semibold"><Moon className="h-4 w-4 text-brand-text" aria-hidden /> {t('aiSettings.quietHours')}</h4>
        <p id="quiet-hint" className="mt-1 text-sm text-muted">{t('aiSettings.bubalyHoldsNotificationsRaisedIn')}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="text-sm text-muted" htmlFor="quiet-start">{t('aiSettings.from')}</label>
          <select
            id="quiet-start"
            aria-describedby="quiet-hint"
            className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm"
            disabled={!canManage || saving === 'quietHours'}
            value={settings.quietHours?.start ?? ''}
            onChange={(e) => {
              const start = Number(e.target.value);
              const end = settings.quietHours?.end ?? 7;
              save('quietHours', { quietHours: { start, end } }, (prev) => ({ ...prev, quietHours: { start, end } }));
            }}
          >
            <option value="" disabled>--</option>
            {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
          <label className="text-sm text-muted" htmlFor="quiet-end">until</label>
          <select
            id="quiet-end"
            aria-describedby="quiet-hint"
            className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm"
            disabled={!canManage || saving === 'quietHours'}
            value={settings.quietHours?.end ?? ''}
            onChange={(e) => {
              const end = Number(e.target.value);
              const start = settings.quietHours?.start ?? 21;
              save('quietHours', { quietHours: { start, end } }, (prev) => ({ ...prev, quietHours: { start, end } }));
            }}
          >
            <option value="" disabled>--</option>
            {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
          {settings.quietHours && (
            <Button
              variant="secondary"
              disabled={!canManage || saving === 'quietHours'}
              onClick={() => save('quietHours', { quietHours: null }, (prev) => ({ ...prev, quietHours: null }))}
            >
              {t('aiSettings.clear')}
            </Button>
          )}
        </div>
        {!settings.quietHours && (
          <p className="mt-2 text-sm text-muted">{t('aiSettings.noQuietHoursSetBubalyMay')}</p>
        )}
      </Card>

      {/* §32's Review + Clear. The toggle above says what Bubaly MAY keep; this
          says what it HAS kept, and lets a family take any of it back. */}
      <AIMemoryPanel canManage={canManage} />

      {!canManage && (
        <p className="text-sm text-muted">{t('aiSettings.onlyAParentOrAdultCan')}</p>
      )}
    </div>
  );
}
