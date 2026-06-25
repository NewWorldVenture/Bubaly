'use client';

// Renders a QR code as an inline SVG (no network calls — the gift token never
// leaves the device). Backed by the `qrcode` library's SVG string output.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function QrCode({ value, size = 220, className }: { value: string; size?: number; className?: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    QRCode.toString(value, { type: 'svg', margin: 1, width: size, errorCorrectionLevel: 'M' })
      .then((out) => { if (alive) setSvg(out); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [value, size]);

  if (failed) {
    return <div className="grid place-items-center rounded-xl bg-surface text-xs text-muted" style={{ width: size, height: size }}>QR unavailable</div>;
  }
  if (!svg) {
    return <div className="animate-pulse rounded-xl bg-surface" style={{ width: size, height: size }} />;
  }
  return (
    <div
      className={className}
      style={{ width: size, height: size }}
      // qrcode emits a self-contained, static <svg>; no user HTML is involved.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
