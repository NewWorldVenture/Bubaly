import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { MomentsView } from '@/components/moments/moments-view';
import { MomentOrganizer, type OrganizerMoment } from '@/components/moments/moment-organizer';
import { activeMoments, type MomentSignals } from '@/lib/moments/organizer';
import { nextBirthdayDate, daysUntil } from '@/lib/moments/birthdays';

export const metadata: Metadata = { title: 'Moments' };
export const dynamic = 'force-dynamic';

const DAY = 86_400_000;

export default async function Page() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;

  // R12: compute the life moments the family is in right now, so the page opens by
  // MOMENT (organizing layer) before the event-prep list below. Best-effort — any
  // hiccup (or a not-yet-migrated table) just hides the band.
  let organizerMoments: OrganizerMoment[] = [];
  try {
    const supabase = await createServer();
    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    const in21 = new Date(now.getTime() + 21 * DAY).toISOString();
    const tomorrowStart = new Date(now); tomorrowStart.setHours(0, 0, 0, 0); tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    const tomorrowEnd = new Date(tomorrowStart.getTime() + DAY);

    const [members, trips, holidays, homework, dismissedRows] = await settleAll([
      supabase.from('family_members').select('display_name, birthday').eq('family_id', familyId).eq('is_active', true).not('birthday', 'is', null),
      supabase.from('vacations').select('title, start_date').eq('family_id', familyId).not('start_date', 'is', null).gte('start_date', todayIso).order('start_date').limit(1),
      supabase.from('calendar_events').select('title, starts_at').eq('family_id', familyId).eq('category', 'holiday').gte('starts_at', now.toISOString()).lte('starts_at', in21).order('starts_at').limit(1),
      supabase.from('homework_assignments').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('status', 'assigned').gte('due_at', tomorrowStart.toISOString()).lt('due_at', tomorrowEnd.toISOString()),
      supabase.from('moment_activations').select('moment_key, status').eq('family_id', familyId).eq('as_of_date', todayIso),
    ]);

    // Soonest upcoming birthday.
    let birthdayInDays: number | null = null;
    let birthdayName: string | null = null;
    for (const m of members.data ?? []) {
      const next = m.birthday ? nextBirthdayDate(m.birthday, now) : null;
      if (!next) continue;
      const d = daysUntil(next, now);
      if (birthdayInDays === null || d < birthdayInDays) { birthdayInDays = d; birthdayName = (m.display_name ?? '').split(' ')[0] || null; }
    }
    const trip = (trips.data ?? [])[0];
    const tripInDays = trip?.start_date ? Math.max(0, Math.round((Date.parse(`${trip.start_date}T00:00:00Z`) - now.getTime()) / DAY)) : null;
    const holiday = (holidays.data ?? [])[0];
    const holidayInDays = holiday?.starts_at ? Math.max(0, Math.round((Date.parse(holiday.starts_at) - now.getTime()) / DAY)) : null;

    const sig: MomentSignals = {
      hour: now.getHours(), dow: now.getDay(),
      birthdayInDays, birthdayName,
      tripInDays, tripLabel: trip?.title ?? null,
      holidayInDays, holidayLabel: holiday?.title ?? null,
      homeworkDueTomorrow: homework.count ?? 0,
    };

    const dismissed = new Set(((dismissedRows.data ?? []) as { moment_key: string; status: string }[]).filter((r) => r.status === 'dismissed').map((r) => r.moment_key));
    const live = activeMoments(sig).filter((m) => !dismissed.has(m.key));

    // Log today's active moments (insert-only so a prior engaged/dismissed wins).
    if (live.length > 0) {
      await supabase.from('moment_activations').upsert(
        live.map((m) => ({ family_id: familyId, moment_key: m.key, as_of_date: todayIso, status: 'active', reason: m.reason, priority: m.priority, created_by: ctx.user.id })),
        { onConflict: 'family_id,moment_key,as_of_date', ignoreDuplicates: true },
      );
    }
    organizerMoments = live.map((m) => ({ key: m.key, label: m.label, blurb: m.blurb, reason: m.reason, capabilities: m.capabilities }));
  } catch { /* organizing band is best-effort */ }

  return (
    <div className="space-y-6">
      {organizerMoments.length > 0 && <MomentOrganizer moments={organizerMoments} />}
      <MomentsView />
    </div>
  );
}
