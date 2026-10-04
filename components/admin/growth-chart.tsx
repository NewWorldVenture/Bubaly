import { lastUtcDays } from '@/lib/admin/clock';

/** Real cumulative-count-by-day area chart from a list of actual creation timestamps. */
export function GrowthChart({ timestamps, days = 30 }: { timestamps: string[]; days?: number }) {
  // Cumulative count at the END of each of the last `days` whole admin-zone
  // days (lib/admin/clock.ts). The rolling host-midnight cutoffs this replaced
  // drew a different curve on every host.
  const dates = timestamps.map((t) => new Date(t).getTime());
  const points = lastUtcDays(days).map((w) => dates.filter((t) => t < w.end).length);
  const max = Math.max(...points, 1);
  const w = 600, h = 160;
  const path = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i / (points.length - 1)) * w} ${h - (v / max) * (h - 10) - 5}`)
    .join(' ');
  const areaPath = `${path} L ${w} ${h} L 0 ${h} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-40 w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="growthFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7c5dff" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#7c5dff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#growthFill)" />
      <path d={path} fill="none" stroke="#7c5dff" strokeWidth="2" />
    </svg>
  );
}
