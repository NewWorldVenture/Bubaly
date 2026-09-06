'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Loader2, Check, RefreshCw } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { normalizePin, isValidPin } from '@/lib/onboarding/pin';
import { normalizeUsername, isValidUsername, suggestUsername } from '@/lib/onboarding/child-login';
import { createChildLoginAction, resetChildPinAction } from '@/app/(app)/family/child-login-actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export type AccessMember = {
  id: string; display_name: string; role: string; color: string | null;
  username: string | null; // set when a login already exists
};

function CreateRow({ member }: { member: AccessMember }) {
  const t = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState(suggestUsername(member.display_name));
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const valid = isValidUsername(normalizeUsername(username)) && isValidPin(pin);

  async function create() {
    if (!valid || busy) return;
    setBusy(true);
    const res = await createChildLoginAction({ memberId: member.id, username: normalizeUsername(username), pin });
    setBusy(false);
    if (!res.ok) { toastError(res.error); return; }
    success(`Login created for ${member.display_name}`);
    router.refresh();
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-brand-text transition hover:bg-brand/10">
        <KeyRound className="h-3.5 w-3.5" /> {t('childAccessManager.createLogin')}
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username"
        autoCapitalize="none" autoCorrect="off" spellCheck={false}
        className="h-9 w-32 rounded-lg border border-border bg-bg px-2.5 text-sm focus-ring" />
      <input value={pin} onChange={(e) => setPin(normalizePin(e.target.value))} inputMode="numeric" placeholder="PIN"
        className="h-9 w-20 rounded-lg border border-border bg-bg px-2.5 text-center text-sm tracking-[0.3em] focus-ring" />
      <Button onClick={create} disabled={!valid || busy} className="h-9 px-3 text-xs">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
      </Button>
    </div>
  );
}

function ResetRow({ member }: { member: AccessMember }) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  async function reset() {
    if (!isValidPin(pin) || busy) return;
    setBusy(true);
    const res = await resetChildPinAction({ memberId: member.id, pin });
    setBusy(false);
    if (!res.ok) { toastError(res.error); return; }
    success('PIN reset'); setPin(''); setOpen(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="rounded-lg bg-elevated px-2.5 py-1 text-xs font-semibold">@{member.username}</span>
      {open ? (
        <>
          <input value={pin} onChange={(e) => setPin(normalizePin(e.target.value))} inputMode="numeric" placeholder={t('childAccessManager.newPin')}
            className="h-9 w-24 rounded-lg border border-border bg-bg px-2.5 text-center text-sm tracking-[0.3em] focus-ring" />
          <Button onClick={reset} disabled={!isValidPin(pin) || busy} className="h-9 px-3 text-xs">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
          </Button>
        </>
      ) : (
        <button onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted transition hover:text-brand-text">
          <RefreshCw className="h-3.5 w-3.5" /> {t('childAccessManager.resetPin')}
        </button>
      )}
    </div>
  );
}

export function ChildAccessManager({ members, configured }: { members: AccessMember[]; configured: boolean }) {
  const t = useTranslations();
  if (members.length === 0) {
    return <p className="rounded-2xl border border-border bg-surface/40 p-6 text-center text-sm text-muted">
      {t('childAccessManager.noFamilyMembersToGiveA')}
    </p>;
  }
  return (
    <div className="space-y-3">
      {!configured && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
          {t('childAccessManager.kidLoginsNeedThe')} <code>CHILD_LOGIN_SECRET</code> {t('childAccessManager.serverEnvSetBeforeTheyCan')}
        </p>
      )}
      {members.map((m) => (
        <div key={m.id} className={cn('flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface/40 p-4')}>
          <div className="flex items-center gap-3">
            <Avatar name={m.display_name} color={m.color ?? undefined} size={40} className="rounded-full" />
            <div>
              <p className="text-sm font-semibold">{m.display_name}</p>
              <p className="text-xs capitalize text-muted">{m.role}{m.username ? ' · has a login' : ' · no login yet'}</p>
            </div>
          </div>
          {m.username ? <ResetRow member={m} /> : <CreateRow member={m} />}
        </div>
      ))}
    </div>
  );
}
