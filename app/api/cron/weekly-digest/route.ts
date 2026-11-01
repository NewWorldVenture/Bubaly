import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { briefingCalendarBounds } from '@/lib/briefing/calendar-window';
import { lastWeeklySlot, WEEKLY_DIGEST_SLOT, weeklyWindow } from '@/lib/server/cron-slot';
import { readCompleteCalendarOccurrences } from '@/lib/services/calendar/search-occurrences';
import { CALENDAR_SOURCE_ARCHIVE_ENABLED } from '@/lib/calendar/source-capability';
import { dayKeyInZone } from '@/lib/schedule/zoned';
import { addDaysToDayKey, weekStartDayKey } from '@/lib/services/scope';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { listAllAuthUsers } from '@/lib/server/list-all-auth-users';
import { readAll } from '@/lib/supabase/read-all';
import { settle, settleAll } from '@/lib/supabase/settle';
import { sendReactEmail } from '@/lib/email';
import { WeeklyDigestEmail } from '@/lib/emails/weekly-digest';
import * as React from 'react';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { loadCompareLine } from '@/lib/network/compare-line-server';
import { renderCompareLine } from '@/lib/network/compare-line';

// Runs every Monday at 08:00 UTC via Vercel Cron.
// Sends each family a summary of the week ahead: events, due chores, meal count.
//
// Budgeted and bounded, because an unbounded serial loop over every family is
// not merely slow here — it is silently unfair. The loop walks `families` in the
// same `order('id')` every week and keeps no cursor, so when the run is killed
// mid-loop the SAME prefix is served every time and the tail is never served at
// all: a stable, invisible partition of the customer base, and the families in
// it simply never receive a digest.
//
// Two changes follow from that. A declared budget, matching provider-sync,
// library-feeds and marketing, so the limit is chosen rather than inherited from
// the platform default. And bounded concurrency, because each family costs two
// to four sequential round trips plus an email API call, which serially is what
// makes the run outgrow any budget at all.
//
// If the budget is reached anyway, the run reports what it did NOT reach and
// answers 502 rather than 200 — the tail being unserved is exactly the thing
// that must not look like a clean run.
export const runtime = 'nodejs';
export const maxDuration = 300;

// Below maxDuration with room to finish the families already in flight and to
// write the response.
const BUDGET_MS = 260_000;
// Each family is mostly waiting on Supabase and the email provider, so this is
// concurrency against latency, not CPU.
const CONCURRENCY = 8;
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('weeklyDigest.unauthorized') }, { status: 401 });
  }

  const supabase = createServiceClient();

  // The occurrence this tick belongs to: the most recent Monday 08:00 UTC slot
  // at or before now, and the week that starts there (lib/server/cron-slot.ts).
  // Both schedulers fire this route at that minute, a GitHub tick can land a
  // few minutes late, and a 502 invites a replay by hand. Derived from the
  // clock, each tick rendered its own bytes and nothing folded them, so every
  // family's admin received two digests. Every tick for one slot now reads the
  // same window, renders the same bytes and sends each recipient under one
  // idempotency key, which the provider folds (as admin-digest does).
  const slot = lastWeeklySlot(new Date(), WEEKLY_DIGEST_SLOT);
  const { start: weekStart } = weeklyWindow(slot);
  const keyFor = (familyId: string, to: string) =>
    `weekly-digest/${createHash('sha256').update(`${slot.toISOString()}|${familyId}|${to}`).digest('hex')}`;

  // Every household, not the first thousand. An unbounded select is capped at
  // PostgREST's db-max-rows and says nothing, so families past that ceiling
  // would silently never receive a digest.
  const { rows: families, error: familiesError } = await readAll<{ id: string; name: string; timezone: string | null }>(
    // `timezone` is selected because the digest prints DATES. Without it every
    // date in this email is Greenwich's, and an email cannot be re-rendered the
    // way a page can be reloaded.
    // A closed account (families.closed_at) is not emailed.
    (from, to) => supabase.from('families').select('id, name, timezone').is('closed_at', null).order('id').range(from, to),
  );
  if (familiesError) {
    console.error('Weekly digest family read error:', familiesError);
    return NextResponse.json({ error: t('weeklyDigest.weeklyDigestProcessingFailed') }, { status: 500 });
  }
  if (!families?.length) return NextResponse.json({ sent: 0, failed: 0, skipped: 0 });

  // Every auth user, not GoTrue's default first 50. `listUsers()` with no
  // arguments is ONE page, and `families` above is read with readAll — so a
  // truncated recipient map silently drops the digest for every family whose
  // admin sits past that page, without counting a failure.
  const { users: allAuthUsers, error: authUsersError } = await listAllAuthUsers(supabase);
  if (authUsersError) {
    console.error('Weekly digest user read error:', authUsersError);
    return NextResponse.json({ error: t('weeklyDigest.weeklyDigestProcessingFailed') }, { status: 500 });
  }
  const emailByUserId = new Map(
    allAuthUsers.map((u) => [u.id, u.email ?? null]),
  );

  let sent = 0;
  let failed = 0;
  // A family nobody could be emailed for is neither a send nor a send failure,
  // and reporting it as neither is how this route answered 200 while most of
  // the customer base got nothing. It is NOT a failed run, though — there is
  // nothing to retry — so it is reported without turning the status into 502.
  let skipped = 0;
  // Families this run never ATTEMPTED, because the budget ran out. That one is
  // a failed run: the tail being unserved is precisely what must not look
  // clean, so it decides the status below.
  let unserved = 0;
  const startedAt = Date.now();

  const digestFor = async (family: (typeof families)[number]) => {
    // The family's own week: Monday to Sunday on their wall, the Monday on or
    // after the slot's day there. It was the seven days after the Monday 08:00
    // UTC instant, which is no family's week: Tokyo's ran Monday 17:00 to the
    // next Monday 17:00 (this Monday's morning out, next Monday's in), Honolulu's
    // began on Sunday, and the day-keyed parts (meals, all-day events) were read
    // inclusive at both ends, eight days for everyone. Every bound below is the
    // family's, end-exclusive, and depends on the slot alone, so every tick of
    // one occurrence still reads, renders and keys the same week.
    const tz = family.timezone || 'UTC';
    const dayIn = (iso: string) => dayKeyInZone(Date.parse(iso), tz) ?? iso.slice(0, 10);
    // The Monday on or after a day is the Monday on or before the day six later.
    const weekFrom = weekStartDayKey(addDaysToDayKey(dayIn(weekStart), 6));
    const weekTo = addDaysToDayKey(weekFrom, 7);
    // An open chore is an ASSIGNMENT that is still todo/in_progress. `chores` is
    // the definition table — it carries neither `status` nor `assignee_id`, so
    // reading those from it errors and skipped every family's digest. Counts,
    // not rows: only the totals are rendered.
    const [{ data: events, count: eventCount, error: eventsError }, { count: openChores, error: choresError }, { count: mealsPlanned, error: mealsError }, { data: members, error: membersError }] = await settleAll([
      // Qualify the entire native domain before the existing ten-row detail
      // cap. Source adoption remains a separate, held consumer boundary.
      (async () => {
        const unavailable = (message: string) => ({ data: null, count: null, error: { message } });
        if (CALENDAR_SOURCE_ARCHIVE_ENABLED) return unavailable('Weekly digest imported-source calendars are not supported yet.');
        // Timed rows from the family's Monday midnight to the next Monday's,
        // all-day rows by their DATE over the same seven days. The read takes
        // the closed span, a superset; the filter below is end-exclusive.
        const bounds = briefingCalendarBounds(weekFrom, tz, 0, 7);
        const result = await readCompleteCalendarOccurrences({ db: supabase, familyId: family.id, tz, userId: null, memberId: null, role: 'system', actorKind: 'system' }, { from: bounds.timedFrom, to: bounds.timedTo });
        if (!result.ok) return unavailable(result.error);
        const native = result.data.occurrences.filter(row => row.kind === 'native');
        if (native.length !== result.data.occurrences.length) return unavailable('Weekly digest requires a native calendar domain.');
        // Preserve this digest's upcoming-start selection. Qualification also
        // covers ongoing rows, without adding them to the existing list.
        const upcoming = native.filter(row => row.all_day
          ? row.startDate! >= bounds.allDayFromDay && row.startDate! < bounds.allDayToDay
          : Date.parse(row.starts_at) >= Date.parse(bounds.timedFrom) && Date.parse(row.starts_at) < Date.parse(bounds.timedTo))
          .sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.event.id.localeCompare(b.event.id));
        return { data: upcoming.slice(0, 10), count: upcoming.length, error: null };
      })(),
      supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
        .eq('family_id', family.id).in('status', ['todo', 'in_progress']),
      supabase.from('meal_plans').select('id', { count: 'exact', head: true })
        .eq('family_id', family.id)
        .gte('plan_date', weekFrom).lt('plan_date', weekTo),
      supabase.from('family_members').select('user_id, display_name').eq('family_id', family.id).eq('is_active', true),
    ]);

    const familyDataError = eventsError ?? choresError ?? mealsError ?? membersError;
    if (familyDataError) {
      console.error(`[weekly-digest] Family data read failed for ${family.id}:`, familyDataError);
      failed++;
      return;
    }

    if (!members?.length) { skipped++; return; }

    // The one parent or adult the digest goes to: the earliest to join who has
    // a login and an email on file. It was `.limit(1)` with no order, and a
    // family was skipped whenever that row had no login — a parent or adult
    // added as a managed profile — while the parent who DOES have one got
    // nothing. Unordered, the row also moved whenever a member row was
    // rewritten (a profile save updates `display_name`), so a family's digest
    // could stop, or change parent, from one Monday to the next. Ordered and
    // read whole (a family has a handful of managers), it is the same person
    // every week.
    const { data: managers, error: adminMemberError } = await supabase
      .from('family_members')
      .select('user_id, display_name')
      .eq('family_id', family.id)
      .eq('is_active', true)
      .in('role', ['parent', 'adult'])
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });

    if (adminMemberError) {
      console.error(`[weekly-digest] Admin member read failed for ${family.id}:`, adminMemberError);
      failed++;
      return;
    }

    // Only the choice of WHO. Once chosen, that person's own opt-out below
    // withholds the digest; it does not pass it to another parent.
    const adminMember = (managers ?? []).find((m) => m.user_id && emailByUserId.get(m.user_id));
    if (!adminMember?.user_id) { skipped++; return; }
    const adminEmail = emailByUserId.get(adminMember.user_id);
    if (!adminEmail) { skipped++; return; }

    // This is a personal notification preference. An absent row keeps the
    // default opt-in; an unavailable read is not permission to send. Keep the
    // failure local to this family, matching the other per-family reads above.
    const { data: preference, error: preferenceError } = await settle(supabase
      .from('user_preferences').select('email_enabled')
      .eq('user_id', adminMember.user_id).maybeSingle());
    if (preferenceError) {
      console.error(`[weekly-digest] Email preference read failed for ${family.id}:`, preferenceError);
      failed++;
      return;
    }
    if (preference && !preference.email_enabled) { skipped++; return; }

    const { ok, skipped: notSent } = await sendReactEmail({
      to: adminEmail,
      // One key per family, recipient and slot: a second tick for the same
      // occurrence is folded by the provider rather than delivered again.
      idempotencyKey: keyFor(family.id, adminEmail),
      subject: `${family.name} — your week ahead`,
      react: React.createElement(WeeklyDigestEmail, {
        familyName: family.name,
        adminName: adminMember.display_name,
        events: (events ?? []).map((e) => ({ title: e.event.title, date: e.all_day ? e.startDate! : dayIn(e.starts_at) })),
        eventCount: eventCount ?? 0,
        openChores: openChores ?? 0,
        mealsPlanned: mealsPlanned ?? 0,
        memberCount: members?.length ?? 0,
        // The "Week of …" date is the family's, not the UTC host's: the Monday
        // the counts above start on, the same on every tick of the slot.
        timeZone: tz,
        weekOf: weekFrom,
        // One "families like yours" line, only for families opted into benchmarks
        // and only from the k-anonymized rows the nightly aggregation persisted.
        compareLine: renderCompareLine(await loadCompareLine(supabase, family.id), t),
      }),
    });
    // No provider: sendReactEmail answers ok with `skipped`, and nothing was sent.
    if (notSent) skipped++;
    else if (ok) sent++;
    else failed++;
  };

  for (let i = 0; i < families.length; i += CONCURRENCY) {
    if (Date.now() - startedAt > BUDGET_MS) {
      unserved = families.length - i;
      console.error(`[weekly-digest] budget reached with ${unserved} families unserved`);
      break;
    }
    await Promise.all(families.slice(i, i + CONCURRENCY).map(digestFor));
  }

  // `unserved` counts families this run never attempted. Reporting 200 here
  // would make an unserved tail indistinguishable from a complete run. A
  // `skipped` family has no recipient to reach and nothing to retry, so it is
  // reported but does not make the run a failure.
  const ok = failed === 0 && unserved === 0;
  return NextResponse.json(
    { sent, failed, skipped, ...(unserved > 0 ? { unserved } : {}) },
    { status: ok ? 200 : 502 },
  );
}
