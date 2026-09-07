import * as React from 'react';

/**
 * The email a family sends a friend from the referral panel. Same transport,
 * sender and visual shell as InviteEmail (lib/emails/invite.tsx); the link is
 * the referrer's `/signup?ref=CODE` link so the friend's family is attributed
 * automatically when they finish onboarding.
 */
export function ReferralEmail({
  inviterName,
  familyName,
  code,
  link,
  rewardLabel,
}: {
  inviterName: string;
  familyName: string;
  code: string;
  link: string;
  rewardLabel: string;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', background: '#030914', color: '#edf0f7', maxWidth: 520, margin: '40px auto', padding: 32 }}>
        <div style={{ marginBottom: 32 }}>
          <span style={{ fontSize: 24, fontWeight: 800, background: 'linear-gradient(135deg,#7c5dff,#f4996e)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            Bubaly
          </span>
        </div>

        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
          {inviterName} thinks your family would like Bubaly
        </h1>
        <p style={{ color: '#94a0b8', lineHeight: 1.6, marginBottom: 24 }}>
          {inviterName} from {familyName} uses Bubaly to keep the family calendar, lists, meals and admin in one calm place — and to hand the busywork to a family assistant that actually does it. Sign up with their code and you get <strong style={{ color: '#edf0f7' }}>{rewardLabel}</strong> when you upgrade.
        </p>

        <div style={{ background: '#091019', border: '1px solid #23364e', borderRadius: 16, padding: 20, marginBottom: 24 }}>
          <p style={{ color: '#94a0b8', fontSize: 12, margin: 0, textTransform: 'uppercase', letterSpacing: 1 }}>Your referral code</p>
          <p style={{ fontSize: 22, fontWeight: 800, letterSpacing: 3, margin: '6px 0 0' }}>{code}</p>
        </div>

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
          Start your family space →
        </a>

        <p style={{ color: '#94a0b8', fontSize: 13, lineHeight: 1.6 }}>
          Free to start, no credit card. If you weren&apos;t expecting this, you can safely ignore this email.
        </p>
        <p style={{ color: '#94a0b8', fontSize: 12, marginTop: 8 }}>
          Or copy this link: <span style={{ color: '#7c5dff' }}>{link}</span>
        </p>

        <hr style={{ borderColor: '#23364e', margin: '32px 0' }} />
        <p style={{ color: '#94a0b8', fontSize: 12 }}>
          &copy; {new Date().getFullYear()} Bubaly &middot; You&apos;re receiving this because {inviterName} sent you their referral code.
        </p>
      </body>
    </html>
  );
}
