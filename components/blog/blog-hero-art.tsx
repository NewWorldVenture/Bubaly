import { getTranslations } from '@/lib/i18n/server';
// Bespoke, self-contained editorial illustration for the /blog hero — layered
// "story cards" rising out of an insight spark, over an ambient brand glow.
// No external assets (fully offline/CSP-safe). Theme-aware: card surfaces, strokes
// and text-line placeholders flip via `dark:` fill/stroke utilities, while the
// violet→indigo→blue brand gradients read cleanly on both light and dark backdrops.

export async function BlogHeroArt({ className }: { className?: string }) {
  const t = await getTranslations();
  return (
    <svg
      viewBox="0 0 420 380"
      role="img"
      aria-label={t('blogHeroArt.illustrationOfFamilyStoriesAnd')}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="bhaBrand" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8B5CF6" />
          <stop offset="0.55" stopColor="#6366F1" />
          <stop offset="1" stopColor="#3B82F6" />
        </linearGradient>
        <linearGradient id="bhaPink" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#F472B6" />
          <stop offset="1" stopColor="#A855F7" />
        </linearGradient>
        <linearGradient id="bhaSheen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.35" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.05" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="bhaGlow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#8B5CF6" stopOpacity="0.5" />
          <stop offset="0.55" stopColor="#6366F1" stopOpacity="0.18" />
          <stop offset="1" stopColor="#6366F1" stopOpacity="0" />
        </radialGradient>
        <filter id="bhaSoft" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="14" stdDeviation="20" floodColor="#4C1D95" floodOpacity="0.30" />
        </filter>
      </defs>

      {/* Ambient glow */}
      <circle cx="216" cy="188" r="162" fill="url(#bhaGlow)" />

      {/* Orbit ring */}
      <ellipse
        cx="214" cy="196" rx="172" ry="126" fill="none"
        className="stroke-slate-900/10 dark:stroke-white/10"
        strokeWidth="1.5" strokeDasharray="1 9" strokeLinecap="round"
      />

      {/* Back card (peeking) */}
      <g transform="rotate(-8 155 220)" filter="url(#bhaSoft)">
        <rect
          x="70" y="150" width="170" height="140" rx="20"
          className="fill-white dark:fill-[#161C31] stroke-slate-900/5 dark:stroke-white/10"
          strokeWidth="1" opacity="0.85"
        />
        <rect x="88" y="168" width="118" height="46" rx="11" className="fill-slate-100 dark:fill-white/[0.06]" />
        <rect x="88" y="226" width="134" height="8" rx="4" className="fill-slate-200 dark:fill-white/10" />
        <rect x="88" y="242" width="96" height="8" rx="4" className="fill-slate-200 dark:fill-white/[0.07]" />
      </g>

      {/* Front hero card */}
      <g transform="rotate(3 250 205)" filter="url(#bhaSoft)">
        <rect
          x="150" y="120" width="200" height="172" rx="24"
          className="fill-white dark:fill-[#1B2138] stroke-slate-900/[0.07] dark:stroke-white/12"
          strokeWidth="1"
        />
        {/* Thumbnail */}
        <rect x="168" y="138" width="164" height="66" rx="14" fill="url(#bhaBrand)" />
        <rect x="168" y="138" width="164" height="66" rx="14" fill="url(#bhaSheen)" />
        {/* spark inside thumbnail */}
        <path
          d="M250 155 L253.4 168.6 L267 172 L253.4 175.4 L250 189 L246.6 175.4 L233 172 L246.6 168.6 Z"
          fill="#ffffff" opacity="0.92"
        />
        {/* Category pill */}
        <rect x="168" y="218" width="70" height="19" rx="9.5" fill="url(#bhaPink)" opacity="0.92" />
        {/* Title / text lines */}
        <rect x="168" y="248" width="152" height="9" rx="4.5" className="fill-slate-300 dark:fill-white/15" />
        <rect x="168" y="264" width="112" height="9" rx="4.5" className="fill-slate-200 dark:fill-white/10" />
        {/* Author row */}
        <circle cx="176" cy="284" r="8" fill="url(#bhaBrand)" />
        <rect x="192" y="280" width="74" height="8" rx="4" className="fill-slate-200 dark:fill-white/[0.08]" />
      </g>

      {/* Insight spark orb */}
      <g filter="url(#bhaSoft)">
        <circle cx="344" cy="94" r="30" fill="url(#bhaBrand)" />
        <circle cx="344" cy="94" r="30" fill="url(#bhaSheen)" />
      </g>
      <circle cx="344" cy="94" r="39" fill="none" className="stroke-slate-900/10 dark:stroke-white/15" strokeWidth="1.5" />
      <path
        d="M344 78 L348.2 89.8 L360 94 L348.2 98.2 L344 110 L339.8 98.2 L328 94 L339.8 89.8 Z"
        fill="#ffffff" opacity="0.95"
      />

      {/* Accent sparkles + dots */}
      <path d="M300 322 L302.4 328.6 L309 331 L302.4 333.4 L300 340 L297.6 333.4 L291 331 L297.6 328.6 Z" className="fill-violet-400/70" />
      <circle cx="92" cy="120" r="5" fill="url(#bhaPink)" />
      <circle cx="120" cy="318" r="6" className="fill-violet-400/80" />
      <circle cx="374" cy="266" r="5" className="fill-blue-400/80" />
      <circle cx="78" cy="248" r="9" fill="none" className="stroke-slate-900/10 dark:stroke-white/15" strokeWidth="1.5" />
    </svg>
  );
}
