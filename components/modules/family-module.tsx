'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { firstName } from '@/lib/utils/format';
import Link from 'next/link';
import {
  Cake, Calendar as CalendarIcon, Copy, CreditCard, Clock, Edit3, FileText, HeartPulse,
  Home, MoreHorizontal, Plus, Shield, ShieldCheck, Sparkles, Trash2, UserPlus,
  Users, Wifi, Phone as PhoneIcon, ChevronRight, Activity, Settings as SettingsIcon,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { SkeletonList, ErrorState } from '@/components/ui/states';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import { MANAGER_ROLES, type MemberRole } from '@/lib/constants/roles';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Family = Tables<'families'>;
type Member = Tables<'family_members'>;
type CalEvent = Pick<Tables<'calendar_events'>, 'id' | 'title' | 'starts_at' | 'ends_at' | 'all_day' | 'assignee_id'>;
type Album = Pick<Tables<'family_albums'>, 'id' | 'name' | 'cover_url' | 'kind' | 'created_at'>;

// ── Helpers ─────────────────────────────────────────────────────────────────
const ROLE_LABEL: Record<MemberRole, string> = {
  parent: 'Parent', adult: 'Adult', teen: 'Teen', child: 'Kid', caregiver: 'Caregiver', guest: 'Guest',
};
function roleBadge(role: MemberRole): { label: string; cls: string; icon: typeof ShieldCheck } {
  if (role === 'parent') return { label: 'Admin', cls: 'text-emerald-400', icon: ShieldCheck };
  if (role === 'adult' || role === 'caregiver') return { label: 'Adult', cls: 'text-blue-400', icon: Shield };
  return { label: 'Kid Account', cls: 'text-sky-400', icon: Shield };
}
function memberAge(birthday: string | null): number | null {
  if (!birthday) return null;
  const b = new Date(birthday);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}
function nextBirthday(birthday: string | null, now: Date): { date: Date; inDays: number; turning: number } | null {
  if (!birthday) return null;
  const b = new Date(birthday);
  if (Number.isNaN(b.getTime())) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(now.getFullYear(), b.getMonth(), b.getDate());
  if (next < today) next = new Date(now.getFullYear() + 1, b.getMonth(), b.getDate());
  const inDays = Math.round((next.getTime() - today.getTime()) / 86_400_000);
  const turning = next.getFullYear() - b.getFullYear();
  return { date: next, inDays, turning };
}
function inLabel(days: number): string {
  if (days === 0) return 'Today';
  if (days === 1) return 'in 1 day';
  if (days < 30) return `in ${days} days`;
  const months = Math.round(days / 30);
  return months <= 1 ? 'in 1 month' : `in ${months} months`;
}
function fmtRelDay(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function planLabel(level: number): string {
  return level >= 2 ? 'Family+' : level === 1 ? 'Family Basic' : 'Free';
}
function shortLocation(address: string | null): string | null {
  if (!address) return null;
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) return `${parts[1]}, ${parts[2].split(' ')[0]}`;
  if (parts.length === 2) return parts[1];
  return parts[0] ?? null;
}

const ROLE_OPTIONS: MemberRole[] = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'];
const MEMBER_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6'];

export function FamilyModule() {
  const t = useTranslations();
  const { familyId, userId, role, members, refreshMembers, planLevel } = useApp();
  const { success, error: toastError } = useToast();
  const canManage = MANAGER_ROLES.includes(role);

  const [family, setFamily] = useState<Family | null>(null);
  const [sub, setSub] = useState<{ plan: string; current_period_end: string | null } | null>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [highlights, setHighlights] = useState<Album[]>([]);
  const [counts, setCounts] = useState({ contacts: 0, documents: 0, notes: 0, medical: 0, credentials: 0 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showAllMembers, setShowAllMembers] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editMember, setEditMember] = useState<Member | null>(null);
  const [removeMember, setRemoveMember] = useState<Member | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = createClient();
    const nowIso = new Date().toISOString();
    try {
      const [fam, subRes, evRes, alRes, cContacts, cDocs, cNotes, cMedical, cCreds] = await Promise.all([
        sb.from('families').select('*').eq('id', familyId).maybeSingle(),
        sb.from('subscriptions').select('plan, current_period_end').eq('family_id', familyId).maybeSingle(),
        sb.from('calendar_events').select('id, title, starts_at, ends_at, all_day, assignee_id').eq('family_id', familyId).gte('starts_at', nowIso).order('starts_at').limit(4),
        sb.from('family_albums').select('id, name, cover_url, kind, created_at').eq('family_id', familyId).order('created_at', { ascending: false }).limit(12),
        sb.from('family_contacts').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('is_emergency', true),
        sb.from('documents').select('id', { count: 'exact', head: true }).eq('family_id', familyId),
        sb.from('notes').select('id', { count: 'exact', head: true }).eq('family_id', familyId),
        sb.from('medical_profiles').select('id', { count: 'exact', head: true }).eq('family_id', familyId),
        sb.from('family_credentials').select('id', { count: 'exact', head: true }).eq('family_id', familyId).is('deleted_at', null),
      ]);
      // Supabase query errors do NOT throw — they resolve as { data: null, error }
      // — so the surrounding try/catch never catches them and the ErrorState below
      // was dead code for the most common failure. Surface a failed PRIMARY read
      // (the family row: name/address/cover/code) instead of a degraded "Your
      // Family / Not set" hub. Secondary reads (sub/counts) stay degraded.
      if (fam.error) { setLoadError('Could not load your family hub. Refresh and try again.'); return; }
      setFamily(fam.data ?? null);
      setSub(subRes.data ?? null);
      setEvents((evRes.data ?? []) as CalEvent[]);
      const albums = (alRes.data ?? []) as Album[];
      const hl = albums.filter((a) => a.kind === 'highlight');
      setHighlights((hl.length ? hl : albums).slice(0, 4));
      setCounts({
        contacts: cContacts.count ?? 0, documents: cDocs.count ?? 0,
        notes: cNotes.count ?? 0, medical: cMedical.count ?? 0, credentials: cCreds.count ?? 0,
      });
      setLoadError(null);
    } catch {
      setLoadError('Could not load your family hub.');
    } finally {
      setLoading(false);
    }
  }, [familyId]);

  useEffect(() => { void load(); }, [load]);

  const now = useMemo(() => new Date(), []);
  const activeMembers = useMemo(() => members.filter((m) => m.is_active), [members]);
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const birthdays = useMemo(() =>
    activeMembers
      .map((m) => ({ m, nb: nextBirthday(m.birthday, now) }))
      .filter((x): x is { m: Member; nb: NonNullable<ReturnType<typeof nextBirthday>> } => x.nb !== null)
      .sort((a, b) => a.nb.inDays - b.nb.inDays)
      .slice(0, 4),
    [activeMembers, now]);

  const visibleMembers = showAllMembers ? activeMembers : activeMembers.slice(0, 12);

  if (loading) return <SkeletonList />;
  if (loadError) return <ErrorState message={loadError} onRetry={() => { setLoading(true); void load(); }} />;

  const famName = family?.name ?? 'Your Family';
  const location = shortLocation(family?.address ?? null);
  const planName = sub?.plan ? prettyPlan(sub.plan) : planLabel(planLevel);

  async function copyCode() {
    if (!family?.family_code) return;
    try { await navigator.clipboard.writeText(family.family_code); success(t('familyModule.familyCodeCopied')); }
    catch { toastError(t('familyModule.couldNotCopyTheCode')); }
  }

  const sharedCards = [
    { icon: PhoneIcon, tint: 'bg-rose-500/15 text-rose-400', label: 'Emergency Contacts', count: counts.contacts, unit: 'contacts', href: '/dashboard/contacts' },
    { icon: FileText, tint: 'bg-blue-500/15 text-blue-400', label: 'Important Documents', count: counts.documents, unit: 'files', href: '/dashboard/documents' },
    { icon: Shield, tint: 'bg-emerald-500/15 text-emerald-400', label: 'Family Rules', count: counts.notes, unit: 'notes', href: '/dashboard/notes' },
    { icon: Wifi, tint: 'bg-orange-500/15 text-orange-400', label: 'Wi-Fi & Passwords', count: counts.credentials, unit: 'saved', href: '/dashboard/passwords' },
    { icon: HeartPulse, tint: 'bg-violet-500/15 text-violet-400', label: 'Medical Info', count: counts.medical, unit: 'profiles', href: '/dashboard/health' },
  ];

  return (
    <div className="module-with-sidebar">
      <div className="module-main space-y-5">
        <PageHeader
          title={t('family.family')}
          description={t('familyModule.yourFamilyHubEveryoneEverything')}
          action={
            <div className="flex flex-wrap items-center gap-2">
              {canManage && <Button onClick={() => { setEditMember(null); setAddOpen(true); }}><Plus className="h-4 w-4" /> {t('family.addMember')}</Button>}
              <Button variant="secondary" onClick={() => setInviteOpen(true)}><UserPlus className="h-4 w-4" /> {t('family.inviteFamily')}</Button>
            </div>
          }
        />

        {/* Family profile */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold">{famName}</h2>
                {planLevel > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-brand/15 px-2.5 py-0.5 text-xs font-semibold text-brand-text">
                    <Sparkles className="h-3 w-3" /> {planName}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-sm text-muted">
                {activeMembers.length} {t('family.member')}{activeMembers.length === 1 ? '' : 's'}{location ? ` · ${location}` : ''}
              </p>
            </div>
            {canManage && (
              <button onClick={() => setEditOpen(true)} className="flex items-center gap-1 text-sm font-semibold text-brand-text hover:underline">
                <Edit3 className="h-3.5 w-3.5" /> {t('family.editFamilyProfile')}
              </button>
            )}
          </div>

          {/* Cover */}
          <div className="relative h-44 w-full overflow-hidden rounded-2xl sm:h-56">
            {family?.cover_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={family.cover_url} alt={`${famName} cover`} className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center bg-gradient-to-br from-brand/25 via-violet-600/15 to-blue-900/20 text-muted">
                <Users className="h-10 w-10" />
              </div>
            )}
          </div>

          {/* Members */}
          {activeMembers.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted">{t('family.noMembersYetAddYourFirst')}</p>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {visibleMembers.map((m) => {
                const badge = roleBadge(m.role);
                const age = memberAge(m.birthday);
                return (
                  <div key={m.id} className="group relative flex flex-col items-center gap-1.5 rounded-2xl border border-border bg-surface/20 p-4 text-center">
                    {canManage && (
                      <div className="absolute right-1.5 top-1.5">
                        <button onClick={() => setMenuId(menuId === m.id ? null : m.id)} aria-label={`Manage ${m.display_name}`} className="grid h-6 w-6 place-items-center rounded-lg text-muted/60 opacity-0 transition hover:bg-elevated group-hover:opacity-100">
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                        {menuId === m.id && (
                          <>
                            <button className="fixed inset-0 z-10 cursor-default" aria-hidden tabIndex={-1} onClick={() => setMenuId(null)} />
                            <div className="absolute right-0 z-20 mt-1 w-32 overflow-hidden rounded-xl border border-border bg-surface text-left shadow-lg">
                              <button onClick={() => { setMenuId(null); setEditMember(m); setAddOpen(true); }} className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-elevated"><Edit3 className="h-3.5 w-3.5" /> {t('family.edit')}</button>
                              <button onClick={() => { setMenuId(null); setRemoveMember(m); }} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-rose-400 hover:bg-elevated"><Trash2 className="h-3.5 w-3.5" /> {t('family.remove')}</button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                    <Avatar name={m.display_name} src={m.avatar_url} color={m.color} size={56} />
                    <p className="mt-1 truncate text-sm font-semibold">{m.display_name}</p>
                    <p className="text-xs text-muted">{ROLE_LABEL[m.role]}{age != null ? ` · ${age}` : ''}</p>
                    {m.email && <p className="w-full truncate text-[11px] text-muted">{m.email}</p>}
                    {m.phone && <p className="w-full truncate text-[11px] text-muted">{m.phone}</p>}
                    <span className={cn('mt-1 inline-flex items-center gap-1 text-[11px] font-semibold', badge.cls)}>
                      <badge.icon className="h-3 w-3" /> {badge.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {activeMembers.length > 12 && (
            <button onClick={() => setShowAllMembers((v) => !v)} className="mt-3 w-full text-center text-sm font-semibold text-brand-text hover:underline">
              {showAllMembers ? 'Show fewer' : `View all ${activeMembers.length} members`}
            </button>
          )}
          {canManage && (
            <button onClick={() => { setEditMember(null); setAddOpen(true); }} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-3 text-sm font-semibold text-muted transition hover:border-brand/50 hover:text-fg">
              <Plus className="h-4 w-4" /> {t('family.addMember')}
            </button>
          )}
        </div>

        {/* Family Calendar + Highlights */}
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">{t('family.familyCalendar')}</h2>
              <Link href="/dashboard/calendar" className="text-xs font-semibold text-brand-text hover:underline">{t('family.viewCalendar')}</Link>
            </div>
            {events.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">{t('family.nothingScheduledYet')}</p>
            ) : (
              <div className="space-y-2.5">
                {events.map((e) => {
                  const who = e.assignee_id ? memberById.get(e.assignee_id) : undefined;
                  return (
                    <Link key={e.id} href="/dashboard/calendar" className="flex items-center gap-3 rounded-xl px-1.5 py-1.5 hover:bg-elevated">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand-text"><CalendarIcon className="h-4 w-4" /></span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{e.title}</p>
                        <p className="truncate text-xs text-muted">{fmtRelDay(e.starts_at)}{!e.all_day ? ` · ${fmtTime(e.starts_at)}` : ' · All Day'}</p>
                      </div>
                      {who && <span className="shrink-0 text-xs text-muted">{firstName(who.display_name)}</span>}
                    </Link>
                  );
                })}
              </div>
            )}
            <Link href="/dashboard/calendar" className="mt-3 flex items-center justify-center gap-1 text-sm font-semibold text-brand-text hover:underline">{t('family.viewFullCalendar')}</Link>
          </div>

          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">{t('family.familyHighlights')}</h2>
              <Link href="/dashboard/memories" className="flex items-center gap-0.5 text-xs font-semibold text-brand-text hover:underline">{t('family.viewAll')} <ChevronRight className="h-3.5 w-3.5" /></Link>
            </div>
            {highlights.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">{t('family.noHighlightsYet')}</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {highlights.map((a) => (
                  <Link key={a.id} href="/dashboard/memories" className="group overflow-hidden rounded-xl border border-border bg-surface/40">
                    <div className="h-20 w-full">
                      {a.cover_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={a.cover_url} alt={a.name} className="h-full w-full object-cover transition group-hover:scale-[1.03]" />
                      ) : <div className="grid h-full w-full place-items-center bg-elevated text-muted"><Sparkles className="h-5 w-5" /></div>}
                    </div>
                    <div className="p-2">
                      <p className="truncate text-xs font-semibold">{a.name}</p>
                      <p className="truncate text-[10px] text-muted">{fmtDate(a.created_at)}</p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
            <Link href="/dashboard/memories/create" className="mt-3 flex items-center justify-center gap-1 text-sm font-semibold text-brand-text hover:underline"><Plus className="h-3.5 w-3.5" /> {t('family.addMemory')}</Link>
          </div>
        </div>

        {/* Shared Information */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <h2 className="mb-4 font-semibold">{t('family.sharedInformation')}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {sharedCards.map((c) => (
              <Link key={c.label} href={c.href} className="flex flex-col gap-2 rounded-2xl border border-border bg-surface/20 p-4 transition hover:bg-elevated">
                <span className={cn('grid h-10 w-10 place-items-center rounded-xl', c.tint)}><c.icon className="h-5 w-5" /></span>
                <div>
                  <p className="text-sm font-semibold">{c.label}</p>
                  <p className="text-xs text-muted">{c.count != null ? `${c.count} ${c.unit}` : 'View'}</p>
                </div>
                <span className="text-xs font-semibold text-brand-text">{t('family.view')}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Right rail */}
      <aside className="module-sidebar flex flex-col gap-5">
        {/* Family Info */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">{t('family.familyInfo')}</h2>
            {canManage && <button onClick={() => setEditOpen(true)} className="text-xs font-semibold text-brand-text hover:underline">{t('family.edit')}</button>}
          </div>
          <div className="space-y-3.5">
            <InfoRow icon={Users} tint="bg-brand/10 text-brand-text" label={t('family.familyName')} value={famName} />
            <InfoRow icon={Home} tint="bg-blue-500/10 text-blue-400" label={t('family.address')} value={family?.address ?? 'Not set'} />
            <InfoRow icon={Clock} tint="bg-emerald-500/10 text-emerald-400" label={t('family.timeZone')} value={family?.timezone ?? 'UTC'} />
            <InfoRow icon={CreditCard} tint="bg-orange-500/10 text-orange-400" label={t('family.subscription')}
              value={`${planName} Plan`} sub={sub?.current_period_end ? `Renews ${fmtDate(sub.current_period_end)}` : undefined} />
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-rose-500/10 text-rose-400"><CreditCard className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted">{t('family.familyCode')}</p>
                <p className="truncate text-sm font-semibold">{family?.family_code ?? '—'}</p>
              </div>
              {family?.family_code && (
                <button onClick={copyCode} aria-label={t('family.copyFamilyCode')} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-elevated hover:text-fg"><Copy className="h-4 w-4" /></button>
              )}
            </div>
          </div>
        </div>

        {/* Upcoming Birthdays */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">{t('family.upcomingBirthdays')}</h2>
            <Link href="/dashboard/calendar" className="text-xs font-semibold text-brand-text hover:underline">{t('family.viewAll')}</Link>
          </div>
          {birthdays.length === 0 ? (
            <p className="py-2 text-center text-sm text-muted">{t('family.noBirthdaysOnFile')}</p>
          ) : (
            <div className="space-y-3">
              {birthdays.map(({ m, nb }) => (
                <div key={m.id} className="flex items-center gap-3">
                  <Avatar name={m.display_name} src={m.avatar_url} color={m.color} size={36} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{m.display_name}</p>
                    <p className="truncate text-xs text-muted">{t('family.turns')} {nb.turning} {inLabel(nb.inDays)}</p>
                  </div>
                  <span className="shrink-0 text-xs font-semibold text-muted">{nb.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                </div>
              ))}
            </div>
          )}
          <Link href="/dashboard/calendar" className="mt-4 flex items-center justify-center gap-1.5 text-sm font-semibold text-brand-text hover:underline"><Cake className="h-3.5 w-3.5" /> {t('family.addToCalendar')}</Link>
        </div>

        {/* Quick Actions */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <h2 className="mb-4 font-semibold">{t('family.quickActions')}</h2>
          <div className="space-y-1.5">
            <button onClick={() => setInviteOpen(true)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium hover:bg-elevated"><UserPlus className="h-4 w-4 text-muted" /> {t('family.inviteFamilyMember')}</button>
            <QuickLink href="/family/permissions" icon={ShieldCheck} label={t('family.managePermissions')} />
            <QuickLink href="/dashboard/settings" icon={SettingsIcon} label={t('family.familySettings')} />
            <QuickLink href="/family/activity" icon={Activity} label={t('family.viewFamilyActivity')} />
            <QuickLink href="/dashboard/contacts" icon={PhoneIcon} label={t('family.emergencyContacts')} />
          </div>
        </div>
      </aside>

      {addOpen && (
        <MemberModal
          familyId={familyId} createdBy={userId} member={editMember}
          onClose={() => { setAddOpen(false); setEditMember(null); }}
          onSaved={() => { setAddOpen(false); setEditMember(null); void refreshMembers(); }}
        />
      )}
      {editOpen && family && (
        <EditFamilyModal family={family} onClose={() => setEditOpen(false)} onSaved={(f) => { setFamily(f); setEditOpen(false); }} />
      )}
      {inviteOpen && (
        <InviteModal code={family?.family_code ?? null} onClose={() => setInviteOpen(false)} onCopy={copyCode} />
      )}
      <Modal open={!!removeMember} title={t('family.removeMember')} onClose={() => setRemoveMember(null)}>
        <div className="space-y-4">
          <p className="text-sm text-muted">{t('family.remove')} <span className="font-semibold text-fg">{removeMember?.display_name}</span> {t('family.fromTheFamilyTheyCanBe')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRemoveMember(null)}>{t('family.cancel')}</Button>
            <Button variant="danger" onClick={async () => {
              if (!removeMember) return;
              const sb = createClient();
              const { error: err } = await sb.from('family_members').update({ is_active: false }).eq('id', removeMember.id);
              setRemoveMember(null);
              if (err) { toastError(describeDbError(err)); return; }
              success(t('familyModule.memberRemoved')); void refreshMembers();
            }}>{t('family.remove')}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function prettyPlan(plan: string): string {
  const p = plan.toLowerCase();
  if (p.includes('plus')) return 'Family+';
  if (p.includes('basic') || p.includes('family')) return 'Family Basic';
  if (p === 'free') return 'Free';
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function InfoRow({ icon: Icon, tint, label, value, sub }: { icon: typeof Users; tint: string; label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl', tint)}><Icon className="h-4 w-4" /></span>
      <div className="min-w-0">
        <p className="text-xs text-muted">{label}</p>
        <p className="truncate text-sm font-semibold">{value}</p>
        {sub && <p className="truncate text-[11px] text-muted">{sub}</p>}
      </div>
    </div>
  );
}

function QuickLink({ href, icon: Icon, label }: { href: string; icon: typeof Users; label: string }) {
  return (
    <Link href={href} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium hover:bg-elevated">
      <Icon className="h-4 w-4 text-muted" /> {label}
    </Link>
  );
}

// ── Add / Edit member modal ─────────────────────────────────────────────────
function MemberModal({ familyId, createdBy, member, onClose, onSaved }: {
  familyId: string; createdBy: string; member: Member | null; onClose: () => void; onSaved: () => void;
}) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(member?.display_name ?? '');
  const [mrole, setMrole] = useState<MemberRole>(member?.role ?? 'child');
  const [birthday, setBirthday] = useState(member?.birthday ?? '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [phone, setPhone] = useState(member?.phone ?? '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    const sb = createClient();
    const payload = {
      display_name: name.trim(), role: mrole,
      birthday: birthday || null, email: email.trim() || null, phone: phone.trim() || null,
    };
    const { error: err } = member
      ? await sb.from('family_members').update(payload).eq('id', member.id)
      : await sb.from('family_members').insert({
          ...payload, family_id: familyId, is_active: true,
          color: MEMBER_COLORS[Math.floor(Math.random() * MEMBER_COLORS.length)],
        });
    setSaving(false);
    if (err) { toastError(describeDbError(err)); return; }
    success(member ? 'Member updated' : 'Member added');
    onSaved();
  }

  return (
    <Modal open title={member ? 'Edit Member' : 'Add Member'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('family.name')} required>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('family.eGEllaParker')} required />}</Field>
        <Field label={t('family.role')}>{(id) => (
          <Select id={id} value={mrole} onChange={(e) => setMrole(e.target.value as MemberRole)}>
            {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </Select>
        )}</Field>
        <Field label={t('family.birthday')}>{(id) => <Input id={id} type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} />}</Field>
        <Field label={t('family.email')}>{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />}</Field>
        <Field label={t('family.phone')}>{(id) => <Input id={id} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 555-1234" />}</Field>
        <Button type="submit" className="w-full" loading={saving} disabled={saving || !name.trim()}>{member ? 'Save Changes' : 'Add Member'}</Button>
      </form>
    </Modal>
  );
}

// ── Edit family profile modal ───────────────────────────────────────────────
function EditFamilyModal({ family, onClose, onSaved }: { family: Family; onClose: () => void; onSaved: (f: Family) => void }) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(family.name);
  const [address, setAddress] = useState(family.address ?? '');
  const [timezone, setTimezone] = useState(family.timezone ?? 'UTC');
  const [coverUrl, setCoverUrl] = useState(family.cover_url ?? '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    const sb = createClient();
    const { data, error: err } = await sb.from('families')
      .update({ name: name.trim(), address: address.trim() || null, timezone: timezone.trim() || 'UTC', cover_url: coverUrl.trim() || null })
      .eq('id', family.id).select('*').maybeSingle();
    setSaving(false);
    if (err || !data) { toastError(err ? describeDbError(err) : 'Could not save'); return; }
    success(t('familyModule.familyProfileUpdated'));
    onSaved(data as Family);
  }

  return (
    <Modal open title={t('family.editFamilyProfile')} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('family.familyName')} required>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
        <Field label={t('family.address')}>{(id) => <Input id={id} value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t('family.123FamilyWayAustinTx78701')} />}</Field>
        <Field label={t('family.timeZone')}>{(id) => <Input id={id} value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/Chicago" />}</Field>
        <Field label={t('family.coverPhotoUrl')} hint={t('familyModule.pasteAnImageUrlFor')}>{(id) => <Input id={id} value={coverUrl} onChange={(e) => setCoverUrl(e.target.value)} placeholder="https://…" />}</Field>
        <Button type="submit" className="w-full" loading={saving} disabled={saving || !name.trim()}>{t('family.saveChanges')}</Button>
      </form>
    </Modal>
  );
}

// ── Invite modal ────────────────────────────────────────────────────────────
function InviteModal({ code, onClose, onCopy }: { code: string | null; onClose: () => void; onCopy: () => void }) {
  const t = useTranslations();
  return (
    <Modal open title={t('family.inviteFamily')} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-muted">{t('family.shareYourFamilyCodeSoA')}</p>
        <div className="flex items-center justify-between rounded-xl border border-border bg-surface/40 px-4 py-3">
          <span className="font-mono text-lg font-bold tracking-widest">{code ?? '—'}</span>
          {code && <Button size="sm" variant="secondary" onClick={onCopy}><Copy className="h-4 w-4" /> {t('family.copy')}</Button>}
        </div>
        <Link href="/family/members" className="btn-cta inline-flex w-full items-center justify-center" onClick={onClose}>{t('family.manageMembersInvites')}</Link>
      </div>
    </Modal>
  );
}
