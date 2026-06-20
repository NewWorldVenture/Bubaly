'use client';

import { useEffect, useState } from 'react';

export function DisplayClock() {
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
        {now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
      </div>
      <div className="mt-2 text-base text-white/60 lg:text-lg">
        {now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
      </div>
    </div>
  );
}
