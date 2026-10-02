'use client';

import { useEffect, useState } from 'react';
import { useFormat } from '@/components/i18n/use-format';

export function DisplayClock() {
  // The family's clock (TIME-003).
  const { fmtDate, fmtTime } = useFormat();
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
        {fmtTime(now)}
      </div>
      <div className="mt-2 text-base text-white/60 lg:text-lg">
        {fmtDate(now, 'EEEE, MMMM d')}
      </div>
    </div>
  );
}
