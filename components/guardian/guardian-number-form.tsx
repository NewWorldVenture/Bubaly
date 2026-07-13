'use client';

import { useState } from 'react';
import { Phone, Check, X } from 'lucide-react';
import { assignGuardianPhoneAction } from '@/app/(app)/guardian/actions';
import { formatPhone } from '@/lib/guardian/phone';
import { useToast } from '@/components/ui/toast';

export function GuardianNumberForm({
  memberId,
  initialPhone,
  twilioEnabled,
}: {
  memberId: string;
  initialPhone: string | null;
  twilioEnabled: boolean;
}) {
  const { success: toastSuccess, error: toastError } = useToast();
  const [phone, setPhone] = useState<string | null>(initialPhone);
  const [editing, setEditing] = useState(!initialPhone);
  const [draft, setDraft] = useState(initialPhone ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const res = await assignGuardianPhoneAction({ member_id: memberId, phone: draft });
    setSaving(false);
    if (res.ok) {
      setPhone(res.data?.phone ?? null);
      setEditing(false);
      toastSuccess(res.data?.phone ? 'Guardian number saved' : 'Guardian number cleared');
    } else {
      toastError(res.error);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Your Guardian Number</h3>
        {phone && !editing && (
          <button
            onClick={() => { setDraft(phone ?? ''); setEditing(true); }}
            className="text-xs font-medium text-brand-text hover:underline"
          >
            Change
          </button>
        )}
      </div>

      {!twilioEnabled && (
        <p className="text-xs text-amber-400">
          Twilio isn&apos;t configured yet, so the number won&apos;t route live calls until it is — but you
          can still assign it here so it&apos;s ready to go.
        </p>
      )}

      {phone && !editing ? (
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-500/10 text-lg">📞</div>
          <div>
            <p className="text-lg font-bold text-emerald-400">{formatPhone(phone)}</p>
            <p className="text-xs text-muted">Share this number — Bubaly answers for you</p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted">
            Enter the Twilio phone number you bought for this person. Bubaly answers, screens, and routes
            every call and text to it.
          </p>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="(555) 123-4567"
                inputMode="tel"
                className="h-10 w-full rounded-lg border border-border bg-bg pl-9 pr-3 text-sm"
              />
            </div>
            <button
              onClick={save}
              disabled={saving}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand text-white hover:bg-brand/90 disabled:opacity-50 transition"
              aria-label="Save Guardian number"
            >
              <Check className="h-4 w-4" />
            </button>
            {phone && (
              <button
                onClick={() => { setEditing(false); setDraft(phone ?? ''); }}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-border text-muted hover:bg-surface transition"
                aria-label="Cancel"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {phone && (
            <button
              onClick={() => { setDraft(''); save(); }}
              disabled={saving}
              className="text-xs text-red-400 hover:underline disabled:opacity-50"
            >
              Remove this number
            </button>
          )}
        </div>
      )}
    </div>
  );
}
