'use client';

// Family Wi-Fi & Passwords vault. Shared family credentials (Wi-Fi, logins,
// PINs, cards) backed by public.family_credentials (family-scoped RLS).
// Secrets are masked by default and revealed on demand; copy never requires a
// reveal. Fully wired: realtime read, create/update, soft-delete, search,
// category filter, favorite, empty/error/loading states, toasts, confirms.

import { useMemo, useState } from 'react';
import { firstName } from '@/lib/utils/format';
import {
  Wifi, Globe, Mail, CreditCard, KeyRound, Tv, AppWindow, BadgeCheck, Lock,
  Star, Copy, Eye, EyeOff, Pencil, Trash2, Plus, Search, ExternalLink, MoreHorizontal, Shield,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { SkeletonList, EmptyState, ErrorState } from '@/components/ui/states';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Credential = Tables<'family_credentials'>;

type CatMeta = { value: string; label: string; icon: typeof Wifi; tint: string };
const CATEGORIES: CatMeta[] = [
  { value: 'wifi', label: 'Wi-Fi', icon: Wifi, tint: 'bg-orange-500/15 text-orange-400' },
  { value: 'website', label: 'Website', icon: Globe, tint: 'bg-blue-500/15 text-blue-400' },
  { value: 'app', label: 'App', icon: AppWindow, tint: 'bg-violet-500/15 text-violet-400' },
  { value: 'streaming', label: 'Streaming', icon: Tv, tint: 'bg-rose-500/15 text-rose-400' },
  { value: 'email', label: 'Email', icon: Mail, tint: 'bg-sky-500/15 text-sky-400' },
  { value: 'card', label: 'Card', icon: CreditCard, tint: 'bg-emerald-500/15 text-emerald-400' },
  { value: 'pin', label: 'PIN / Code', icon: KeyRound, tint: 'bg-amber-500/15 text-amber-400' },
  { value: 'membership', label: 'Membership', icon: BadgeCheck, tint: 'bg-teal-500/15 text-teal-400' },
  { value: 'other', label: 'Other', icon: Lock, tint: 'bg-slate-500/15 text-slate-400' },
];
const CAT_BY_VALUE = new Map(CATEGORIES.map((c) => [c.value, c]));
const catMeta = (v: string | null) => CAT_BY_VALUE.get(v ?? 'other') ?? CATEGORIES[CATEGORIES.length - 1];

const blankForm = { id: '', category: 'wifi', label: '', username: '', secret: '', url: '', notes: '', member_id: '', is_favorite: false };
type Form = typeof blankForm;

export function PasswordsModule() {
  const t = useTranslations();
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();

  const [query, setQuery] = useState('');
  const [catFilter, setCatFilter] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<Form>(blankForm);
  const [formSecretShown, setFormSecretShown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState<Credential | null>(null);

  const { data, loading, error, refresh } = useRealtimeQuery<Credential>({
    table: 'family_credentials', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_credentials').select('*').eq('family_id', familyId).is('deleted_at', null).order('is_favorite', { ascending: false }).order('label'),
  });

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of data) m[c.category] = (m[c.category] ?? 0) + 1;
    return m;
  }, [data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.filter((c) => {
      if (catFilter && c.category !== catFilter) return false;
      if (!q) return true;
      return c.label.toLowerCase().includes(q)
        || (c.username ?? '').toLowerCase().includes(q)
        || (c.url ?? '').toLowerCase().includes(q)
        || (c.notes ?? '').toLowerCase().includes(q);
    });
  }, [data, query, catFilter]);

  async function copy(text: string, what: string) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); success(`${what} copied`); }
    catch { toastError('Could not copy'); }
  }

  function toggleReveal(id: string) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function openAdd() { setForm(blankForm); setFormSecretShown(false); setEditOpen(true); }
  function openEdit(c: Credential) {
    setForm({
      id: c.id, category: c.category, label: c.label, username: c.username ?? '', secret: c.secret ?? '',
      url: c.url ?? '', notes: c.notes ?? '', member_id: c.member_id ?? '', is_favorite: c.is_favorite,
    });
    setFormSecretShown(false); setEditOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.label.trim()) { toastError('A name/label is required'); return; }
    setSaving(true);
    const sb = createClient();
    const payload = {
      category: form.category, label: form.label.trim(),
      username: form.username.trim() || null, secret: form.secret,
      url: form.url.trim() || null, notes: form.notes.trim() || null,
      member_id: form.member_id || null, is_favorite: form.is_favorite,
    };
    const { error: err } = form.id
      ? await sb.from('family_credentials').update(payload).eq('id', form.id)
      : await sb.from('family_credentials').insert({ ...payload, family_id: familyId, created_by: userId });
    setSaving(false);
    if (err) { toastError(describeDbError(err)); return; }
    success(form.id ? 'Entry updated' : 'Entry saved');
    setEditOpen(false); refresh();
  }

  async function toggleFavorite(c: Credential) {
    const sb = createClient();
    const { error: err } = await sb.from('family_credentials').update({ is_favorite: !c.is_favorite }).eq('id', c.id);
    if (err) { toastError(describeDbError(err)); return; }
    refresh();
  }

  async function remove(c: Credential) {
    setConfirmDel(null);
    const sb = createClient();
    const { error: err } = await sb.from('family_credentials').update({ deleted_at: new Date().toISOString() }).eq('id', c.id);
    if (err) { toastError(describeDbError(err)); return; }
    success('Entry deleted'); refresh();
  }

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="module-page">
      <PageHeader
        title={t('passwords.wiFiPasswords')}
        description={t('passwordsModule.sharedFamilyLoginsWiFi')}
        action={<Button onClick={openAdd}><Plus className="h-4 w-4" /> {t('passwords.addEntry')}</Button>}
      />

      {/* Search + category filter */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full lg:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('passwords.searchEntries')} aria-label={t('passwords.searchEntries')}
            className="h-10 w-full rounded-xl border border-border bg-surface/40 pl-9 pr-3 text-sm outline-none placeholder:text-muted focus:border-brand/50" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button onClick={() => setCatFilter(null)}
            className={cn('rounded-lg border px-2.5 py-1.5 text-xs font-medium transition', catFilter === null ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:bg-elevated')}>
            {t('passwords.all')}{data.length})
          </button>
          {CATEGORIES.filter((c) => counts[c.value]).map((c) => (
            <button key={c.value} onClick={() => setCatFilter(catFilter === c.value ? null : c.value)}
              className={cn('flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition', catFilter === c.value ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:bg-elevated')}>
              <c.icon className="h-3.5 w-3.5" /> {c.label} ({counts[c.value]})
            </button>
          ))}
        </div>
      </div>

      {/* Security note */}
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <Shield className="h-3.5 w-3.5 text-emerald-400" /> {t('passwords.visibleOnlyToYourFamilySecrets')}
      </p>

      {filtered.length === 0 ? (
        data.length === 0 ? (
          <EmptyState icon={KeyRound} title={t('passwords.noEntriesYet')}
            description={t('passwordsModule.saveYourFamilyWiFi')}
            action={<Button onClick={openAdd}><Plus className="h-4 w-4" /> {t('passwords.addYourFirstEntry')}</Button>} />
        ) : (
          <EmptyState icon={Search} title={t('passwords.noMatches')} description={t('passwordsModule.tryADifferentSearchOr')} />
        )
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((c) => {
            const meta = catMeta(c.category);
            const isRevealed = revealed.has(c.id);
            const owner = c.member_id ? memberById.get(c.member_id) : undefined;
            return (
              <div key={c.id} className="group relative flex flex-col rounded-2xl border border-border bg-surface/40 p-4">
                <div className="flex items-start gap-3">
                  <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', meta.tint)}><meta.icon className="h-5 w-5" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate font-semibold">{c.label}</p>
                      {c.is_favorite && <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />}
                    </div>
                    <p className="truncate text-xs text-muted">{meta.label}{owner ? ` · ${firstName(owner.display_name)}` : ''}</p>
                  </div>
                  <div className="relative">
                    <button onClick={() => setMenuId(menuId === c.id ? null : c.id)} aria-label={`Actions for ${c.label}`} className="grid h-7 w-7 place-items-center rounded-lg text-muted/60 hover:bg-elevated">
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                    {menuId === c.id && (
                      <>
                        <button className="fixed inset-0 z-10 cursor-default" aria-hidden tabIndex={-1} onClick={() => setMenuId(null)} />
                        <div className="absolute right-0 z-20 mt-1 w-36 overflow-hidden rounded-xl border border-border bg-surface text-left shadow-lg">
                          <button onClick={() => { setMenuId(null); toggleFavorite(c); }} className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-elevated"><Star className="h-3.5 w-3.5" /> {c.is_favorite ? 'Unstar' : 'Star'}</button>
                          <button onClick={() => { setMenuId(null); openEdit(c); }} className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-elevated"><Pencil className="h-3.5 w-3.5" /> {t('passwords.edit')}</button>
                          <button onClick={() => { setMenuId(null); setConfirmDel(c); }} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-rose-400 hover:bg-elevated"><Trash2 className="h-3.5 w-3.5" /> {t('passwords.delete')}</button>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="mt-3 space-y-2">
                  {c.username && (
                    <Row label={c.category === 'wifi' ? 'Network' : c.category === 'card' ? 'Number' : 'Username'} value={c.username} onCopy={() => copy(c.username!, 'Username')} />
                  )}
                  <div className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-[11px] uppercase tracking-wide text-muted">{c.category === 'wifi' ? 'Password' : c.category === 'pin' ? 'Code' : 'Secret'}</span>
                    <code className="min-w-0 flex-1 truncate font-mono text-sm">{isRevealed ? (c.secret || '—') : '•'.repeat(Math.min(Math.max(c.secret.length, 6), 12))}</code>
                    <button onClick={() => toggleReveal(c.id)} aria-label={isRevealed ? 'Hide' : 'Reveal'} className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-elevated hover:text-fg">
                      {isRevealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                    <button onClick={() => copy(c.secret, 'Secret')} disabled={!c.secret} aria-label={t('passwords.copySecret')} className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-elevated hover:text-fg disabled:opacity-40">
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                  {c.url && (
                    <a href={/^https?:\/\//.test(c.url) ? c.url : `https://${c.url}`} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 truncate text-xs font-medium text-brand-text hover:underline">
                      <ExternalLink className="h-3 w-3 shrink-0" /> {c.url}
                    </a>
                  )}
                  {c.notes && <p className="line-clamp-2 text-xs text-muted">{c.notes}</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add / Edit modal */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title={form.id ? 'Edit entry' : 'Add entry'}>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('passwords.category')}>{(id) => (
              <Select id={id} value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
                {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </Select>
            )}</Field>
            <Field label={t('passwords.name')} required>{(id) => <Input id={id} value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder={t('passwords.eGHomeWiFi')} required />}</Field>
          </div>
          <Field label={form.category === 'wifi' ? 'Network name' : form.category === 'card' ? 'Card number' : 'Username / email'}>
            {(id) => <Input id={id} value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} placeholder={t('passwords.optional')} autoComplete="off" />}
          </Field>
          <Field label={form.category === 'wifi' ? 'Password' : form.category === 'pin' ? 'Code' : 'Secret / password'}>
            {(id) => (
              <div className="relative">
                <Input id={id} type={formSecretShown ? 'text' : 'password'} value={form.secret} onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))} placeholder="••••••••" autoComplete="off" className="pr-10" />
                <button type="button" onClick={() => setFormSecretShown((v) => !v)} aria-label={formSecretShown ? 'Hide' : 'Show'} className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-muted hover:text-fg">
                  {formSecretShown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            )}
          </Field>
          <Field label={t('passwords.linkOptional')}>{(id) => <Input id={id} value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="netflix.com" autoComplete="off" />}</Field>
          <Field label={t('passwords.belongsToOptional')}>{(id) => (
            <Select id={id} value={form.member_id} onChange={(e) => setForm((f) => ({ ...f, member_id: e.target.value }))}>
              <option value="">{t('passwords.wholeFamily')}</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </Select>
          )}</Field>
          <Field label={t('passwords.notesOptional')}>{(id) => <Textarea id={id} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} placeholder={t('passwords.eGGuestNetworkResetsMonthly')} />}</Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.is_favorite} onChange={(e) => setForm((f) => ({ ...f, is_favorite: e.target.checked }))} className="h-4 w-4 rounded border-border" />
            {t('passwords.pinToTopFavorite')}
          </label>
          <Button type="submit" className="w-full" loading={saving} disabled={saving || !form.label.trim()}>{form.id ? 'Save changes' : 'Save entry'}</Button>
        </form>
      </Modal>

      {/* Delete confirm */}
      <Modal open={!!confirmDel} onClose={() => setConfirmDel(null)} title={t('passwords.deleteEntry')}>
        <div className="space-y-4">
          <p className="text-sm text-muted">{t('passwords.delete')} <span className="font-semibold text-fg">{confirmDel?.label}</span>{t('passwords.thisRemovesItForTheWhole')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmDel(null)}>{t('passwords.cancel')}</Button>
            <Button variant="danger" onClick={() => confirmDel && remove(confirmDel)}>{t('passwords.delete')}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Row({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{value}</span>
      <button onClick={onCopy} aria-label={`Copy ${label}`} className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-elevated hover:text-fg">
        <Copy className="h-4 w-4" />
      </button>
    </div>
  );
}
