import * as React from 'react';
import { APP_URL } from '@/lib/email';

export type DigestItem = { title: string; body: string | null; icon: string };

/** Daily roll-up of a member's pending FamilyOS notifications. */
export function NotificationDigestEmail({
  name, items,
}: {
  name: string;
  items: DigestItem[];
}) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const count = items.length;

  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', background: '#030914', color: '#edf0f7', maxWidth: 520, margin: '40px auto', padding: 32 }}>
        <div style={{ marginBottom: 28 }}>
          <span style={{ fontSize: 24, fontWeight: 800, background: 'linear-gradient(135deg,#7c5dff,#f4996e)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            FamilyOS
          </span>
        </div>

        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
          {count} thing{count > 1 ? 's' : ''} need{count > 1 ? '' : 's'} your attention
        </h1>
        <p style={{ color: '#94a0b8', marginBottom: 28 }}>Hi {name} — here&apos;s what&apos;s coming up for {today}.</p>

        <div style={{ background: '#091019', border: '1px solid #23364e', borderRadius: 16, overflow: 'hidden', marginBottom: 28 }}>
          {items.slice(0, 20).map((it, i) => (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 20px',
                borderBottom: i < Math.min(items.length, 20) - 1 ? '1px solid #23364e' : undefined,
              }}
            >
              <span style={{ fontSize: 18, lineHeight: '22px' }}>{it.icon}</span>
              <div>
                <p style={{ margin: 0, fontWeight: 600 }}>{it.title}</p>
                {it.body && <p style={{ margin: '2px 0 0', fontSize: 13, color: '#94a0b8' }}>{it.body}</p>}
              </div>
            </div>
          ))}
        </div>

        <a
          href={`${APP_URL}/dashboard/notifications`}
          style={{ display: 'inline-block', background: 'linear-gradient(135deg,#7c5dff,#6355e6)', color: '#fff', fontWeight: 700, fontSize: 16, padding: '14px 28px', borderRadius: 12, textDecoration: 'none' }}
        >
          Open FamilyOS
        </a>

        <p style={{ color: '#5b6578', fontSize: 12, marginTop: 32 }}>
          You&apos;re getting this because email notifications are on. Turn them off any time in Settings → Notifications.
        </p>
      </body>
    </html>
  );
}
