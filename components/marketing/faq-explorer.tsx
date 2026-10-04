'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight, BookOpen, CalendarDays, Check, CreditCard, Link2, MessageCircleQuestion, Rocket, Search,
  ShieldCheck, Smartphone, Sparkles, Users, X, type LucideIcon, Baby,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { usePlural, useTranslations } from '@/components/i18n/locale-provider';

/** A link under an answer, to the page that says more. */
export type FaqLink = { href: string; label: string };

/** One question. `id` is its anchor on the page — /faq#<id> opens it. */
export type FaqEntry = { id: string; q: string; a: string; links?: FaqLink[] };

/** The icons a topic may wear. Names, not components: this crosses the server boundary. */
export type FaqIcon = 'start' | 'ai' | 'privacy' | 'family' | 'kids' | 'calendar' | 'pricing' | 'devices' | 'knowledge';

/** A topic is a section of the page, a card in the topic grid and an entry in the side nav. */
export type FaqTopic = { id: string; label: string; blurb: string; icon: FaqIcon; items: FaqEntry[] };

const ICONS: Record<FaqIcon, LucideIcon> = {
  start: Rocket,
  ai: Sparkles,
  privacy: ShieldCheck,
  family: Users,
  kids: Baby,
  calendar: CalendarDays,
  pricing: CreditCard,
  devices: Smartphone,
  knowledge: BookOpen,
};

// Matches the header that sits over the page: a heading counts as "current"
// once it has scrolled up under the header and until it is 40% down the view.
const SCROLL_SPY_MARGIN = '-96px 0px -60% 0px';

/** Case- and accent-insensitive form used for matching, never for display. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function termsOf(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

function matches(text: string, terms: string[]): boolean {
  const folded = fold(text);
  return terms.every((term) => folded.includes(term));
}

/**
 * Wraps each occurrence of a search term in <mark>. Matching runs on the
 * folded text, which has the same length as the original for every Latin
 * script this site ships in once combining marks are stripped per character,
 * so the slices below land on the same characters the reader sees.
 */
function highlight(text: string, terms: string[]): ReactNode {
  if (terms.length === 0) return text;
  const folded = Array.from(text, (ch) => fold(ch) || ch).join('');
  if (folded.length !== text.length) return text;
  const ranges: [number, number][] = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(term, from);
      if (at === -1) break;
      ranges.push([at, at + term.length]);
      from = at + term.length;
    }
  }
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([start, end], index) => {
    if (start > cursor) parts.push(<Fragment key={`t${index}`}>{text.slice(cursor, start)}</Fragment>);
    parts.push(
      <mark key={`m${index}`} className="rounded bg-violet-500/25 px-0.5 text-inherit">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(<Fragment key="tail">{text.slice(cursor)}</Fragment>);
  return parts;
}

/**
 * The FAQ's interactive body: live search, a topic grid, a sticky topic nav
 * with scroll-spy, and one disclosure per question.
 *
 * Every answer is in the server-rendered HTML. Questions are native
 * <details> elements, so they open without JavaScript, the browser's own
 * find-in-page reaches a closed answer, and search engines read every answer
 * the FAQPage structured data names. Script adds the search, deep links and
 * the copy-link control on top.
 */
export function FaqExplorer({ topics, popular }: { topics: FaqTopic[]; popular: string[] }) {
  const t = useTranslations();
  const plural = usePlural();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  // A reader's own open/closed choices. Searching starts a fresh set, so a
  // question opened for one search does not stay open under the next.
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [activeTopic, setActiveTopic] = useState<string>(topics[0]?.id ?? '');

  const terms = useMemo(() => termsOf(query), [query]);
  const searching = terms.length > 0;

  const byId = useMemo(() => {
    const index = new Map<string, FaqEntry>();
    for (const topic of topics) for (const item of topic.items) index.set(item.id, item);
    return index;
  }, [topics]);

  const visible = useMemo(() => {
    if (!searching) return topics;
    return topics
      .map((topic) => ({ ...topic, items: topic.items.filter((item) => matches(`${item.q} ${item.a}`, terms)) }))
      .filter((topic) => topic.items.length > 0);
  }, [topics, terms, searching]);

  const total = useMemo(() => topics.reduce((sum, topic) => sum + topic.items.length, 0), [topics]);
  const resultCount = useMemo(() => visible.reduce((sum, topic) => sum + topic.items.length, 0), [visible]);

  // A question that matched only in its answer opens by itself, so the reader
  // can see why it is in the results.
  const answerOnly = useMemo(() => {
    const ids = new Set<string>();
    if (!searching) return ids;
    for (const topic of visible) {
      for (const item of topic.items) if (!matches(item.q, terms)) ids.add(item.id);
    }
    return ids;
  }, [visible, terms, searching]);

  const isOpen = (id: string) => (id in choices ? choices[id] : answerOnly.has(id));

  const setOpen = useCallback((id: string, open: boolean) => {
    setChoices((prev) => (prev[id] === open ? prev : { ...prev, [id]: open }));
  }, []);

  const updateQuery = (next: string) => {
    setQuery(next);
    setChoices({});
  };

  // Keep ?q= in the address bar so a search can be shared, and read it back on arrival.
  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('q');
    if (initial) setQuery(initial);
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (query.trim()) url.searchParams.set('q', query.trim());
    else url.searchParams.delete('q');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [query]);

  // /faq#<question-id> opens that question and brings it into view.
  useEffect(() => {
    const openFromHash = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id || !byId.has(id)) return;
      setOpen(id, true);
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    return () => window.removeEventListener('hashchange', openFromHash);
  }, [byId, setOpen]);

  // "/" jumps to the search field from anywhere on the page, as on most help centres.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Scroll-spy for the side nav.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const shown = entries.filter((entry) => entry.isIntersecting);
        if (shown.length > 0) setActiveTopic(shown[0].target.id.replace(/^topic-/, ''));
      },
      { rootMargin: SCROLL_SPY_MARGIN },
    );
    for (const topic of visible) {
      const heading = document.getElementById(`topic-${topic.id}`);
      if (heading) observer.observe(heading);
    }
    return () => observer.disconnect();
  }, [visible]);

  const copyLink = async (id: string) => {
    const url = `${window.location.origin}${window.location.pathname}#${id}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // No clipboard (an insecure context or a denied permission): the address
      // bar is the next best place to leave the link.
    }
    window.history.replaceState(window.history.state, '', `#${id}`);
    setCopied(id);
    window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 2000);
  };

  const visibleIds = visible.flatMap((topic) => topic.items.map((item) => item.id));
  const allOpen = visibleIds.length > 0 && visibleIds.every((id) => isOpen(id));
  const toggleAll = () => {
    const next = !allOpen;
    setChoices((prev) => {
      const out = { ...prev };
      for (const id of visibleIds) out[id] = next;
      return out;
    });
  };

  const popularEntries = popular.map((id) => byId.get(id)).filter((item): item is FaqEntry => Boolean(item));

  return (
    <div>
      {/* Search */}
      <div className="mx-auto mt-10 max-w-2xl">
        <form role="search" onSubmit={(event) => event.preventDefault()} className="relative">
          <label htmlFor="faq-search" className="sr-only">{t('faqExplorer.searchLabel')}</label>
          <Search className="pointer-events-none absolute left-5 top-1/2 h-5 w-5 -translate-y-1/2 text-white/50" aria-hidden />
          <input
            ref={searchRef}
            id="faq-search"
            type="search"
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') updateQuery(''); }}
            placeholder={t('faqExplorer.searchPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="faq-search-status"
            className="h-14 w-full rounded-2xl border border-white/15 bg-white/[0.045] pl-14 pr-14 text-base text-white shadow-[0_18px_50px_rgba(76,52,180,0.18)] outline-none backdrop-blur transition placeholder:text-muted focus:border-violet-400/60 focus:ring-4 focus:ring-violet-500/20 sm:h-16 sm:text-lg [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              onClick={() => { updateQuery(''); searchRef.current?.focus(); }}
              className="absolute right-3 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-xl text-white/60 transition hover:bg-white/[0.07] hover:text-white focus-ring"
            >
              <X className="h-5 w-5" aria-hidden />
              <span className="sr-only">{t('faqExplorer.clearSearch')}</span>
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-5 top-1/2 hidden -translate-y-1/2 rounded-md border border-white/15 px-2 py-0.5 font-mono text-xs text-white/65 sm:block" aria-hidden>/</kbd>
          )}
        </form>
        <p id="faq-search-status" role="status" aria-live="polite" className="mt-3 min-h-5 text-center text-sm text-white/60">
          {searching
            ? plural('faqExplorer.resultCount', resultCount, { query: query.trim() })
            : plural('faqExplorer.answerCount', total, { topics: topics.length })}
        </p>
        {!searching && popularEntries.length > 0 && (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-widest text-white/65">{t('faqExplorer.popular')}</span>
            {popularEntries.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className="inline-flex min-h-9 items-center rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-sm text-white/80 transition hover:border-violet-400/40 hover:bg-white/[0.06] hover:text-white focus-ring"
              >
                {item.q}
              </a>
            ))}
          </div>
        )}
      </div>

      {/* Topic grid — browsing, before reading */}
      {!searching && (
        <nav aria-label={t('faqExplorer.browseByTopic')} className="mt-16">
          <h2 className="text-center text-xs font-semibold uppercase tracking-[0.2em] text-white/65">{t('faqExplorer.browseByTopic')}</h2>
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {topics.map((topic) => {
              const Icon = ICONS[topic.icon];
              return (
                <li key={topic.id}>
                  <a
                    href={`#topic-${topic.id}`}
                    className="group flex h-full items-start gap-4 rounded-2xl border border-white/8 bg-white/[0.025] p-5 transition hover:-translate-y-0.5 hover:border-violet-400/35 hover:bg-white/[0.045] focus-ring"
                  >
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-white/10 bg-gradient-to-br from-blue-500/15 to-violet-600/20">
                      <Icon className="h-5 w-5 text-brand-text" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-3">
                        <span className="font-bold text-white">{topic.label}</span>
                        <ArrowRight className="h-4 w-4 shrink-0 text-white/40 transition group-hover:translate-x-0.5 group-hover:text-brand-text" aria-hidden />
                      </span>
                      <span className="mt-1 block text-sm leading-6 text-white/60">{topic.blurb}</span>
                      <span className="mt-3 block text-xs font-semibold text-white/65">{plural('faqExplorer.topicCount', topic.items.length)}</span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      )}

      {/* Reading: side nav + every answer */}
      <div className={cn('grid gap-10 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-14', searching ? 'mt-10' : 'mt-20')}>
        <aside className="hidden lg:block">
          <nav aria-label={t('faqExplorer.topicsNav')} className="sticky top-24">
            <p className="px-3 text-xs font-semibold uppercase tracking-[0.2em] text-white/65">{t('faqExplorer.topicsNav')}</p>
            <ul className="mt-3 space-y-1">
              {visible.map((topic) => {
                const Icon = ICONS[topic.icon];
                const current = topic.id === activeTopic;
                return (
                  <li key={topic.id}>
                    <a
                      href={`#topic-${topic.id}`}
                      aria-current={current ? 'location' : undefined}
                      className={cn(
                        'flex min-h-10 items-center gap-3 rounded-xl px-3 py-2 text-sm transition focus-ring',
                        current ? 'bg-white/[0.06] font-semibold text-white' : 'text-white/60 hover:bg-white/[0.03] hover:text-white',
                      )}
                    >
                      <Icon className={cn('h-4 w-4 shrink-0', current ? 'text-brand-text' : 'text-white/40')} aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{topic.label}</span>
                      <span className="text-xs tabular-nums text-white/65">{topic.items.length}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
            <Link
              href="/contact"
              className="mt-6 flex items-start gap-3 rounded-2xl border border-white/8 bg-white/[0.025] p-4 text-sm transition hover:bg-white/[0.045] focus-ring"
            >
              <MessageCircleQuestion className="mt-0.5 h-5 w-5 shrink-0 text-brand-text" aria-hidden />
              <span>
                <span className="block font-semibold text-white">{t('faqExplorer.sideAskTitle')}</span>
                <span className="mt-1 block leading-5 text-white/60">{t('faqExplorer.sideAskBody')}</span>
              </span>
            </Link>
          </nav>
        </aside>

        <div className="min-w-0">
          {visible.length > 0 && (
            <div className="mb-6 flex justify-end">
              <button
                type="button"
                onClick={toggleAll}
                className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-white/10 px-3.5 py-2 text-sm font-semibold text-white/75 transition hover:bg-white/[0.045] hover:text-white focus-ring"
              >
                {allOpen ? t('faqExplorer.collapseAll') : t('faqExplorer.expandAll')}
              </button>
            </div>
          )}

          {visible.length === 0 && (
            <div className="rounded-3xl border border-white/8 bg-white/[0.025] px-6 py-14 text-center">
              <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-white/[0.04]">
                <Search className="h-6 w-6 text-brand-text" aria-hidden />
              </span>
              <h2 className="mt-5 text-xl font-bold">{t('faqExplorer.noResultsTitle', { query: query.trim() })}</h2>
              <p className="mx-auto mt-2 max-w-md text-white/65">{t('faqExplorer.noResultsBody')}</p>
              <div className="mt-6 flex flex-wrap justify-center gap-3">
                <button
                  type="button"
                  onClick={() => { updateQuery(''); searchRef.current?.focus(); }}
                  className="inline-flex min-h-11 items-center rounded-xl border border-white/15 px-5 py-2.5 text-sm font-bold transition hover:bg-white/[0.06] focus-ring"
                >
                  {t('faqExplorer.clearSearch')}
                </button>
                <Link
                  href="/contact"
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-5 py-2.5 text-sm font-bold text-brand-fg shadow-glow transition hover:-translate-y-0.5 focus-ring"
                >
                  {t('faqExplorer.askUs')}{' '}<ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </div>
            </div>
          )}

          <div className="space-y-16">
            {visible.map((topic) => {
              const Icon = ICONS[topic.icon];
              return (
                <section key={topic.id} aria-labelledby={`topic-${topic.id}`}>
                  <div className="flex items-start gap-4">
                    <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-white/10 bg-gradient-to-br from-blue-500/15 to-violet-600/20">
                      <Icon className="h-6 w-6 text-brand-text" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <h2 id={`topic-${topic.id}`} className="scroll-mt-28 text-2xl font-black tracking-tight sm:text-3xl">{topic.label}</h2>
                      <p className="mt-1 text-white/60">{topic.blurb}</p>
                    </div>
                  </div>
                  <div className="mt-6 space-y-3">
                    {topic.items.map((item) => {
                      const open = isOpen(item.id);
                      return (
                        <details
                          key={item.id}
                          id={item.id}
                          open={open}
                          onToggle={(event) => setOpen(item.id, event.currentTarget.open)}
                          className={cn(
                            'group scroll-mt-28 rounded-2xl border transition-colors',
                            open ? 'border-violet-400/30 bg-white/[0.045]' : 'border-white/8 bg-white/[0.025] hover:border-white/15 hover:bg-white/[0.035]',
                          )}
                        >
                          <summary className="flex min-h-14 cursor-pointer list-none items-center gap-4 rounded-2xl px-5 py-4 text-left focus-ring [&::-webkit-details-marker]:hidden">
                            <span className="min-w-0 flex-1 text-base font-semibold leading-7 text-white sm:text-[17px]">{highlight(item.q, terms)}</span>
                            <span className={cn(
                              'grid h-8 w-8 shrink-0 place-items-center rounded-full border transition',
                              open ? 'rotate-45 border-violet-400/40 bg-violet-500/15 text-brand-text' : 'border-white/15 text-white/60',
                            )} aria-hidden>
                              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
                            </span>
                          </summary>
                          <div className="px-5 pb-5">
                            <p className="max-w-3xl text-[15px] leading-7 text-white/75">{highlight(item.a, terms)}</p>
                            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/8 pt-4">
                              {item.links?.map((link) => (
                                <Link
                                  key={link.href}
                                  href={link.href}
                                  className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-500/10 px-3.5 py-1.5 text-sm font-semibold text-brand-text transition hover:bg-violet-500/20 focus-ring"
                                >
                                  {link.label}<ArrowRight className="h-3.5 w-3.5" aria-hidden />
                                </Link>
                              ))}
                              <button
                                type="button"
                                onClick={() => copyLink(item.id)}
                                className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-white/70 transition hover:bg-white/[0.045] hover:text-white focus-ring"
                              >
                                {copied === item.id
                                  ? <><Check className="h-4 w-4 text-emerald-400" aria-hidden />{t('faqExplorer.linkCopied')}</>
                                  : <><Link2 className="h-4 w-4" aria-hidden />{t('faqExplorer.copyLink')}</>}
                              </button>
                            </div>
                          </div>
                        </details>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
