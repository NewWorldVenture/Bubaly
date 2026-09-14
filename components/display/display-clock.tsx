'use client';

import { useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/locale-provider';

export function DisplayClock() {
  const locale = useLocale();
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!now) return null;
  return (
    <div className="text-right">
      <div className="text-5xl font-black tabular-nums leading-none lg:text-6xl">
        {now.toLocaleTimeString(locale.code, { hour: 'numeric', minute: '2-digit' })}
      </div>
      <div className="mt-2 text-base text-white/60 lg:text-lg">
        {now.toLocaleDateString(locale.code, { weekday: 'long', month: 'long', day: 'numeric' })}
      </div>
    </div>
  );
}
