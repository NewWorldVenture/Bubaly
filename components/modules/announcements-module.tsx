'use client';

import { useEffect, useMemo, useState } from 'react';
import { Megaphone, Plus, Pin, PinOff, Trash2, Check, Users } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { isAdmin } from '@/lib/constants/roles';
import { fmtDateTime } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Announcement = Tables<'family_announcements'>;
type Read = Tables<'announcement_reads'>;

export function AnnouncementsModule() {
  const t = useTranslations();
  const { familyId, userId, role, members, selfMember } = useApp();
  const admin = isAdmin(role);
  const { success, error: toastError } = useToast();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const activeMembers = members.filter((m) => m.is_active).length;

  const { data: announcements, loading: announcementsLoading, error: announcementsError, refresh: refreshAnnouncements } = useRealtimeQuery<Announcement>({
    table: 'family_announcements', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_announcements').select('*').eq('family_id', familyId)
      .order('is_pinned', { ascending: false }).order('created_at', { ascending: false }),
  });
  const { data: reads, loading: readsLoading, error: readsError, refresh: refreshReads } = useRealtimeQuery<Read>({
    table: 'announcement_reads', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('announcement_reads').select('*').eq('family_id', familyId),
  });

  const loading = announcementsLoading || readsLoading;
  const error = announcementsError || readsError;
  const refresh = () => { void refreshAnnouncements(); void refreshReads(); };

  const readsByAnnouncement = useMemo(() => {
    const m = new Map<string, Read[]>();
    for (const r of reads ?? []) {
      const arr = m.get(r.announcement_id) ?? [];
      arr.push(r); m.set(r.announcement_id, arr);
    }
    return m;
  }, [reads]);

  const [showCompose, setShowCompose] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [saving, setSaving] = useState(false);

  // Auto-mark unread announcements as read for the current member.
  useEffect(() => {
    if (!selfMember || !announcements || !reads) return;
    const mine = new Set((reads).filter((r) => r.member_id === selfMember.id).map((r) => r.announcement_id));
    const unread = announcements.filter((a) => !mine.has(a.id));
    if (unread.length === 0) return;
    const supabase = createClient();
    void supabase.from('announcement_reads').upsert(
      unread.map((a) => ({ announcement_id: a.id, family_id: familyId, member_id: selfMember.id })),
      { onConflict: 'announcement_id,member_id' },
    );
  }, [announcements, reads, selfMember, familyId]);

  async function post(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    const supabase = createClient();
    const { error: err } = await supabase.from('family_announcements').insert({
      family_id: familyId, author_id: userId, author_member_id: selfMember?.id ?? null,
      title: title.trim(), body: body.trim() || null, is_pinned: pinned,
    });
    setSaving(false);
    if (err) return toastError(describeDbError(err));
    success(t('announcementsModule.announcementPosted'));
    setTitle(''); setBody(''); setPinned(false); setShowCompose(false);
  }

  async function togglePin(a: Announcement) {
    const supabase = createClient();
    const { error: err } = await supabase.from('family_announcements').update({ is_pinned: !a.is_pinned }).eq('id', a.id);
    if (err) toastError(describeDbError(err));
  }

  async function remove(id: string) {
    const supabase = createClient();
    const { error: err } = await supabase.from('family_announcements').delete().eq('id', id);
    if (err) toastError(describeDbError(err));
    else success(t('announcementsModule.announcementRemoved'));
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('announcements.announcements')}
        description={t('announcementsModule.broadcastUpdatesToTheWhole')}
        action={
          <div className="flex items-center gap-2">
            <AiInsight kind="announcements" iconOnly />
            {admin && <Button onClick={() => setShowCompose(true)}><Plus className="h-4 w-4" /> New</Button>}
          </div>
        }
      />

      {loading ? (
        <SkeletonList />
      ) : error ? (
        <ErrorState message={t('announcementsModule.couldNotLoadAnnouncementsRefresh')} onRetry={refresh} />
      ) : (announcements ?? []).length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title={t('announcements.noAnnouncementsYet')}
          description={admin ? 'Post the first family update — everyone will see it here.' : 'Family updates from your parents will appear here.'}
        />
      ) : (
        <ul className="space-y-3">
          {(announcements ?? []).map((a) => {
            const author = a.author_member_id ? memberById.get(a.author_member_id) : undefined;
            const readCount = readsByAnnouncement.get(a.id)?.length ?? 0;
            return (
              <li key={a.id} className="rounded-2xl border border-border bg-surface/40 p-4">
                <div className="flex items-start gap-3">
                  {author ? <Avatar name={author.display_name} color={author.color} size={36} /> : <div className="grid h-9 w-9 place-items-center rounded-full bg-brand/15 text-brand-text"><Megaphone className="h-4 w-4" /></div>}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold">{a.title}</p>
                      {a.is_pinned && <Pin className="h-3.5 w-3.5 text-amber-400" />}
                    </div>
                    {a.body && <p className="mt-1 whitespace-pre-wrap text-sm text-fg/90">{a.body}</p>}
                    <div className="mt-2 flex items-center gap-3 text-xs text-muted">
                      <span>{author?.display_name ?? 'Family'} · {fmtDateTime(a.created_at)}</span>
                      <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />{readCount}/{activeMembers} read</span>
                    </div>
                  </div>
                  {admin && (
                    <div className="flex shrink-0 gap-1">
                      <button onClick={() => togglePin(a)} title={a.is_pinned ? 'Unpin' : 'Pin'} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg">
                        {a.is_pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                      </button>
                      <button onClick={() => remove(a.id)} title={t('announcements.delete')} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-danger">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Modal open={showCompose} onClose={() => setShowCompose(false)} title={t('announcements.newAnnouncement')}>
        <form onSubmit={post} className="space-y-4">
          <Field label={t('announcements.title')} required>{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('announcements.eGEarlyDismissalFriday')} required />}</Field>
          <Field label={t('announcements.details')}>{(id) => <Textarea id={id} value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder={t('announcements.addAnyDetails')} />}</Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="h-4 w-4 accent-[var(--brand)]" />
            {t('announcements.pinToTop')}
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setShowCompose(false)}>{t('announcements.cancel')}</Button>
            <Button type="submit" loading={saving}><Check className="h-4 w-4" /> {t('announcements.post')}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
