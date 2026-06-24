import * as React from 'react';
import { APP_URL } from '@/lib/email';

export function ChoreReminderEmail({
  memberName,
  chores,
  familyName,
}: {
  memberName: string;
  chores: { title: string; points: number; dueAt?: string | null }[];
  familyName: string;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', background: '#030914', color: '#edf0f7', maxWidth: 520, margin: '40px auto', padding: 32 }}>
        <div style={{ marginBottom: 32 }}>
          <span style={{ fontSize: 24, fontWeight: 800, background: 'linear-gradient(135deg,#7c5dff,#f4996e)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            Bubaly
          </span>
        </div>

        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
          Hey {memberName}, you have {chores.length} chore{chores.length !== 1 ? 's' : ''} to do
        </h1>
        <p style={{ color: '#94a0b8', marginBottom: 24 }}>
          From {familyName} — complete them to earn your points!
        </p>

        <div style={{ background: '#091019', border: '1px solid #23364e', borderRadius: 16, overflow: 'hidden', marginBottom: 24 }}>
          {chores.map((c, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 20px',
              borderBottom: i < chores.length - 1 ? '1px solid #23364e' : undefined,
            }}>
              <div>
                <p style={{ margin: 0, fontWeight: 600 }}>{c.title}</p>
                {c.dueAt && <p style={{ margin: 0, fontSize: 12, color: '#94a0b8' }}>Due {new Date(c.dueAt).toLocaleDateString()}</p>}
              </div>
              <span style={{ background: '#7c5dff22', color: '#7c5dff', borderRadius: 8, padding: '4px 10px', fontSize: 13, fontWeight: 700 }}>
                +{c.points} pts
              </span>
            </div>
          ))}
        </div>

        <a
          href={`${APP_URL}/dashboard/chores`}
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
          View my chores →
        </a>

        <hr style={{ borderColor: '#23364e', margin: '32px 0' }} />
        <p style={{ color: '#94a0b8', fontSize: 12 }}>© {new Date().getFullYear()} Bubaly</p>
      </body>
    </html>
  );
}
