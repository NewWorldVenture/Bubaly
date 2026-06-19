import * as React from 'react';
import { APP_URL } from '@/lib/email';

export function WelcomeEmail({ name }: { name: string }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', background: '#030914', color: '#edf0f7', maxWidth: 520, margin: '40px auto', padding: 32 }}>
        <div style={{ marginBottom: 32 }}>
          <span style={{ fontSize: 24, fontWeight: 800, background: 'linear-gradient(135deg,#7c5dff,#f4996e)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            FamilyOS
          </span>
        </div>

        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
          Welcome to FamilyOS, {name}!
        </h1>
        <p style={{ color: '#94a0b8', lineHeight: 1.6, marginBottom: 24 }}>
          Your family&apos;s command center is ready. Start by adding your family members, scheduling events on the calendar, or asking your AI assistant to plan the week.
        </p>

        <div style={{ background: '#091019', border: '1px solid #23364e', borderRadius: 16, padding: 24, marginBottom: 24 }}>
          <p style={{ fontWeight: 700, marginBottom: 16 }}>Get started in 3 steps:</p>
          {[
            ['1', 'Invite your family', 'Settings → Members → Invite', '/dashboard/settings'],
            ['2', 'Add events to your calendar', 'Keep everyone in sync', '/dashboard/calendar'],
            ['3', 'Ask the AI assistant', 'Plan meals, chores, and more', '/dashboard/assistant'],
          ].map(([step, title, desc, href]) => (
            <div key={step} style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: '#7c5dff22', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontWeight: 700, color: '#7c5dff', fontSize: 14 }}>
                {step}
              </div>
              <div>
                <p style={{ fontWeight: 600, margin: 0 }}>{title}</p>
                <a href={`${APP_URL}${href}`} style={{ color: '#94a0b8', fontSize: 13, textDecoration: 'none' }}>{desc}</a>
              </div>
            </div>
          ))}
        </div>

        <a
          href={`${APP_URL}/dashboard`}
          style={{
            display: 'inline-block',
            background: 'linear-gradient(135deg,#7c5dff,#6355e6)',
            color: '#fff',
            fontWeight: 700,
            fontSize: 16,
            padding: '14px 28px',
            borderRadius: 12,
            textDecoration: 'none',
          }}
        >
          Open FamilyOS →
        </a>

        <hr style={{ borderColor: '#23364e', margin: '32px 0' }} />
        <p style={{ color: '#94a0b8', fontSize: 12 }}>
          © {new Date().getFullYear()} FamilyOS · Questions? Reply to this email anytime.
        </p>
      </body>
    </html>
  );
}
