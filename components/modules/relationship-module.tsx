'use client';

import { useLayoutEffect, useMemo, useState } from 'react';
import {
  Heart, Cake, Sparkles, Wine, Star, CalendarDays, Gift, Plus, Pencil, Trash2,
  ExternalLink, DollarSign, Bell, Wand2, Loader2, SlidersHorizontal, MapPin, Check, ShoppingBag,
  CalendarPlus, CalendarCheck,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import {
  upcomingDates, formatCountdown, milestoneLabel, type RelDate,
} from '@/lib/relationship/dates';
import { createRelationshipDigestRequestScope, suggestGiftsFromWishlist, summarizeGifts, type WishItemLite, type RelationshipDigest } from '@/lib/relationship/gifts';
import { buildCalendarEventForDate } from '@/lib/relationship/calendar';
import type { Tables, RelationshipDateKind, RelationshipDateStatus, RelationshipGiftStatus } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type RDate = Tables<'relationship_dates'>;
type Gift_ = Tables<'relationship_gift_ideas'>;
type Profile = Tables<'relationship_profile'>;
type Wish = Tables<'wishlist_items'>;

const KIND_META: Record<RelationshipDateKind, { label: string; icon: typeof Heart; cls: string }> = {
  anniversary: { label: 'Anniversary', icon: Heart, cls: 'text-rose-300 bg-rose-500/10 border-rose-500/30' },
  birthday: { label: 'Birthday', icon: Cake, cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  first_date: { label: 'First date', icon: Sparkles, cls: 'text-fuchsia-300 bg-fuchsia-500/10 border-fuchsia-500/30' },
  date_night: { label: 'Date night', icon: Wine, cls: 'text-violet-300 bg-violet-500/10 border-violet-500/30' },
  milestone: { label: 'Milestone', icon: Star, cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  custom: { label: 'Date', icon: CalendarDays, cls: 'text-slate-300 bg-slate-500/10 border-slate-500/30' },
};

const GIFT_STATUS: { value: RelationshipGiftStatus; label: string }[] = [
  { value: 'idea', label: '💡 Idea' },
  { value: 'saved', label: '🔖 Saved' },
  { value: 'ordered', label: '📦 Ordered' },
  { value: 'purchased', label: '✅ Purchased' },
  { value: 'given', label: '🎁 Given' },
];

const RECURRING_KINDS: RelationshipDateKind[] = ['anniversary', 'birthday', 'first_date'];
const blankDate = {
  id: '', kind: 'anniversary' as RelationshipDateKind, title: '', eventDate: '', recursAnnually: true,
  reminderDaysBefore: '14', memberId: '', location: '', notes: '', status: 'upcoming',
};
const blankGift = { id: '', title: '', url: '', price: '', occasion: '', forName: '', reason: '', status: 'idea' as RelationshipGiftStatus };
const fmtDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
const dollars = (cents: number | null) => (cents == null ? null : `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`);

export function RelationshipModule() {
  const t = useTranslations();
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();

  const { data: dates, loading: dl, error: de } = useRealtimeQuery<RDate>({
    table: 'relationship_dates', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('relationship_dates').select('*').eq('family_id', familyId),
  });
  const { data: gifts } = useRealtimeQuery<Gift_>({
    table: 'relationship_gift_ideas', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('relationship_gift_ideas').select('*').eq('family_id', familyId),
  });
  const { data: profileRows } = useRealtimeQuery<Profile>({
    table: 'relationship_profile', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('relationship_profile').select('*').eq('family_id', familyId),
  });
  const { data: wishes } = useRealtimeQuery<Wish>({
    table: 'wishlist_items', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('wishlist_items').select('*').eq('family_id', familyId),
  });
  const profile = profileRows?.find((row) => row.family_id === familyId) ?? null;
  const digestMemberId = selfMember?.family_id === familyId ? selfMember.id : null;
  const digestPartnerId = profile?.partner_member_id ?? null;
  const digestPartnerName = profile?.partner_name ?? null;
  const digestScope = useMemo(() => createRelationshipDigestRequestScope({
    familyId, userId, memberId: digestMemberId,
    partnerMemberId: digestPartnerId, partnerName: digestPartnerName,
  }), [familyId, userId, digestMemberId, digestPartnerId, digestPartnerName]);

  const [dateModal, setDateModal] = useState(false);
  const [dateForm, setDateForm] = useState(blankDate);
  const [giftModal, setGiftModal] = useState(false);
  const [giftForm, setGiftForm] = useState(blankGift);
  const [profileModal, setProfileModal] = useState(false);
  const [wishModal, setWishModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiLoadingScope, setAiLoadingScope] = useState<typeof digestScope | null>(null);
  const [digestResult, setDigestResult] = useState<{
    scope: typeof digestScope;
    request: ReturnType<typeof digestScope.begin>;
    digest: RelationshipDigest;
  } | null>(null);
  const aiLoading = aiLoadingScope === digestScope;
  // The render guard hides old history before context-change effects run.
  const digest = digestResult && digestResult.scope === digestScope && digestScope.isCurrent(digestResult.request)
    ? digestResult.digest : null;
  useLayoutEffect(() => {
    setDigestResult(null);
    setAiLoadingScope(null);
    return () => digestScope.invalidate();
  }, [digestScope]);
  const [giftFilter, setGiftFilter] = useState<'all' | RelationshipGiftStatus>('all');

  const giftSummary = useMemo(() => summarizeGifts((gifts ?? []).map((g) => ({ status: g.status, price_cents: g.price_cents }))), [gifts]);
  const visibleGifts = useMemo(() => (gifts ?? []).filter((g) => giftFilter === 'all' || g.status === giftFilter), [gifts, giftFilter]);

  const upcoming = useMemo(() => upcomingDates(
    (dates ?? []).map((d): RelDate => ({
      id: d.id, kind: d.kind, title: d.title, eventDate: d.event_date,
      recursAnnually: d.recurs_annually, reminderDaysBefore: d.reminder_days_before, status: d.status,
    })),
    { withinDays: 365 },
  ), [dates]);

  const partnerName = profile?.partner_name?.trim()
    || (profile?.partner_member_id ? members.find((m) => m.id === profile.partner_member_id)?.display_name : null)
    || 'your partner';
  const partnerWishes = useMemo(
    () => (wishes ?? []).filter((w) => profile?.partner_member_id && w.member_id === profile.partner_member_id),
    [wishes, profile?.partner_member_id],
  );
  const wishSuggestions = useMemo(
    () => suggestGiftsFromWishlist(partnerWishes as unknown as WishItemLite[], { maxBudgetCents: profile?.gift_budget_cents ?? null, limit: 12 }),
    [partnerWishes, profile?.gift_budget_cents],
  );

  // ── Dates CRUD ──
  function openNewDate(kind: RelationshipDateKind = 'anniversary') {
    setDateForm({ ...blankDate, kind, recursAnnually: RECURRING_KINDS.includes(kind), status: kind === 'date_night' ? 'planned' : 'upcoming' });
    setDateModal(true);
  }
  function openEditDate(d: RDate) {
    setDateForm({
      id: d.id, kind: d.kind, title: d.title, eventDate: d.event_date, recursAnnually: d.recurs_annually,
      reminderDaysBefore: String(d.reminder_days_before), memberId: d.member_id ?? '', location: d.location ?? '',
      notes: d.notes ?? '', status: d.status,
    });
    setDateModal(true);
  }
  async function saveDate(e: React.FormEvent) {
    e.preventDefault();
    if (!dateForm.title.trim()) { toastError('Give this date a name'); return; }
    if (!dateForm.eventDate) { toastError('Pick a date'); return; }
    setSaving(true);
    const sb = createClient();
    const fields = {
      kind: dateForm.kind, title: dateForm.title.trim(), event_date: dateForm.eventDate,
      recurs_annually: dateForm.recursAnnually, reminder_days_before: Number(dateForm.reminderDaysBefore) || 14,
      member_id: dateForm.memberId || null, location: dateForm.location.trim() || null,
      notes: dateForm.notes.trim() || null, status: dateForm.status as RelationshipDateStatus,
    };
    const { error: err } = dateForm.id
      ? await sb.from('relationship_dates').update(fields).eq('id', dateForm.id)
      : await sb.from('relationship_dates').insert({ ...fields, family_id: familyId, created_by: userId });
    setSaving(false);
    if (err) { toastError(describeDbError(err)); return; }
    success(dateForm.id ? 'Date updated' : 'Date added');
    setDateModal(false);
  }
  async function removeDate(d: RDate) {
    if (!confirm(`Remove "${d.title}"?`)) return;
    const { error: err } = await createClient().from('relationship_dates').delete().eq('id', d.id);
    if (err) { toastError(describeDbError(err)); return; }
    success('Removed');
  }
  async function toggleCalendar(d: RDate) {
    const sb = createClient();
    if (d.calendar_event_id) {
      await sb.from('calendar_events').delete().eq('id', d.calendar_event_id);
      const { error: err } = await sb.from('relationship_dates').update({ calendar_event_id: null }).eq('id', d.id);
      if (err) { toastError(describeDbError(err)); return; }
      success('Removed from calendar');
      return;
    }
    const payload = buildCalendarEventForDate(
      { kind: d.kind, title: d.title, eventDate: d.event_date, recursAnnually: d.recurs_annually, location: d.location },
      familyId, userId,
    );
    const { data: created, error: err } = await sb.from('calendar_events').insert(payload).select('id').single();
    if (err || !created) { toastError(describeDbError(err)); return; }
    const { error: e2 } = await sb.from('relationship_dates').update({ calendar_event_id: created.id }).eq('id', d.id);
    if (e2) { toastError(describeDbError(e2)); return; }
    success('Added to your family calendar 📅');
  }

  // ── Gifts CRUD ──
  function openNewGift() { setGiftForm({ ...blankGift, forName: partnerName === 'your partner' ? '' : partnerName }); setGiftModal(true); }
  function openEditGift(g: Gift_) {
    setGiftForm({
      id: g.id, title: g.title, url: g.url ?? '', price: g.price_cents != null ? String(g.price_cents / 100) : '',
      occasion: g.occasion ?? '', forName: g.for_name ?? '', reason: g.reason ?? '', status: g.status,
    });
    setGiftModal(true);
  }
  async function saveGift(e: React.FormEvent) {
    e.preventDefault();
    if (!giftForm.title.trim()) { toastError('What’s the gift?'); return; }
    setSaving(true);
    const fields = {
      title: giftForm.title.trim(), url: giftForm.url.trim() || null,
      price_cents: giftForm.price ? Math.round(Number(giftForm.price) * 100) : null,
      occasion: giftForm.occasion.trim() || null, for_name: giftForm.forName.trim() || null,
      reason: giftForm.reason.trim() || null, status: giftForm.status,
    };
    const sb = createClient();
    const { error: err } = giftForm.id
      ? await sb.from('relationship_gift_ideas').update(fields).eq('id', giftForm.id)
      : await sb.from('relationship_gift_ideas').insert({ ...fields, family_id: familyId, created_by: userId, source: 'manual' });
    setSaving(false);
    if (err) { toastError(describeDbError(err)); return; }
    success(giftForm.id ? 'Gift updated' : 'Gift idea saved');
    setGiftModal(false);
  }
  async function setGiftStatus(g: Gift_, status: RelationshipGiftStatus) {
    const { error: err } = await createClient().from('relationship_gift_ideas').update({ status }).eq('id', g.id);
    if (err) toastError(describeDbError(err));
  }
  async function removeGift(g: Gift_) {
    const { error: err } = await createClient().from('relationship_gift_ideas').delete().eq('id', g.id);
    if (err) { toastError(describeDbError(err)); return; }
    success('Removed');
  }
  async function saveAiGift(idea: { title: string; reason: string; estimatedPrice: string | null }) {
    const cents = idea.estimatedPrice ? Math.round((Number(idea.estimatedPrice.replace(/[^0-9.]/g, '')) || 0) * 100) : null;
    const { error: err } = await createClient().from('relationship_gift_ideas').insert({
      family_id: familyId, created_by: userId, title: idea.title, reason: idea.reason || null,
      price_cents: cents && cents > 0 ? cents : null, for_name: partnerName === 'your partner' ? null : partnerName,
      source: 'ai', status: 'idea',
    });
    if (err) { toastError(describeDbError(err)); return; }
    success('Saved to gift ideas');
  }
  async function addWishGift(w: Wish) {
    const { error: err } = await createClient().from('relationship_gift_ideas').insert({
      family_id: familyId, created_by: userId, title: w.title, url: w.url, for_name: partnerName === 'your partner' ? null : partnerName,
      price_cents: w.price != null ? Math.round(w.price * 100) : null, source: 'wishlist', wishlist_item_id: w.id, status: 'idea',
    });
    if (err) { toastError(describeDbError(err)); return; }
    success(`Added “${w.title}” to gift ideas`);
  }

  // ── Profile ──
  const [pForm, setPForm] = useState({ partnerName: '', partnerMemberId: '', interests: '', loveLanguages: '', budget: '', notes: '' });
  function openProfile() {
    setPForm({
      partnerName: profile?.partner_name ?? '', partnerMemberId: profile?.partner_member_id ?? '',
      interests: (profile?.interests ?? []).join(', '), loveLanguages: (profile?.love_languages ?? []).join(', '),
      budget: profile?.gift_budget_cents != null ? String(profile.gift_budget_cents / 100) : '', notes: profile?.notes ?? '',
    });
    setProfileModal(true);
  }
  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const fields = {
      partner_name: pForm.partnerName.trim() || null,
      partner_member_id: pForm.partnerMemberId || null,
      interests: pForm.interests.split(',').map((s) => s.trim()).filter(Boolean),
      love_languages: pForm.loveLanguages.split(',').map((s) => s.trim()).filter(Boolean),
      gift_budget_cents: pForm.budget ? Math.round(Number(pForm.budget) * 100) : null,
      notes: pForm.notes.trim() || null,
    };
    const sb = createClient();
    const { error: err } = profile
      ? await sb.from('relationship_profile').update(fields).eq('id', profile.id)
      : await sb.from('relationship_profile').insert({ ...fields, family_id: familyId, created_by: userId });
    setSaving(false);
    if (err) { toastError(describeDbError(err)); return; }
    success('Preferences saved');
    setProfileModal(false);
  }

  // ── AI ──
  async function runAi() {
    const request = digestScope.begin();
    // Also guard the existing finally cleanup against a newer request.
    function setAiLoading(loading: boolean) {
      if (digestScope.isCurrent(request)) setAiLoadingScope(loading ? digestScope : null);
    }
    setAiLoading(true);
    try {
      const res = await fetch('/api/ai/relationship', { method: 'POST', signal: request.signal });
      if (!digestScope.isCurrent(request)) return;
      const json = await res.json();
      if (!digestScope.isCurrent(request)) return;
      if (!res.ok) { toastError(json.error ?? 'Could not generate suggestions.'); return; }
      if (!digestScope.accepts(request, json.context)) {
        toastError('Household or partner context changed. Please generate suggestions again.');
        return;
      }
      setDigestResult({ scope: digestScope, request, digest: json.digest as RelationshipDigest });
    } catch {
      if (!digestScope.isCurrent(request)) return;
      toastError('Network problem — please try again.');
    } finally {
      setAiLoading(false);
    }
  }

  if (dl) return <SkeletonList count={5} />;
  if (de) return <ErrorState message={typeof de === 'string' ? de : 'Failed to load'} />;

  return (
    <div>
      <PageHeader
        title={t('relationship.relationshipHelper')}
        description={`Never miss the moments that matter${partnerName === 'your partner' ? '' : ` with ${partnerName}`} — anniversaries, birthdays, date nights, and gift ideas, with a little AI nudge.`}
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={openProfile} className="gap-1.5"><SlidersHorizontal className="h-4 w-4" /> {t('relationship.preferences')}</Button>
            <Button onClick={() => runAi()} disabled={aiLoading} className="gap-1.5">
              {aiLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} {t('relationship.aiSuggestions')}
            </Button>
          </div>
        }
      />

      {/* AI digest */}
      {digest && (
        <div className="mb-6 rounded-2xl border border-brand/30 bg-brand/5 p-5">
          <div className="flex items-start gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand-text"><Sparkles className="h-5 w-5" /></div>
            <div className="flex-1">
              {digest.headline && <p className="font-semibold">{digest.headline}</p>}
              {digest.prompts.length > 0 && (
                <ul className="mt-2 space-y-1.5">
                  {digest.prompts.map((p, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-muted"><Heart className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-300" />{p}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {digest.giftHistory && (
            <div className="mt-4 rounded-xl border border-border bg-surface/50 p-3">
              <p className="text-xs font-semibold">{t('relationship.recordedGiftHistory')}</p>
              <p className="mt-1 text-xs text-muted">{digest.giftHistory.summary}</p>
              {digest.giftHistory.records.length > 0 && (
                <details className="mt-2 text-xs text-muted">
                  <summary className="cursor-pointer text-brand-text">{t('relationship.viewRecordedOutcomes')}</summary>
                  <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto">
                    {digest.giftHistory.records.map((record) => (
                      <li key={record.id}>
                        <span className="font-medium text-fg">{record.title}</span>
                        {' - '}{record.status === 'given' ? 'Given' : 'Purchased'}
                        {record.for_name ? ` for ${record.for_name}` : ''}
                        {' - '}{record.matchedBy === 'member_id' ? 'recipient ID match' : 'recorded name match'}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2">Duplicate checks use wishlist IDs or gift titles ignoring case and whitespace. Different wording may still describe the same gift.</p>
                </details>
              )}
            </div>
          )}
          {digest.giftIdeas.length > 0 && (
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {digest.giftIdeas.map((idea, i) => (
                <div key={i} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-surface/50 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{idea.title}{idea.estimatedPrice ? <span className="ml-1 text-xs text-muted">· {idea.estimatedPrice}</span> : null}</p>
                    {idea.reason && <p className="mt-0.5 text-xs text-muted">{idea.reason}</p>}
                  </div>
                  <button onClick={() => saveAiGift(idea)} className="shrink-0 rounded-lg bg-brand/10 px-2.5 py-1.5 text-xs font-semibold text-brand-text hover:bg-brand/20" aria-label={t('relationship.saveGiftIdea')}>
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Upcoming dates */}
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{t('relationship.upcoming')}</h2>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={() => openNewDate('date_night')} className="gap-1"><Wine className="h-3.5 w-3.5" /> {t('relationship.dateNight')}</Button>
            <Button size="sm" onClick={() => openNewDate('anniversary')} className="gap-1"><Plus className="h-3.5 w-3.5" /> {t('relationship.addDate')}</Button>
          </div>
        </div>
        {upcoming.length === 0 ? (
          <EmptyState icon={Heart} title={t('relationship.noDatesYet')}
            description="Add your anniversary, your partner’s birthday, or plan a date night — Bubaly will remind you and suggest gifts."
            action={<Button onClick={() => openNewDate('anniversary')} className="gap-1.5"><Plus className="h-4 w-4" /> {t('relationship.addYourFirstDate')}</Button>} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {upcoming.map((u) => {
              const meta = KIND_META[u.kind];
              const Icon = meta.icon;
              const ms = milestoneLabel(u);
              const due = u.days <= u.reminderDaysBefore;
              const raw = (dates ?? []).find((d) => d.id === u.id)!;
              return (
                <div key={u.id} className={cn('flex flex-col rounded-2xl border bg-surface/50 p-4', due ? 'border-brand/40' : 'border-border')}>
                  <div className="flex items-start justify-between gap-2">
                    <span className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide', meta.cls)}>
                      <Icon className="h-3 w-3" /> {meta.label}
                    </span>
                    <div className="flex items-center gap-1">
                      <button onClick={() => toggleCalendar(raw)} aria-label={raw.calendar_event_id ? 'Remove from calendar' : 'Add to calendar'}
                        className={cn('rounded p-1 hover:bg-elevated', raw.calendar_event_id ? 'text-emerald-300' : 'text-muted hover:text-fg')}>
                        {raw.calendar_event_id ? <CalendarCheck className="h-3.5 w-3.5" /> : <CalendarPlus className="h-3.5 w-3.5" />}
                      </button>
                      <button onClick={() => openEditDate(raw)} aria-label={t('relationship.edit')} className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"><Pencil className="h-3.5 w-3.5" /></button>
                      <button onClick={() => removeDate(raw)} aria-label={t('relationship.remove')} className="rounded p-1 text-muted hover:bg-elevated hover:text-rose-400"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  </div>
                  <p className="mt-2 font-semibold">{u.title}</p>
                  <p className="text-sm text-muted">{fmtDate(raw.event_date)}{ms ? ` · ${ms}` : ''}</p>
                  {raw.location && <p className="mt-0.5 flex items-center gap-1 text-xs text-muted"><MapPin className="h-3 w-3" />{raw.location}</p>}
                  <div className="mt-3 flex items-center gap-1.5">
                    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold', due ? 'bg-brand/15 text-brand-text' : 'bg-elevated text-muted')}>
                      {due && <Bell className="h-3 w-3" />} {formatCountdown(u.days)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Gift ideas */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{t('relationship.giftIdeas')}</h2>
          <div className="flex flex-wrap gap-1.5">
            {profile?.partner_member_id && wishSuggestions.length > 0 && (
              <Button size="sm" variant="outline" onClick={() => setWishModal(true)} className="gap-1"><Gift className="h-3.5 w-3.5" /> {t('relationship.fromWishlist')}</Button>
            )}
            <Button size="sm" onClick={openNewGift} className="gap-1"><Plus className="h-3.5 w-3.5" /> {t('relationship.addIdea')}</Button>
          </div>
        </div>
        {(gifts ?? []).length === 0 ? (
          <EmptyState icon={Gift} title={t('relationship.noGiftIdeasYet')}
            description={`Jot down ideas as you spot them${profile?.partner_member_id ? `, pull from ${partnerName}’s wishlist,` : ''} or let AI suggest a few.`}
            action={<Button onClick={openNewGift} className="gap-1.5"><Plus className="h-4 w-4" /> {t('relationship.addAGiftIdea')}</Button>} />
        ) : (
          <>
            {/* Shopping summary + status filter */}
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <p className="text-sm text-muted">
                <span className="font-semibold text-fg">{giftSummary.open}</span> {t('relationship.toBuy')}
                {giftSummary.openCents > 0 && <> · <span className="font-semibold text-fg">{dollars(giftSummary.openCents)}</span> {t('relationship.toGo')}</>}
                {giftSummary.done > 0 && <> · {giftSummary.done} done</>}
              </p>
              <div className="flex flex-wrap gap-1 sm:ml-auto">
                {(['all', ...GIFT_STATUS.map((s) => s.value)] as const).map((f) => (
                  <button key={f} onClick={() => setGiftFilter(f)}
                    className={cn('rounded-full border px-2.5 py-1 text-xs font-medium transition',
                      giftFilter === f ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:text-fg')}>
                    {f === 'all' ? 'All' : GIFT_STATUS.find((s) => s.value === f)?.label}
                  </button>
                ))}
              </div>
            </div>
            {visibleGifts.length === 0 ? (
              <p className="rounded-xl border border-border bg-surface/30 px-4 py-6 text-center text-sm text-muted">{t('relationship.noGiftsInThisStatus')}</p>
            ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visibleGifts.map((g) => (
              <div key={g.id} className="flex flex-col rounded-2xl border border-border bg-surface/50 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand-text"><Gift className="h-5 w-5" /></div>
                  <div className="flex items-center gap-1">
                    {g.source === 'ai' && <span className="rounded bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand-text">AI</span>}
                    {g.source === 'wishlist' && <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">{t('relationship.wishlist')}</span>}
                    <button onClick={() => openEditGift(g)} aria-label={t('relationship.edit')} className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"><Pencil className="h-3.5 w-3.5" /></button>
                    <button onClick={() => removeGift(g)} aria-label={t('relationship.remove')} className="rounded p-1 text-muted hover:bg-elevated hover:text-rose-400"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
                <p className="mt-2 font-semibold">{g.title}</p>
                {g.reason && <p className="mt-0.5 text-sm text-muted">{g.reason}</p>}
                {g.for_name && <p className="mt-0.5 text-xs text-muted">For {g.for_name}{g.occasion ? ` · ${g.occasion}` : ''}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  {g.price_cents != null && <span className="inline-flex items-center gap-0.5"><DollarSign className="h-3.5 w-3.5" />{dollars(g.price_cents)?.replace('$', '')}</span>}
                  {g.url && <a href={g.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand-text hover:underline"><ExternalLink className="h-3.5 w-3.5" /> {t('relationship.view')}</a>}
                </div>
                <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
                  {g.status === 'purchased' || g.status === 'given'
                    ? <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-300"><Check className="h-3.5 w-3.5" />{GIFT_STATUS.find((s) => s.value === g.status)?.label}</span>
                    : <ShoppingBag className="h-3.5 w-3.5 text-muted" />}
                  <Select aria-label={t('relationship.giftStatus')} value={g.status} onChange={(e) => setGiftStatus(g, e.target.value as RelationshipGiftStatus)} className="ml-auto h-7 w-auto text-xs">
                    {GIFT_STATUS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </Select>
                </div>
              </div>
            ))}
            </div>
            )}
          </>
        )}
      </section>

      {/* Date modal */}
      <Modal open={dateModal} onClose={() => setDateModal(false)} title={dateForm.id ? 'Edit date' : 'Add a date'}>
        <form onSubmit={saveDate} className="space-y-4">
          <Field label={t('relationship.type')}>
            {(id) => (
              <Select id={id} value={dateForm.kind} onChange={(e) => {
                const kind = e.target.value as RelationshipDateKind;
                setDateForm((f) => ({ ...f, kind, recursAnnually: RECURRING_KINDS.includes(kind) }));
              }}>
                {(Object.keys(KIND_META) as RelationshipDateKind[]).map((k) => <option key={k} value={k}>{KIND_META[k].label}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('relationship.title')} required>
            {(id) => <Input id={id} value={dateForm.title} onChange={(e) => setDateForm((f) => ({ ...f, title: e.target.value }))} placeholder={t('relationship.eGOurAnniversary')} autoFocus />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('relationship.date')} required>
              {(id) => <Input id={id} type="date" value={dateForm.eventDate} onChange={(e) => setDateForm((f) => ({ ...f, eventDate: e.target.value }))} />}
            </Field>
            <Field label={t('relationship.remindMeDaysBefore')}>
              {(id) => <Input id={id} type="number" min={0} max={365} value={dateForm.reminderDaysBefore} onChange={(e) => setDateForm((f) => ({ ...f, reminderDaysBefore: e.target.value }))} />}
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={dateForm.recursAnnually} onChange={(e) => setDateForm((f) => ({ ...f, recursAnnually: e.target.checked }))} className="h-4 w-4 rounded border-border" />
            {t('relationship.repeatsEveryYear')}
          </label>
          {dateForm.kind === 'date_night' && (
            <Field label={t('relationship.where')}>
              {(id) => <Input id={id} value={dateForm.location} onChange={(e) => setDateForm((f) => ({ ...f, location: e.target.value }))} placeholder={t('relationship.restaurantMovie')} />}
            </Field>
          )}
          <Field label={t('relationship.whoItsAboutOptional')}>
            {(id) => (
              <Select id={id} value={dateForm.memberId} onChange={(e) => setDateForm((f) => ({ ...f, memberId: e.target.value }))}>
                <option value="">—</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('relationship.notes')}>
            {(id) => <Textarea id={id} value={dateForm.notes} onChange={(e) => setDateForm((f) => ({ ...f, notes: e.target.value }))} placeholder={t('relationship.ideasReservationsAnythingToRemember')} />}
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setDateModal(false)}>{t('relationship.cancel')}</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : dateForm.id ? 'Save changes' : 'Add date'}</Button>
          </div>
        </form>
      </Modal>

      {/* Gift modal */}
      <Modal open={giftModal} onClose={() => setGiftModal(false)} title={giftForm.id ? 'Edit gift idea' : 'Add a gift idea'}>
        <form onSubmit={saveGift} className="space-y-4">
          <Field label={t('relationship.gift')} required>
            {(id) => <Input id={id} value={giftForm.title} onChange={(e) => setGiftForm((f) => ({ ...f, title: e.target.value }))} placeholder={t('relationship.eGWeekendCabinGetaway')} autoFocus />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('relationship.link')}>
              {(id) => <Input id={id} type="url" value={giftForm.url} onChange={(e) => setGiftForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://…" />}
            </Field>
            <Field label={t('relationship.approxPrice')}>
              {(id) => <Input id={id} type="number" inputMode="decimal" min={0} step="0.01" value={giftForm.price} onChange={(e) => setGiftForm((f) => ({ ...f, price: e.target.value }))} placeholder="0.00" />}
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="For">
              {(id) => <Input id={id} value={giftForm.forName} onChange={(e) => setGiftForm((f) => ({ ...f, forName: e.target.value }))} placeholder={t('relationship.partnersName')} />}
            </Field>
            <Field label={t('relationship.occasion')}>
              {(id) => <Input id={id} value={giftForm.occasion} onChange={(e) => setGiftForm((f) => ({ ...f, occasion: e.target.value }))} placeholder={t('relationship.anniversaryBirthday')} />}
            </Field>
          </div>
          <Field label={t('relationship.notes')}>
            {(id) => <Textarea id={id} value={giftForm.reason} onChange={(e) => setGiftForm((f) => ({ ...f, reason: e.target.value }))} placeholder={t('relationship.whyItsAGreatFit')} />}
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setGiftModal(false)}>{t('relationship.cancel')}</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : giftForm.id ? 'Save changes' : 'Save idea'}</Button>
          </div>
        </form>
      </Modal>

      {/* Preferences modal */}
      <Modal open={profileModal} onClose={() => setProfileModal(false)} title={t('relationship.partnerPreferences')}>
        <form onSubmit={saveProfile} className="space-y-4">
          <p className="text-sm text-muted">{t('relationship.theseHelpTheAiSuggestThoughtful')}</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('relationship.partnersName')}>
              {(id) => <Input id={id} value={pForm.partnerName} onChange={(e) => setPForm((f) => ({ ...f, partnerName: e.target.value }))} placeholder={t('relationship.eGSam')} />}
            </Field>
            <Field label={t('relationship.linkToMember')}>
              {(id) => (
                <Select id={id} value={pForm.partnerMemberId} onChange={(e) => setPForm((f) => ({ ...f, partnerMemberId: e.target.value }))}>
                  <option value="">—</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                </Select>
              )}
            </Field>
          </div>
          <Field label={t('relationship.interestsCommaSeparated')}>
            {(id) => <Input id={id} value={pForm.interests} onChange={(e) => setPForm((f) => ({ ...f, interests: e.target.value }))} placeholder={t('relationship.hikingCoffeeVinylRecords')} />}
          </Field>
          <Field label={t('relationship.loveLanguagesCommaSeparated')}>
            {(id) => <Input id={id} value={pForm.loveLanguages} onChange={(e) => setPForm((f) => ({ ...f, loveLanguages: e.target.value }))} placeholder={t('relationship.qualityTimeGiftsActsOfService')} />}
          </Field>
          <Field label={t('relationship.typicalGiftBudget')}>
            {(id) => <Input id={id} type="number" min={0} step="1" value={pForm.budget} onChange={(e) => setPForm((f) => ({ ...f, budget: e.target.value }))} placeholder="100" />}
          </Field>
          <Field label={t('relationship.notes')}>
            {(id) => <Textarea id={id} value={pForm.notes} onChange={(e) => setPForm((f) => ({ ...f, notes: e.target.value }))} placeholder={t('relationship.sizesAllergiesWhatToAvoid')} />}
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setProfileModal(false)}>{t('relationship.cancel')}</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save preferences'}</Button>
          </div>
        </form>
      </Modal>

      {/* From-wishlist modal */}
      <Modal open={wishModal} onClose={() => setWishModal(false)} title={`Add from ${partnerName}’s wishlist`}>
        <div className="space-y-2">
          {wishSuggestions.length === 0
            ? <p className="text-sm text-muted">{t('relationship.noAvailableWishlistItemsToAdd')}</p>
            : wishSuggestions.map((c) => {
                const w = partnerWishes.find((x) => x.id === c.wishlistItemId)!;
                const already = (gifts ?? []).some((g) => g.wishlist_item_id === c.wishlistItemId);
                return (
                  <div key={c.wishlistItemId} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface/50 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{c.title}</p>
                      <p className="text-xs text-muted">{c.priceCents != null ? dollars(c.priceCents) : 'No price'} · {c.priority} priority</p>
                    </div>
                    <Button size="sm" variant={already ? 'outline' : 'primary'} disabled={already} onClick={() => addWishGift(w)} className="shrink-0 gap-1">
                      {already ? <><Check className="h-3.5 w-3.5" /> {t('relationship.added')}</> : <><Plus className="h-3.5 w-3.5" /> Add</>}
                    </Button>
                  </div>
                );
              })}
        </div>
      </Modal>
    </div>
  );
}
