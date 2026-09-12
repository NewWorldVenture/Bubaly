'use client';

// The always-on big clock for the Kitchen Display header. Ticks once a second and
// renders time + AM/PM + full date via the pure formatter (respects the family's
// 12/24h and seconds settings). Renders nothing on the server to avoid hydration
// mismatch, then fades in.
import { useEffect, useState } from 'react';
import { formatClock } from '@/lib/display/ambient';
import { displayTimezone } from '@/lib/display/calendar';
import { useLocale } from '@/components/i18n/locale-provider';

export function AmbientClock({ clock24, seconds, timezone }: { clock24: boolean; seconds: boolean; timezone?: string }) {
  const locale = useLocale();
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!now) return <div className="h-[3.5rem] w-40 animate-pulse rounded-2xl bg-white/5 sm:h-[4.5rem]" />;

  const zone = displayTimezone(timezone).timezone;
  const { time, suffix } = formatClock(now, { clock24, seconds, timezone: zone });
  return (
    <div className="animate-fade-in text-right leading-none">
      <div className="flex items-baseline justify-end gap-2">
        <span className="text-5xl font-black tabular-nums sm:text-6xl lg:text-7xl">{time}</span>
        {suffix && <span className="text-xl font-bold text-white/60 sm:text-2xl">{suffix}</span>}
      </div>
      <p className="mt-1.5 text-sm font-medium text-white/60 sm:text-base lg:text-lg">
        {now.toLocaleDateString(locale, { timeZone: zone, weekday: 'long', month: 'long', day: 'numeric' })}
      </p>
    </div>
  );
}
