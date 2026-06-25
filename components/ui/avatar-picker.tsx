'use client';

import { useRef, useState } from 'react';
import { Camera, Check, Loader2, X } from 'lucide-react';
import { uploadAvatar } from '@/lib/storage/avatars';
import { createClient } from '@/lib/supabase/client';
import { initials } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';

function presetSvgUrl(from: string, to: string, id: string): string {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">`,
    `<defs><linearGradient id="${id}" x1="0%" y1="0%" x2="100%" y2="100%">`,
    `<stop offset="0%" stop-color="${from}"/>`,
    `<stop offset="100%" stop-color="${to}"/>`,
    `</linearGradient></defs>`,
    `<circle cx="40" cy="40" r="40" fill="url(#${id})"/>`,
    `</svg>`,
  ].join('');
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// Preset gradient circles — stored as data URIs in profiles.avatar_url
const PRESET_AVATARS = [
  { id: 'violet', label: 'Violet', url: presetSvgUrl('#8b5cf6', '#6d28d9', 'a1') },
  { id: 'indigo', label: 'Indigo', url: presetSvgUrl('#6366f1', '#4338ca', 'a2') },
  { id: 'blue', label: 'Blue', url: presetSvgUrl('#3b82f6', '#1d4ed8', 'a3') },
  { id: 'cyan', label: 'Cyan', url: presetSvgUrl('#06b6d4', '#0e7490', 'a4') },
  { id: 'teal', label: 'Teal', url: presetSvgUrl('#14b8a6', '#0f766e', 'a5') },
  { id: 'green', label: 'Green', url: presetSvgUrl('#22c55e', '#15803d', 'a6') },
  { id: 'amber', label: 'Amber', url: presetSvgUrl('#f59e0b', '#b45309', 'a7') },
  { id: 'orange', label: 'Orange', url: presetSvgUrl('#f97316', '#c2410c', 'a8') },
  { id: 'red', label: 'Red', url: presetSvgUrl('#ef4444', '#b91c1c', 'a9') },
  { id: 'pink', label: 'Pink', url: presetSvgUrl('#ec4899', '#be185d', 'aa') },
  { id: 'rose', label: 'Rose', url: presetSvgUrl('#f43f5e', '#be123c', 'ab') },
  { id: 'slate', label: 'Slate', url: presetSvgUrl('#64748b', '#334155', 'ac') },
];

interface AvatarPickerProps {
  /** Form field name — the hidden input will carry the selected URL */
  name?: string;
  /** Current avatar URL (preset data URI or Supabase Storage URL) */
  defaultValue?: string;
  /** Used to render initials in the live preview when no avatar is set */
  displayName?: string;
  /** Notified whenever the selection changes (for controlled/state-driven forms). */
  onChange?: (url: string) => void;
}

export function AvatarPicker({ name = 'avatarUrl', defaultValue = '', displayName = '', onChange }: AvatarPickerProps) {
  const [selected, setSelectedState] = useState(defaultValue);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const setSelected = (v: string) => { setSelectedState(v); onChange?.(v); };

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setUploading(true);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not signed in');
      const { url, error: upErr } = await uploadAvatar(supabase, user.id, file);
      if (upErr) throw new Error(upErr);
      setSelected(url ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div>
      {/* Hidden form input */}
      <input type="hidden" name={name} value={selected} />

      {/* Live preview + label */}
      <div className="mb-3 flex items-center gap-4">
        <div className="relative h-16 w-16 shrink-0">
          {selected ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={selected}
              alt="Your avatar"
              className="h-full w-full rounded-full object-cover ring-2 ring-brand/30"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center rounded-full bg-brand/10 text-xl font-bold text-brand">
              {initials(displayName) || '?'}
            </div>
          )}
          {selected && (
            <button
              type="button"
              onClick={() => setSelected('')}
              aria-label="Remove avatar"
              className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface shadow-sm transition hover:bg-elevated"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <div>
          <p className="text-sm font-medium">Profile photo</p>
          <p className="mt-0.5 text-xs text-muted">Pick a color theme or upload your photo</p>
        </div>
      </div>

      {/* Preset color grid + upload button */}
      <div className="flex flex-wrap items-center gap-2">
        {PRESET_AVATARS.map((p) => {
          const active = selected === p.url;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelected(p.url)}
              aria-label={`${p.label} avatar`}
              aria-pressed={active}
              className={cn(
                'relative h-9 w-9 rounded-full transition-transform hover:scale-110 focus:outline-none',
                active
                  ? 'ring-2 ring-brand ring-offset-2 ring-offset-surface'
                  : 'ring-1 ring-border ring-offset-1 ring-offset-surface',
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt={p.label} className="h-full w-full rounded-full" />
              {active && (
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/20">
                  <Check className="h-4 w-4 text-white drop-shadow" />
                </span>
              )}
            </button>
          );
        })}

        {/* Upload button — styled as part of the grid */}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          aria-label={uploading ? 'Uploading…' : 'Upload your own photo'}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashed border-border bg-elevated transition hover:bg-surface disabled:opacity-60"
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted" />
          ) : (
            <Camera className="h-4 w-4 text-muted" />
          )}
        </button>
      </div>

      {error && <p className="mt-1.5 text-xs text-danger" role="alert">{error}</p>}

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
        className="hidden"
        onChange={handleUpload}
      />
    </div>
  );
}
