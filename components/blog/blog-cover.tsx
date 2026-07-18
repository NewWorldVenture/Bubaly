// Bespoke, generated blog cover art — a unique, on-brand illustration derived
// deterministically from each post's title + category. Replaces third-party stock
// hotlinks (e.g. loremflickr) so every cover is:
//   • free — owned, inline SVG, no external asset or license to clear
//   • unique — the title seeds a procedural motif, so no two posts share art
//   • duplicate-free — deterministic per-title, stable across renders
//   • self-contained — no network/CDN (CSP-safe), fast (no image request)
//   • theme-aware — vivid category gradient reads on light and dark
// Real uploaded/curated free-licensed photos still win; this fills the rest.

import type { BlogCategory } from '@/lib/blog/posts';

// Category → brand-consistent gradient stops (violet-family spine, category hue).
const CATEGORY_STOPS: Record<BlogCategory, [string, string, string]> = {
  'Parenting': ['#8B5CF6', '#6D5CF6', '#5B57E8'],
  'Organization': ['#6366F1', '#4F76F1', '#3B82F6'],
  'School & Activities': ['#10B981', '#0EA57A', '#0E9488'],
  'AI & Technology': ['#6366F1', '#7C5CF6', '#8B5CF6'],
  'Wellness': ['#F59E0B', '#F0836B', '#EC5C8D'],
  'Family Finances': ['#F43F5E', '#EC4899', '#A855F7'],
  'Recipes & Food': ['#F97316', '#F0596B', '#EF4444'],
  'Travel & Adventures': ['#06B6D4', '#22A2E0', '#3B82F6'],
  'Home & Seasonal': ['#14B8A6', '#10A5B4', '#0E96C8'],
};
const DEFAULT_STOPS: [string, string, string] = ['#8B5CF6', '#6366F1', '#3B82F6'];

// Deterministic string hash (djb2) → 32-bit unsigned seed.
function hash(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

// Tiny seeded PRNG (mulberry32) — stable, no runtime randomness.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STAR =
  (cx: number, cy: number, r: number) =>
    `M${cx} ${cy - r} L${(cx + r * 0.3).toFixed(1)} ${(cy - r * 0.3).toFixed(1)} ` +
    `L${cx + r} ${cy} L${(cx + r * 0.3).toFixed(1)} ${(cy + r * 0.3).toFixed(1)} ` +
    `L${cx} ${cy + r} L${(cx - r * 0.3).toFixed(1)} ${(cy + r * 0.3).toFixed(1)} ` +
    `L${cx - r} ${cy} L${(cx - r * 0.3).toFixed(1)} ${(cy - r * 0.3).toFixed(1)} Z`;

/**
 * Generated cover for a blog post. Fills its container (like an <img> with
 * object-fit: cover). Give the wrapper the size/rounding; this paints edge-to-edge.
 */
export function BlogCover({
  title,
  category,
  className,
  seed: seedProp,
}: {
  title: string;
  category: BlogCategory;
  className?: string;
  seed?: string;
}) {
  const seed = hash(seedProp ?? `${category}::${title}`);
  const rand = rng(seed);
  const [a, b, c] = CATEGORY_STOPS[category] ?? DEFAULT_STOPS;
  const uid = `bc${(seed % 1_000_000).toString(36)}`;

  // Focal glow position (seeded) + rotation of the abstract "story card" stack.
  const gx = 30 + rand() * 40; // %
  const gy = 20 + rand() * 40; // %
  const cardRot = -14 + rand() * 28;

  // Scattered accents: rings, dots, sparkles — count + placement seeded.
  const dots = Array.from({ length: 7 }, () => ({
    x: 20 + rand() * 380,
    y: 20 + rand() * 240,
    r: 2 + rand() * 6,
    o: 0.25 + rand() * 0.45,
  }));
  const rings = Array.from({ length: 3 }, () => ({
    x: 20 + rand() * 380,
    y: 20 + rand() * 240,
    r: 10 + rand() * 26,
    o: 0.18 + rand() * 0.28,
  }));
  const stars = Array.from({ length: 2 }, () => ({
    x: 30 + rand() * 360,
    y: 30 + rand() * 220,
    r: 7 + rand() * 8,
    o: 0.5 + rand() * 0.4,
  }));

  return (
    <svg
      viewBox="0 0 400 280"
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label={`Illustrated cover for “${title}”`}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={`${uid}bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={a} />
          <stop offset="0.55" stopColor={b} />
          <stop offset="1" stopColor={c} />
        </linearGradient>
        <radialGradient id={`${uid}glow`} cx={`${gx}%`} cy={`${gy}%`} r="0.7">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.42" />
          <stop offset="0.45" stopColor="#ffffff" stopOpacity="0.10" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${uid}sheen`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.30" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Base gradient + focal glow */}
      <rect width="400" height="280" fill={`url(#${uid}bg)`} />
      <rect width="400" height="280" fill={`url(#${uid}glow)`} />

      {/* Orbit ring (dashed) */}
      <ellipse
        cx="200" cy="140" rx="182" ry="120" fill="none"
        stroke="#ffffff" strokeOpacity="0.16" strokeWidth="1.4"
        strokeDasharray="1 10" strokeLinecap="round"
      />

      {/* Abstract "story card" stack — seeded rotation, subtle */}
      <g transform={`rotate(${cardRot.toFixed(1)} 200 150)`} opacity="0.9">
        <rect x="132" y="86" width="150" height="120" rx="18" fill="#ffffff" opacity="0.10" />
        <rect x="146" y="74" width="150" height="120" rx="18" fill="#ffffff" opacity="0.14" />
        <rect x="160" y="62" width="150" height="120" rx="18" fill="#ffffff" opacity="0.20" />
        <rect x="160" y="62" width="150" height="120" rx="18" fill={`url(#${uid}sheen)`} />
        <rect x="178" y="82" width="90" height="10" rx="5" fill="#ffffff" opacity="0.55" />
        <rect x="178" y="100" width="116" height="7" rx="3.5" fill="#ffffff" opacity="0.32" />
        <rect x="178" y="114" width="78" height="7" rx="3.5" fill="#ffffff" opacity="0.24" />
      </g>

      {/* Seeded accents */}
      {rings.map((r, i) => (
        <circle key={`r${i}`} cx={r.x.toFixed(0)} cy={r.y.toFixed(0)} r={r.r.toFixed(0)}
          fill="none" stroke="#ffffff" strokeOpacity={r.o.toFixed(2)} strokeWidth="1.4" />
      ))}
      {dots.map((d, i) => (
        <circle key={`d${i}`} cx={d.x.toFixed(0)} cy={d.y.toFixed(0)} r={d.r.toFixed(1)}
          fill="#ffffff" fillOpacity={d.o.toFixed(2)} />
      ))}
      {stars.map((s, i) => (
        <path key={`s${i}`} d={STAR(s.x, s.y, s.r)} fill="#ffffff" fillOpacity={s.o.toFixed(2)} />
      ))}

      {/* Bottom scrim for overlaid text legibility */}
      <rect width="400" height="280" fill={`url(#${uid}bg)`} opacity="0" />
      <linearGradient id={`${uid}scrim`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0.5" stopColor="#000000" stopOpacity="0" />
        <stop offset="1" stopColor="#000000" stopOpacity="0.32" />
      </linearGradient>
      <rect width="400" height="280" fill={`url(#${uid}scrim)`} />
    </svg>
  );
}
