'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import Link from 'next/link';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

type SearchablePost = {
  slug: string;
  title: string;
  excerpt: string;
  category: string;
};

export function BlogSearch({ posts }: { posts: SearchablePost[] }) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (q.length < 2) return [];
    return posts
      .filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.excerpt.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q),
      )
      .slice(0, 5);
  }, [query, posts]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const showDropdown = focused && query.length >= 2;

  return (
    <div ref={containerRef} className="relative mt-7 max-w-sm">
      <div className="flex h-12 items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-4 transition focus-within:border-violet-400/50">
        <Search className="h-4 w-4 shrink-0 text-white/40" />
        <input
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-white/40 sm:text-base"
          placeholder="Search articles..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
        />
        {query && (
          <button onClick={() => setQuery('')} className="shrink-0 text-white/40 hover:text-white/70">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {showDropdown && (
        <div className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-xl border border-white/10 bg-[#0c1220] shadow-2xl">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-white/40">
              No articles found for &ldquo;{query}&rdquo;
            </div>
          ) : (
            <ul>
              {results.map((post) => (
                <li key={post.slug}>
                  <Link
                    href={`/blog/${post.slug}`}
                    className="flex flex-col gap-1 px-4 py-3 transition hover:bg-white/[0.04]"
                    onClick={() => { setFocused(false); setQuery(''); }}
                  >
                    <span className="text-sm font-semibold">{post.title}</span>
                    <span className="text-xs text-white/40">{post.category}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
