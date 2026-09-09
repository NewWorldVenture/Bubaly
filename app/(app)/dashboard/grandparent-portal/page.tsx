import type { Metadata } from 'next';
import { Heart, Users, Camera, Award, Megaphone, Cake } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import {
  buildGrandparentDigest, digestSummary, celebrationCountdown, orderHouseholds,
  type HouseholdRef,
} from '@/lib/grandparent/digest';
import { daysUntilNext } from '@/lib/celebrations/dates';
import { fmtDate } from '@/lib/utils/format';
import { Avatar } from '@/components/ui/avatar';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Grandparent Portal' };
export const dynamic = 'force-dynamic';

type Translate = (key: string, params?: Record<string, string | number>) => string;
type Supabase = Awaited<ReturnType<typeof createServer>>;

export default async function GrandparentPortalPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  // M28: a grandparent invited into two of their children's families belongs to
  // both. The portal used to show the ACTIVE family only, so the other
  // grandchildren were one household switch away. Every membership renders,
  // through the same RLS-bound client — the database still decides what each
  // family will hand over; iterating memberships only stops the page from
  // hiding families the reader is already entitled to see.
  const households = orderHouseholds(
    ctx.memberships.map((m) => ({ familyId: m.familyId, familyName: m.family.name })),
    ctx.active.familyId,
  );
  const multi = households.length > 1;

  // Each household is read and rendered independently and a failure is confined
  // to its own card: one family's outage must not blank out the others, and it
  // must not look like that family simply has nothing to share.
  const sections = await Promise.all(
    households.map(async (household) => ({
      household,
      body: await householdBody(supabase, t, household),
    })),
  );

  return (
    <div className="mx-auto max-w-2xl space-y-8 py-4">
      <div className="text-center">
        <Heart className="mx-auto h-8 w-8 text-rose-400" />
        <h1 className="mt-2 text-2xl font-bold">
          {multi ? t('dashboardGrandparentPortal.yourFamilies') : households[0]?.familyName}
        </h1>
        {multi && (
          <p className="mt-1 text-sm text-muted">
            {t('dashboardGrandparentPortal.familiesYoureConnectedTo', { count: households.length })}
          </p>
        )}
      </div>

      {sections.map(({ household, body }) => (
        <div key={household.familyId} className="space-y-8">
          {multi && (
            <h2 className="border-b border-border pb-2 text-lg font-bold">{household.familyName}</h2>
          )}
          {body}
        </div>
      ))}

      <p className="text-center text-xs text-muted">
        {t('dashboardGrandparentPortal.simplifiedViewForGrandparentsAndExtended')}
      </p>
    </div>
  );
}

/**
 * One household's digest, or a retryable error card for that household alone.
 *
 * A plain async function rather than an async component so the whole tree is
 * resolved before it is rendered (React 18 cannot render a promise child), and
 * so a test can render the page and see every card.
 */
async function householdBody(supabase: Supabase, t: Translate, household: HouseholdRef) {
  const familyId = household.familyId;

  const [
    membersRes,
    photosRes,
    milestonesRes,
    announcementsRes,
    datesRes,
    // Settle transport failures per source so the error stays within this
    // household's card instead of rejecting the entire page's Promise.all.
  ] = await settleAll([
    supabase.from('family_members').select('id, display_name, birthday, color, role').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_photos').select('url, caption, created_at').eq('family_id', familyId).order('created_at', { ascending: false }).limit(12),
    supabase.from('family_milestones').select('id, title, description, milestone_date, member_id').eq('family_id', familyId).order('milestone_date', { ascending: false }).limit(10),
    supabase.from('family_announcements').select('id, title, body, author_member_id, created_at').eq('family_id', familyId).order('created_at', { ascending: false }).limit(8),
    supabase.from('family_dates').select('title, event_date, kind').eq('family_id', familyId),
  ]);

  // Every source contributes to the digest. A failed photo or milestone read
  // must not look like a household with nothing new to share. Log each failure
  // and render the existing retry guidance for this household alone.
  const sourceErrors = [
    ['photos', photosRes.error],
    ['milestones', milestonesRes.error],
    ['announcements', announcementsRes.error],
    ['dates', datesRes.error],
  ] as const;
  let incomplete = false;
  for (const [source, error] of sourceErrors) {
    if (error) {
      console.error(`[dashboard/grandparent-portal] ${source} read failed`, error);
      incomplete = true;
    }
  }
  if (membersRes.error) {
    console.error('[dashboard/grandparent-portal] member roster read failed', membersRes.error);
    return <ErrorState message={t('grandparentPortal.couldNotLoadYourFamily')} />;
  }
  if (incomplete) {
    return <ErrorState message={t('grandparentPortal.couldNotLoadYourFamily')} />;
  }
  const members = membersRes.data;
  const photos = photosRes.data;
  const milestones = milestonesRes.data;
  const announcements = announcementsRes.data;
  const dates = datesRes.data;

  const memberById = new Map((members ?? []).map((m) => [m.id, m]));

  const celebrationInputs = [
    ...(members ?? []).filter((m) => m.birthday).map((m) => ({
      title: t('dashboardGrandparentPortal.someonesBirthday', { name: m.display_name }),
      date: m.birthday as string,
      daysUntil: daysUntilNext(m.birthday as string) ?? 999,
    })),
    ...(dates ?? []).map((d) => ({
      title: d.title, date: d.event_date,
      daysUntil: daysUntilNext(d.event_date) ?? 999,
    })),
  ];

  const digest = buildGrandparentDigest({
    familyName: household.familyName,
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
    <div className="space-y-8">
      <p className="text-center text-sm text-muted">{digestSummary(digest)}</p>

      {/* Family members */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <Users className="h-4 w-4 text-brand-text" /> {t('dashboardGrandparentPortal.family')}
        </h2>
        <div className="grid max-h-[32rem] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3">
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
            <Camera className="h-4 w-4 text-pink-400" /> {t('dashboardGrandparentPortal.recentPhotos')}
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {digest.recentPhotos.map((p, i) => (
              <div key={i} className="overflow-hidden rounded-2xl border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={p.caption ?? t('dashboardGrandparentPortal.photo')} className="aspect-square w-full object-cover" />
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
            <Award className="h-4 w-4 text-amber-400" /> {t('dashboardGrandparentPortal.milestones')}
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
            <Megaphone className="h-4 w-4 text-violet-400" /> {t('dashboardGrandparentPortal.familyUpdates')}
          </h2>
          <ul className="space-y-2">
            {digest.recentAnnouncements.map((a, i) => (
              <li key={i} className="rounded-2xl border border-border bg-surface/40 p-4">
                <p className="font-semibold">{a.title}</p>
                {a.body && <p className="mt-1 text-sm text-fg/90">{a.body}</p>}
                <p className="mt-1 text-xs text-muted">
                  {a.authorName ?? t('dashboardGrandparentPortal.familyAuthor')} · {fmtDate(a.date)}
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
            <Cake className="h-4 w-4 text-rose-400" /> {t('dashboardGrandparentPortal.comingUp')}
          </h2>
          <ul className="space-y-2">
            {digest.upcomingCelebrations.map((c, i) => (
              <li key={i} className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface/40 p-4">
                <div>
                  <p className="font-semibold">{c.title}</p>
                  <p className="text-xs text-muted">{fmtDate(c.date)}</p>
                </div>
                <span className={`shrink-0 text-sm font-semibold ${c.daysUntil <= 7 ? 'text-brand-text' : 'text-muted'}`}>
                  {celebrationCountdown(c.daysUntil)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
