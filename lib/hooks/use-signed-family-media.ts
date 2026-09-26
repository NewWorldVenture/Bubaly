'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  FAMILY_MEDIA_SIGNED_TTL_SECONDS,
  parseFamilyMediaRef,
  signFamilyMediaRefs,
  type FamilyMediaSigner,
} from '@/lib/storage/family-media-ref';

// The browser side of SEC-001: turn the family-media references a component is
// about to draw into URLs an <img> may load, signed with the viewer's own
// session so Storage checks their family membership.
//
//   const media = useSignedFamilyMedia(photos.map((p) => p.url));
//   <img src={media(p.url) ?? undefined} />
//
// External media (a GIF, a pasted cover) resolves synchronously, so it never
// flickers. An object in this bucket is null until its signed URL arrives,
// and stays null if it cannot be signed: the component draws its placeholder,
// never the stored public URL. Signed URLs are re-minted before they expire,
// so a tab left open all afternoon keeps its pictures.

const RESIGN_MS = Math.floor(FAMILY_MEDIA_SIGNED_TTL_SECONDS * 1000 * 0.8);

export function useSignedFamilyMedia(
  values: readonly (string | null | undefined)[],
  client?: FamilyMediaSigner,
): (value: string | null | undefined) => string | null {
  // A stable key for the distinct values, so a re-render with the same list
  // does not re-sign.
  const key = useMemo(() => [...new Set(values.filter((v): v is string => Boolean(v)))].sort().join('\n'), [values]);
  const [signed, setSigned] = useState<Map<string, string | null>>(() => new Map());

  useEffect(() => {
    if (!key) { setSigned(new Map()); return; }
    let cancelled = false;
    const list = key.split('\n');
    const run = async () => {
      const map = await signFamilyMediaRefs(client ?? (createClient() as unknown as FamilyMediaSigner), list);
      if (!cancelled) setSigned(map);
    };
    void run();
    const timer = setInterval(() => { void run(); }, RESIGN_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [key, client]);

  return useCallback((value: string | null | undefined) => {
    if (!value) return null;
    if (signed.has(value)) return signed.get(value) ?? null;
    const ref = parseFamilyMediaRef(value);
    return ref.kind === 'external' ? ref.url : null;
  }, [signed]);
}
