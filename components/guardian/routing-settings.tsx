'use client';

import { useState } from 'react';
import { Shield, Phone, Zap, Volume2, BellOff, Ban } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { ROUTING_MODE_LABEL_KEYS, ROUTING_MODE_DESCRIPTION_KEYS, type RoutingMode } from '@/lib/guardian/pipeline';
import { TRUST_LABEL_KEYS, TRUST_ICONS, type TrustLevel } from '@/lib/guardian/trust';
import {
  EDITABLE_TRUST_LEVELS, TRUST_TO_FIELD, initialRoutingForm, routingUpdate,
  type RoutingProfile, type RoutingProfileSource,
} from '@/lib/guardian/routing-form';
import { upsertMemberProfileAction } from '@/app/(app)/guardian/actions';
import { ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { useTranslations } from '@/components/i18n/locale-provider';

type Member = { id: string; display_name: string };

const ROUTING_ICONS: Record<RoutingMode, React.ReactNode> = {
  immediate_ring: <Phone className="h-4 w-4" />,
  immediate_ai_summary: <Phone className="h-4 w-4" />,
  ai_handle_first: <Zap className="h-4 w-4" />,
  voicemail_first: <Volume2 className="h-4 w-4" />,
  silent_handling: <BellOff className="h-4 w-4" />,
  blocked: <Ban className="h-4 w-4" />,
};

const ROUTING_COLORS: Record<RoutingMode, string> = {
  immediate_ring: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  immediate_ai_summary: 'border-green-500/40 bg-green-500/10 text-green-400',
  ai_handle_first: 'border-blue-500/40 bg-blue-500/10 text-blue-400',
  voicemail_first: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  silent_handling: 'border-purple-500/40 bg-purple-500/10 text-purple-400',
  blocked: 'border-red-500/40 bg-red-500/10 text-red-400',
};

const ALL_MODES: RoutingMode[] = [
  'immediate_ring', 'immediate_ai_summary', 'ai_handle_first',
  'voicemail_first', 'silent_handling', 'blocked',
];

const CONTEXT_OPTIONS = [
  { value: 'driving', label: 'Driving', icon: '🚗' },
  { value: 'meeting', label: 'In a Meeting', icon: '💼' },
  { value: 'sleeping', label: 'Sleeping', icon: '😴' },
  { value: 'vacation', label: 'Vacation', icon: '🌴' },
  { value: 'do_not_disturb', label: 'Do Not Disturb', icon: '🔕' },
];

/**
 * The routing form, or an error instead of it.
 *
 * The status check is deliberately OUTSIDE the component that holds the form
 * state. A failed profile read used to arrive as `profile === null`, which is
 * also how "this member has no profile row yet" arrives, so the form seeded
 * itself from the factory defaults and Save upserted them over the family's real
 * call routing — persona, both greetings, the context overrides and every
 * routing mode, unrecoverable from the UI. There is no safe form to render for a
 * read that failed, because every field the user would see is a value the server
 * never sent.
 */
export function RoutingSettings({ profile, member }: { profile: RoutingProfileSource; member: Member }) {
  const tr = useTranslations();
  const initial = initialRoutingForm(profile, member.id);
  if (!initial) return <ErrorState message={tr('guardianSettings.couldnTLoadYourGuardianSettings')} />;
  return <RoutingForm initial={initial} member={member} />;
}

function RoutingForm({ initial, member }: { initial: RoutingProfile; member: Member }) {
  const tr = useTranslations();
  const { success: toastSuccess, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'routing' | 'persona' | 'context'>('routing');
  const [form, setForm] = useState<RoutingProfile>(initial);

  function setMode(trust: TrustLevel, mode: RoutingMode) {
    const field = TRUST_TO_FIELD[trust];
    setForm(p => ({ ...p, [field]: mode }));
  }

  function setContextMode(ctx: string, mode: RoutingMode) {
    setForm(p => ({ ...p, context_overrides: { ...p.context_overrides, [ctx]: mode } }));
  }

  async function save() {
    setSaving(true);
    // routingUpdate sends every field this form can edit. Listing them here by
    // hand is what left three of the six routing rows unsaved: they rendered,
    // they responded, they reported "Settings saved", and the value never left
    // the browser.
    const res = await upsertMemberProfileAction(routingUpdate(form, member.id));
    setSaving(false);
    if (res.ok) toastSuccess(tr('routingSettings.settingsSaved'));
    else toastError(res.error);
  }

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex gap-1 rounded-xl border border-border bg-surface/40 p-1">
        {(['routing', 'persona', 'context'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'flex-1 rounded-lg py-2 text-sm font-medium capitalize transition',
              activeTab === tab ? 'bg-bg shadow text-fg' : 'text-muted hover:text-fg',
            )}
          >
            {tab === 'routing' ? 'Routing Rules' : tab === 'persona' ? 'AI Persona' : 'Context Modes'}
          </button>
        ))}
      </div>

      {/* Routing tab */}
      {activeTab === 'routing' && (
        <div className="space-y-3">
          <p className="text-sm text-muted">{tr('routingSettings.chooseHowBubalyHandlesCallsFrom')}</p>
          {EDITABLE_TRUST_LEVELS.map((trust) => {
            const field = TRUST_TO_FIELD[trust];
            const currentMode = form[field];
            return (
              <div key={trust} className="rounded-2xl border border-border bg-surface/40 p-4 space-y-2">
                <p className="text-sm font-semibold flex items-center gap-1.5">
                  <span>{TRUST_ICONS[trust]}</span>
                  {tr(TRUST_LABEL_KEYS[trust])}
                </p>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  {ALL_MODES.map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setMode(trust, mode)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium text-left transition',
                        currentMode === mode
                          ? ROUTING_COLORS[mode]
                          : 'border-border text-muted hover:border-brand/40',
                      )}
                    >
                      {ROUTING_ICONS[mode]}
                      {tr(ROUTING_MODE_LABEL_KEYS[mode])}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted">{tr(ROUTING_MODE_DESCRIPTION_KEYS[currentMode])}</p>
              </div>
            );
          })}
        </div>
      )}

      {/* Persona tab */}
      {activeTab === 'persona' && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-border bg-surface/40 p-4 space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium">{tr('routingSettings.aiAssistantName')}</label>
              <input
                value={form.ai_persona_name}
                onChange={e => setForm(p => ({ ...p, ai_persona_name: e.target.value }))}
                placeholder={tr('routingSettings.bubaly')}
                className="h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm"
              />
              <p className="mt-1 text-xs text-muted">{tr('routingSettings.howTheAiIntroducesItselfTo')}</p>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">{tr('routingSettings.customGreeting')}</label>
              <textarea
                value={form.ai_greeting_template ?? ''}
                onChange={e => setForm(p => ({ ...p, ai_greeting_template: e.target.value }))}
                placeholder={`Hello! You've reached the [Family] family. I'm ${form.ai_persona_name}, the AI assistant for ${member.display_name}. How can I help?`}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm min-h-[80px]"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">{tr('routingSettings.voicemailGreeting')}</label>
              <textarea
                value={form.voicemail_greeting ?? ''}
                onChange={e => setForm(p => ({ ...p, voicemail_greeting: e.target.value }))}
                placeholder={`You've reached ${member.display_name}. Please leave a message.`}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm min-h-[80px]"
              />
            </div>
          </div>
          <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-3">
            <p className="text-xs text-blue-300">
              <strong>{tr('routingSettings.privacyNote')}</strong> {tr('routingSettings.theAiNeverSharesFamilyAddresses')}
            </p>
          </div>
        </div>
      )}

      {/* Context tab */}
      {activeTab === 'context' && (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            {tr('routingSettings.overrideRoutingWhenYouAposRe')}
          </p>
          {CONTEXT_OPTIONS.map((opt) => {
            const currentMode = (form.context_overrides[opt.value] ?? 'ai_handle_first') as RoutingMode;
            return (
              <div key={opt.value} className="rounded-2xl border border-border bg-surface/40 p-4 space-y-2">
                <p className="text-sm font-semibold">{opt.icon} {opt.label}</p>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  {ALL_MODES.map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setContextMode(opt.value, mode)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium text-left transition',
                        currentMode === mode ? ROUTING_COLORS[mode] : 'border-border text-muted hover:border-brand/40',
                      )}
                    >
                      {ROUTING_ICONS[mode]}
                      {tr(ROUTING_MODE_LABEL_KEYS[mode])}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <button
        onClick={save}
        disabled={saving}
        className="w-full rounded-2xl bg-brand py-3 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-50 transition"
      >
        {saving ? 'Saving…' : 'Save Settings'}
      </button>
    </div>
  );
}
