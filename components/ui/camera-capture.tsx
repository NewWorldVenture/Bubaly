'use client';

// Reusable in-browser camera. Streams the device camera via getUserMedia into a
// live <video>, and a shutter grabs the current frame to a JPEG File (drawn on an
// offscreen canvas). Works on desktop and mobile (HTTPS + permission required);
// on failure it degrades to the native file picker with capture="environment".
// Fully cleans up the MediaStream on close/unmount.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, X, SwitchCamera, ImagePlus, Check } from 'lucide-react';
import { useLockBodyScroll } from '@/lib/hooks/use-lock-body-scroll';
import { useTranslations } from '@/components/i18n/locale-provider';

type FacingMode = 'environment' | 'user';

function describeCameraError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera access was blocked. Allow camera permission in your browser, or upload a photo instead.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device. You can upload a photo instead.';
  if (name === 'NotReadableError') return 'The camera is in use by another app. Close it and try again, or upload a photo instead.';
  return 'Couldn’t start the camera. You can upload a photo instead.';
}

export function CameraCapture({
  onCapture,
  onClose,
}: {
  /** Called with a JPEG File for each shot taken. */
  onCapture: (file: File) => void;
  onClose: () => void;
}) {
  const tr = useTranslations();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fallbackRef = useRef<HTMLInputElement>(null);

  const [facing, setFacing] = useState<FacingMode>('environment');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [flash, setFlash] = useState(false);

  // Full-screen camera: lock the page behind it so touch-scroll can't drag the
  // underlying page out from under the viewfinder on mobile.
  useLockBodyScroll(true);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Start (and restart on camera flip) the stream; clean up on unmount.
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(null);
    (async () => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setError(tr('cameraCapture.thisBrowserDoesnTSupport'));
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        stop(); // drop any previous stream before swapping
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => { /* autoplay guarded below */ });
        }
        setReady(true);
      } catch (err) {
        if (!cancelled) setError(describeCameraError(err));
      }
    })();
    return () => { cancelled = true; stop(); };
  }, [facing, stop, tr]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleClose() {
    stop();
    onClose();
  }

  function shoot() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      onCapture(new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      setCount((c) => c + 1);
      setFlash(true);
      setTimeout(() => setFlash(false), 160);
    }, 'image/jpeg', 0.92);
  }

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-black pt-[var(--safe-top)] pb-[var(--safe-bottom)] pl-[var(--safe-left)] pr-[var(--safe-right)]" role="dialog" aria-modal="true" aria-label={tr('cameraCapture.takeAPhoto')}>
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <button type="button" onClick={handleClose} aria-label={tr('cameraCapture.closeCamera')} className="grid h-10 w-10 place-items-center rounded-full bg-white/10 hover:bg-white/20">
          <X className="h-5 w-5" />
        </button>
        <span className="text-sm font-medium">{count > 0 ? `${count} photo${count === 1 ? '' : 's'} added` : 'Take a photo'}</span>
        <button type="button" onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))}
          aria-label={tr('cameraCapture.switchCamera')} disabled={!!error}
          className="grid h-10 w-10 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30">
          <SwitchCamera className="h-5 w-5" />
        </button>
      </div>

      {/* Viewfinder */}
      <div className="relative flex-1 overflow-hidden">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center text-white">
            <Camera className="h-12 w-12 text-white/50" />
            <p className="max-w-sm text-sm text-white/80">{error}</p>
            <button type="button" onClick={() => fallbackRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black hover:bg-white/90">
              <ImagePlus className="h-4 w-4" /> {tr('cameraCapture.uploadAPhoto')}
            </button>
          </div>
        ) : (
          <>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
            {!ready && (
              <div className="absolute inset-0 grid place-items-center text-white/70">
                <span className="text-sm">{tr('cameraCapture.startingCamera')}</span>
              </div>
            )}
            {flash && <div className="absolute inset-0 bg-white/80 transition-opacity" />}
          </>
        )}
      </div>

      {/* Shutter */}
      {!error && (
        <div className="flex items-center justify-center gap-8 px-4 py-6">
          {count > 0 ? (
            <button type="button" onClick={handleClose}
              className="inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/20">
              <Check className="h-4 w-4" /> {tr('cameraCapture.done')}
            </button>
          ) : <span className="w-20" />}
          <button type="button" onClick={shoot} disabled={!ready} aria-label={tr('cameraCapture.takePhoto')}
            className="grid place-items-center rounded-full bg-white ring-4 ring-white/30 transition active:scale-95 disabled:opacity-40"
            style={{ height: '4.5rem', width: '4.5rem' }}>
            <span className="h-14 w-14 rounded-full border-4 border-black/80" />
          </button>
          <span className="w-20" />
        </div>
      )}

      {/* Hidden fallback: native camera/file picker if getUserMedia is unavailable */}
      <input ref={fallbackRef} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) { onCapture(f); }
          e.target.value = '';
          handleClose();
        }} />

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
