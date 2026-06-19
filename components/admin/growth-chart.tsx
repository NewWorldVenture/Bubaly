/** Real cumulative-count-by-day area chart from a list of actual creation timestamps. */
export function GrowthChart({ timestamps, days = 30 }: { timestamps: string[]; days?: number }) {
  const now = new Date();
  const dates = timestamps.map((t) => new Date(t));
  const points: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - i);
    cutoff.setHours(23, 59, 59, 999);
    points.push(dates.filter((d) => d <= cutoff).length);
  }
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
