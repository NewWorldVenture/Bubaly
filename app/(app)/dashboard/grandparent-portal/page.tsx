import type { Metadata } from 'next';
import { Heart, Users, Camera, Award, Megaphone, Cake, BookHeart } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { buildGrandparentDigest, digestSummary, celebrationCountdown } from '@/lib/grandparent/digest';
import { daysUntilNext } from '@/lib/celebrations/dates';
import { fmtDate } from '@/lib/utils/format';
import { Avatar } from '@/components/ui/avatar';
import { PageHeader } from '@/components/app/page-header';

export const metadata: Metadata = { title: 'Grandparent Portal' };
export const dynamic = 'force-dynamic';

export default async function GrandparentPortalPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [
    { data: family },
    { data: members },
    { data: photos },
    { data: milestones },
    { data: announcements },
    { data: dates },
  ] = await Promise.all([
    supabase.from('families').select('name').eq('id', familyId).single(),
    supabase.from('family_members').select('id, display_name, birthday, color, role').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_photos').select('url, caption, created_at').eq('family_id', familyId).order('created_at', { ascending: false }).limit(12),
    supabase.from('family_milestones').select('id, title, description, milestone_date, member_id').eq('family_id', familyId).order('milestone_date', { ascending: false }).limit(10),
    supabase.from('family_announcements').select('id, title, body, author_member_id, created_at').eq('family_id', familyId).order('created_at', { ascending: false }).limit(8),
    supabase.from('family_dates').select('title, event_date, kind').eq('family_id', familyId),
  ]);

  const memberById = new Map((members ?? []).map((m) => [m.id, m]));

  const celebrationInputs = [
    ...(members ?? []).filter((m) => m.birthday).map((m) => ({
      title: `${m.display_name}'s birthday`, date: m.birthday as string,
      daysUntil: daysUntilNext(m.birthday as string) ?? 999,
    })),
    ...(dates ?? []).map((d) => ({
      title: d.title, date: d.event_date,
      daysUntil: daysUntilNext(d.event_date) ?? 999,
    })),
  ];

  const digest = buildGrandparentDigest({
    familyName: family?.name ?? 'Your Family',
    members: (members ?? []).map((m) => ({
      name: m.display_name, birthday: m.birthday, color: m.color, role: m.role,
    })),
    photos: (photos ?? []).map((p) => ({
      url: p.url ?? '', caption: p.caption, date: p.created_at,
    })),
    milestones: (milestones ?? []).map((m) => ({
      title: m.title, description: m.description, date: m.milestone_date,
      memberName: m.member_id ? memberById.get(m.member_id)?.display_name ?? null : null,
    })),
    announcements: (announcements ?? []).map((a) => ({
      title: a.title, body: a.body,
      authorName: a.author_member_id ? memberById.get(a.author_member_id)?.display_name ?? null : null,
      date: a.created_at,
    })),
    celebrations: celebrationInputs,
  });

  return (
    <div className="mx-auto max-w-2xl space-y-8 py-4">
      <div className="text-center">
        <Heart className="mx-auto h-8 w-8 text-rose-400" />
        <h1 className="mt-2 text-2xl font-bold">{digest.familyName}</h1>
        <p className="mt-1 text-sm text-muted">{digestSummary(digest)}</p>
      </div>

      {/* Family members */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <Users className="h-4 w-4 text-brand" /> Family
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {digest.members.map((m) => (
            <div key={m.name} className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4">
              <Avatar name={m.name} color={m.color} size={40} />
              <div className="min-w-0">
                <p className="truncate font-semibold">{m.name}</p>
                <p className="text-xs capitalize text-muted">{m.role}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Recent photos */}
      {digest.recentPhotos.length > 0 && (
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
            <Camera className="h-4 w-4 text-pink-400" /> Recent Photos
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {digest.recentPhotos.map((p, i) => (
              <div key={i} className="overflow-hidden rounded-2xl border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={p.caption ?? 'Photo'} className="aspect-square w-full object-cover" />
                {p.caption && (
                  <div className="p-2">
                    <p className="truncate text-xs">{p.caption}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Milestones */}
      {digest.recentMilestones.length > 0 && (
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
            <Award className="h-4 w-4 text-amber-400" /> Milestones
          </h2>
          <ul className="space-y-2">
            {digest.recentMilestones.map((m, i) => (
              <li key={i} className="rounded-2xl border border-border bg-surface/40 p-4">
                <p className="font-semibold">{m.title}</p>
                {m.description && <p className="mt-1 text-sm text-muted">{m.description}</p>}
                <p className="mt-1 text-xs text-muted">
                  {fmtDate(m.date)}{m.memberName ? ` · ${m.memberName}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Announcements */}
      {digest.recentAnnouncements.length > 0 && (
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
            <Megaphone className="h-4 w-4 text-violet-400" /> Family Updates
          </h2>
          <ul className="space-y-2">
            {digest.recentAnnouncements.map((a, i) => (
              <li key={i} className="rounded-2xl border border-border bg-surface/40 p-4">
                <p className="font-semibold">{a.title}</p>
                {a.body && <p className="mt-1 text-sm text-fg/90">{a.body}</p>}
                <p className="mt-1 text-xs text-muted">
                  {a.authorName ?? 'Family'} · {fmtDate(a.date)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Upcoming celebrations */}
      {digest.upcomingCelebrations.length > 0 && (
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
            <Cake className="h-4 w-4 text-rose-400" /> Coming Up
          </h2>
          <ul className="space-y-2">
            {digest.upcomingCelebrations.map((c, i) => (
              <li key={i} className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface/40 p-4">
                <div>
                  <p className="font-semibold">{c.title}</p>
                  <p className="text-xs text-muted">{fmtDate(c.date)}</p>
                </div>
                <span className={`shrink-0 text-sm font-semibold ${c.daysUntil <= 7 ? 'text-brand' : 'text-muted'}`}>
                  {celebrationCountdown(c.daysUntil)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-center text-xs text-muted">
        Simplified view for grandparents and extended family
      </p>
    </div>
  );
}
