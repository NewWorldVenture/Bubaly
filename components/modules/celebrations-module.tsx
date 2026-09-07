'use client';

import { useMemo, useState } from 'react';
import { Cake, Heart, PartyPopper, CalendarHeart, Plus, Trash2, Gift } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { isAdmin } from '@/lib/constants/roles';
import {
  upcomingCelebrations, countdownLabel, type CelebrationInput, type CelebrationKind,
} from '@/lib/celebrations/dates';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type FamilyDate = Tables<'family_dates'>;

const KIND_ICON: Record<CelebrationKind, typeof Cake> = {
  birthday: Cake, anniversary: Heart, holiday: PartyPopper, other: CalendarHeart,
};
const KIND_TINT: Record<CelebrationKind, string> = {
  birthday: 'text-pink-300 bg-pink-500/15',
  anniversary: 'text-rose-300 bg-rose-500/15',
  holiday: 'text-violet-300 bg-violet-500/15',
  other: 'text-amber-300 bg-amber-500/15',
};

export function CelebrationsModule() {
  const t = useTranslations();
  const { familyId, userId, role, members } = useApp();
  const admin = isAdmin(role);
  const { success, error: toastError } = useToast();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const { data: dates, loading, error, refresh } = useRealtimeQuery<FamilyDate>({
    table: 'family_dates', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_dates').select('*').eq('family_id', familyId),
  });

  const items: CelebrationInput[] = useMemo(() => {
    const fromMembers: CelebrationInput[] = members
      .filter((m) => m.birthday)
      .map((m) => ({ id: `m-${m.id}`, kind: 'birthday', title: `${m.display_name}'s birthday`, date: m.birthday as string, memberId: m.id, color: m.color }));
    const fromDates: CelebrationInput[] = (dates ?? []).map((d) => ({
      id: `d-${d.id}`, kind: (d.kind as CelebrationKind) ?? 'other', title: d.title, date: d.event_date,
      memberId: d.member_id, color: d.member_id ? memberById.get(d.member_id)?.color : null,
    }));
    return [...fromMembers, ...fromDates];
  }, [members, dates, memberById]);

  const upcoming = useMemo(() => upcomingCelebrations(items, 120), [items]);

  const [showAdd, setShowAdd] = useState(false);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<CelebrationKind>('birthday');
  const [date, setDate] = useState('');
  const [saving, setSaving] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !date) return;
    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase.from('family_dates').insert({
      family_id: familyId, title: title.trim(), kind, event_date: date, created_by: userId,
    });
    setSaving(false);
    if (error) return toastError(describeDbError(error));
    success(t('celebrationsModule.celebrationAdded'));
    setTitle(''); setDate(''); setKind('birthday'); setShowAdd(false);
  }

  async function remove(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('family_dates').delete().eq('id', id.replace(/^d-/, ''));
    if (error) toastError(describeDbError(error)); else success(t('celebrationsModule.removed'));
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('celebrations.celebrations')}
        description={t('celebrationsModule.neverMissABirthdayOr')}
        action={
          <div className="flex items-center gap-2">
            <AiInsight kind="celebrations" iconOnly />
            {admin && <Button onClick={() => setShowAdd(true)}><Plus className="h-4 w-4" /> Add</Button>}
          </div>
        }
      />

      {loading ? (
        <SkeletonList />
      ) : error ? (
        <ErrorState message={t('celebrationsModule.couldNotLoadCelebrationsRefresh')} onRetry={refresh} />
      ) : upcoming.length === 0 ? (
        <EmptyState icon={Gift} title={t('celebrations.noUpcomingCelebrations')} description={t('celebrationsModule.addBirthdaysInFamilyMember')} />
      ) : (
        <ul className="space-y-2">
          {upcoming.map((c) => {
            const Icon = KIND_ICON[c.kind];
            const who = c.memberId ? memberById.get(c.memberId) : undefined;
            const soon = c.daysUntil <= 7;
            return (
              <li key={c.id} className={`flex items-center gap-3 rounded-2xl border p-4 ${soon ? 'border-brand/40 bg-brand/5' : 'border-border bg-surface/40'}`}>
                <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${KIND_TINT[c.kind]}`}><Icon className="h-5 w-5" /></div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{c.title}{c.turning ? <span className="ml-1 text-sm font-normal text-muted">{t('celebrations.turning')} {c.turning}</span> : null}</p>
                  <p className="text-xs text-muted">{new Date(c.nextDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
                </div>
                {who && <Avatar name={who.display_name} color={who.color} size={32} />}
                <span className={`shrink-0 text-sm font-semibold ${soon ? 'text-brand-text' : 'text-muted'}`}>{countdownLabel(c.daysUntil)}</span>
                {admin && c.id.startsWith('d-') && (
                  <button onClick={() => remove(c.id)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-danger"><Trash2 className="h-4 w-4" /></button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title={t('celebrations.addACelebration')}>
        <form onSubmit={add} className="space-y-4">
          <Field label={t('celebrations.whatAreWeCelebrating')} required>{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('celebrationsModule.eGMomDadS')} required />}</Field>
          <Field label={t('celebrations.type')}>{(id) => (
            <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as CelebrationKind)}>
              <option value="birthday">{t('celebrations.birthday')}</option>
              <option value="anniversary">{t('celebrations.anniversary')}</option>
              <option value="holiday">{t('celebrations.holiday')}</option>
              <option value="other">{t('celebrations.other')}</option>
            </Select>
          )}</Field>
          <Field label={t('celebrations.date')} required>{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}</Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setShowAdd(false)}>{t('celebrations.cancel')}</Button>
            <Button type="submit" loading={saving}><Plus className="h-4 w-4" /> Add</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
