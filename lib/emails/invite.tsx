import * as React from 'react';
import { APP_URL } from '@/lib/email';

export function InviteEmail({
  familyName,
  inviterName,
  token,
  role,
}: {
  familyName: string;
  inviterName: string;
  token: string;
  role: string;
}) {
  const link = `${APP_URL}/join?token=${token}`;
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', background: '#030914', color: '#edf0f7', maxWidth: 520, margin: '40px auto', padding: 32 }}>
        <div style={{ marginBottom: 32 }}>
          <span style={{ fontSize: 24, fontWeight: 800, background: 'linear-gradient(135deg,#7c5dff,#f4996e)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            FamilyOS
          </span>
        </div>

        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
          You&apos;ve been invited to join {familyName}
        </h1>
        <p style={{ color: '#94a0b8', lineHeight: 1.6, marginBottom: 24 }}>
          {inviterName} has invited you to join their family on FamilyOS as a <strong style={{ color: '#edf0f7' }}>{role}</strong>. FamilyOS helps families coordinate schedules, chores, meals, and more — all in one place.
        </p>

        <a
          href={link}
          style={{
            display: 'inline-block',
            background: 'linear-gradient(135deg,#7c5dff,#6355e6)',
            color: '#fff',
            fontWeight: 700,
            fontSize: 16,
            padding: '14px 28px',
            borderRadius: 12,
            textDecoration: 'none',
            marginBottom: 24,
          }}
        >
          Accept invitation →
        </a>

        <p style={{ color: '#94a0b8', fontSize: 13, lineHeight: 1.6 }}>
          This invitation expires in 14 days. If you weren&apos;t expecting this, you can safely ignore this email.
        </p>
        <p style={{ color: '#94a0b8', fontSize: 12, marginTop: 8 }}>
          Or copy this link: <span style={{ color: '#7c5dff' }}>{link}</span>
        </p>

        <hr style={{ borderColor: '#23364e', margin: '32px 0' }} />
        <p style={{ color: '#94a0b8', fontSize: 12 }}>
          &copy; {new Date().getFullYear()} FamilyOS &middot; You&apos;re receiving this because someone invited you.
        </p>
      </body>
    </html>
  );
}
