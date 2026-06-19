import * as React from 'react';
import { APP_URL } from '@/lib/email';

export function WeeklyDigestEmail({
  familyName, adminName, events, openChores, mealsPlanned, memberCount,
}: {
  familyName: string;
  adminName: string;
  events: { title: string; date: string }[];
  openChores: number;
  mealsPlanned: number;
  memberCount: number;
}) {
  const today = new Date();
  const weekLabel = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', background: '#030914', color: '#edf0f7', maxWidth: 520, margin: '40px auto', padding: 32 }}>
        <div style={{ marginBottom: 32 }}>
          <span style={{ fontSize: 24, fontWeight: 800, background: 'linear-gradient(135deg,#7c5dff,#f4996e)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            FamilyOS
          </span>
        </div>

        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Good morning, {adminName}!</h1>
        <p style={{ color: '#94a0b8', marginBottom: 28 }}>Here&apos;s your {familyName} overview for the week of {weekLabel}.</p>

        <div style={{ display: 'flex', gap: 12, marginBottom: 28 }}>
          {[
            { label: 'Events', value: events.length },
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
                <p style={{ margin: 0, fontSize: 12, color: '#94a0b8' }}>{new Date(e.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</p>
              </div>
            ))}
          </div>
        )}

        <a
          href={`${APP_URL}/dashboard`}
          style={{ display: 'inline-block', background: 'linear-gradient(135deg,#7c5dff,#6355e6)', color: '#fff', fontWeight: 700, fontSize: 16, padding: '14px 28px', borderRadius: 12, textDecoration: 'none' }}
        >
          Open FamilyOS &rarr;
        </a>

        <hr style={{ borderColor: '#23364e', margin: '32px 0' }} />
        <p style={{ color: '#94a0b8', fontSize: 12 }}>
          &copy; {today.getFullYear()} FamilyOS &middot; You&apos;re receiving this because you&apos;re a family admin.
        </p>
      </body>
    </html>
  );
}
