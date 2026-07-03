import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Plus, Upload, FolderPlus, MoreHorizontal, Search, Filter, ChevronRight, Camera,
  Sparkles, Image as ImageIcon, Video, BookOpen, LayoutGrid, GraduationCap, Plane, Cake,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import {
  buildTimeline, memoryStats, sharedWithYou, relativeTime,
  type AlbumRow, type PhotoRow, type MemberLite,
} from '@/lib/memories/memories';
import { pickOnThisDay } from '@/lib/memories/on-this-day';

export const metadata: Metadata = { title: 'Memories' };
export const dynamic = 'force-dynamic';

type TabKey = 'highlights' | 'photos' | 'albums' | 'videos' | 'stories';
const TABS: { key: TabKey; label: string; icon: typeof ImageIcon }[] = [
  { key: 'highlights', label: 'Highlights', icon: Sparkles },
  { key: 'photos', label: 'Photos', icon: ImageIcon },
  { key: 'albums', label: 'Albums', icon: LayoutGrid },
  { key: 'videos', label: 'Videos', icon: Video },
  { key: 'stories', label: 'Stories', icon: BookOpen },
];

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtEventRange(start: string, end: string | null): string {
  const s = new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (!end || end.slice(0, 10) === start.slice(0, 10)) return s;
  return `${new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

const EVENT_ICON: Record<string, typeof Cake> = { birthday: Cake, holiday: Cake, school: GraduationCap, sports: GraduationCap };
function eventIcon(category: string | null) {
  return category && EVENT_ICON[category] ? EVENT_ICON[category] : Plane;
}
function countVideos(photos: PhotoRow[] | undefined): number {
  return (photos ?? []).filter((p) => p.media_type === 'video').length;
}

export default async function MemoriesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const tab: TabKey = (TABS.find((t) => t.key === sp.tab)?.key ?? 'highlights') as TabKey;
  const q = (sp.q ?? '').trim();

  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const myUserId = ctx.user.id;
  const supabase = await createServer();

  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1).toISOString();
  const nowIso = now.toISOString();

  const [
    { data: albumsRaw },
    { data: photosRaw },
    { data: members },
    { data: upcoming },
    { count: photoCount },
    { count: videoCount },
    { count: albumCount },
    { count: memoriesCount },
  ] = await Promise.all([
    supabase.from('family_albums').select('id, name, cover_url, kind, is_shared, photo_count, created_at, created_by')
      .eq('family_id', familyId).order('created_at', { ascending: false }).limit(200),
    supabase.from('family_photos').select('id, album_id, uploaded_by, url, thumbnail_url, caption, media_type, taken_at, created_at')
      .eq('family_id', familyId).order('created_at', { ascending: false }).limit(400),
    supabase.from('family_members').select('id, user_id, display_name, color').eq('family_id', familyId).eq('is_active', true),
    supabase.from('calendar_events').select('id, title, starts_at, ends_at, category, all_day')
      .eq('family_id', familyId).gte('starts_at', nowIso).order('starts_at').limit(3),
    supabase.from('family_photos').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('media_type', 'image').gte('created_at', yearStart),
    supabase.from('family_photos').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('media_type', 'video').gte('created_at', yearStart),
    supabase.from('family_albums').select('id', { count: 'exact', head: true }).eq('family_id', familyId),
    supabase.from('family_memories').select('id', { count: 'exact', head: true }).eq('family_id', familyId).is('deleted_at', null).gte('created_at', yearStart),
  ]);

  const albums = (albumsRaw ?? []) as AlbumRow[];
  const photos = (photosRaw ?? []) as PhotoRow[];
  const memberList = (members ?? []) as MemberLite[];

  const matchesQ = (name: string) => !q || name.toLowerCase().includes(q.toLowerCase());
  const highlights = albums.filter((a) => a.kind === 'highlight' && matchesQ(a.name));
  const collections = albums.filter((a) => a.kind !== 'highlight' && matchesQ(a.name));
  const photosByAlbum = new Map<string, PhotoRow[]>();
  for (const p of photos) {
    if (!p.album_id) continue;
    const arr = photosByAlbum.get(p.album_id) ?? [];
    if (arr.length < 6) arr.push(p);
    photosByAlbum.set(p.album_id, arr);
  }

  const timeline = buildTimeline(highlights);
  const stats = memoryStats({ photos: photoCount ?? 0, videos: videoCount ?? 0, albums: albumCount ?? 0, memories: memoriesCount ?? 0 });
  const shared = sharedWithYou(photos, memberList, myUserId, now);
  const sharedById = new Map(memberList.map((m) => [m.user_id ?? m.id, m]));
  // Delight: photos taken on today's date in past years (from the already-loaded set).
  const onThisDay = pickOnThisDay(photos.filter((p) => p.url), now, 6);

  const HeaderButton = ({ href, icon: Icon, label, primary }: { href: string; icon: typeof Plus; label: string; primary?: boolean }) => (
    <Link href={href} className={cn(
      'inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition',
      primary ? 'bg-brand text-brand-fg hover:brightness-110' : 'border border-border bg-surface/40 text-fg hover:bg-elevated',
    )}>
      <Icon className="h-4 w-4" /> {label}
    </Link>
  );

  const SectionHeader = ({ title, action, href }: { title: string; action?: string; href?: string }) => (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-lg font-bold">{title}</h2>
      {action && href && (
        <Link href={href} className="flex items-center gap-1 text-sm font-semibold text-brand hover:underline">{action} <ChevronRight className="h-3.5 w-3.5" /></Link>
      )}
    </div>
  );

  const AlbumCard = ({ album, videos }: { album: AlbumRow; videos: number }) => (
    <Link href="/dashboard/photos" className="group w-[200px] shrink-0 overflow-hidden rounded-2xl border border-border bg-surface/40">
      <div className="h-28 w-full">
        {album.cover_url
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={album.cover_url} alt={album.name} className="h-full w-full object-cover transition group-hover:scale-[1.02]" />
          : <div className="grid h-full w-full place-items-center bg-elevated text-muted"><Camera className="h-7 w-7" /></div>}
      </div>
      <div className="p-3">
        <p className="truncate text-sm font-semibold">{album.name}</p>
        <p className="mt-0.5 truncate text-xs text-muted">
          {album.photo_count} photo{album.photo_count === 1 ? '' : 's'}{videos > 0 ? `, ${videos} video${videos === 1 ? '' : 's'}` : ''}
        </p>
      </div>
    </Link>
  );

  const EmptyBlock = ({ label }: { label: string }) => (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-surface/40 py-16 text-center">
      <Camera className="h-9 w-9 text-muted/40" />
      <p className="mt-3 text-sm text-muted">{label}</p>
      <Link href="/dashboard/memories/create" className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:brightness-110"><Plus className="h-4 w-4" /> Add Memory</Link>
    </div>
  );

  const MediaGrid = ({ items, empty }: { items: PhotoRow[]; empty: string }) => (
    items.length === 0 ? <EmptyBlock label={empty} /> : (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((p) => (
          <div key={p.id} className="relative overflow-hidden rounded-xl border border-border bg-surface/40">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.thumbnail_url ?? p.url ?? ''} alt={p.caption ?? ''} className="aspect-square w-full object-cover" />
            {p.media_type === 'video' && <span className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-white"><Video className="h-3.5 w-3.5" /></span>}
          </div>
        ))}
      </div>
    )
  );

  const TimelineView = () => (
    timeline.length === 0 ? <EmptyBlock label="No highlights yet — add a memory to start your timeline." /> : (
      <section>
        <SectionHeader title="Timeline" />
        <div className="space-y-6">
          {timeline.map((row) => {
            const strip = photosByAlbum.get(row.album.id) ?? [];
            return (
              <div key={row.album.id} className="flex gap-4">
                <div className="flex w-28 shrink-0 flex-col">
                  <div className="flex items-center gap-2">
                    <span className="grid h-4 w-4 place-items-center rounded-full border-2 border-brand"><span className="h-1.5 w-1.5 rounded-full bg-brand" /></span>
                    <span className="text-sm font-semibold">{new Date(row.album.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                  </div>
                  <span className="ml-6 text-xs text-muted">{row.relative}</span>
                </div>
                <div className="min-w-0 flex-1 rounded-2xl border border-border bg-surface/30 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="truncate text-sm font-semibold">{row.album.name}</p>
                    <Link href="/dashboard/photos" className="flex shrink-0 items-center gap-1 text-xs text-muted hover:text-fg">{row.album.photo_count} items <ChevronRight className="h-3.5 w-3.5" /></Link>
                  </div>
                  {strip.length > 0 && (
                    <div className="grid grid-cols-5 gap-2">
                      {strip.slice(0, 5).map((p) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={p.id} src={p.thumbnail_url ?? p.url ?? ''} alt="" className="h-20 w-full rounded-lg object-cover" />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    )
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Memories</h1>
          <p className="mt-1 text-sm text-muted">Capture, organize, and relive life&apos;s best moments.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <HeaderButton href="/dashboard/memories/create" icon={Plus} label="Add Memory" primary />
          <HeaderButton href="/dashboard/photos" icon={Upload} label="Upload Photos" />
          <HeaderButton href="/dashboard/photos" icon={FolderPlus} label="Create Album" />
          <Link href="/dashboard/photos" aria-label="More options" className="grid h-10 w-10 place-items-center rounded-xl border border-border bg-surface/40 text-muted hover:bg-elevated">
            <MoreHorizontal className="h-4 w-4" />
          </Link>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        {/* Main column */}
        <div className="min-w-0 space-y-8">
          {/* Tabs + search + filter */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
              {TABS.map((t) => {
                const active = t.key === tab;
                return (
                  <Link key={t.key} href={`/dashboard/memories?tab=${t.key}${q ? `&q=${encodeURIComponent(q)}` : ''}`}
                    className={cn('flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition',
                      active ? 'bg-brand/15 text-brand' : 'text-muted hover:bg-elevated hover:text-fg')}>
                    <t.icon className="h-4 w-4" /> {t.label}
                  </Link>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <form className="relative" action="/dashboard/memories">
                <input type="hidden" name="tab" value={tab} />
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input name="q" defaultValue={q} placeholder="Search memories..."
                  className="h-10 w-full rounded-xl border border-border bg-surface/40 pl-9 pr-3 text-sm outline-none placeholder:text-muted focus:border-brand/50 lg:w-56" />
              </form>
              <Link href={`/dashboard/memories?tab=${tab}`} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-border bg-surface/40 px-3 text-sm text-muted hover:bg-elevated">
                <Filter className="h-4 w-4" /> Filter
              </Link>
            </div>
          </div>

          {tab === 'highlights' && (
            <>
              {highlights.length > 0 && (
                <section>
                  <SectionHeader title="Recent Highlights" action="View all" href="/dashboard/memories?tab=albums" />
                  <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
                    {highlights.slice(0, 8).map((a) => (
                      <Link key={a.id} href="/dashboard/photos" className="group w-[220px] shrink-0 overflow-hidden rounded-2xl border border-border bg-surface/40">
                        <div className="relative h-40 w-full">
                          {a.cover_url
                            // eslint-disable-next-line @next/next/no-img-element
                            ? <img src={a.cover_url} alt={a.name} className="h-full w-full object-cover transition group-hover:scale-[1.02]" />
                            : <div className="grid h-full w-full place-items-center bg-elevated text-muted"><Camera className="h-8 w-8" /></div>}
                          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3">
                            <p className="truncate text-sm font-semibold text-white">{a.name}</p>
                            <div className="mt-0.5 flex items-center justify-between text-[11px] text-white/80">
                              <span>{fmtDay(a.created_at)}</span>
                              <span className="inline-flex items-center gap-1 rounded-md bg-black/40 px-1.5 py-0.5"><ImageIcon className="h-3 w-3" />{a.photo_count}</span>
                            </div>
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                </section>
              )}

              {collections.length > 0 && (
                <section>
                  <SectionHeader title="Albums" action="View all albums" href="/dashboard/memories?tab=albums" />
                  <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
                    {collections.slice(0, 8).map((a) => <AlbumCard key={a.id} album={a} videos={countVideos(photosByAlbum.get(a.id))} />)}
                  </div>
                </section>
              )}

              {highlights.length === 0 && collections.length === 0
                ? <EmptyBlock label={q ? `No memories match “${q}”.` : 'Your family memory lane is empty — add a favorite photo, create an album, or record a milestone.'} />
                : <TimelineView />}
            </>
          )}

          {tab === 'photos' && <MediaGrid items={photos.filter((p) => p.media_type !== 'video')} empty="No photos yet." />}
          {tab === 'videos' && <MediaGrid items={photos.filter((p) => p.media_type === 'video')} empty="No videos yet." />}
          {tab === 'albums' && (
            collections.concat(highlights).length === 0 ? <EmptyBlock label="No albums yet." /> : (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {collections.concat(highlights).map((a) => <AlbumCard key={a.id} album={a} videos={countVideos(photosByAlbum.get(a.id))} />)}
              </div>
            )
          )}
          {tab === 'stories' && <TimelineView />}
        </div>

        {/* Right rail */}
        <aside className="space-y-6">
          {/* On this day — today's memories from past years (only when present). */}
          {onThisDay.length > 0 && (
            <div className="rounded-2xl border border-accent/25 bg-gradient-to-br from-accent/10 to-transparent p-5">
              <div className="mb-3 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-accent" />
                <h3 className="text-base font-bold">On this day</h3>
              </div>
              <p className="mb-3 text-xs text-muted">
                {onThisDay.length === 1 ? onThisDay[0].label : `${onThisDay.length} memories · from ${onThisDay[onThisDay.length - 1].label}`}
              </p>
              <div className="grid grid-cols-3 gap-2">
                {onThisDay.slice(0, 6).map((m) => (
                  <div key={m.id} className="relative aspect-square overflow-hidden rounded-xl bg-elevated">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.thumbnail_url || m.url || ''} alt={m.caption ?? 'Family memory'} className="h-full w-full object-cover" loading="lazy" />
                    <span className="absolute bottom-1 left-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold text-white">{m.label}</span>
                  </div>
                ))}
              </div>
              {onThisDay[0].caption && <p className="mt-3 truncate text-xs text-muted">“{onThisDay[0].caption}”</p>}
            </div>
          )}

          {/* Family Moments */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <h3 className="mb-4 text-base font-bold">Family Moments</h3>
            <div className="relative mx-auto grid h-24 w-24 place-items-center rounded-full bg-brand/15">
              <Camera className="h-9 w-9 text-brand" />
              <Sparkles className="absolute -right-1 top-2 h-4 w-4 text-brand/70" />
              <Sparkles className="absolute -left-2 bottom-3 h-3 w-3 text-brand/50" />
            </div>
            <p className="mt-4 text-center text-sm font-semibold">Add memories every day</p>
            <p className="mt-1 text-center text-xs text-muted">Small moments. Big memories.</p>
            <Link href="/dashboard/memories/create" className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg hover:brightness-110">Add Photos</Link>
          </div>

          {/* Memory Stats */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <h3 className="text-base font-bold">Memory Stats</h3>
            <p className="mb-3 text-xs text-muted">This Year</p>
            <div className="space-y-3">
              {stats.map((s) => (
                <div key={s.label} className="flex items-center gap-3">
                  <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', s.tint)}><s.icon className="h-4 w-4" /></span>
                  <span className="flex-1 text-sm text-muted">{s.label}</span>
                  <span className="text-sm font-bold">{s.value.toLocaleString()}</span>
                </div>
              ))}
            </div>
            <Link href="/dashboard/photos" className="mt-4 flex items-center justify-center gap-1 text-sm font-semibold text-brand hover:underline">View full report <ChevronRight className="h-3.5 w-3.5" /></Link>
          </div>

          {/* Upcoming Events */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-bold">Upcoming Events</h3>
              <Link href="/dashboard/calendar" className="text-xs font-semibold text-brand hover:underline">View calendar</Link>
            </div>
            {(upcoming ?? []).length === 0 ? (
              <p className="text-sm text-muted">Nothing scheduled yet.</p>
            ) : (
              <div className="space-y-3">
                {(upcoming ?? []).map((e) => {
                  const Icon = eventIcon(e.category);
                  return (
                    <Link key={e.id} href="/dashboard/calendar" className="flex items-center gap-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand"><Icon className="h-4 w-4" /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{e.title}</span>
                        <span className="block truncate text-xs text-muted">{fmtEventRange(e.starts_at, e.ends_at)}</span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>

          {/* Shared With You */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-bold">Shared With You</h3>
              <Link href="/dashboard/photos" className="text-xs font-semibold text-brand hover:underline">View all</Link>
            </div>
            {shared.length === 0 ? (
              <p className="text-sm text-muted">No new shares.</p>
            ) : (
              <div className="space-y-3">
                {shared.map((s) => {
                  const m = sharedById.get(s.userId);
                  return (
                    <Link key={s.userId} href="/dashboard/photos" className="flex items-center gap-3">
                      <Avatar name={s.name} color={m?.color ?? undefined} size={32} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm"><span className="font-medium">{s.name}</span> shared {s.label}</span>
                        <span className="block text-xs text-muted">{relativeTime(s.at, now)}</span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
