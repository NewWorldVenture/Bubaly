'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDistanceToNow, isToday, isTomorrow, parseISO } from 'date-fns';
import { de, enUS, es, fr, it, nl, pt } from 'date-fns/locale';
import {
  Image as ImageIcon, Plus, Upload, X, Star, StarOff, Trash2,
  ChevronLeft, ChevronRight, ZoomIn, Edit2, Grid3X3, List,
  Camera, Heart, Mountain, GraduationCap, Trophy, Calendar,
  Download, Share2, Search, Tag, MoreHorizontal, Film, Play, Loader2,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { FAMILY_MEDIA_MAX_LABEL, partitionBySize } from '@/lib/storage/family-media';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import { progressBarA11y } from '@/lib/ui/a11y';
import type { Tables } from '@/lib/database.types';
import { useLocale, useTranslations } from '@/components/i18n/locale-provider';

type Album = Tables<'family_albums'>;
type Photo = Tables<'family_photos'>;

const ALBUM_KINDS = [
  { id: 'general', labelKey: 'photosModule.kindGeneral', icon: Camera, color: '#7c5dfa' },
  { id: 'vacation', labelKey: 'photosModule.kindVacation', icon: Mountain, color: '#f4996e' },
  { id: 'school', labelKey: 'photosModule.kindSchool', icon: GraduationCap, color: '#22c55e' },
  { id: 'sports', labelKey: 'photosModule.kindSports', icon: Trophy, color: '#f59e0b' },
  { id: 'milestones', labelKey: 'photosModule.kindMilestones', icon: Star, color: '#ec4899' },
  { id: 'holiday', labelKey: 'photosModule.kindHoliday', icon: Calendar, color: '#3b82f6' },
  { id: 'birthday', labelKey: 'photosModule.kindBirthday', icon: Heart, color: '#ef4444' },
  { id: 'other', labelKey: 'photosModule.kindOther', icon: ImageIcon, color: '#6b7280' },
] as const;
const DATE_LOCALES = { de, en: enUS, es, fr, it, nl, pt };

export function PhotosModule() {
  const tr = useTranslations();
  const { code: locale } = useLocale();
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  // Preserve fmtRelative's local Today/Tomorrow/distance semantics and tolerant
  // timestamp parsing while formatting words and clocks in the chosen locale.
  function relativeDate(value: string | null | undefined): string {
    if (!value) return '';
    const parsed = parseISO(value);
    const date = Number.isNaN(parsed.getTime()) ? new Date(value) : parsed;
    if (Number.isNaN(date.getTime())) return '';
    if (isToday(date) || isTomorrow(date)) return tr(isToday(date) ? 'photosModule.todayAt' : 'photosModule.tomorrowAt', {
      time: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date),
    });
    const language = locale.split('-')[0] as keyof typeof DATE_LOCALES;
    return formatDistanceToNow(date, { addSuffix: true, locale: DATE_LOCALES[language] ?? enUS });
  }

  const [activeAlbum, setActiveAlbum] = useState<Album | null>(null);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [newAlbumOpen, setNewAlbumOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [editPhoto, setEditPhoto] = useState<Photo | null>(null);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'albums' | 'all' | 'favorites' | 'recents'>('albums');
  const dropRef = useRef<HTMLDivElement>(null);

  const { data: albums, loading: albumsLoading, error: albumsError, refresh: refreshAlbums } = useRealtimeQuery<Album>({
    table: 'family_albums', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_albums').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
  });

  const { data: allPhotos, loading: photosLoading, error: photosError, refresh: refreshPhotos } = useRealtimeQuery<Photo>({
    table: 'family_photos', familyId, deps: [familyId, activeAlbum?.id],
    fetcher: (sb) => {
      let q = sb.from('family_photos').select('*').eq('family_id', familyId);
      if (tab === 'favorites') q = q.eq('is_favorite', true);
      if (activeAlbum) q = q.eq('album_id', activeAlbum.id);
      return q.order('created_at', { ascending: false });
    },
  });

  const photos = allPhotos.filter((p) =>
    !search || p.caption?.toLowerCase().includes(search.toLowerCase()) ||
    p.tags?.some((t) => t.toLowerCase().includes(search.toLowerCase()))
  );

  // ── Upload handler ────────────────────────────────────────
  async function uploadFiles(files: FileList | null) {
    if (!files || !files.length) return;
    const media = Array.from(files).filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (!media.length) { toastError(tr('photosModule.chooseImageOrVideoFiles')); return; }
    // Skip anything over the family-media bucket limit before it fails mid-upload.
    const { ok: valid, tooBig } = partitionBySize(media);
    if (tooBig.length) toastError(tr(tooBig.length === 1 ? 'photosModule.skippedFile' : 'photosModule.skippedFiles', { count: tooBig.length, limit: FAMILY_MEDIA_MAX_LABEL }));
    if (!valid.length) return;
    const supabase = createClient();
    setUploadProgress({ done: 0, total: valid.length });
    let uploaded = 0;
    for (let i = 0; i < valid.length; i++) {
      const file = valid[i];
      const isVideo = file.type.startsWith('video/');
      const ext = file.name.split('.').pop();
      const folder = isVideo ? 'videos' : 'photos';
      const unique = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const path = `${familyId}/${folder}/${unique}.${ext}`;
      const { data: stored, error: upErr } = await supabase.storage
        .from('family-media')
        .upload(path, file, { upsert: false, cacheControl: '31536000' });
      if (upErr) {
        toastError(tr('photosModule.uploadFailed', { name: file.name }));
      } else {
        const { data: { publicUrl } } = supabase.storage.from('family-media').getPublicUrl(stored.path);
        const { data: photo, error: insertError } = await supabase.from('family_photos').insert({
          family_id: familyId,
          album_id: activeAlbum?.id ?? null,
          uploaded_by: userId,
          storage_path: stored.path,
          url: publicUrl,
          size_bytes: file.size,
          media_type: isVideo ? 'video' : 'image',
        }).select('id').single();
        if (insertError || !photo) {
          toastError(tr('photosModule.theFileUploadedButIts'));
          const { error: cleanupError } = await supabase.storage.from('family-media').remove([stored.path]);
          if (cleanupError) toastError(tr('photosModule.theUploadedFileCouldNot'));
        } else {
          uploaded++;
        }
      }
      setUploadProgress({ done: i + 1, total: valid.length });
    }
    setUploadProgress(null);
    if (uploaded > 0) {
      success(tr(uploaded === 1 ? 'photosModule.uploadedFile' : 'photosModule.uploadedFiles', { count: uploaded }));
      void refreshPhotos();
      void refreshAlbums();
    }
    setUploadOpen(false);
  }

  // ── Drag & drop ───────────────────────────────────────────
  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;
    function onDrop(e: DragEvent) {
      e.preventDefault(); e.stopPropagation();
      el!.classList.remove('border-brand', 'bg-brand/5');
      if (e.dataTransfer?.files) void uploadFiles(e.dataTransfer.files);
    }
    function onDragOver(e: DragEvent) { e.preventDefault(); el!.classList.add('border-brand', 'bg-brand/5'); }
    function onDragLeave() { el!.classList.remove('border-brand', 'bg-brand/5'); }
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);
    return () => { el.removeEventListener('dragover', onDragOver); el.removeEventListener('dragleave', onDragLeave); el.removeEventListener('drop', onDrop); };
  }, [activeAlbum, tr]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleFavorite(photo: Photo) {
    const supabase = createClient();
    const { error } = await supabase.from('family_photos').update({ is_favorite: !photo.is_favorite }).eq('id', photo.id);
    if (error) toastError(describeDbError(error));
    void refreshPhotos();
  }

  async function deletePhoto(photo: Photo) {
    const supabase = createClient();
    // Delete the DB row (the source of truth) FIRST and surface any failure —
    // dropping this error showed a false "Photo deleted" while the photo remained.
    // Only remove the storage object after the row is gone, so a failed delete can
    // never orphan a library row that points at an already-removed image.
    const { error } = await supabase.from('family_photos').delete().eq('id', photo.id);
    if (error) { toastError(describeDbError(error)); return; }
    await supabase.storage.from('family-media').remove([photo.storage_path]);
    success(tr('photosModule.photoDeleted'));
    void refreshPhotos();
    if (lightboxIdx !== null) setLightboxIdx(null);
  }

  async function updateCaption(photo: Photo, caption: string) {
    const supabase = createClient();
    const { error } = await supabase.from('family_photos').update({ caption }).eq('id', photo.id);
    if (error) toastError(describeDbError(error));
    void refreshPhotos();
    setEditPhoto(null);
  }

  const loading = albumsLoading || photosLoading;
  const error = albumsError || photosError;
  const refresh = () => { void refreshAlbums(); void refreshPhotos(); };

  // ── Album stats ───────────────────────────────────────────
  const albumStats = albums.map((a) => ({
    ...a,
    count: allPhotos.filter((p) => p.album_id === a.id).length,
    cover: allPhotos.find((p) => p.album_id === a.id)?.url,
  }));

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={tr('photosModule.couldNotLoadFamilyPhotos')} onRetry={refresh} />;

  return (
    <div ref={dropRef} className="module-page transition-colors border-2 border-transparent rounded-2xl">
      {/* Header */}
      <PageHeader
        title={tr('photos.familyPhotosVideos')}
        description={tr('photosModule.memoriesYourFamilyWillTreasure')}
        action={
          <div className="flex items-center gap-2">
            <AiInsight kind="photos" iconOnly />
            <div className="flex items-center gap-1 rounded-xl border border-border bg-surface/60 px-3 py-1.5">
              <Search className="h-3.5 w-3.5 text-muted" />
              <input value={search} inputMode="search" enterKeyHint="search" onChange={(e) => setSearch(e.target.value)}
                placeholder={tr('photos.searchPhotos')}
                className="w-28 bg-transparent text-sm placeholder:text-muted outline-none sm:w-40" />
            </div>
            <Button variant="outline" size="sm" aria-label={tr(view === 'grid' ? 'photosModule.showList' : 'photosModule.showGrid')} onClick={() => setView(v => v === 'grid' ? 'list' : 'grid')}>
              {view === 'grid' ? <List className="h-4 w-4" /> : <Grid3X3 className="h-4 w-4" />}
            </Button>
            <Button onClick={() => setUploadOpen(true)}>
              <Upload className="h-4 w-4" /> {tr('photos.upload')}
            </Button>
            <Button variant="outline" onClick={() => setNewAlbumOpen(true)}>
              <Plus className="h-4 w-4" /> {tr('photos.album')}
            </Button>
          </div>
        }
      />

      {/* Tabs */}
      <div className="tab-bar">
        {([['albums', 'photos.albums'], ['all', 'photosModule.allPhotos'], ['favorites', 'photosModule.favorites'], ['recents', 'photosModule.recents']] as const).map(([key, labelKey]) => (
          <button key={key} onClick={() => { setTab(key); setActiveAlbum(null); }}
            className={cn('tab-item', tab === key ? 'tab-item-active' : 'tab-item-inactive')}>
            {tr(labelKey)}
            {key === 'favorites' && <span className="ml-1 rounded-full bg-current/10 px-1.5 text-[10px]">
              {allPhotos.filter((p) => p.is_favorite).length}
            </span>}
          </button>
        ))}
      </div>

      {/* Albums tab */}
      {tab === 'albums' && !activeAlbum && (
        <div>
          {albumStats.length === 0 ? (
            <EmptyState icon={ImageIcon} title={tr('photos.noAlbumsYet')}
              description={tr('photosModule.createYourFirstFamilyAlbum')}
              action={<Button onClick={() => setNewAlbumOpen(true)}><Plus className="h-4 w-4" /> {tr('photos.createAlbum')}</Button>} />
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {albumStats.map((album) => {
                const kind = ALBUM_KINDS.find((k) => k.id === album.kind) ?? ALBUM_KINDS[0];
                return (
                  <button key={album.id} onClick={() => { setActiveAlbum(album); setTab('all'); }}
                    className="group text-left">
                    <div className="relative aspect-square overflow-hidden rounded-2xl border border-border/60 bg-elevated">
                      {album.cover ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={album.cover} alt={album.name} loading="lazy" decoding="async" className="h-full w-full object-cover transition group-hover:scale-105" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-5xl opacity-30">
                          <kind.icon className="h-12 w-12" style={{ color: kind.color }} />
                        </div>
                      )}
                      {/* Overlay */}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
                      <div className="absolute bottom-0 left-0 right-0 p-3">
                        <p className="truncate text-sm font-bold text-white">{album.name}</p>
                        <p className="text-[11px] text-white/70">{tr(album.count === 1 ? 'photosModule.photoCount' : 'photosModule.photosCount', { count: album.count })}</p>
                      </div>
                      {/* Kind badge */}
                      <div className="absolute right-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                        style={{ background: kind.color + 'cc' }}>
                        {tr(kind.labelKey)}
                      </div>
                    </div>
                  </button>
                );
              })}

              {/* Create album card */}
              <button onClick={() => setNewAlbumOpen(true)}
                className="group flex aspect-square items-center justify-center rounded-2xl border-2 border-dashed border-border hover:border-brand/50 hover:bg-brand/5 transition">
                <div className="flex flex-col items-center gap-2 text-muted group-hover:text-brand-text transition">
                  <Plus className="h-8 w-8" />
                  <span className="text-xs font-medium">{tr('photos.newAlbum')}</span>
                </div>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Photos grid (all / favorites / recents / album detail) */}
      {(tab !== 'albums' || activeAlbum) && (
        <div>
          {/* Album breadcrumb */}
          {activeAlbum && (
            <div className="mb-3 flex items-center gap-2 text-sm">
              <button onClick={() => { setActiveAlbum(null); setTab('albums'); }}
                className="flex items-center gap-1 text-muted hover:text-brand-text transition">
                <ChevronLeft className="h-4 w-4" /> {tr('photos.albums')}
              </button>
              <span className="text-muted">/</span>
              <span className="font-semibold">{activeAlbum.name}</span>
              <Badge tone="neutral" className="ml-1">{tr(photos.length === 1 ? 'photosModule.photoCount' : 'photosModule.photosCount', { count: photos.length })}</Badge>
            </div>
          )}

          {photos.length === 0 ? (
            <EmptyState icon={Camera} title={tr('photos.noPhotosYet')}
              description={tr(activeAlbum ? 'photosModule.emptyAlbum' : 'photosModule.emptyPhotos')}
              action={<Button onClick={() => setUploadOpen(true)}><Upload className="h-4 w-4" /> {tr('photos.uploadPhotos')}</Button>} />
          ) : view === 'grid' ? (
            /* Grid */
            <div className="columns-2 gap-3 sm:columns-3 lg:columns-4 xl:columns-5">
              {photos.map((photo, idx) => {
                const isVideo = photo.media_type === 'video';
                return (
                <div key={photo.id} className="group relative mb-3 break-inside-avoid overflow-hidden rounded-xl border border-border/40"
                  onClick={() => setLightboxIdx(idx)}>
                  {isVideo ? (
                    <div className="flex aspect-video w-full cursor-pointer items-center justify-center bg-black/80">
                      <Play className="h-10 w-10 text-white/70" />
                    </div>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={photo.url ?? ''} alt={photo.caption ?? tr('photosModule.photo')}
                      className="w-full cursor-pointer object-cover transition group-hover:scale-105"
                      loading="lazy" decoding="async" />
                  )}
                  {/* Video badge */}
                  {isVideo && (
                    <div className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white">
                      <Film className="h-3 w-3" /> {tr('photos.video')}
                    </div>
                  )}
                  {/* Hover overlay */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 coarse:opacity-100 transition-opacity">
                    <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
                      {photo.caption && <p className="truncate text-[11px] text-white">{photo.caption}</p>}
                      <div className="ml-auto flex gap-1.5">
                        <button onClick={(e) => { e.stopPropagation(); toggleFavorite(photo); }}
                          aria-label={tr(photo.is_favorite ? 'photosModule.removeFavorite' : 'photosModule.addFavorite')}
                          className="rounded-full bg-black/40 p-1.5 text-white hover:bg-black/60">
                          {photo.is_favorite ? <Heart className="h-3.5 w-3.5 fill-red-400 text-red-400" /> : <Heart className="h-3.5 w-3.5" />}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); setEditPhoto(photo); }}
                          aria-label={tr('photos.editPhotoDetails')}
                          className="rounded-full bg-black/40 p-1.5 text-white hover:bg-black/60">
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                  {photo.is_favorite && (
                    <div className={`absolute ${isVideo ? 'right-2 bottom-2' : 'right-2 top-2'}`}>
                      <Heart className="h-4 w-4 fill-red-400 text-red-400 drop-shadow" />
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          ) : (
            /* List */
            <div className="overflow-hidden rounded-2xl border border-border">
              {photos.map((photo, idx) => (
                <div key={photo.id} onClick={() => setLightboxIdx(idx)}
                  className="group flex cursor-pointer items-center gap-4 border-b border-border/50 px-4 py-3 hover:bg-elevated/30 transition last:border-0">
                  {photo.media_type === 'video' ? (
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-black/80">
                      <Play className="h-5 w-5 text-white/70" />
                    </div>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={photo.url ?? ''} alt="" loading="lazy" decoding="async" className="h-12 w-12 rounded-xl object-cover" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium">{photo.caption ?? tr(photo.media_type === 'video' ? 'photos.video' : 'photosModule.photo')}</p>
                    <p className="text-xs text-muted">{relativeDate(photo.created_at)}</p>
                  </div>
                  {photo.tags?.map((t) => <Badge key={t} tone="neutral">{t}</Badge>)}
                  <button onClick={(e) => { e.stopPropagation(); toggleFavorite(photo); }}
                    aria-label={tr(photo.is_favorite ? 'photosModule.removeFavorite' : 'photosModule.addFavorite')}>
                    {photo.is_favorite ? <Heart className="h-4 w-4 fill-red-400 text-red-400" /> : <Heart className="h-4 w-4 text-muted" />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Lightbox ──────────────────────────────────────────── */}
      {lightboxIdx !== null && photos[lightboxIdx] && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 pt-[var(--safe-top)] pb-[var(--safe-bottom)]"
          onClick={() => setLightboxIdx(null)}>
          {/* Nav */}
          {lightboxIdx > 0 && (
            <button onClick={(e) => { e.stopPropagation(); setLightboxIdx((i) => (i ?? 0) - 1); }}
              aria-label={tr('photos.previousPhoto')}
              className="absolute left-4 flex h-12 w-12 items-center justify-center rounded-full bg-elevated text-fg hover:bg-elevated transition">
              <ChevronLeft className="h-6 w-6" />
            </button>
          )}
          {lightboxIdx < photos.length - 1 && (
            <button onClick={(e) => { e.stopPropagation(); setLightboxIdx((i) => (i ?? 0) + 1); }}
              aria-label={tr('photos.nextPhoto')}
              className="absolute right-4 flex h-12 w-12 items-center justify-center rounded-full bg-elevated text-fg hover:bg-elevated transition">
              <ChevronRight className="h-6 w-6" />
            </button>
          )}

          {/* Media */}
          <div onClick={(e) => e.stopPropagation()} className="relative flex max-h-[90vh] max-w-[90vw] flex-col items-center">
            {photos[lightboxIdx].media_type === 'video' ? (
              <video
                src={photos[lightboxIdx].url ?? ''}
                controls
                autoPlay
                playsInline
                className="max-h-[80vh] max-w-full rounded-2xl shadow-2xl"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photos[lightboxIdx].url ?? ''} alt={photos[lightboxIdx].caption ?? ''}
                className="max-h-[80vh] max-w-full rounded-2xl object-contain shadow-2xl" />
            )}
            {/* Controls */}
            <div className="mt-4 flex items-center gap-3 text-white">
              <span className="text-sm text-white/70">{lightboxIdx + 1} / {photos.length}</span>
              {photos[lightboxIdx].caption && <p className="text-sm">{photos[lightboxIdx].caption}</p>}
              <div className="ml-auto flex gap-2">
                <a href={photos[lightboxIdx].url ?? '#'} download target="_blank" rel="noreferrer" aria-label={tr('photosModule.download')}
                  onClick={(e) => e.stopPropagation()}
                  className="rounded-lg bg-elevated p-2 hover:bg-elevated transition">
                  <Download className="h-4 w-4" />
                </a>
                <button onClick={() => toggleFavorite(photos[lightboxIdx])}
                  aria-label={tr(photos[lightboxIdx].is_favorite ? 'photosModule.removeFavorite' : 'photosModule.addFavorite')}
                  className="rounded-lg bg-elevated p-2 hover:bg-elevated transition">
                  <Heart className={cn('h-4 w-4', photos[lightboxIdx].is_favorite && 'fill-red-400 text-red-400')} />
                </button>
                <button onClick={() => { if (confirm(tr('photosModule.deleteThisPhoto'))) deletePhoto(photos[lightboxIdx]); }}
                  aria-label={tr('photos.deletePhoto')}
                  className="rounded-lg bg-red-500/20 p-2 text-red-400 hover:bg-red-500/30 transition">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Close */}
          <button onClick={() => setLightboxIdx(null)}
            aria-label={tr('photos.close')}
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-elevated text-fg hover:bg-elevated transition">
            <X className="h-5 w-5" />
          </button>
        </div>
      )}

      {/* New Album Modal */}
      {newAlbumOpen && (
        <NewAlbumModal familyId={familyId} userId={userId}
          onClose={() => setNewAlbumOpen(false)}
          onCreated={() => { setNewAlbumOpen(false); void refreshAlbums(); }} />
      )}

      {/* Upload Modal */}
      {uploadOpen && (
        <UploadModal
          onClose={() => setUploadOpen(false)}
          onUpload={uploadFiles}
          progress={uploadProgress} />
      )}

      {/* Edit caption modal */}
      {editPhoto && (
        <EditPhotoModal photo={editPhoto}
          onClose={() => setEditPhoto(null)}
          onSave={(caption) => updateCaption(editPhoto, caption)} />
      )}
    </div>
  );
}

function NewAlbumModal({ familyId, userId, onClose, onCreated }: {
  familyId: string; userId: string; onClose: () => void; onCreated: () => void;
}) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('general');
  const [description, setDescription] = useState('');

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.from('family_albums').insert({
      family_id: familyId, name: name.trim(), kind, description: description.trim() || null, created_by: userId,
    });
    setLoading(false);
    if (error) { toastError(describeDbError(error)); return; }
    onCreated();
  }

  return (
    <Modal open onClose={onClose} title={tr('photos.newAlbum')}>
      <form onSubmit={create} className="space-y-4">
        <Field label={tr('photos.albumName')} required>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('photosModule.summer2025EmmaSBirthday')} autoFocus />}
        </Field>
        <Field label={tr('photos.category')}>
          {(id) => (
            <div className="grid grid-cols-4 gap-2">
              {ALBUM_KINDS.map((k) => (
                <button key={k.id} type="button" onClick={() => setKind(k.id)}
                  className={cn('flex flex-col items-center gap-1.5 rounded-xl border p-2 text-xs transition',
                    kind === k.id ? 'border-brand/60 bg-brand/10' : 'border-border hover:bg-elevated')}>
                  <k.icon className="h-5 w-5" style={{ color: k.color }} />
                  {tr(k.labelKey)}
                </button>
              ))}
            </div>
          )}
        </Field>
        <Field label={tr('photos.descriptionOptional')}>
          {(id) => <Textarea id={id} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={tr('photos.whatIsThisAlbumAbout')} className="min-h-[80px]" />}
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('photos.cancel')}</Button>
          <Button type="submit" loading={loading}>{tr('photos.createAlbum')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function UploadModal({ onClose, onUpload, progress }: {
  onClose: () => void; onUpload: (f: FileList) => void; progress?: { done: number; total: number } | null;
}) {
  const tr = useTranslations();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<File[]>([]);
  const busy = !!progress;

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) setSelected(Array.from(e.target.files));
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); setDragging(false);
    if (busy) return;
    if (e.dataTransfer.files) setSelected(Array.from(e.dataTransfer.files));
  }

  return (
    <Modal open onClose={() => { if (!busy) onClose(); }} title={tr('photos.uploadPhotosVideos')}>
      <div className="space-y-4">
        <div onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => { if (!busy) fileRef.current?.click(); }}
          onKeyDown={(e) => { if (!busy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileRef.current?.click(); } }}
          role="button"
          tabIndex={busy ? -1 : 0}
          aria-label={tr('photos.uploadPhotosOrVideos')}
          aria-disabled={busy}
          className={cn(
            'flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed p-10 text-center transition',
            'focus:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/40',
            busy ? 'cursor-not-allowed border-border opacity-60' : 'cursor-pointer',
            dragging ? 'border-brand bg-brand/10' : !busy && 'border-border hover:border-brand/50 hover:bg-brand/5',
          )}>
          <Upload className="h-10 w-10 text-muted" />
          <div>
            <p className="font-semibold">{tr('photos.dropPhotosOrVideosHereOr')}</p>
            <p className="mt-1 text-sm text-muted">{tr('photos.supportsJpegPngHeicWebpMp4')}</p>
          </div>
          <input ref={fileRef} type="file" accept="image/*,video/*" multiple className="hidden" onChange={handleChange} />
        </div>

        {selected.length > 0 && (
          <div>
            <p className="mb-2 text-sm text-muted">{tr(selected.length === 1 ? 'photosModule.selectedFile' : 'photosModule.selectedFiles', { count: selected.length })}</p>
            <div className="flex flex-wrap gap-2">
              {selected.slice(0, 8).map((f, i) => (
                <div key={i} className="h-14 w-14 overflow-hidden rounded-xl border border-border bg-elevated">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={URL.createObjectURL(f)} alt={f.name} className="h-full w-full object-cover" />
                </div>
              ))}
              {selected.length > 8 && <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-border bg-elevated text-xs text-muted">+{selected.length - 8}</div>}
            </div>
          </div>
        )}

        {/* Live upload progress — honest per-file bar so multi-file uploads aren't a blind wait. */}
        {busy && progress && (
          <div aria-live="polite">
            <div className="h-1.5 overflow-hidden rounded-full bg-border"
              {...progressBarA11y((progress.done / Math.max(progress.total, 1)) * 100, tr('photosModule.uploadProgress', { done: progress.done, total: progress.total }))}>
              <div className="h-full rounded-full bg-brand transition-[width] duration-300"
                style={{ width: `${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%` }} />
            </div>
            <p className="mt-1.5 text-center text-xs text-muted">{tr('photosModule.processedProgress', { done: progress.done, total: progress.total })}</p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>{tr('photos.cancel')}</Button>
          <Button disabled={!selected.length || busy} onClick={() => {
            const dt = new DataTransfer();
            selected.forEach((f) => dt.items.add(f));
            onUpload(dt.files);
          }}>
            {busy && progress
              ? <><Loader2 className="h-4 w-4 animate-spin" /> {tr('photosModule.uploadingFile', { current: Math.min(progress.done + 1, progress.total), total: progress.total })}</>
              : <><Upload className="h-4 w-4" /> {selected.length > 0 ? tr(selected.length === 1 ? 'photosModule.uploadFile' : 'photosModule.uploadFiles', { count: selected.length }) : tr('photos.upload')}</>}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function EditPhotoModal({ photo, onClose, onSave }: { photo: Photo; onClose: () => void; onSave: (caption: string) => void }) {
  const tr = useTranslations();
  const [caption, setCaption] = useState(photo.caption ?? '');
  return (
    <Modal open onClose={onClose} title={tr('photos.editPhoto')}>
      <div className="space-y-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photo.url ?? ''} alt="" className="max-h-48 w-full rounded-xl object-cover" />
        <Field label={tr('photos.caption')}>
          {(id) => <Input id={id} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder={tr('photos.addACaption')} autoFocus />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{tr('photos.cancel')}</Button>
          <Button onClick={() => onSave(caption)}>{tr('photos.save')}</Button>
        </div>
      </div>
    </Modal>
  );
}
