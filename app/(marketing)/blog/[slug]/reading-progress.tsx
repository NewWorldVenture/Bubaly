'use client';

import { useEffect, useState } from 'react';

export function ReadingProgress() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    function handleScroll() {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (docHeight <= 0) return;
      setProgress(Math.min(100, (scrollTop / docHeight) * 100));
    }
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <div className="fixed left-0 right-0 top-0 z-50 h-1">
      <div
        className="h-full bg-gradient-to-r from-blue-500 to-violet-600 transition-[width] duration-150"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}
