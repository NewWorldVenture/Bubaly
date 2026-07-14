'use client';

// Echo-style rotating hint bar pinned to the bottom of the display: one
// glanceable, data-driven line at a time ("🍽️ Dinner tonight: Chicken Tacos"),
// crossfading every 8 seconds. Hints come from the pure `buildHints` engine so
// the bar always has something useful (or a friendly tip) to say.
import { useEffect, useState } from 'react';

export function HintsTicker({ hints }: { hints: string[] }) {
  const [i, setI] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (hints.length < 2) return;
    const id = setInterval(() => {
      setVisible(false);
      setTimeout(() => { setI((v) => (v + 1) % hints.length); setVisible(true); }, 400);
    }, 8000);
    return () => clearInterval(id);
  }, [hints.length]);

  if (hints.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center pb-4">
      <p
        aria-live="polite"
        className="max-w-[92%] truncate rounded-full bg-black/45 px-5 py-2 text-sm font-medium text-white/85 shadow-lg backdrop-blur-xl transition-opacity duration-400"
        style={{ opacity: visible ? 1 : 0 }}
      >
        {hints[i % hints.length]}
      </p>
    </div>
  );
}
