'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  ShieldCheck, Scale, Inbox, Users, Share2, Siren, ScrollText, Plus, Check, X,
  Trash2, Loader2, Lock, ChevronRight, Clock, Power,
} from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { PageHeader } from '@/components/app/page-header';
import { ApprovalCard } from '@/components/approvals/approval-card';
import { cn } from '@/lib/utils/cn';
import { toApprovalCardData, type TrustApproval } from '@/lib/approvals/card-data';
import {
  TRUST_DOMAINS, CAPABILITIES, DOMAIN_LABELS, CAPABILITY_LABELS,
  ROLE_DEFAULTS, type Capability, type TrustRole,
} from '@/lib/trust/engine';
import {
  savePolicyAction, togglePolicyAction, deletePolicyAction,
  setPermissionGrantAction, createDelegationAction, revokeDelegationAction,
  decideApprovalAction, activateEmergencyAction, endEmergencyAction,
} from '@/app/(app)/dashboard/trust/actions';
import { useTranslations } from '@/components/i18n/locale-provider';
import { explainTrustDecision, isAcceptedPolicy } from '@/lib/ai/explanation';

type Member = { id: string; name: string; role: string; color: string | null };
type Policy = {
  id: string; name: string; description: string | null; domain: string; capability: string;
  subject_kind: string; subject_role: string | null; subject_member_id: string | null;
  effect: string; conditions: Record<string, unknown>; approval_model: string;
  required_approvals: number; priority: number; enabled: boolean; is_system: boolean;
  created_at?: string | null;
};
type Grant = { id: string; member_id: string; domain: string; capability: string; effect: string };
type Delegation = { id: string; from_member_id: string; to_member_id: string; domains: string[]; reason: string | null; starts_at: string; expires_at: string };
type Approval = TrustApproval;
type Emergency = { id: string; kind: string; reason: string | null; elevated_domains: string[]; activated_at: string; expires_at?: string | null };
type Audit = { id: string; actor_kind: string; actor_id: string | null; domain: string | null; capability: string | null; decision: string; reason: string | null; policy_id?: string | null; confidence: number | null; created_at: string };

export type TrustData = {
  members: Member[]; policies: Policy[]; grants: Grant[]; delegations: Delegation[];
  approvals: Approval[]; emergencies: Emergency[]; audit: Audit[];
};

const EFFECT_STYLES: Record<string, string> = {
  allow: 'bg-green-500/15 text-green-400 border-green-500/30',
  auto_approve: 'bg-green-500/15 text-green-400 border-green-500/30',
  deny: 'bg-red-500/15 text-red-400 border-red-500/30',
  require_approval: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
};
const EFFECT_LABELS: Record<string, string> = {
  allow: 'Allow', auto_approve: 'Auto-approve', deny: 'Deny', require_approval: 'Require approval',
};
const DECISION_STYLES: Record<string, string> = {
  allow: 'text-green-400', auto_approve: 'text-green-400', approved: 'text-green-400', executed: 'text-green-400',
  deny: 'text-red-400', rejected: 'text-red-400',
  require_approval: 'text-amber-400', emergency_override: 'text-rose-400',
};

type Tab = 'approvals' | 'policies' | 'permissions' | 'delegations' | 'emergency' | 'audit';

function fmtAmount(cents: number | null) {
  if (cents == null) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
}
function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function timeLeft(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m left`;
  if (h < 48) return `${h}h left`;
  return `${Math.round(h / 24)}d left`;
}

export function TrustModule({ data, canManage }: { data: TrustData; canManage: boolean }) {
  const tr = useTranslations();
  const [tab, setTab] = useState<Tab>('approvals');
  const pendingApprovals = data.approvals.filter(a => a.status === 'pending');
  const activeEmergency = data.emergencies[0] ?? null;

  const TABS: { key: Tab; label: string; icon: React.ComponentType<{ className?: string }>; badge?: number }[] = [
    { key: 'approvals', label: 'Approvals', icon: Inbox, badge: pendingApprovals.length || undefined },
    { key: 'policies', label: 'Policies', icon: Scale },
    { key: 'permissions', label: 'Permissions', icon: Users },
    { key: 'delegations', label: 'Delegations', icon: Share2 },
    { key: 'emergency', label: 'Emergency', icon: Siren },
    { key: 'audit', label: 'Audit', icon: ScrollText },
  ];

  return (
    <div className="module-page">
      <PageHeader
        title={tr('trust.trustPermissions')}
        description={tr('trustModule.theHouseholdPolicyEngineThat')}
        action={<div className="hidden sm:flex items-center gap-1.5 rounded-full bg-brand/10 px-3 py-1.5 text-xs font-semibold text-brand-text"><ShieldCheck className="h-3.5 w-3.5" /> {tr('trust.trustEngine')}</div>}
      />

      {/* Emergency banner */}
      {activeEmergency && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-rose-500/40 bg-rose-500/10 p-4">
          <Siren className="h-5 w-5 flex-shrink-0 text-rose-400 animate-pulse" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-rose-300">{tr('trust.emergencyModeActive')} {activeEmergency.kind.replace('_', ' ')}</p>
            <p className="text-xs text-muted">{tr('trust.permissionsAreTemporarilyElevatedFor')} {activeEmergency.elevated_domains.map(d => DOMAIN_LABELS[d] ?? d).join(', ')}{tr('trust.everyActionIsLogged')}</p>
          </div>
          {canManage && <EndEmergencyButton id={activeEmergency.id} />}
        </div>
      )}

      {/* Stat row */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Pending approvals', value: String(pendingApprovals.length), icon: Inbox, color: pendingApprovals.length ? 'text-amber-400' : 'text-muted' },
          { label: 'Active policies', value: String(data.policies.filter(p => p.enabled).length), icon: Scale, color: 'text-brand-text' },
          { label: 'Active delegations', value: String(data.delegations.length), icon: Share2, color: 'text-blue-400' },
          { label: 'Members governed', value: String(data.members.length), icon: Users, color: 'text-violet-400' },
        ].map(s => (
          <div key={s.label} className="rounded-2xl border border-border bg-surface/40 p-4">
            <s.icon className={cn('h-5 w-5', s.color)} />
            <div className="mt-2 text-2xl font-bold">{s.value}</div>
            <div className="text-[11px] text-muted">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="tab-bar mb-5 overflow-x-auto no-scrollbar">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={cn('tab-item whitespace-nowrap flex items-center gap-1.5', tab === t.key ? 'tab-item-active' : 'tab-item-inactive')}>
            <t.icon className="h-3.5 w-3.5" /> {t.label}
            {t.badge ? <span className="ml-0.5 rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-white">{t.badge}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'approvals' && <ApprovalsTab approvals={data.approvals} members={data.members} canManage={canManage} />}
      {tab === 'policies' && <PoliciesTab policies={data.policies} members={data.members} canManage={canManage} />}
      {tab === 'permissions' && <PermissionsTab members={data.members} grants={data.grants} canManage={canManage} />}
      {tab === 'delegations' && <DelegationsTab delegations={data.delegations} members={data.members} canManage={canManage} />}
      {tab === 'emergency' && <EmergencyTab active={activeEmergency} canManage={canManage} />}
      {tab === 'audit' && <AuditTab audit={data.audit} members={data.members} policies={data.policies} />}
    </div>
  );
}

// ─── Approvals inbox ──────────────────────────────────────────────────────────
function ApprovalsTab({ approvals, members, canManage }: { approvals: Approval[]; members: Member[]; canManage: boolean }) {
  const tr = useTranslations();
  const router = useRouter();
  // Optimistic: a decided card leaves the inbox at once; router.refresh()
  // re-syncs the counts and the "Recently decided" list from the server.
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const nameById = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
  // A consensus rule means "every parent and adult", so the card needs to know
  // how many that is before it can say what it is waiting for.
  const managerCount = useMemo(() => members.filter(m => m.role === 'parent' || m.role === 'adult').length, [members]);
  const pending = approvals.filter(a => a.status === 'pending' && !gone.has(a.id));
  const decided = approvals.filter(a => a.status !== 'pending').slice(0, 12);

  return (
    <div className="space-y-4">
      {pending.length === 0 ? (
        <EmptyCard icon={Check} title={tr('trust.noApprovalsWaiting')} sub="When Bubaly or a family member proposes something that needs sign-off, it shows up here." />
      ) : (
        <div className="space-y-2.5">
          {pending.map(a => (
            <ApprovalCard
              key={a.id}
              approval={toApprovalCardData(a, { requestedBy: nameById.get(a.requested_by_member_id ?? '') ?? null, canEdit: canManage, managerCount })}
              canDecide={canManage}
              onResult={(result) => {
                if (result.decision !== 'pending') setGone((g) => new Set(g).add(a.id));
                router.refresh();
              }}
            />
          ))}
        </div>
      )}

      {decided.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{tr('trust.recentlyDecided')}</h3>
          <div className="space-y-1.5">
            {decided.map(a => (
              <div key={a.id} className="flex items-center gap-3 rounded-xl border border-border/60 bg-surface/20 px-4 py-2.5">
                <span className={cn('text-[11px] font-bold capitalize', DECISION_STYLES[a.status] ?? 'text-muted')}>{a.status}</span>
                <span className="flex-1 truncate text-sm">{a.title}</span>
                <span className="text-[10px] text-muted">{fmtWhen(a.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Policies ────────────────────────────────────────────────────────────────
function PoliciesTab({ policies, members, canManage }: { policies: Policy[]; members: Member[]; canManage: boolean }) {
  const tr = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [editing, setEditing] = useState<Policy | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const nameById = useMemo(() => new Map(members.map(m => [m.id, m.name])), [members]);

  async function toggle(p: Policy) {
    setBusy(p.id);
    const res = await togglePolicyAction({ id: p.id, enabled: !p.enabled });
    setBusy(null);
    if (!res.ok) return toastError(res.error ?? 'Could not update');
    router.refresh();
  }
  async function remove(p: Policy) {
    if (typeof window !== 'undefined' && !window.confirm(`Delete policy "${p.name}"?`)) return;
    setBusy(p.id);
    const res = await deletePolicyAction({ id: p.id });
    setBusy(null);
    if (!res.ok) return toastError(res.error ?? 'Could not delete');
    success(tr('trustModule.policyDeleted')); router.refresh();
  }

  function subjectLabel(p: Policy) {
    if (p.subject_kind === 'everyone') return 'Everyone';
    if (p.subject_kind === 'ai') return 'AI agents';
    if (p.subject_kind === 'role') return `Role: ${p.subject_role}`;
    return `Member: ${nameById.get(p.subject_member_id ?? '') ?? '—'}`;
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {tr('trust.newPolicy')}</Button>
        </div>
      )}
      {policies.length === 0 ? (
        <EmptyCard icon={Scale} title={tr('trust.noPoliciesYet')}
          sub={'Define rules like "Auto-approve appointments under $50" or "Only Mom can approve overnight events." The AI evaluates them before every action.'} />
      ) : (
        <div className="space-y-2">
          {policies.map(p => (
            <div key={p.id} className={cn('rounded-2xl border bg-surface/40 p-4', p.enabled ? 'border-border' : 'border-border/50 opacity-60')}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold">{p.name}</p>
                    <span className={cn('rounded-md border px-1.5 py-0.5 text-[10px] font-semibold', EFFECT_STYLES[p.effect])}>{EFFECT_LABELS[p.effect] ?? p.effect}</span>
                    {isAcceptedPolicy(p.conditions) && (
                      <span className="rounded-md border border-brand/30 bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand-text">{tr('trustModule.acceptedFromAnAutopilotSuggestion')}</span>
                    )}
                  </div>
                  {p.description && <p className="mt-0.5 text-xs text-muted">{p.description}</p>}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
                    <span className="rounded bg-surface px-1.5 py-0.5 border border-border/60">{DOMAIN_LABELS[p.domain] ?? p.domain}</span>
                    <span className="rounded bg-surface px-1.5 py-0.5 border border-border/60 capitalize">{p.capability}</span>
                    <span>· {subjectLabel(p)}</span>
                    {p.effect === 'require_approval' && <span>· {p.required_approvals} approval{p.required_approvals > 1 ? 's' : ''} ({p.approval_model.replace('_', ' ')})</span>}
                    <span>{tr('trust.priority')} {p.priority}</span>
                  </div>
                  {Object.keys(p.conditions ?? {}).length > 0 && (
                    <div className="mt-1 text-[10px] text-muted">when {conditionSummary(p.conditions, tr)}</div>
                  )}
                </div>
                {canManage && (
                  <div className="flex flex-shrink-0 items-center gap-1">
                    <button onClick={() => toggle(p)} disabled={busy === p.id} title={p.enabled ? 'Disable' : 'Enable'}
                      className={cn('relative h-5 w-9 rounded-full transition', p.enabled ? 'bg-brand' : 'bg-elevated')}>
                      <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all', p.enabled ? 'left-[18px]' : 'left-0.5')} />
                    </button>
                    <button onClick={() => setEditing(p)} className="rounded p-1 text-muted hover:text-fg" title={tr('trust.edit')}><ChevronRight className="h-4 w-4" /></button>
                    <button onClick={() => remove(p)} className="rounded p-1 text-muted hover:text-red-400" title={tr('trust.delete')}><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {(adding || editing) && (
        <PolicyModal policy={editing} members={members}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => { setAdding(false); setEditing(null); router.refresh(); }} />
      )}
    </div>
  );
}

function conditionSummary(c: Record<string, unknown>, tr: (key: string, params?: Record<string, string | number>) => string): string {
  const parts: string[] = [];
  if (typeof c.maxAmountCents === 'number') parts.push(`under ${fmtAmount(c.maxAmountCents)}`);
  if (typeof c.minConfidence === 'number') parts.push(`AI ≥ ${Math.round((c.minConfidence as number) * 100)}% sure`);
  if (typeof c.timeStart === 'string' && typeof c.timeEnd === 'string') parts.push(`between ${c.timeStart}–${c.timeEnd}`);
  // A tag-scoped policy — the narrow kind Autopilot learns — names the one tool it covers.
  const tags = Array.isArray(c.tags) ? (c.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [];
  if (tags.length > 0) parts.push(tr('trustModule.onlyTool', { tool: tags.join(', ') }));
  return parts.join(', ') || 'always';
}

function PolicyModal({ policy, members, onClose, onSaved }: {
  policy: Policy | null; members: Member[]; onClose: () => void; onSaved: () => void;
}) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [subjectKind, setSubjectKind] = useState(policy?.subject_kind ?? 'everyone');
  const [effect, setEffect] = useState(policy?.effect ?? 'require_approval');
  const c = policy?.conditions ?? {};

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    const form = new FormData(e.currentTarget);
    const maxAmount = String(form.get('maxAmount') ?? '').trim();
    const minConf = String(form.get('minConfidence') ?? '').trim();
    const timeStart = String(form.get('timeStart') ?? '').trim();
    const timeEnd = String(form.get('timeEnd') ?? '').trim();
    const conditions: Record<string, unknown> = {};
    if (maxAmount) conditions.maxAmountCents = Math.round(parseFloat(maxAmount) * 100);
    if (minConf) conditions.minConfidence = Math.min(1, Math.max(0, parseFloat(minConf) / 100));
    if (timeStart && timeEnd) { conditions.timeStart = timeStart; conditions.timeEnd = timeEnd; }

    setLoading(true);
    const res = await savePolicyAction({
      id: policy?.id,
      name: String(form.get('name') ?? '').trim(),
      description: String(form.get('description') ?? '').trim(),
      domain: String(form.get('domain') ?? 'all'),
      capability: String(form.get('capability') ?? 'automate'),
      subjectKind,
      subjectRole: subjectKind === 'role' ? String(form.get('subjectRole') ?? 'teen') : null,
      subjectMemberId: subjectKind === 'member' ? String(form.get('subjectMemberId') ?? '') : null,
      effect,
      conditions,
      approvalModel: String(form.get('approvalModel') ?? 'single'),
      requiredApprovals: Number(form.get('requiredApprovals') ?? 1),
      priority: Number(form.get('priority') ?? 100),
    });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not save');
    onSaved();
  }

  return (
    <Modal open title={policy ? 'Edit Policy' : 'New Policy'} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={tr('trust.name')} required>{id => <Input id={id} name="name" autoFocus defaultValue={policy?.name ?? ''} placeholder={tr('trust.autoApproveAppointmentsUnder50')} />}</Field>
        <Field label={tr('trust.description')}>{id => <Input id={id} name="description" defaultValue={policy?.description ?? ''} placeholder={tr('trust.optionalExplainTheIntent')} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('trust.domain')}>{id => (
            <Select id={id} name="domain" defaultValue={policy?.domain ?? 'all'}>
              <option value="all">{tr('trust.allDomains')}</option>
              {TRUST_DOMAINS.map(d => <option key={d} value={d}>{DOMAIN_LABELS[d]}</option>)}
            </Select>
          )}</Field>
          <Field label={tr('trust.capability')}>{id => (
            <Select id={id} name="capability" defaultValue={policy?.capability ?? 'automate'}>
              <option value="all">{tr('trust.allActions')}</option>
              {CAPABILITIES.map(cap => <option key={cap} value={cap}>{CAPABILITY_LABELS[cap]}</option>)}
            </Select>
          )}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('trust.appliesTo')}>{id => (
            <Select id={id} name="subjectKind" value={subjectKind} onChange={e => setSubjectKind(e.target.value)}>
              <option value="everyone">{tr('trust.everyone')}</option>
              <option value="ai">{tr('trust.aiAgents')}</option>
              <option value="role">{tr('trust.aRole')}</option>
              <option value="member">{tr('trust.aSpecificMember')}</option>
            </Select>
          )}</Field>
          <Field label={tr('trust.effect')}>{id => (
            <Select id={id} name="effect" value={effect} onChange={e => setEffect(e.target.value)}>
              <option value="allow">{tr('trust.allow')}</option>
              <option value="auto_approve">Auto-approve</option>
              <option value="require_approval">{tr('trust.requireApproval')}</option>
              <option value="deny">{tr('trust.deny')}</option>
            </Select>
          )}</Field>
        </div>
        {subjectKind === 'role' && (
          <Field label={tr('trust.role')}>{id => (
            <Select id={id} name="subjectRole" defaultValue={policy?.subject_role ?? 'teen'}>
              {(['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as TrustRole[]).map(r => <option key={r} value={r} className="capitalize">{r}</option>)}
            </Select>
          )}</Field>
        )}
        {subjectKind === 'member' && (
          <Field label={tr('trust.member')}>{id => (
            <Select id={id} name="subjectMemberId" defaultValue={policy?.subject_member_id ?? members[0]?.id}>
              {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          )}</Field>
        )}
        {effect === 'require_approval' && (
          <div className="grid grid-cols-2 gap-3">
            {/* Only models the engine actually enforces are offered.
                "First available" was the same rule as Single, and nothing has
                ever ordered approvers, so Sequential was a label on a count. */}
            <Field label={tr('trust.approvalModel')}>{id => (
              <Select id={id} name="approvalModel" defaultValue={policy?.approval_model ?? 'single'}>
                <option value="single">{tr('trust.singleApprover')}</option>
                <option value="two_parent">{tr('trust.twoParents')}</option>
                <option value="consensus">{tr('trust.everyParentAndAdult')}</option>
              </Select>
            )}</Field>
            {/* The model sets the floor; this can only raise it. */}
            <Field label={tr('trust.atLeastThisMany')}>{id => <Input id={id} name="requiredApprovals" type="number" min="1" max="5" defaultValue={policy?.required_approvals ?? 1} />}</Field>
          </div>
        )}
        <div className="rounded-xl border border-border bg-surface/40 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{tr('trust.conditionsOptional')}</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('trust.maxAmount')}>{id => <Input id={id} name="maxAmount" type="number" min="0" step="5" defaultValue={typeof c.maxAmountCents === 'number' ? (c.maxAmountCents / 100).toString() : ''} placeholder="50" />}</Field>
            <Field label={tr('trust.minAiConfidence')}>{id => <Input id={id} name="minConfidence" type="number" min="0" max="100" defaultValue={typeof c.minConfidence === 'number' ? Math.round((c.minConfidence as number) * 100).toString() : ''} placeholder="95" />}</Field>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Field label={tr('trust.timeFrom')}>{id => <Input id={id} name="timeStart" type="time" defaultValue={typeof c.timeStart === 'string' ? c.timeStart : ''} />}</Field>
            <Field label={tr('trust.timeTo')}>{id => <Input id={id} name="timeEnd" type="time" defaultValue={typeof c.timeEnd === 'string' ? c.timeEnd : ''} />}</Field>
          </div>
        </div>
        <Field label={tr('trust.priorityHigherWins')}>{id => <Input id={id} name="priority" type="number" min="0" max="1000" defaultValue={policy?.priority ?? 100} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('trust.cancel')}</Button>
          <Button type="submit" loading={loading}>{loading ? 'Saving…' : policy ? 'Save Policy' : 'Create Policy'}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Permissions matrix ───────────────────────────────────────────────────────
const KEY_DOMAINS = ['medical', 'finances', 'calendar', 'transportation', 'documents', 'messaging', 'chores', 'shopping'];
const KEY_CAPS: Capability[] = ['view', 'edit', 'approve', 'automate'];

function PermissionsTab({ members, grants, canManage }: { members: Member[]; grants: Grant[]; canManage: boolean }) {
  const tr = useTranslations();
  const router = useRouter();
  const { error: toastError } = useToast();
  const [selected, setSelected] = useState<string>(members[0]?.id ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const member = members.find(m => m.id === selected);

  const grantMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of grants) if (g.member_id === selected) m.set(`${g.domain}__${g.capability}`, g.effect);
    return m;
  }, [grants, selected]);

  // Effective default from the role matrix (what they get with no explicit grant).
  function roleDefault(role: string, domain: string, cap: Capability): 'allow' | 'approval' | 'deny' {
    const def = ROLE_DEFAULTS[role as TrustRole];
    if (!def) return 'deny';
    if (!def.capabilities.includes(cap)) return 'deny';
    const sensitive = def.sensitiveDomains.includes(domain);
    if (cap !== 'view' && sensitive) return 'approval';
    return 'allow';
  }

  async function cycle(domain: string, cap: Capability) {
    if (!canManage || busy) return;
    const cur = grantMap.get(`${domain}__${cap}`);
    const next: 'allow' | 'deny' | 'clear' = cur === undefined ? 'allow' : cur === 'allow' ? 'deny' : 'clear';
    setBusy(`${domain}__${cap}`);
    const res = await setPermissionGrantAction({ memberId: selected, domain, capability: cap, effect: next });
    setBusy(null);
    if (!res.ok) return toastError(res.error ?? 'Could not update');
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto">
        {members.map(m => (
          <button key={m.id} onClick={() => setSelected(m.id)}
            className={cn('flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition',
              selected === m.id ? 'border-brand/50 bg-brand/15 text-brand-text' : 'border-border bg-surface/40 text-muted hover:text-fg')}>
            <Avatar name={m.name} color={m.color ?? undefined} size={18} /> {m.name} <span className="text-[10px] capitalize opacity-70">({m.role})</span>
          </button>
        ))}
      </div>

      {member && (
        <div className="overflow-x-auto rounded-2xl border border-border bg-surface/30">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-muted">
                <th className="px-3 py-2.5 text-left font-semibold">{tr('trust.domain')}</th>
                {KEY_CAPS.map(c => <th key={c} className="px-2 py-2.5 text-center font-semibold">{CAPABILITY_LABELS[c]}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {KEY_DOMAINS.map(domain => (
                <tr key={domain}>
                  <td className="px-3 py-2.5 font-medium">{DOMAIN_LABELS[domain]}</td>
                  {KEY_CAPS.map(cap => {
                    const explicit = grantMap.get(`${domain}__${cap}`);
                    const def = roleDefault(member.role, domain, cap);
                    const state = explicit ?? (def === 'allow' ? 'default-allow' : def === 'approval' ? 'default-approval' : 'default-deny');
                    return (
                      <td key={cap} className="px-2 py-2 text-center">
                        <button onClick={() => cycle(domain, cap)} disabled={!canManage || busy === `${domain}__${cap}`}
                          title={explicit ? `Override: ${explicit}` : `Role default: ${def}`}
                          className={cn('inline-flex h-7 w-7 items-center justify-center rounded-lg border text-[10px] font-bold transition',
                            state === 'allow' && 'border-green-500/40 bg-green-500/15 text-green-400',
                            state === 'deny' && 'border-red-500/40 bg-red-500/15 text-red-400',
                            state === 'default-allow' && 'border-border bg-surface text-green-400/50',
                            state === 'default-approval' && 'border-border bg-surface text-amber-400/60',
                            state === 'default-deny' && 'border-border bg-surface text-muted/40',
                            canManage && 'hover:brightness-125 cursor-pointer')}>
                          {busy === `${domain}__${cap}` ? <Loader2 className="h-3 w-3 animate-spin" />
                            : state === 'allow' || state === 'default-allow' ? <Check className="h-3.5 w-3.5" />
                            : state === 'deny' || state === 'default-deny' ? <X className="h-3.5 w-3.5" />
                            : '~'}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted">
        <span className="flex items-center gap-1"><span className="inline-flex h-4 w-4 items-center justify-center rounded border border-green-500/40 bg-green-500/15 text-green-400"><Check className="h-3 w-3" /></span> allowed</span>
        <span className="flex items-center gap-1"><span className="inline-flex h-4 w-4 items-center justify-center rounded border border-red-500/40 bg-red-500/15 text-red-400"><X className="h-3 w-3" /></span> blocked</span>
        <span className="flex items-center gap-1"><span className="text-amber-400/60">~</span> {tr('trust.needsApprovalRoleDefault')}</span>
        <span>{tr('trust.fadedRoleDefaultSolidExplicitOverride')}{canManage ? ' (tap to change)' : ''}</span>
      </div>
    </div>
  );
}

// ─── Delegations ─────────────────────────────────────────────────────────────
function DelegationsTab({ delegations, members, canManage }: { delegations: Delegation[]; members: Member[]; canManage: boolean }) {
  const tr = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const nameById = useMemo(() => new Map(members.map(m => [m.id, m.name])), [members]);

  async function revoke(id: string) {
    setBusy(id);
    const res = await revokeDelegationAction({ id });
    setBusy(null);
    if (!res.ok) return toastError(res.error ?? 'Could not revoke');
    success(tr('trustModule.delegationRevoked')); router.refresh();
  }

  return (
    <div className="space-y-4">
      {canManage && <div className="flex justify-end"><Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {tr('trust.newDelegation')}</Button></div>}
      {delegations.length === 0 ? (
        <EmptyCard icon={Share2} title={tr('trust.noActiveDelegations')}
          sub={'Temporarily hand off authority — e.g. "Grandma manages transportation until Friday." Delegations always expire automatically.'} />
      ) : (
        <div className="space-y-2">
          {delegations.map(d => (
            <div key={d.id} className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4">
              <div className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl bg-blue-500/15"><Share2 className="h-4 w-4 text-blue-400" /></div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{nameById.get(d.from_member_id) ?? '—'} → {nameById.get(d.to_member_id) ?? '—'}</p>
                <p className="text-[11px] text-muted">
                  {d.domains.length ? d.domains.map(x => DOMAIN_LABELS[x] ?? x).join(', ') : 'All delegable domains'}
                  {d.reason ? ` · ${d.reason}` : ''}
                </p>
                <p className="mt-0.5 flex items-center gap-1 text-[10px] text-amber-400"><Clock className="h-3 w-3" /> {timeLeft(d.expires_at)} {tr('trust.expires')} {fmtWhen(d.expires_at)}</p>
              </div>
              {canManage && (
                <button onClick={() => revoke(d.id)} disabled={busy === d.id} className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted hover:text-red-400 hover:border-red-400/40 transition">
                  {busy === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Revoke'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {adding && <DelegationModal members={members} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); router.refresh(); }} />}
    </div>
  );
}

function DelegationModal({ members, onClose, onSaved }: { members: Member[]; onClose: () => void; onSaved: () => void }) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [domains, setDomains] = useState<string[]>([]);

  function toggleDomain(d: string) {
    setDomains(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    const form = new FormData(e.currentTarget);
    const fromMemberId = String(form.get('from') ?? '');
    const toMemberId = String(form.get('to') ?? '');
    const reason = String(form.get('reason') ?? '').trim();
    const expiresAt = String(form.get('expiresAt') ?? '');
    if (!fromMemberId || !toMemberId) return toastError(tr('trustModule.pickBothMembers'));
    if (!expiresAt) return toastError(tr('trustModule.pickAnExpiry'));
    setLoading(true);
    const res = await createDelegationAction({ fromMemberId, toMemberId, domains, reason, expiresAt: new Date(expiresAt).toISOString() });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not create');
    onSaved();
  }

  return (
    <Modal open title={tr('trust.newDelegation')} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('trust.from')}>{id => <Select id={id} name="from" defaultValue={members[0]?.id}>{members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>}</Field>
          <Field label="To">{id => <Select id={id} name="to" defaultValue={members[1]?.id ?? members[0]?.id}>{members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>}</Field>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">{tr('trust.domains')} <span className="text-xs text-muted">{tr('trust.noneAllDelegable')}</span></p>
          <div className="flex flex-wrap gap-1.5">
            {['transportation', 'medical', 'calendar', 'chores', 'shopping', 'meal_planning', 'school_forms', 'pets'].map(d => (
              <button key={d} type="button" onClick={() => toggleDomain(d)}
                className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium transition',
                  domains.includes(d) ? 'border-brand/50 bg-brand/15 text-brand-text' : 'border-border bg-surface/40 text-muted hover:text-fg')}>
                {DOMAIN_LABELS[d]}
              </button>
            ))}
          </div>
        </div>
        <Field label={tr('trust.reason')}>{id => <Input id={id} name="reason" placeholder={tr('trust.businessTripHospitalStay')} />}</Field>
        <Field label={tr('trust.expires')} required>{id => <Input id={id} name="expiresAt" type="datetime-local" />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('trust.cancel')}</Button>
          <Button type="submit" loading={loading}>{loading ? 'Creating…' : 'Delegate'}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Emergency ────────────────────────────────────────────────────────────────
function EmergencyTab({ active, canManage }: { active: Emergency | null; canManage: boolean }) {
  const tr = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState('medical');
  const [domains, setDomains] = useState<string[]>(['medical', 'transportation', 'phone_calls', 'documents']);

  function toggleDomain(d: string) { setDomains(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]); }

  async function activate() {
    if (loading) return;
    setLoading(true);
    const res = await activateEmergencyAction({ kind, reason: undefined, elevatedDomains: domains });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not activate');
    success(tr('trustModule.emergencyModeActivated')); router.refresh();
  }
  async function end() {
    if (!active || loading) return;
    setLoading(true);
    const res = await endEmergencyAction({ id: active.id });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not end');
    success(tr('trustModule.emergencyModeEnded')); router.refresh();
  }

  if (active) {
    return (
      <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 p-6 text-center">
        <Siren className="mx-auto mb-3 h-10 w-10 text-rose-400 animate-pulse" />
        <p className="text-lg font-bold text-rose-300">{tr('trust.emergencyModeIsActive')}</p>
        <p className="mt-1 text-sm text-muted capitalize">{active.kind.replace('_', ' ')} {tr('trust.since')} {fmtWhen(active.activated_at)}</p>
        <p className="mt-2 text-xs text-muted">Elevated: {active.elevated_domains.map(d => DOMAIN_LABELS[d] ?? d).join(', ')}</p>
        {/* Elevation outranks every other rule, so when it stops is part of what
            is active — not a detail to discover later. */}
        {active.expires_at && <p className="mt-1 text-xs text-muted">{tr('trust.endsOnItsOwn')} {fmtWhen(active.expires_at)}</p>}
        {canManage && <button onClick={end} disabled={loading} className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-rose-500/20 px-4 py-2 text-sm font-semibold text-rose-300 hover:bg-rose-500/30 transition">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />} {tr('trust.endEmergencyMode')}</button>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-surface/40 p-5">
        <div className="flex items-center gap-2 mb-1">
          <Siren className="h-5 w-5 text-rose-400" />
          <p className="text-sm font-bold">{tr('trust.emergencyOperationsMode')}</p>
        </div>
        <p className="text-xs text-muted">{tr('trustModule.temporarilyElevatePermissionsSoThe')}</p>
        {!canManage ? (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-muted"><Lock className="h-3.5 w-3.5" /> {tr('trust.onlyAParentOrAdultCan')}</p>
        ) : (
          <>
            <div className="mt-4">
              <p className="mb-1.5 text-xs font-semibold">{tr('trust.type')}</p>
              <Select value={kind} onChange={e => setKind(e.target.value)}>
                {[['medical', 'Medical emergency'], ['missing_person', 'Missing person'], ['severe_weather', 'Severe weather'], ['natural_disaster', 'Natural disaster'], ['vehicle_accident', 'Vehicle accident'], ['general', 'General']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </div>
            <div className="mt-3">
              <p className="mb-1.5 text-xs font-semibold">{tr('trust.elevateTheseDomains')}</p>
              <div className="flex flex-wrap gap-1.5">
                {['medical', 'transportation', 'phone_calls', 'documents', 'calendar', 'finances', 'emergency'].map(d => (
                  <button key={d} type="button" onClick={() => toggleDomain(d)}
                    className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium transition',
                      domains.includes(d) ? 'border-rose-500/50 bg-rose-500/15 text-rose-300' : 'border-border bg-surface/40 text-muted hover:text-fg')}>
                    {DOMAIN_LABELS[d]}
                  </button>
                ))}
              </div>
            </div>
            <button onClick={activate} disabled={loading || domains.length === 0}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-rose-500 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-600 transition disabled:opacity-50">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Siren className="h-4 w-4" />} {tr('trust.activateEmergencyMode')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Audit ────────────────────────────────────────────────────────────────────
function AuditTab({ audit, members, policies }: { audit: Audit[]; members: Member[]; policies: Policy[] }) {
  const tr = useTranslations();
  const nameById = useMemo(() => new Map(members.map(m => [m.id, m.name])), [members]);
  const policyById = useMemo(() => new Map(policies.map(p => [p.id, p])), [policies]);
  if (audit.length === 0) return <EmptyCard icon={ScrollText} title={tr('trust.noActivityYet')} sub="Every trust decision — allow, deny, approval, emergency override — is recorded here with its reasoning." />;
  // A decision that cites a policy the family still holds is explained by that
  // policy — for one accepted out of an Autopilot suggestion, by the day the
  // family said yes — rather than by the engine's generic "allowed by a
  // household policy" line.
  const reasonFor = (a: Audit): string => {
    const policy = a.policy_id ? policyById.get(a.policy_id) ?? null : null;
    if (!policy) return a.reason ?? `${a.capability} · ${a.domain}`;
    return explainTrustDecision({
      decision: a.decision, reason: a.reason, domain: a.domain, capability: a.capability, confidence: a.confidence,
      policy: { name: policy.name, created_at: policy.created_at ?? null, conditions: policy.conditions, effect: policy.effect },
    }).reason;
  };
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface/30 divide-y divide-border/50">
      {audit.map(a => (
        <div key={a.id} className="flex items-start gap-3 px-4 py-3">
          <span className={cn('mt-0.5 text-[11px] font-bold capitalize flex-shrink-0', DECISION_STYLES[a.decision] ?? 'text-muted')}>{a.decision.replace('_', ' ')}</span>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-fg/90">{reasonFor(a)}</p>
            <p className="mt-0.5 text-[10px] text-muted">
              {a.actor_kind === 'ai_agent' ? `AI · ${a.actor_id}` : (nameById.get(a.actor_id ?? '') ?? 'Member')}
              {a.domain ? ` · ${DOMAIN_LABELS[a.domain] ?? a.domain}` : ''}
              {a.confidence != null ? ` · ${Math.round(a.confidence * 100)}%` : ''}
              {` · ${fmtWhen(a.created_at)}`}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Shared ───────────────────────────────────────────────────────────────────
function EmptyCard({ icon: Icon, title, sub }: { icon: React.ComponentType<{ className?: string }>; title: string; sub: string }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-border bg-surface/40 py-12 text-center">
      <div className="mb-3 grid h-14 w-14 place-items-center rounded-full bg-brand/10"><Icon className="h-6 w-6 text-brand-text opacity-60" /></div>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 max-w-sm text-xs text-muted">{sub}</p>
    </div>
  );
}

function EndEmergencyButton({ id }: { id: string }) {
  const tr = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  async function end() {
    setLoading(true);
    const res = await endEmergencyAction({ id });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not end');
    success(tr('trustModule.emergencyModeEnded')); router.refresh();
  }
  return (
    <button onClick={end} disabled={loading} className="flex-shrink-0 rounded-lg bg-rose-500/20 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/30 transition">
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'End'}
    </button>
  );
}
