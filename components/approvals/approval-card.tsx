'use client';

// The approval card (§31): "Bubaly needs your approval" as a decision a parent
// can make in one glance — the title, what will happen in plain language, who
// asked and when, what it costs, and three buttons.
//
// What it never shows: the payload, the model's reasoning chain, or a tool
// name. A parent approves "add soccer at 9:00 AM Saturday", not
// `calendar.createEvent`. Edit opens the shared Modal with the scalar fields
// the service marked editable, so a wrong time can be corrected without
// declining and re-asking.
//
// Optimistic: the buttons lock and the card shows its pending verb while the
// server action runs; the row leaves the list only after the service says the
// decision landed, because a card that disappears on a failed decision is a
// lie the family acts on.
import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Clock, Loader2, Pencil, Sparkles, User, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Field, Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { DOMAIN_LABELS } from '@/lib/trust/engine';
import { decideApproval, editAndApproveApproval } from '@/app/(app)/dashboard/approvals-actions';
import type { ApprovalCardData, EditableField } from '@/lib/approvals/card-data';

export type ApprovalCardResult =
  | { decision: 'approved' | 'rejected' | 'modified'; summary: string; resumedRunId: string | null }
  | { decision: 'pending'; summary: string };

type Busy = 'approving' | 'declining' | 'editing' | null;

export function formatAmount(cents: number | null | undefined, currency = 'USD'): string | null {
  if (cents == null) return null;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

export function formatWhen(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** "Expires in 2 days" / "Expires in 3h" / "Expired" — the deadline a parent is deciding against. */
export function formatExpiry(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'Expired';
  const hours = ms / 3_600_000;
  if (hours < 1) return `Expires in ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 36) return `Expires in ${Math.round(hours)}h`;
  return `Expires in ${Math.round(hours / 24)} days`;
}

/** 44px targets on touch (`coarse:min-h-11`), compact on a pointer. */
const ACTION = 'coarse:min-h-11 focus-ring';

export function ApprovalCard({
  approval,
  canDecide,
  compact = false,
  onResult,
  className,
}: {
  approval: ApprovalCardData;
  canDecide: boolean;
  /** Tight layout for lists on Home; the full card is for the inbox and run pages. */
  compact?: boolean;
  /** Fired after the service confirms the decision, with the outcome copy already resolved. */
  onResult?: (result: ApprovalCardResult) => void;
  className?: string;
}) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [busy, setBusy] = useState<Busy>(null);
  const [editing, setEditing] = useState(false);
  const [, startTransition] = useTransition();

  const editable = approval.editableFields ?? [];
  const canEdit = canDecide && approval.canEdit && editable.length > 0;

  const decide = useCallback((decision: 'approved' | 'rejected') => {
    if (busy) return;
    setBusy(decision === 'approved' ? 'approving' : 'declining');
    startTransition(async () => {
      const res = await decideApproval({ id: approval.id, decision });
      setBusy(null);
      if (!res.ok) {
        toastError(res.error);
        return;
      }
      if (res.data.status === 'pending') {
        success(res.data.summary);
        onResult?.({ decision: 'pending', summary: res.data.summary });
      } else {
        success(res.data.summary);
        onResult?.({ decision, summary: res.data.summary, resumedRunId: res.data.resumedRunId });
      }
      router.refresh();
    });
  }, [approval.id, busy, onResult, router, success, toastError]);

  const submitEdits = useCallback((edits: Record<string, string | number | boolean>) => {
    if (busy) return;
    setBusy('editing');
    startTransition(async () => {
      const res = await editAndApproveApproval({ id: approval.id, edits });
      setBusy(null);
      if (!res.ok) {
        toastError(res.error);
        return;
      }
      setEditing(false);
      const summary = 'Approved with your changes — Bubaly is on it.';
      success(summary);
      onResult?.({ decision: 'modified', summary, resumedRunId: res.data.resumedRunId });
      router.refresh();
    });
  }, [approval.id, busy, onResult, router, success, toastError]);

  const amount = formatAmount(approval.amountCents);
  const when = formatWhen(approval.requestedAt);
  const expiry = formatExpiry(approval.expiresAt);
  const expired = expiry === 'Expired';
  const requester = approval.requestedBy ?? (approval.agent ? 'Bubaly' : null);
  const isAi = requester === 'Bubaly';
  const consequences = approval.consequences.slice(0, compact ? 3 : 8);

  return (
    <article
      aria-busy={busy !== null}
      className={cn(
        'rounded-2xl border border-amber-500/25 bg-amber-500/5 text-fg',
        compact ? 'p-3' : 'p-4',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cn('grid flex-shrink-0 place-items-center rounded-xl bg-amber-500/15', compact ? 'h-8 w-8' : 'h-9 w-9')}>
          {isAi ? <Sparkles className="h-4 w-4 text-amber-400" aria-hidden /> : <User className="h-4 w-4 text-amber-400" aria-hidden />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold leading-tight">{approval.title}</h3>
            {amount && <span className="rounded-md bg-surface px-1.5 py-0.5 text-[11px] font-semibold">{amount}</span>}
            {!compact && approval.domain && (
              <span className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium capitalize">
                {DOMAIN_LABELS[approval.domain] ?? approval.domain}
              </span>
            )}
          </div>
          {!compact && approval.summary && <p className="mt-0.5 text-xs text-fg/80">{approval.summary}</p>}

          {consequences.length > 0 && (
            <div className={cn('text-xs', compact ? 'mt-1.5' : 'mt-2')}>
              {!compact && <p className="font-medium text-fg/90">Bubaly will:</p>}
              <ul className="mt-0.5 space-y-0.5">
                {consequences.map((line, i) => (
                  <li key={`${i}-${line}`} className="flex gap-1.5 text-fg/80">
                    <span aria-hidden className="mt-[0.45em] h-1 w-1 flex-shrink-0 rounded-full bg-amber-400" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
            {requester && <span>{isAi ? 'Bubaly' : requester}</span>}
            {when && <span>· {when}</span>}
            {expiry && (
              <span className={cn('inline-flex items-center gap-1', expired ? 'text-danger' : undefined)}>
                · <Clock className="h-3 w-3" aria-hidden /> {expiry}
              </span>
            )}
          </div>
        </div>
      </div>

      {canDecide ? (
        <div className={cn('flex items-center justify-end gap-2', compact ? 'mt-2' : 'mt-3')}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={ACTION}
            disabled={busy !== null || expired}
            onClick={() => decide('rejected')}
            aria-label={`Decline: ${approval.title}`}
          >
            {busy === 'declining' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
            {busy === 'declining' ? 'Declining…' : 'Decline'}
          </Button>
          {canEdit && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={ACTION}
              disabled={busy !== null || expired}
              onClick={() => setEditing(true)}
              aria-label={`Edit: ${approval.title}`}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
            </Button>
          )}
          <Button
            type="button"
            variant="primary"
            size="sm"
            className={ACTION}
            disabled={busy !== null || expired}
            onClick={() => decide('approved')}
            aria-label={`Approve: ${approval.title}`}
          >
            {busy === 'approving' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />}
            {busy === 'approving' ? 'Approving…' : 'Approve'}
          </Button>
        </div>
      ) : (
        <p className={cn('text-right text-[11px] text-muted', compact ? 'mt-1.5' : 'mt-3')}>Waiting for a parent or adult.</p>
      )}

      {canEdit && (
        <EditApprovalModal
          open={editing}
          title={approval.title}
          fields={editable}
          busy={busy === 'editing'}
          onClose={() => { if (busy !== 'editing') setEditing(false); }}
          onSubmit={submitEdits}
        />
      )}
    </article>
  );
}

function fieldValue(field: EditableField, raw: string | number | boolean | undefined): string | number | boolean {
  return raw === undefined ? field.value : raw;
}

/**
 * A small form over the editable scalars. Numbers are parsed on submit and a
 * blank number keeps the original value, so a fat-fingered field can never
 * send `NaN` into a tool schema.
 */
export function EditApprovalModal({
  open, title, fields, busy, onClose, onSubmit,
}: {
  open: boolean;
  title: string;
  fields: EditableField[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (edits: Record<string, string | number | boolean>) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string | number | boolean>>({});

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const edits: Record<string, string | number | boolean> = {};
    for (const field of fields) {
      const value = draft[field.key];
      if (value === undefined) continue;
      if (field.type === 'number') {
        const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
        if (!Number.isFinite(parsed)) continue;
        edits[field.key] = parsed;
      } else if (field.type === 'boolean') {
        edits[field.key] = Boolean(value);
      } else {
        edits[field.key] = String(value);
      }
    }
    onSubmit(edits);
  };

  return (
    <Modal open={open} onClose={onClose} title="Edit before approving" description={title} className="max-w-md">
      <form onSubmit={submit} className="space-y-3">
        {fields.map((field) => (
          field.type === 'boolean' ? (
            <label key={field.key} className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-surface px-3 text-sm text-fg">
              <input
                type="checkbox"
                className="h-4 w-4 accent-brand"
                checked={Boolean(fieldValue(field, draft[field.key]))}
                onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.checked }))}
              />
              {field.label}
            </label>
          ) : (
            <Field key={field.key} label={field.label}>
              {(id) => (
                <Input
                  id={id}
                  type={field.type === 'number' ? 'number' : 'text'}
                  inputMode={field.type === 'number' ? 'decimal' : undefined}
                  step={field.type === 'number' ? 'any' : undefined}
                  value={String(fieldValue(field, draft[field.key]))}
                  onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.value }))}
                />
              )}
            </Field>
          )
        ))}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" className={ACTION} onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" className={ACTION} loading={busy} disabled={busy}>
            {busy ? 'Approving…' : 'Save & approve'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
