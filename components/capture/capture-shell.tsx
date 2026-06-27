'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useRef, useEffect, useMemo } from 'react';
import {
  Mic, Type, Camera, FileText, Sparkles, X, ArrowRight,
  Loader2, ChevronDown, Settings2, GripVertical, Plus, Check, Upload, Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useToast } from '@/components/ui/toast';
import { createClient } from '@/lib/supabase/client';
import { uploadFamilyDocument } from '@/lib/storage/documents';
import {
  availableQuickRoutes, resolveQuickRoutes, defaultQuickRouteKeys, type QuickRoute,
} from '@/lib/capture/quick-routes';
import { saveCaptureRoutesAction } from '@/app/(app)/capture/actions';

type CaptureMode = 'type' | 'voice' | 'photo' | 'document';

const ROUTES_STORAGE_KEY = 'bubaly.capture.quickRoutes';

function loadSavedKeys(): string[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ROUTES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((k) => typeof k === 'string') ? parsed : null;
  } catch { return null; }
}

function routeCapture(text: string): { destination: string; url: string } {
  const lower = text.toLowerCase();
  if (/buy|shop|grocery|groceries|store|milk|eggs|bread|chicken|produce/.test(lower))
    return { destination: 'Grocery List', url: '/dashboard/grocery' };
  if (/event|party|birthday|meeting|appointment|schedule|doctor|dentist|school/.test(lower))
    return { destination: 'Calendar', url: '/dashboard/calendar' };
  if (/meal|recipe|dinner|lunch|breakfast|cook|food/.test(lower))
    return { destination: 'Meals', url: '/dashboard/meals' };
  if (/trip|vacation|travel|flight|hotel|pack/.test(lower))
    return { destination: 'Trip Planner', url: '/dashboard/trips' };
  if (/health|symptom|medicine|medication|sick|pain|fever/.test(lower))
    return { destination: 'Health', url: '/dashboard/health' };
  if (/document|scan|file|pdf|receipt|invoice/.test(lower))
    return { destination: 'Documents', url: '/dashboard/documents' };
  if (/note|remember|idea|thought/.test(lower))
    return { destination: 'Notes', url: '/dashboard/notes' };
  if (/task|todo|remind|chore|clean|fix|repair|do|finish/.test(lower))
    return { destination: 'Tasks & Chores', url: '/dashboard/chores' };
  return { destination: 'AI Assistant', url: `/dashboard/assistant?q=${encodeURIComponent(text)}` };
}

export function CaptureShell({ planLevel = 0, savedRouteKeys = null, familyId, userId }: {
  planLevel?: number; savedRouteKeys?: string[] | null; familyId?: string; userId?: string;
}) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [mode, setMode] = useState<CaptureMode>('type');
  const [text, setText] = useState('');
  const [routing, setRouting] = useState(false);
  const [routed, setRouted] = useState<{ destination: string; url: string } | null>(null);
  const [recording, setRecording] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Photo / Scan capture.
  const photoInputRef = useRef<HTMLInputElement>(null);
  const scanInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  function pickPhoto() { setMode('photo'); setRouted(null); photoInputRef.current?.click(); }
  function pickScan() { setMode('document'); setRouted(null); scanInputRef.current?.click(); }

  function onFilePicked(f: File | null) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (!f) { setFile(null); setPreviewUrl(null); return; }
    setFile(f);
    setPreviewUrl(f.type.startsWith('image/') ? URL.createObjectURL(f) : null);
  }
  function clearFile() { onFilePicked(null); if (photoInputRef.current) photoInputRef.current.value = ''; if (scanInputRef.current) scanInputRef.current.value = ''; }

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  async function uploadCapture() {
    if (!file) return;
    if (!familyId || !userId) { toastError('Please sign in again to upload.'); return; }
    setUploading(true);
    const supabase = createClient();
    try {
      if (mode === 'photo') {
        const ext = file.name.split('.').pop() || 'jpg';
        const path = `${familyId}/photos/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const { data: stored, error: upErr } = await supabase.storage
          .from('family-media').upload(path, file, { upsert: false, cacheControl: '31536000' });
        if (upErr || !stored) throw new Error(upErr?.message ?? 'Upload failed');
        const { data: { publicUrl } } = supabase.storage.from('family-media').getPublicUrl(stored.path);
        const { error: insErr } = await supabase.from('family_photos').insert({
          family_id: familyId, uploaded_by: userId, storage_path: stored.path, url: publicUrl,
          size_bytes: file.size, media_type: file.type.startsWith('video/') ? 'video' : 'image',
        });
        if (insErr) { await supabase.storage.from('family-media').remove([stored.path]); throw new Error(insErr.message); }
        success('Photo added');
        router.push('/dashboard/photos');
      } else {
        const { path, error: upErr } = await uploadFamilyDocument(supabase, { familyId, folder: 'scans', file });
        if (upErr || !path) throw new Error(upErr ?? 'Upload failed');
        const title = file.name.replace(/\.[^.]+$/, '').slice(0, 120) || 'Scan';
        const { error: insErr } = await supabase.from('documents').insert({
          family_id: familyId, title, category: 'other', created_by: userId,
          storage_path: path, size_bytes: file.size, mime_type: file.type || null,
        });
        if (insErr) throw new Error(insErr.message);
        success('Scan saved to Documents');
        router.push('/dashboard/documents');
      }
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  // Quick-jump buttons: tier-gated catalog + the user's saved customization.
  // Source of truth is Supabase (synced across devices); localStorage is an
  // offline cache used only when the server has no saved selection yet.
  const available = useMemo(() => availableQuickRoutes(planLevel), [planLevel]);
  const [savedKeys, setSavedKeys] = useState<string[] | null>(savedRouteKeys);
  const [customizing, setCustomizing] = useState(false);
  useEffect(() => {
    if (savedRouteKeys == null) setSavedKeys(loadSavedKeys());
  }, [savedRouteKeys]);
  const quickRoutes = useMemo(() => resolveQuickRoutes(savedKeys, planLevel), [savedKeys, planLevel]);

  async function saveRoutes(keys: string[]) {
    // An empty selection means "use the tier default" rather than no buttons.
    const next = keys.length > 0 ? keys : defaultQuickRouteKeys(planLevel);
    setSavedKeys(next); // optimistic
    try { window.localStorage.setItem(ROUTES_STORAGE_KEY, JSON.stringify(next)); } catch { /* cache unavailable */ }
    const res = await saveCaptureRoutesAction(next);
    if (res.ok) success('Buttons saved');
    else toastError('Saved on this device — sync will retry later.');
  }

  function handleInput(value: string) {
    setText(value);
    setRouted(null);
  }

  function handleSubmit() {
    if (!text.trim()) return;
    setRouting(true);
    setTimeout(() => {
      setRouted(routeCapture(text));
      setRouting(false);
    }, 500);
  }

  function goToDestination() {
    if (routed) router.push(routed.url);
  }

  function startVoice() {
    type SpeechResult = { transcript: string };
    type SRCtor = new () => {
      lang: string; interimResults: boolean;
      onresult: ((e: { results: SpeechResult[][] }) => void) | null;
      onerror: (() => void) | null;
      onend: (() => void) | null;
      start: () => void;
    };
    const w = window as unknown as Record<string, unknown>;
    const SR: SRCtor | undefined = (w['SpeechRecognition'] ?? w['webkitSpeechRecognition']) as SRCtor | undefined;
    if (!SR) { toastError('Voice input is not supported in this browser.'); return; }
    const recognition = new SR();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    setRecording(true);
    recognition.onresult = (e) => {
      const transcript = e.results[0]?.[0]?.transcript ?? '';
      setText(transcript);
      setRecording(false);
      setMode('type');
    };
    recognition.onerror = () => { setRecording(false); toastError('Could not capture voice. Try again.'); };
    recognition.onend = () => setRecording(false);
    recognition.start();
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg pb-24 pt-4">
      <div className="mx-auto w-full max-w-lg px-4">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Capture</h1>
            <p className="text-sm text-muted">Speak, type, or snap — AI routes it instantly.</p>
          </div>
          <button type="button" onClick={() => router.back()}
            className="grid h-9 w-9 place-items-center rounded-full bg-elevated text-muted hover:text-fg">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Mode picker */}
        <div className="mb-4 grid grid-cols-4 gap-2">
          {([
            { id: 'type' as const, icon: Type, label: 'Type', action: () => { setMode('type'); textRef.current?.focus(); } },
            { id: 'voice' as const, icon: Mic, label: 'Voice', action: () => { setMode('voice'); startVoice(); } },
            { id: 'photo' as const, icon: Camera, label: 'Photo', action: pickPhoto },
            { id: 'document' as const, icon: FileText, label: 'Scan', action: pickScan },
          ]).map(({ id, icon: Icon, label, action }) => (
            <button key={id} type="button" onClick={action}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-2xl py-3 text-xs font-semibold transition',
                mode === id ? 'bg-brand/15 text-brand' : 'bg-elevated text-muted hover:bg-elevated/80 hover:text-fg',
              )}>
              <Icon className="h-5 w-5" />
              {label}
            </button>
          ))}
        </div>

        {/* Hidden capture inputs (camera on mobile) */}
        <input ref={photoInputRef} type="file" accept="image/*" capture="environment" className="hidden"
          onChange={(e) => onFilePicked(e.target.files?.[0] ?? null)} />
        <input ref={scanInputRef} type="file" accept="image/*,application/pdf" className="hidden"
          onChange={(e) => onFilePicked(e.target.files?.[0] ?? null)} />

        {/* Input area */}
        <div className="relative mb-4 overflow-hidden rounded-2xl border border-border bg-surface/40 focus-within:border-brand/50 focus-within:ring-1 focus-within:ring-brand/30">
          {recording ? (
            <div className="flex min-h-[120px] flex-col items-center justify-center gap-3 p-6">
              <div className="relative">
                <Mic className="h-10 w-10 text-brand" />
                <span className="absolute inset-0 animate-ping rounded-full bg-brand/30" />
              </div>
              <p className="text-sm font-medium text-brand">Listening…</p>
              <button type="button" onClick={() => setRecording(false)} className="text-xs text-muted underline">Cancel</button>
            </div>
          ) : (mode === 'photo' || mode === 'document') ? (
            file ? (
              <div className="flex items-center gap-3 p-4">
                {previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewUrl} alt="Capture preview" className="h-16 w-16 rounded-xl object-cover" />
                ) : (
                  <div className="grid h-16 w-16 place-items-center rounded-xl bg-elevated text-muted"><FileText className="h-7 w-7" /></div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{file.name}</p>
                  <p className="text-xs text-muted">{(file.size / 1024 / 1024).toFixed(1)} MB · {mode === 'photo' ? 'Photo' : 'Scan'}</p>
                </div>
                <button type="button" onClick={clearFile} aria-label="Remove file" className="rounded-lg p-2 text-muted hover:bg-elevated hover:text-danger"><Trash2 className="h-4 w-4" /></button>
              </div>
            ) : (
              <button type="button" onClick={mode === 'photo' ? pickPhoto : pickScan}
                className="flex min-h-[120px] w-full flex-col items-center justify-center gap-2 p-6 text-muted transition hover:text-brand">
                {mode === 'photo' ? <Camera className="h-9 w-9" /> : <FileText className="h-9 w-9" />}
                <span className="text-sm font-medium">{mode === 'photo' ? 'Take or choose a photo' : 'Choose a document or photo to scan'}</span>
              </button>
            )
          ) : (
            <textarea
              ref={textRef}
              value={text}
              onChange={(e) => handleInput(e.target.value)}
              placeholder={'What\'s on your mind? "Buy milk", "Plan birthday party", "Schedule dentist"…'}
              className="min-h-[120px] w-full resize-none bg-transparent p-4 text-sm outline-none placeholder:text-muted"
              autoFocus={mode === 'type'}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit(); }}
            />
          )}
          {text && !recording && mode !== 'photo' && mode !== 'document' && (
            <div className="flex items-center justify-between border-t border-border/60 px-4 py-2">
              <span className="text-xs text-muted">{text.length} chars</span>
              <button type="button" onClick={() => handleInput('')} className="text-xs text-muted hover:text-fg">Clear</button>
            </div>
          )}
        </div>

        {/* Primary action */}
        {(mode === 'photo' || mode === 'document') ? (
          <button type="button" disabled={!file || uploading} onClick={uploadCapture}
            className="mb-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand py-4 text-sm font-bold text-white transition hover:bg-brand/90 disabled:opacity-40">
            {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
            {uploading ? 'Uploading…' : mode === 'photo' ? 'Save to Photos' : 'Save to Documents'}
          </button>
        ) : routed ? (
          <div className="mb-4 overflow-hidden rounded-2xl border border-brand/30 bg-brand/5">
            <div className="flex items-center gap-3 p-4">
              <Sparkles className="h-5 w-5 shrink-0 text-brand" />
              <div className="flex-1">
                <p className="text-sm font-semibold">Sending to <span className="text-brand">{routed.destination}</span></p>
                <p className="text-xs text-muted">AI matched your input to the best destination.</p>
              </div>
            </div>
            <div className="flex gap-2 border-t border-brand/20 p-3">
              <button type="button" onClick={goToDestination}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand/90">
                Go to {routed.destination} <ArrowRight className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => setRouted(null)}
                className="flex items-center gap-1.5 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-elevated">
                <ChevronDown className="h-4 w-4" /> Change
              </button>
            </div>
          </div>
        ) : (
          <button type="button" disabled={!text.trim() || routing} onClick={handleSubmit}
            className="mb-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand py-4 text-sm font-bold text-white transition hover:bg-brand/90 disabled:opacity-40">
            {routing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />}
            {routing ? 'Routing with AI…' : 'Let AI Route This'}
          </button>
        )}

        {/* Quick route chips */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Or jump directly to</p>
            <button type="button" onClick={() => setCustomizing(true)}
              className="flex items-center gap-1 text-xs font-medium text-muted transition hover:text-brand">
              <Settings2 className="h-3.5 w-3.5" /> Customize
            </button>
          </div>
          {quickRoutes.length === 0 ? (
            <button type="button" onClick={() => setCustomizing(true)}
              className="flex w-full flex-col items-center gap-1.5 rounded-2xl border border-dashed border-border p-5 text-center text-sm text-muted transition hover:border-brand/30 hover:text-brand">
              <Plus className="h-5 w-5" /> Add quick-jump buttons
            </button>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {quickRoutes.map(({ key, icon: Icon, label, href, hint }) => (
                <Link key={key} href={href}
                  className="flex flex-col items-center gap-1.5 rounded-2xl border border-border bg-surface/40 p-3 text-center transition hover:border-brand/30 hover:bg-elevated">
                  <Icon className="h-6 w-6 text-brand" />
                  <span className="text-xs font-semibold">{label}</span>
                  <span className="text-[10px] text-muted">{hint}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {customizing && (
        <CustomizeRoutes
          available={available}
          current={quickRoutes}
          onSave={(keys) => { saveRoutes(keys); setCustomizing(false); }}
          onReset={() => { saveRoutes(defaultQuickRouteKeys(planLevel)); setCustomizing(false); }}
          onClose={() => setCustomizing(false)}
        />
      )}
    </div>
  );
}

// Lets the user pick which quick-jump buttons appear and their order. Only
// tier-accessible routes are offered (locked features are never listed).
function CustomizeRoutes({
  available, current, onSave, onReset, onClose,
}: {
  available: QuickRoute[];
  current: QuickRoute[];
  onSave: (keys: string[]) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  // Ordered working list: currently-shown routes first (in their order), then
  // the remaining available routes. A checkbox toggles whether each is shown.
  const [order, setOrder] = useState<string[]>(() => {
    const shown = current.map((r) => r.key);
    const rest = available.map((r) => r.key).filter((k) => !shown.includes(k));
    return [...shown, ...rest];
  });
  const [shown, setShown] = useState<Set<string>>(() => new Set(current.map((r) => r.key)));
  const byKey = useMemo(() => new Map(available.map((r) => [r.key, r])), [available]);

  function toggle(key: string) {
    setShown((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function move(key: string, dir: -1 | 1) {
    setOrder((o) => {
      const i = o.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= o.length) return o;
      const next = [...o];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-t-2xl border border-border bg-bg sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border p-4">
          <div>
            <h3 className="font-bold text-fg">Customize quick buttons</h3>
            <p className="text-xs text-muted">Choose which buttons show and reorder them.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted hover:bg-elevated"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex-1 divide-y divide-border overflow-auto">
          {order.map((key) => {
            const r = byKey.get(key);
            if (!r) return null;
            const on = shown.has(key);
            const Icon = r.icon;
            return (
              <div key={key} className="flex items-center gap-3 px-4 py-2.5">
                <button type="button" onClick={() => toggle(key)} aria-label={on ? `Hide ${r.label}` : `Show ${r.label}`}
                  className={cn('grid h-5 w-5 shrink-0 place-items-center rounded border', on ? 'border-brand bg-brand text-white' : 'border-border text-transparent')}>
                  <Check className="h-3.5 w-3.5" />
                </button>
                <Icon className={cn('h-5 w-5 shrink-0', on ? 'text-brand' : 'text-muted')} />
                <div className="min-w-0 flex-1">
                  <p className={cn('text-sm font-medium', !on && 'text-muted')}>{r.label}</p>
                  <p className="text-[11px] text-muted">{r.hint}</p>
                </div>
                <div className="flex items-center gap-0.5 text-muted">
                  <button type="button" onClick={() => move(key, -1)} aria-label={`Move ${r.label} up`} className="rounded p-1 hover:bg-elevated hover:text-fg">▲</button>
                  <button type="button" onClick={() => move(key, 1)} aria-label={`Move ${r.label} down`} className="rounded p-1 hover:bg-elevated hover:text-fg">▼</button>
                  <GripVertical className="h-4 w-4 opacity-40" />
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border p-4">
          <button type="button" onClick={onReset} className="text-sm font-medium text-muted hover:text-fg">Reset to default</button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted hover:text-fg">Cancel</button>
            <button type="button" onClick={() => onSave(order.filter((k) => shown.has(k)))}
              className="rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90">Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
