'use client';

// Screens 9–10 of the mockups: "Create Memory" (photos + title + note) and the
// "Memory Created" confirmation. A memory is stored as one or more favorited,
// captioned rows in family_photos (uploaded to the family-media bucket) so it
// shows up on the Memories timeline alongside milestones and trips. Same storage
// pattern as the Photos module.
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Image as ImageIcon, Plus, X, Check, Sparkles, Loader2, ArrowLeft, Camera } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { progressBarA11y } from '@/lib/ui/a11y';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Textarea } from '@/components/ui/input';
import { CameraCapture } from '@/components/ui/camera-capture';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useJourney } from '@/lib/analytics/use-journey';
import { partitionBySize, oversizeMessage } from '@/lib/storage/family-media';

type Pick = { file: File; preview: string };

export function CreateMemory() {
  const router = useRouter();
  const { familyId, userId } = useApp();
  const { error: toastError, success } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const journey = useJourney('add_memory');

  // Telemetry: the "add a memory" journey starts on arrival (Experience
  // Scorecard); completion is recorded on a successful save below.
  useEffect(() => {
    journey.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [picks, setPicks] = useState<Pick[]>([]);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [created, setCreated] = useState<{ id: string; path: string }[]>([]);
  const [undoing, setUndoing] = useState(false);
  const [done, setDone] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  // Revoke object URLs on unmount / when replaced to avoid leaks.
  useEffect(() => () => { picks.forEach((p) => URL.revokeObjectURL(p.preview)); }, [picks]);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const images = Array.from(list).filter((f) => f.type.startsWith('image/'));
    if (!images.length) { toastError('Please choose image files.'); return; }
    // Drop anything over the family-media bucket limit before it can fail mid-upload.
    const { ok, tooBig } = partitionBySize(images);
    const msg = oversizeMessage(tooBig.length);
    if (msg) toastError(msg);
    if (!ok.length) return;
    setPicks((prev) => [...prev, ...ok.map((file) => ({ file, preview: URL.createObjectURL(file) }))]);
  }

  // A photo captured from the live camera (already a JPEG File).
  function addCaptured(file: File) {
    setPicks((prev) => [...prev, { file, preview: URL.createObjectURL(file) }]);
  }

  function removeAt(i: number) {
    setPicks((prev) => {
      URL.revokeObjectURL(prev[i].preview);
      return prev.filter((_, idx) => idx !== i);
    });
  }

  const canSave = title.trim().length > 0 && picks.length > 0 && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setProgress({ done: 0, total: picks.length });
    const supabase = createClient();
    const trimmedNote = note.trim();
    // Fold the note into the caption: the Memories timeline surfaces any captioned
    // (or favorited) photo, and uses the caption as the memory's title/blurb.
    const caption = trimmedNote ? `${title.trim()} — ${trimmedNote}` : title.trim();
    const takenAt = new Date().toISOString();
    const createdRows: { id: string; path: string }[] = [];
    let saved = 0;
    for (let i = 0; i < picks.length; i++) {
      const { file } = picks[i];
      const ext = file.name.split('.').pop() || 'jpg';
      const path = `${familyId}/photos/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const { data: stored, error: upErr } = await supabase.storage
        .from('family-media')
        .upload(path, file, { upsert: false, cacheControl: '31536000' });
      if (upErr) {
        toastError(`Couldn’t upload ${file.name}: ${upErr.message}`);
      } else {
        const { data: { publicUrl } } = supabase.storage.from('family-media').getPublicUrl(stored.path);
        const { data: row, error: insErr } = await supabase.from('family_photos').insert({
          family_id: familyId,
          uploaded_by: userId,
          storage_path: stored.path,
          url: publicUrl,
          caption,
          taken_at: takenAt,
          size_bytes: file.size,
          media_type: 'image',
        }).select('id').single();
        if (insErr || !row) {
          toastError(describeDbError(insErr ?? { message: 'Could not save memory' }));
        } else {
          // Mark it a favorite so it also shows in the Photos "Favorites" tab.
          await supabase.from('family_photos').update({ is_favorite: true }).eq('id', row.id);
          createdRows.push({ id: row.id, path: stored.path });
          saved++;
        }
      }
      // Advance the visible progress after each file (success or skip).
      setProgress({ done: i + 1, total: picks.length });
    }
    setSaving(false);
    setProgress(null);
    if (saved === 0) return; // errors already surfaced
    setCreated(createdRows);
    journey.complete();
    setDone(true);
  }

  // Reverse the just-created memory: delete its photo rows + storage objects,
  // then return to the form (picks/title/note are still in state) so nothing is lost.
  async function undo() {
    if (undoing) return;
    setUndoing(true);
    const supabase = createClient();
    const ids = created.map((c) => c.id);
    const paths = created.map((c) => c.path);
    if (paths.length) await supabase.storage.from('family-media').remove(paths);
    if (ids.length) await supabase.from('family_photos').delete().in('id', ids);
    setCreated([]);
    setUndoing(false);
    setDone(false);
    success('Memory undone — nothing was saved.');
  }

  // ── Memory Created (screen 10) ───────────────────────────────
  if (done) {
    return (
      <div className="mx-auto w-full max-w-md px-4 py-10 text-center">
        <div className="relative mx-auto h-24 w-24">
          {picks[0] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={picks[0].preview} alt="" className="h-24 w-24 rounded-2xl object-cover" />
          ) : (
            <div className="grid h-24 w-24 place-items-center rounded-2xl bg-brand/15 text-brand-text"><ImageIcon className="h-10 w-10" /></div>
          )}
          <span className="absolute -bottom-1 -right-1 grid h-8 w-8 place-items-center rounded-full bg-emerald-500 text-white ring-4 ring-bg">
            <Check className="h-4 w-4" />
          </span>
        </div>
        <h1 className="mt-5 text-2xl font-bold">Memory created!</h1>
        <p className="mx-auto mt-2 max-w-xs text-sm text-muted">
          “{title.trim()}” is saved to your family memories{picks.length > 1 ? ` (${picks.length} photos)` : ''}.
        </p>
        <div className="mt-8 space-y-3">
          <Button className="w-full" onClick={() => { router.push('/dashboard/memories'); router.refresh(); }}>
            View memories
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => { setPicks([]); setTitle(''); setNote(''); setCreated([]); setDone(false); }}
          >
            <Plus className="h-4 w-4" /> Create another
          </Button>
          {created.length > 0 && (
            <button
              onClick={undo}
              disabled={undoing}
              className="mx-auto flex items-center gap-1.5 text-sm font-medium text-muted underline underline-offset-2 hover:text-danger disabled:opacity-50"
            >
              {undoing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {undoing ? 'Undoing…' : 'Undo — remove this memory'}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Create Memory (screen 9) ─────────────────────────────────
  return (
    <div className="mx-auto w-full max-w-lg px-4 py-6 sm:py-8">
      <div className="mb-6 flex items-center gap-3">
        <Link href="/dashboard/memories" className="grid h-9 w-9 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-fg" aria-label="Back to memories">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Create memory</h1>
          <p className="text-sm text-muted">Add photos, a title, and a note to remember the moment.</p>
        </div>
      </div>

      {/* Photo picker */}
      <div className="grid grid-cols-3 gap-3">
        {picks.map((p, i) => (
          <div key={i} className="group relative aspect-square overflow-hidden rounded-2xl border border-border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.preview} alt="" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => removeAt(i)}
              className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/60 text-white transition hover:bg-black/80"
              aria-label="Remove photo"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setCameraOpen(true)}
          className="flex aspect-square flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-border text-muted transition hover:border-brand/50 hover:bg-brand/5 hover:text-brand-text"
        >
          <Camera className="h-7 w-7" />
          <span className="text-xs font-medium">Take photo</span>
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex aspect-square flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-border text-muted transition hover:border-brand/50 hover:bg-brand/5 hover:text-brand-text"
        >
          <Plus className="h-7 w-7" />
          <span className="text-xs font-medium">Upload</span>
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
          onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
      </div>

      {cameraOpen && (
        <CameraCapture onCapture={addCaptured} onClose={() => setCameraOpen(false)} />
      )}

      {/* Details */}
      <div className="mt-6 space-y-4">
        <Field label="Title" required>
          {(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Beach day, first steps, Grandma’s visit…" maxLength={120} />}
        </Field>
        <Field label="Note (optional)">
          {(id) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What made this moment special?" className="min-h-[96px]" maxLength={1000} />}
        </Field>
      </div>

      <Button className="mt-7 w-full" disabled={!canSave} onClick={save}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {saving
          ? progress && progress.total > 1
            ? `Uploading ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
            : 'Saving…'
          : `Save memory${picks.length > 1 ? ` (${picks.length} photos)` : ''}`}
      </Button>

      {/* Upload progress — honest per-file bar so multi-photo saves aren't a blind wait. */}
      {saving && progress && (
        <div className="mt-3" aria-live="polite">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-border"
            {...progressBarA11y((progress.done / Math.max(progress.total, 1)) * 100, `Uploading: ${progress.done} of ${progress.total}`)}
          >
            <div
              className="h-full rounded-full bg-brand transition-[width] duration-300"
              style={{ width: `${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%` }}
            />
          </div>
          <p className="mt-1.5 text-center text-xs text-muted">
            {progress.done} of {progress.total} uploaded
          </p>
        </div>
      )}

      {picks.length === 0 && (
        <p className="mt-2 text-center text-xs text-muted">Add at least one photo to save a memory.</p>
      )}
    </div>
  );
}
