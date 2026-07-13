'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, Phone, MessageSquare, AlertTriangle, CheckCircle, Clock, TrendingUp, Users, Zap, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { TRUST_LABELS, TRUST_COLORS, TRUST_ICONS } from '@/lib/guardian/trust';
import { ROUTING_MODE_LABELS } from '@/lib/guardian/pipeline';
import { formatPhone } from '@/lib/guardian/phone';
import { updateContextAction, reviewSuggestionAction, acknowledgeEscalationAction, generateGuardianSuggestionsAction } from '@/app/(app)/guardian/actions';
import { useToast } from '@/components/ui/toast';
import type { TrustLevel } from '@/lib/guardian/trust';
import type { RoutingMode } from '@/lib/guardian/pipeline';

type Communication = {
  id: string;
  comm_type: string;
  from_number: string | null;
  from_name: string | null;
  summary: string | null;
  body: string | null;
  trust_level_at_time: TrustLevel | null;
  routing_mode_used: RoutingMode | null;
  scam_detected: boolean;
  scam_type: string | null;
  status: string;
  started_at: string;
};

type Suggestion = {
  id: string;
  suggestion_type: string;
  title: string;
  reasoning: string;
  proposed_trust_level: TrustLevel | null;
};

type Escalation = {
  id: string;
  escalation_type: string;
  severity: string;
  description: string;
  caller_number: string | null;
  acknowledged_at: string | null;
  escalated_at: string;
};

type MemberProfile = {
  id: string;
  member_id: string;
  current_context: string;
  ai_persona_name: string;
  guardian_phone: string | null;
};

type Props = {
  recentComms: Communication[];
  suggestions: Suggestion[];
  escalations: Escalation[];
  memberProfiles: MemberProfile[];
  stats: {
    totalCalls: number;
    blockedToday: number;
    scamsBlocked: number;
    screened: number;
  };
  isTwilioConfigured: boolean;
};

const COMM_ICONS: Record<string, string> = {
  call_inbound: '📞',
  call_outbound: '📲',
  sms_inbound: '💬',
  sms_outbound: '📤',
  whatsapp_inbound: '💚',
  email_inbound: '📧',
};

const CONTEXT_OPTIONS = [
  { value: 'normal', label: 'Normal', icon: '🟢' },
  { value: 'driving', label: 'Driving', icon: '🚗' },
  { value: 'meeting', label: 'In a Meeting', icon: '💼' },
  { value: 'sleeping', label: 'Sleeping', icon: '😴' },
  { value: 'vacation', label: 'Vacation', icon: '🌴' },
  { value: 'do_not_disturb', label: 'Do Not Disturb', icon: '🔕' },
];

export function GuardianDashboard({ recentComms, suggestions, escalations, memberProfiles, stats, isTwilioConfigured }: Props) {
  const router = useRouter();
  const { success: toastSuccess, error: toastError } = useToast();
  const [contextLoading, setContextLoading] = useState<string | null>(null);
  const [suggestionLoading, setSuggestionLoading] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  async function handleScan() {
    setScanning(true);
    const res = await generateGuardianSuggestionsAction();
    setScanning(false);
    if (res.ok) {
      const n = res.data?.created ?? 0;
      toastSuccess(n > 0 ? `Found ${n} new suggestion${n === 1 ? '' : 's'}` : 'All caught up — no new suggestions');
      if (n > 0) router.refresh();
    } else {
      toastError(res.error);
    }
  }

  async function handleContextChange(memberId: string, context: string) {
    setContextLoading(memberId);
    const res = await updateContextAction(memberId, context);
    setContextLoading(null);
    if (res.ok) { toastSuccess(`Status updated to ${CONTEXT_OPTIONS.find(c => c.value === context)?.label}`); router.refresh(); }
    else toastError(res.error);
  }

  async function handleSuggestion(id: string, decision: 'approved' | 'dismissed') {
    setSuggestionLoading(id);
    const res = await reviewSuggestionAction(id, decision);
    setSuggestionLoading(null);
    if (res.ok) { toastSuccess(decision === 'approved' ? 'Applied!' : 'Dismissed'); router.refresh(); }
    else toastError(res.error);
  }

  async function handleAcknowledge(id: string) {
    const res = await acknowledgeEscalationAction(id);
    if (res.ok) { toastSuccess('Escalation acknowledged'); router.refresh(); }
    else toastError(res.error);
  }

  const unacknowledgedEscalations = escalations.filter(e => !e.acknowledged_at);
  const pendingSuggestions = suggestions;

  return (
    <div className="space-y-6">
      {/* Setup banner — only shown when Twilio not configured */}
      {!isTwilioConfigured && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <div>
            <p className="font-semibold text-amber-500">Twilio not configured</p>
            <p className="text-sm text-muted mt-0.5">
              Add <code className="rounded bg-surface px-1 text-xs">TWILIO_ACCOUNT_SID</code>,{' '}
              <code className="rounded bg-surface px-1 text-xs">TWILIO_AUTH_TOKEN</code>, and{' '}
              <code className="rounded bg-surface px-1 text-xs">TWILIO_PHONE_NUMBER</code> to enable call screening.
              The Trust Graph and Rules Engine work without Twilio.
            </p>
          </div>
        </div>
      )}

      {/* Unacknowledged escalations — always top */}
      {unacknowledgedEscalations.length > 0 && (
        <div className="space-y-2">
          {unacknowledgedEscalations.map((esc) => (
            <div key={esc.id} className="flex items-start gap-3 rounded-2xl border border-red-500/40 bg-red-500/8 p-4">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-red-400">
                  {esc.severity === 'critical' ? '🚨' : '⚠️'} Emergency Alert
                </p>
                <p className="text-sm text-muted mt-0.5">{esc.description}</p>
                <p className="text-xs text-muted mt-1">
                  From {formatPhone(esc.caller_number)} · {new Date(esc.escalated_at).toLocaleTimeString()}
                </p>
              </div>
              <button
                onClick={() => handleAcknowledge(esc.id)}
                className="shrink-0 rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600 transition"
              >
                Acknowledge
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Calls Today', value: stats.totalCalls, icon: Phone, color: 'text-blue-400' },
          { label: 'Blocked', value: stats.blockedToday, icon: Shield, color: 'text-red-400' },
          { label: 'Scams Stopped', value: stats.scamsBlocked, icon: AlertTriangle, color: 'text-orange-400' },
          { label: 'AI Screened', value: stats.screened, icon: Zap, color: 'text-purple-400' },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-surface/40 p-4">
            <s.icon className={cn('mb-2 h-5 w-5', s.color)} />
            <p className="text-2xl font-bold">{s.value}</p>
            <p className="text-xs text-muted mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Context switcher per member */}
      {memberProfiles.length > 0 && (
        <div className="rounded-2xl border border-border bg-surface/40 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-muted uppercase tracking-wide">Your Status</h3>
          {memberProfiles.map((profile) => (
            <div key={profile.id} className="space-y-2">
              <p className="text-sm font-medium">{profile.ai_persona_name}&apos;s Status</p>
              <div className="flex flex-wrap gap-2">
                {CONTEXT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleContextChange(profile.member_id, opt.value)}
                    disabled={contextLoading === profile.member_id}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition',
                      profile.current_context === opt.value
                        ? 'border-brand bg-brand/10 text-brand-text'
                        : 'border-border text-muted hover:border-brand/40',
                    )}
                  >
                    <span>{opt.icon}</span>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* AI Suggestions — Adaptive AI Learning */}
      <div className="rounded-2xl border border-purple-500/30 bg-purple-500/5 p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-purple-400" />
            <h3 className="text-sm font-semibold text-purple-300">Bubaly Suggestions</h3>
          </div>
          <button
            onClick={handleScan}
            disabled={scanning}
            className="flex items-center gap-1.5 rounded-lg bg-purple-500/15 px-2.5 py-1.5 text-xs font-semibold text-purple-300 hover:bg-purple-500/25 transition disabled:opacity-50"
          >
            <Sparkles className={cn('h-3.5 w-3.5', scanning && 'animate-pulse')} />
            {scanning ? 'Scanning…' : 'Scan for tips'}
          </button>
        </div>
        <p className="text-xs text-muted">
          Bubaly learns from your call patterns and proposes changes — you decide what to apply. Nothing
          changes until you approve it.
        </p>
        {pendingSuggestions.length === 0 ? (
          <p className="rounded-xl border border-border bg-elevated px-3 py-4 text-center text-xs text-muted">
            No suggestions right now. Tap <span className="font-medium text-purple-300">Scan for tips</span> to
            check your recent activity.
          </p>
        ) : (
          <div className="space-y-2">
            {pendingSuggestions.map((s) => (
              <div key={s.id} className="rounded-xl border border-border bg-elevated p-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{s.title}</p>
                  <p className="text-xs text-muted mt-0.5 line-clamp-2">{s.reasoning}</p>
                  {s.proposed_trust_level && (
                    <span className={cn('mt-1 inline-block text-xs font-semibold', TRUST_COLORS[s.proposed_trust_level])}>
                      → {TRUST_LABELS[s.proposed_trust_level]}
                    </span>
                  )}
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button
                    onClick={() => handleSuggestion(s.id, 'approved')}
                    disabled={suggestionLoading === s.id}
                    className="rounded-lg bg-brand/10 px-2.5 py-1.5 text-xs font-semibold text-brand-text hover:bg-brand/20 transition disabled:opacity-50"
                  >
                    Apply
                  </button>
                  <button
                    onClick={() => handleSuggestion(s.id, 'dismissed')}
                    disabled={suggestionLoading === s.id}
                    className="rounded-lg bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:text-fg transition disabled:opacity-50"
                  >
                    Skip
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent communications feed */}
      <div className="rounded-2xl border border-border bg-surface/40">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">Recent Communications</h3>
          <a href="/guardian/history" className="text-xs text-brand-text hover:underline">View all</a>
        </div>
        {recentComms.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted">
            <Shield className="mx-auto mb-2 h-8 w-8 opacity-30" />
            No communications yet. Bubaly is standing guard.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {recentComms.map((comm) => (
              <CommRow key={comm.id} comm={comm} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CommRow({ comm }: { comm: Communication }) {
  const icon = COMM_ICONS[comm.comm_type] ?? '📱';
  const time = new Date(comm.started_at);
  const isToday = new Date().toDateString() === time.toDateString();
  const timeStr = isToday ? time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : time.toLocaleDateString();

  return (
    <div className="flex items-start gap-3 px-4 py-3 hover:bg-surface/60 transition">
      <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-elevated text-base">
        {comm.scam_detected ? '🚫' : icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">
            {comm.from_name ?? formatPhone(comm.from_number)}
          </span>
          {comm.trust_level_at_time && (
            <span className={cn('text-xs', TRUST_COLORS[comm.trust_level_at_time])}>
              {TRUST_ICONS[comm.trust_level_at_time]}
            </span>
          )}
          {comm.scam_detected && (
            <span className="rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-red-400">SCAM</span>
          )}
        </div>
        <p className="text-xs text-muted mt-0.5 line-clamp-1">
          {comm.summary ?? comm.body ?? (comm.routing_mode_used ? ROUTING_MODE_LABELS[comm.routing_mode_used] : 'Handled')}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-[11px] text-muted">{timeStr}</p>
        <StatusBadge status={comm.status} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; cls: string }> = {
    received: { label: 'Received', cls: 'text-muted' },
    screening: { label: 'Screening', cls: 'text-purple-400' },
    handled: { label: 'Handled', cls: 'text-emerald-400' },
    escalated: { label: 'Escalated', cls: 'text-red-400' },
    blocked: { label: 'Blocked', cls: 'text-red-400' },
    missed: { label: 'Missed', cls: 'text-amber-400' },
  };
  const c = config[status] ?? { label: status, cls: 'text-muted' };
  return <span className={cn('text-[10px] font-semibold', c.cls)}>{c.label}</span>;
}
