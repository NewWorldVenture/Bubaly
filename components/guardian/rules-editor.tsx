'use client';

import { useState } from 'react';
import { Plus, Trash2, ToggleLeft, ToggleRight, ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { TRUST_LABELS, TRUST_LEVELS, TRUST_ICONS, type TrustLevel } from '@/lib/guardian/trust';
import { ROUTING_MODE_LABELS, type RoutingMode } from '@/lib/guardian/pipeline';
import { createRuleAction, toggleRuleAction, deleteRuleAction } from '@/app/(app)/guardian/actions';
import { useToast } from '@/components/ui/toast';

type Rule = {
  id: string;
  name: string;
  description: string | null;
  priority: number;
  is_active: boolean;
  ai_suggested: boolean;
  condition_trust_levels: TrustLevel[] | null;
  condition_time_start: string | null;
  condition_time_end: string | null;
  condition_days_of_week: number[] | null;
  condition_contexts: string[] | null;
  condition_caller_pattern: string | null;
  action_routing_mode: RoutingMode;
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CONTEXTS = [
  { value: 'driving', label: '🚗 Driving' },
  { value: 'meeting', label: '💼 Meeting' },
  { value: 'sleeping', label: '😴 Sleeping' },
  { value: 'vacation', label: '🌴 Vacation' },
  { value: 'do_not_disturb', label: '🔕 Do Not Disturb' },
];

const ROUTING_MODES: RoutingMode[] = [
  'immediate_ring', 'immediate_ai_summary', 'ai_handle_first',
  'voicemail_first', 'silent_handling', 'blocked',
];

export function RulesEditor({ rules: initial }: { rules: Rule[] }) {
  const { success: toastSuccess, error: toastError } = useToast();
  const [rules, setRules] = useState(initial);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function handleToggle(id: string, isActive: boolean) {
    const res = await toggleRuleAction(id, !isActive);
    if (!res.ok) { toastError(res.error); return; }
    setRules(prev => prev.map(r => r.id === id ? { ...r, is_active: !isActive } : r));
    toastSuccess(!isActive ? 'Rule enabled' : 'Rule disabled');
  }

  async function handleDelete(id: string) {
    const res = await deleteRuleAction(id);
    if (!res.ok) { toastError(res.error); return; }
    setRules(prev => prev.filter(r => r.id !== id));
    toastSuccess('Rule deleted');
  }

  async function handleCreate(form: NewRuleForm) {
    const res = await createRuleAction({
      name: form.name,
      description: form.description,
      priority: parseInt(form.priority) || 100,
      condition_trust_levels: form.trust_levels.length > 0 ? form.trust_levels : undefined,
      condition_time_start: form.time_start || undefined,
      condition_time_end: form.time_end || undefined,
      condition_days_of_week: form.days.length > 0 ? form.days : undefined,
      condition_contexts: form.contexts.length > 0 ? form.contexts : undefined,
      condition_caller_pattern: form.caller_pattern || undefined,
      action_routing_mode: form.routing_mode,
    });
    if (!res.ok) { toastError(res.error); return; }
    toastSuccess('Rule created');
    setCreating(false);
    setRules(prev => [...prev, {
      id: res.data!.id,
      name: form.name,
      description: form.description || null,
      priority: parseInt(form.priority) || 100,
      is_active: true,
      ai_suggested: false,
      condition_trust_levels: form.trust_levels.length > 0 ? form.trust_levels : null,
      condition_time_start: form.time_start || null,
      condition_time_end: form.time_end || null,
      condition_days_of_week: form.days.length > 0 ? form.days : null,
      condition_contexts: form.contexts.length > 0 ? form.contexts : null,
      condition_caller_pattern: form.caller_pattern || null,
      action_routing_mode: form.routing_mode,
    }]);
  }

  const sorted = [...rules].sort((a, b) => a.priority - b.priority);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          Rules are evaluated in priority order. The first match wins.
          All rules require parent approval — AI can only suggest.
        </p>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 rounded-xl bg-brand px-3 py-2 text-xs font-semibold text-white hover:bg-brand/90 transition shrink-0"
        >
          <Plus className="h-3.5 w-3.5" /> New Rule
        </button>
      </div>

      {sorted.length === 0 && !creating && (
        <div className="rounded-2xl border border-border bg-surface/40 py-10 text-center text-sm text-muted">
          No rules yet. Create your first rule to customize how calls are handled.
        </div>
      )}

      <div className="space-y-2">
        {sorted.map((rule) => (
          <div
            key={rule.id}
            className={cn(
              'rounded-2xl border transition',
              rule.is_active ? 'border-border bg-surface/40' : 'border-border/40 bg-surface/20 opacity-60',
            )}
          >
            <div className="flex items-center gap-3 px-4 py-3">
              <GripVertical className="h-4 w-4 text-muted/40 cursor-grab" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{rule.name}</span>
                  {rule.ai_suggested && (
                    <span className="rounded-full bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-purple-400">AI</span>
                  )}
                  <span className="ml-auto text-[10px] text-muted">#{rule.priority}</span>
                </div>
                <p className="text-xs text-muted mt-0.5">
                  → <span className="text-brand-text">{ROUTING_MODE_LABELS[rule.action_routing_mode]}</span>
                  {rule.condition_trust_levels?.length && (
                    <> · {rule.condition_trust_levels.map(t => TRUST_ICONS[t]).join(' ')}</>
                  )}
                  {rule.condition_time_start && (
                    <> · {rule.condition_time_start}–{rule.condition_time_end}</>
                  )}
                </p>
              </div>
              <button
                onClick={() => setExpanded(expanded === rule.id ? null : rule.id)}
                className="rounded-lg p-1.5 text-muted hover:bg-surface transition"
              >
                {expanded === rule.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
              <button
                onClick={() => handleToggle(rule.id, rule.is_active)}
                className="text-muted hover:text-fg transition"
              >
                {rule.is_active
                  ? <ToggleRight className="h-5 w-5 text-brand-text" />
                  : <ToggleLeft className="h-5 w-5" />
                }
              </button>
              <button
                onClick={() => handleDelete(rule.id)}
                className="rounded-lg p-1.5 text-muted hover:bg-red-500/10 hover:text-red-400 transition"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            {expanded === rule.id && (
              <div className="border-t border-border bg-elevated/40 px-4 py-3 space-y-2 text-xs">
                {rule.description && <p className="text-muted">{rule.description}</p>}
                {rule.condition_trust_levels?.length && (
                  <DetailRow label="Trust Levels" value={rule.condition_trust_levels.map(t => `${TRUST_ICONS[t]} ${TRUST_LABELS[t]}`).join(', ')} />
                )}
                {rule.condition_time_start && (
                  <DetailRow label="Time" value={`${rule.condition_time_start} – ${rule.condition_time_end}`} />
                )}
                {rule.condition_days_of_week?.length && (
                  <DetailRow label="Days" value={rule.condition_days_of_week.map(d => DAYS[d]).join(', ')} />
                )}
                {rule.condition_contexts?.length && (
                  <DetailRow label="Context" value={rule.condition_contexts.join(', ')} />
                )}
                {rule.condition_caller_pattern && (
                  <DetailRow label="Pattern" value={rule.condition_caller_pattern} />
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {creating && (
        <NewRuleModal
          onSave={handleCreate}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-muted">{label}</span>
      <span className="text-fg">{value}</span>
    </div>
  );
}

type NewRuleForm = {
  name: string;
  description: string;
  priority: string;
  trust_levels: TrustLevel[];
  time_start: string;
  time_end: string;
  days: number[];
  contexts: string[];
  caller_pattern: string;
  routing_mode: RoutingMode;
};

function NewRuleModal({ onSave, onClose }: { onSave: (f: NewRuleForm) => void; onClose: () => void }) {
  const [form, setForm] = useState<NewRuleForm>({
    name: '', description: '', priority: '100',
    trust_levels: [], time_start: '', time_end: '',
    days: [], contexts: [], caller_pattern: '',
    routing_mode: 'ai_handle_first',
  });
  const [saving, setSaving] = useState(false);

  function toggleTrust(t: TrustLevel) {
    setForm(p => ({
      ...p,
      trust_levels: p.trust_levels.includes(t) ? p.trust_levels.filter(x => x !== t) : [...p.trust_levels, t],
    }));
  }
  function toggleDay(d: number) {
    setForm(p => ({ ...p, days: p.days.includes(d) ? p.days.filter(x => x !== d) : [...p.days, d] }));
  }
  function toggleCtx(c: string) {
    setForm(p => ({ ...p, contexts: p.contexts.includes(c) ? p.contexts.filter(x => x !== c) : [...p.contexts, c] }));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rules-editor-title"
        className="relative z-10 w-full max-w-lg max-h-[85dvh] overflow-y-auto rounded-2xl border border-border bg-bg shadow-2xl"
      >
        <div className="sticky top-0 z-10 border-b border-border bg-bg px-5 py-4">
          <h2 id="rules-editor-title" className="text-lg font-bold">New Rule</h2>
          <p className="text-xs text-muted mt-0.5">All conditions must match for the rule to apply.</p>
        </div>
        <div className="p-5 space-y-4">
          <input
            value={form.name}
            onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            placeholder="Rule name (e.g. Quiet hours)"
            className="h-10 w-full rounded-lg border border-border bg-elevated px-3 text-sm"
          />
          <textarea
            value={form.description}
            onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
            placeholder="Description (optional)"
            className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm min-h-[50px]"
          />
          <div>
            <label className="mb-2 block text-xs font-semibold text-muted uppercase tracking-wide">Trust Levels (any of these)</label>
            <div className="flex flex-wrap gap-1.5">
              {TRUST_LEVELS.map((t) => (
                <button key={t} type="button" onClick={() => toggleTrust(t)}
                  className={cn('rounded-full border px-2.5 py-1 text-xs font-medium transition',
                    form.trust_levels.includes(t) ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:border-brand/40'
                  )}>
                  {TRUST_ICONS[t]} {TRUST_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">Time Start</label>
              <input type="time" value={form.time_start} onChange={e => setForm(p => ({ ...p, time_start: e.target.value }))}
                className="h-10 w-full rounded-lg border border-border bg-elevated px-3 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">Time End</label>
              <input type="time" value={form.time_end} onChange={e => setForm(p => ({ ...p, time_end: e.target.value }))}
                className="h-10 w-full rounded-lg border border-border bg-elevated px-3 text-sm" />
            </div>
          </div>
          <div>
            <label className="mb-2 block text-xs font-semibold text-muted uppercase tracking-wide">Days of Week</label>
            <div className="flex gap-1.5">
              {DAYS.map((d, i) => (
                <button key={d} type="button" onClick={() => toggleDay(i)}
                  className={cn('flex-1 rounded-lg border py-2 text-xs font-medium transition',
                    form.days.includes(i) ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:border-brand/40'
                  )}>{d[0]}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-2 block text-xs font-semibold text-muted uppercase tracking-wide">Context</label>
            <div className="flex flex-wrap gap-1.5">
              {CONTEXTS.map((c) => (
                <button key={c.value} type="button" onClick={() => toggleCtx(c.value)}
                  className={cn('rounded-full border px-2.5 py-1 text-xs font-medium transition',
                    form.contexts.includes(c.value) ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:border-brand/40'
                  )}>{c.label}</button>
              ))}
            </div>
          </div>
          <input
            value={form.caller_pattern}
            onChange={e => setForm(p => ({ ...p, caller_pattern: e.target.value }))}
            placeholder="Caller number/name pattern (regex, optional)"
            className="h-10 w-full rounded-lg border border-border bg-elevated px-3 text-sm font-mono"
          />
          <div>
            <label className="mb-2 block text-xs font-semibold text-muted uppercase tracking-wide">Action</label>
            <div className="grid grid-cols-2 gap-1.5">
              {ROUTING_MODES.map((mode) => (
                <button key={mode} type="button" onClick={() => setForm(p => ({ ...p, routing_mode: mode }))}
                  className={cn('rounded-xl border px-3 py-2 text-xs font-medium text-left transition',
                    form.routing_mode === mode ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:border-brand/40'
                  )}>
                  {ROUTING_MODE_LABELS[mode]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Priority (lower = higher priority)</label>
            <input type="number" min="1" max="999" value={form.priority} onChange={e => setForm(p => ({ ...p, priority: e.target.value }))}
              className="h-10 w-32 rounded-lg border border-border bg-elevated px-3 text-sm" />
          </div>
        </div>
        <div className="sticky bottom-0 border-t border-border bg-bg px-5 py-4 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-xl border border-border py-2.5 text-sm font-medium hover:bg-surface transition">Cancel</button>
          <button
            onClick={async () => { if (!form.name.trim()) return; setSaving(true); await onSave(form); setSaving(false); }}
            disabled={saving || !form.name.trim()}
            className="flex-1 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-50 transition"
          >
            {saving ? 'Creating…' : 'Create Rule'}
          </button>
        </div>
      </div>
    </div>
  );
}
