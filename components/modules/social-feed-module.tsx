'use client';

// Social Feed — "All your social feeds. One place." A calm, ad-free consumption
// feed mirroring the product mock: platform source chips, a filterable feed
// (All/Favorites/Family/Friends/Groups), and a right rail (Your Sources /
// Activity / Quick Filters). 100% wired to Supabase via the server actions.
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus, Search, MoreHorizontal, Bookmark, Filter, Play, Star, Heart, Video,
  Image as ImageIcon, Link2, BadgeCheck, X, Rss, Trash2, Sparkles, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import {
  PLATFORMS, platformMeta, platformLabel, buildFeed, quickFilterCounts,
  type FeedTab, type QuickFilter,
} from '@/lib/social/feed';
import {
  addSourceAction, removeSourceAction, toggleFavoriteAction, markReadAction, markAllReadAction,
  addByUrlAction,
} from '@/app/(app)/dashboard/social-feed/actions';

export type FeedSource = { id: string; platform: string; displayName: string; handle: string | null; accountCount: number; category: string };
export type FeedItem = {
  id: string; platform: string; authorName: string; authorHandle: string | null; avatarUrl: string | null;
  content: string | null; mediaUrls: string[]; thumbnailUrl: string | null; permalink: string | null;
  kind: 'post' | 'video' | 'photo' | 'link'; durationLabel: string | null; category: string;
  verified: boolean; isFavorite: boolean; isRead: boolean; postedAt: string;
};

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'now';
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h`;
  const d = h / 24; if (d < 7) return `${Math.floor(d)}d`;
  return `${Math.floor(d / 7)}w`;
}

/** Brand-tinted platform glyph (initial in a tinted ring — no brand SVGs needed). */
function PlatformGlyph({ platform, size = 'md' }: { platform: string; size?: 'sm' | 'md' }) {
  const m = platformMeta(platform);
  const dim = size === 'sm' ? 'h-7 w-7 text-[11px]' : 'h-10 w-10 text-sm';
  return (
    <span className={cn('inline-flex flex-shrink-0 items-center justify-center rounded-xl border border-border bg-surface font-bold', m.tint, dim)}
      title={m.label} aria-label={m.label}>
      {m.label.slice(0, 1)}
    </span>
  );
}

const TABS: { key: FeedTab; label: string }[] = [
  { key: 'all', label: 'All Feeds' },
  { key: 'favorites', label: 'Favorites' },
  { key: 'family', label: 'Family' },
  { key: 'friends', label: 'Friends' },
  { key: 'groups', label: 'Groups' },
];

const QUICK: { key: QuickFilter; label: string; icon: typeof Star }[] = [
  { key: 'unread', label: 'Unread', icon: Rss },
  { key: 'favorites', label: 'Favorites', icon: Heart },
  { key: 'videos', label: 'Videos', icon: Video },
  { key: 'photos', label: 'Photos', icon: ImageIcon },
  { key: 'links', label: 'Links', icon: Link2 },
];

export function SocialFeedModule({ sources, items }: { sources: FeedSource[]; items: FeedItem[] }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [tab, setTab] = useState<FeedTab>('all');
  const [quick, setQuick] = useState<QuickFilter | null>(null);
  const [query, setQuery] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const counts = useMemo(() => quickFilterCounts(items.map((i) => ({
    kind: i.kind, category: i.category as 'family' | 'friends' | 'groups' | 'other',
    is_favorite: i.isFavorite, is_read: i.isRead, media_urls: i.mediaUrls, posted_at: i.postedAt,
  }))), [items]);

  const feed = useMemo(() => {
    const base = buildFeed(
      items.map((i) => ({ ...i, is_favorite: i.isFavorite, is_read: i.isRead, media_urls: i.mediaUrls, posted_at: i.postedAt })) as never[],
      tab, quick,
    ) as unknown as FeedItem[];
    const q = query.trim().toLowerCase();
    return q ? base.filter((i) => `${i.authorName} ${i.authorHandle ?? ''} ${i.content ?? ''}`.toLowerCase().includes(q)) : base;
  }, [items, tab, quick, query]);

  // Group sources by platform for the "Your Sources" rail.
  const sourcesByPlatform = useMemo(() => {
    const map = new Map<string, { count: number; accounts: number }>();
    for (const s of sources) {
      const cur = map.get(s.platform) ?? { count: 0, accounts: 0 };
      cur.count += 1; cur.accounts += s.accountCount; map.set(s.platform, cur);
    }
    return map;
  }, [sources]);

  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string) {
    setBusy(key);
    const res = await fn();
    setBusy(null);
    if (!res.ok) return toastError(res.error ?? 'Something went wrong');
    if (ok) success(ok);
    router.refresh();
  }

  async function addLink() {
    const url = linkUrl.trim();
    if (!url) return;
    setBusy('addlink');
    const res = await addByUrlAction({ url });
    setBusy(null);
    if (!res.ok) return toastError(res.error ?? 'Could not add that link');
    setLinkUrl('');
    success('Added to your feed');
    router.refresh();
  }

  const empty = sources.length === 0 && items.length === 0;

  return (
    <div>
      {/* Hero header (mirrors the mock's title + platform row) */}
      <div className="text-center">
        <h1 className="text-2xl font-bold sm:text-3xl">All your social feeds. <span className="gradient-text">One place.</span></h1>
        <p className="mx-auto mt-1 max-w-xl text-sm text-muted">Collect, organize, and enjoy content from all your favorite social media in one beautiful, ad-free feed for your family.</p>
      </div>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {PLATFORMS.map((p) => (
          <button key={p.key} type="button" onClick={() => setShowAdd(true)}
            className="flex flex-col items-center gap-1 rounded-xl p-1.5 hover:bg-elevated" title={`Add ${p.label}`}>
            <PlatformGlyph platform={p.key} />
            <span className="text-[10px] text-muted">{p.label}</span>
          </button>
        ))}
        <button type="button" onClick={() => setShowAdd(true)} className="flex flex-col items-center gap-1 rounded-xl p-1.5 hover:bg-elevated">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-dashed border-border text-muted"><Plus className="h-4 w-4" /></span>
          <span className="text-[10px] text-muted">More</span>
        </button>
      </div>

      {showAdd && <AddSourcePanel busy={busy} onClose={() => setShowAdd(false)} onAdd={(p, name, handle, cat) => run('add', () => addSourceAction({ platform: p, displayName: name, handle, category: cat }), 'Source added').then(() => setShowAdd(false))} />}

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        {/* ── Main feed column ── */}
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-surface/40 p-3">
            <div>
              <h2 className="font-semibold">Social Feed</h2>
              <p className="text-xs text-muted">Your all-in-one collection from across the web</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                <input value={query} inputMode="search" enterKeyHint="search" onChange={(e) => setQuery(e.target.value)} placeholder="Search feed"
                  className="h-9 w-36 rounded-lg border border-border bg-bg pl-8 pr-2 text-sm focus-ring sm:w-44" />
              </div>
              <Button onClick={() => setShowAdd(true)}><Plus className="mr-1 h-4 w-4" /> Add Source</Button>
            </div>
          </div>

          {/* Paste-a-link bar — the ungated "add to feed" path: unfurls any URL. */}
          <form
            onSubmit={(e) => { e.preventDefault(); void addLink(); }}
            className="mb-3 flex items-center gap-2 rounded-2xl border border-brand/30 bg-brand/5 p-2.5">
            <Link2 className="ml-1 hidden h-4 w-4 shrink-0 text-brand-text sm:block" />
            <input
              value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} inputMode="url"
              placeholder="Paste any link — a video, post, or article — to add it to your feed"
              className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 text-sm focus-ring" />
            <Button type="submit" disabled={!linkUrl.trim() || busy === 'addlink'}>
              {busy === 'addlink' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}
              Add
            </Button>
          </form>

          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex gap-1 overflow-x-auto no-scrollbar">
              {TABS.map((t) => (
                <button key={t.key} onClick={() => setTab(t.key)}
                  className={cn('flex-shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition',
                    tab === t.key ? 'bg-brand text-white' : 'text-muted hover:bg-elevated hover:text-fg')}>
                  {t.label}
                </button>
              ))}
            </div>
            {quick && (
              <button onClick={() => setQuick(null)} className="inline-flex flex-shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted hover:text-fg">
                <Filter className="h-3.5 w-3.5" /> {QUICK.find((q) => q.key === quick)?.label} <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {empty ? (
            <EmptyState icon={Rss} title="Your feed is empty" description="Paste any link above — a video, post, or article — to add it instantly, or connect your favorite accounts. It all lands here, ad-free." action={<Button onClick={() => setShowAdd(true)}><Plus className="mr-1 h-4 w-4" /> Add your first source</Button>} />
          ) : feed.length === 0 ? (
            <EmptyState icon={Filter} title="Nothing matches" description="Try a different tab or clear the filter." />
          ) : (
            <div className="space-y-3">
              {feed.map((item) => (
                <FeedCard key={item.id} item={item} busy={busy}
                  onFavorite={() => run(`fav-${item.id}`, () => toggleFavoriteAction({ id: item.id, favorite: !item.isFavorite }))}
                  onOpen={() => {
                    if (item.permalink) window.open(item.permalink, '_blank', 'noopener');
                    if (!item.isRead) void markReadAction({ id: item.id, read: true }).then(() => router.refresh());
                  }} />
              ))}
            </div>
          )}
        </div>

        {/* ── Right rail ── */}
        <aside className="space-y-4">
          <section className="rounded-2xl border border-border bg-surface/40 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold">Your Sources</h3>
              {counts.unread > 0 && <button onClick={() => run('readall', () => markAllReadAction(), 'Marked all read')} className="text-xs text-brand-text hover:underline">Mark all read</button>}
            </div>
            {sources.length === 0 ? (
              <p className="text-sm text-muted">No sources yet.</p>
            ) : (
              <div className="space-y-2">
                {[...sourcesByPlatform.entries()].map(([platform, agg]) => (
                  <div key={platform} className="flex items-center gap-2.5">
                    <PlatformGlyph platform={platform} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{platformLabel(platform)}</p>
                      <p className="text-xs text-muted">{agg.accounts} {agg.accounts === 1 ? 'account' : 'accounts'}</p>
                    </div>
                    <SourceMenu platform={platform} sources={sources} busy={busy}
                      onRemove={(id) => run(`rm-${id}`, () => removeSourceAction({ id }), 'Source removed')} />
                  </div>
                ))}
              </div>
            )}
            <Button variant="secondary" className="mt-3 w-full" onClick={() => setShowAdd(true)}><Plus className="mr-1 h-4 w-4" /> Add More Sources</Button>
          </section>

          <section className="rounded-2xl border border-border bg-surface/40 p-4">
            <h3 className="mb-3 font-semibold">Activity</h3>
            {items.length === 0 ? (
              <p className="text-sm text-muted">No recent activity.</p>
            ) : (
              <div className="space-y-2.5">
                {items.slice(0, 5).map((i) => (
                  <div key={i.id} className="flex items-center gap-2.5">
                    <PlatformGlyph platform={i.platform} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{i.authorName}</p>
                      <p className="truncate text-xs text-muted">{platformLabel(i.platform)} · {timeAgo(i.postedAt)} ago</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-border bg-surface/40 p-4">
            <h3 className="mb-3 font-semibold">Quick Filters</h3>
            <div className="flex flex-wrap gap-2">
              {QUICK.map((q) => {
                const on = quick === q.key;
                return (
                  <button key={q.key} onClick={() => setQuick(on ? null : q.key)}
                    className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition',
                      on ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:text-fg')}>
                    <q.icon className="h-3.5 w-3.5" /> {q.label}
                    <span className={cn('rounded-full px-1.5 text-[10px] font-bold', on ? 'bg-brand/20' : 'bg-elevated')}>{counts[q.key]}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rounded-2xl border border-brand/20 bg-brand/5 p-4 text-center">
            <Heart className="mx-auto h-7 w-7 text-brand-text" />
            <p className="mt-2 text-sm font-semibold">Less scrolling. More connecting.</p>
            <p className="mt-1 text-xs text-muted">Your family&rsquo;s world in one calm, ad-free place — so you can focus on what matters most.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function FeedCard({ item, busy, onFavorite, onOpen }: { item: FeedItem; busy: string | null; onFavorite: () => void; onOpen: () => void }) {
  const m = platformMeta(item.platform);
  const media = item.mediaUrls.slice(0, 3);
  const hasVideo = item.kind === 'video';
  return (
    <article className={cn('rounded-2xl border border-border bg-surface/40 p-4 transition hover:border-brand/30', !item.isRead && 'ring-1 ring-brand/20')}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <PlatformGlyph platform={item.platform} size="sm" />
          <div>
            <p className="flex items-center gap-1 text-sm font-semibold">
              {item.authorName}
              {item.verified && <BadgeCheck className="h-3.5 w-3.5 text-sky-500" />}
              <span className="font-normal text-muted">· {timeAgo(item.postedAt)}</span>
            </p>
            <p className={cn('text-xs', m.tint)}>{m.label}{item.authorHandle ? ` · ${item.authorHandle}` : ''}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={onFavorite} disabled={busy === `fav-${item.id}`} aria-label={item.isFavorite ? 'Remove bookmark' : 'Bookmark'}
            className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg">
            <Bookmark className={cn('h-4 w-4', item.isFavorite && 'fill-brand text-brand-text')} />
          </button>
          {item.permalink && (
            <button type="button" onClick={onOpen} aria-label="Open post" className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {item.content && <p className="mt-2 whitespace-pre-line text-sm">{item.content}</p>}

      {(media.length > 0 || item.thumbnailUrl) && (
        <button type="button" onClick={onOpen} className="mt-3 block w-full">
          {hasVideo ? (
            <div className="relative overflow-hidden rounded-xl border border-border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={item.thumbnailUrl || media[0]} alt="" loading="lazy" decoding="async" className="h-48 w-full object-cover" />
              <span className="absolute inset-0 grid place-items-center"><span className="grid h-12 w-12 place-items-center rounded-full bg-black/55 text-white"><Play className="h-5 w-5 fill-white" /></span></span>
              {item.durationLabel && <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white">{item.durationLabel}</span>}
            </div>
          ) : media.length === 1 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={media[0]} alt="" loading="lazy" decoding="async" className="h-48 w-full rounded-xl border border-border object-cover" />
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {media.map((url, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={url} alt="" loading="lazy" decoding="async" className="h-24 w-full rounded-lg border border-border object-cover" />
              ))}
            </div>
          )}
        </button>
      )}
    </article>
  );
}

function SourceMenu({ platform, sources, busy, onRemove }: { platform: string; sources: FeedSource[]; busy: string | null; onRemove: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const own = sources.filter((s) => s.platform === platform);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-label="Source options" className="rounded-lg p-1 text-muted hover:bg-elevated hover:text-fg">
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-10 w-44 rounded-xl border border-border bg-surface p-1 shadow-lg" onMouseLeave={() => setOpen(false)}>
          {own.map((s) => (
            <button key={s.id} type="button" disabled={busy === `rm-${s.id}`} onClick={() => { onRemove(s.id); setOpen(false); }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-muted hover:bg-elevated hover:text-danger">
              <Trash2 className="h-3.5 w-3.5" /> Remove {s.displayName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AddSourcePanel({ busy, onClose, onAdd }: { busy: string | null; onClose: () => void; onAdd: (platform: string, name: string, handle: string, category: string) => void }) {
  const [platform, setPlatform] = useState(PLATFORMS[0].key);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [category, setCategory] = useState('other');
  return (
    <div className="mt-4 rounded-2xl border border-brand/30 bg-brand/5 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold">Add a source</h3>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-muted hover:bg-elevated"><X className="h-4 w-4" /></button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Platform</span>
          <select value={platform} onChange={(e) => setPlatform(e.target.value as typeof platform)} className="h-9 rounded-lg border border-border bg-bg px-2 text-sm focus-ring">
            {PLATFORMS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
        <label className="block min-w-[140px] flex-1">
          <span className="mb-1 block text-xs text-muted">Name (optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={platformLabel(platform)} className="h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm focus-ring" />
        </label>
        <label className="block w-32">
          <span className="mb-1 block text-xs text-muted">@handle</span>
          <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@" className="h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm focus-ring" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Group</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 rounded-lg border border-border bg-bg px-2 text-sm focus-ring">
            <option value="other">General</option>
            <option value="family">Family</option>
            <option value="friends">Friends</option>
            <option value="groups">Groups</option>
          </select>
        </label>
        <Button onClick={() => onAdd(platform, name, handle, category)} loading={busy === 'add'}>Add</Button>
      </div>
    </div>
  );
}
