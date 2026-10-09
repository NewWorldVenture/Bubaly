import * as React from 'react';
import { APP_URL } from '@/lib/email';

export function WeeklyDigestEmail({
  familyName, adminName, events, eventCount = events.length, openChores, mealsPlanned, memberCount, compareLine = null, timeZone,
}: {
  familyName: string;
  adminName: string;
  /** `date` is a DAY KEY (YYYY-MM-DD) in the family's zone, not an instant. */
  events: { title: string; date: string }[];
  /** Exact qualifying calendar total before the detail list's display cap. */
  eventCount?: number;
  openChores: number;
  mealsPlanned: number;
  memberCount: number;
  /** "Families like yours …" — present only for benchmark-consenting families whose cohort cleared the floor. */
  compareLine?: string | null;
  /**
   * The family's IANA zone. This email is rendered by a cron on a UTC host, so
   * without it "Week of …" was Greenwich's date — tomorrow's, from 5pm in
   * California — and the host's in any other deployment.
   */
  timeZone: string;
}) {
  const today = new Date();
  const weekLabel = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone });

  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', background: '#030914', color: '#edf0f7', maxWidth: 520, margin: '40px auto', padding: 32 }}>
        <div style={{ marginBottom: 32 }}>
          <span style={{ fontSize: 24, fontWeight: 800, background: 'linear-gradient(135deg,#7c5dff,#f4996e)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            Bubaly
          </span>
        </div>

        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Good morning, {adminName}!</h1>
        <p style={{ color: '#94a0b8', marginBottom: 28 }}>Here&apos;s your {familyName} overview for the week of {weekLabel}.</p>

        <div style={{ display: 'flex', gap: 12, marginBottom: 28 }}>
          {[
            { label: 'Events', value: eventCount },
            { label: 'Open chores', value: openChores },
            { label: 'Meals planned', value: mealsPlanned },
            { label: 'Members', value: memberCount },
          ].map((s) => (
            <div key={s.label} style={{ flex: 1, background: '#091019', border: '1px solid #23364e', borderRadius: 12, padding: '14px 12px', textAlign: 'center' }}>
              <p style={{ fontSize: 24, fontWeight: 800, margin: 0, color: '#7c5dff' }}>{s.value}</p>
              <p style={{ fontSize: 11, color: '#94a0b8', margin: '2px 0 0' }}>{s.label}</p>
            </div>
          ))}
        </div>

        {events.length > 0 && (
          <div style={{ background: '#091019', border: '1px solid #23364e', borderRadius: 16, overflow: 'hidden', marginBottom: 24 }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid #23364e' }}>
              <p style={{ margin: 0, fontWeight: 700, fontSize: 13, color: '#94a0b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>This week</p>
            </div>
            {events.slice(0, 5).map((e, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: i < Math.min(events.length, 5) - 1 ? '1px solid #23364e' : undefined }}>
                <p style={{ margin: 0, fontWeight: 500 }}>{e.title}</p>
                <p style={{ margin: 0, fontSize: 12, color: '#94a0b8' }}>{/* A day key parses as UTC midnight; rendered in UTC it is that day in every zone. */}
                {new Date(e.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}</p>
              </div>
            ))}
          </div>
        )}

        {compareLine && (
          <div style={{ background: '#091019', border: '1px solid #23364e', borderRadius: 16, padding: '14px 20px', marginBottom: 24 }}>
            <p style={{ margin: 0, fontSize: 14, color: '#edf0f7' }}>{compareLine}</p>
            <p style={{ margin: '6px 0 0', fontSize: 11, color: '#94a0b8' }}>
              Aggregated from consenting families; no family is identifiable. Counts are rounded and noised on purpose.
            </p>
          </div>
        )}

        <a
          href={`${APP_URL}/dashboard`}
          style={{ display: 'inline-block', background: 'linear-gradient(135deg,#7c5dff,#6355e6)', color: '#fff', fontWeight: 700, fontSize: 16, padding: '14px 28px', borderRadius: 12, textDecoration: 'none' }}
        >
          Open Bubaly &rarr;
        </a>

        <hr style={{ borderColor: '#23364e', margin: '32px 0' }} />
        <p style={{ color: '#94a0b8', fontSize: 12 }}>
          &copy; {today.getUTCFullYear()} Bubaly &middot; You&apos;re receiving this because you&apos;re a family admin.
        </p>
      </body>
    </html>
  );
}
