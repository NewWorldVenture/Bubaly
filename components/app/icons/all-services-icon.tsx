import type { SVGProps } from 'react';

/**
 * "All Services" launcher icon — a custom line-art illustration of the family
 * services ecosystem: a central gear (services) ringed by a clockwise cycle of
 * arrows, with the core service glyphs around it — crossed tools (home repair),
 * a checklist (planning), a house (household), a first-aid case (health), and a
 * wifi signal (connected home). Drawn with `currentColor` so it inherits the
 * sidebar text color and adapts to light/dark; the viewBox scales cleanly from
 * the 20px sidebar glyph up to any hero size.
 *
 * API-compatible with the lucide icons used elsewhere in the nav (accepts
 * `className` + any SVG props), so it drops into `ALL_SERVICES_ICON` directly.
 */
export function AllServicesIcon({
  className,
  strokeWidth = 3,
  ...props
}: SVGProps<SVGSVGElement> & { strokeWidth?: number }) {
  return (
    <svg
      viewBox="0 0 96 96"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {/* Clockwise cycle of arrows framing the services */}
      <g>
        <path d="M30 13 Q48 5 66 13" />
        <path d="M66 13 L60.5 12 M66 13 L64 18.5" />
        <path d="M83 30 Q91 48 83 66" />
        <path d="M83 66 L78 63.5 M83 66 L84 60.5" />
        <path d="M66 83 Q48 91 30 83" />
        <path d="M30 83 L35.5 84 M30 83 L32 77.5" />
        <path d="M13 66 Q5 48 13 30" />
        <path d="M13 30 L18 32.5 M13 30 L12 35.5" />
      </g>

      {/* Crossed tools — top-left */}
      <g>
        <path d="M17 33 L28 22" />
        <path d="M28 22 a5 5 0 1 0 5 -5 l-3 3 -2 -2 3 -3 a5 5 0 0 0 -3 7z" />
        <path d="M15 35 l3 -3" />
      </g>

      {/* Checklist — top center */}
      <g>
        <path d="M42 21 h12 a2 2 0 0 1 2 2 v11 a2 2 0 0 1 -2 2 h-12 a2 2 0 0 1 -2 -2 v-11 a2 2 0 0 1 2 -2 z" />
        <path d="M45 21 v-2 h6 v2" />
        <path d="M44 27 l1.5 1.5 l2.5 -3" />
        <path d="M51 27 h2.5" />
        <path d="M44 32 l1.5 1.5 l2.5 -3" />
        <path d="M51 32 h2.5" />
      </g>

      {/* House — top-right */}
      <g>
        <path d="M61 30 L71 21 L81 30" />
        <path d="M64 28 v9 h14 v-9" />
      </g>

      {/* Gear — center */}
      <g>
        <circle cx="48" cy="52" r="7.5" />
        <circle cx="48" cy="52" r="2.6" />
        <path d="M48 42 v-3 M48 62 v3 M58 52 h3 M35 52 h3 M55.1 45 l2.1 -2.1 M38.8 59.1 l2.1 -2.1 M55.1 59 l2.1 2.1 M38.8 44.9 l2.1 2.1" />
      </g>

      {/* First-aid case — bottom-left */}
      <g>
        <path d="M18 64 h12 a2 2 0 0 1 2 2 v8 a2 2 0 0 1 -2 2 h-12 a2 2 0 0 1 -2 -2 v-8 a2 2 0 0 1 2 -2 z" />
        <path d="M20 64 v-2 h8 v2" />
        <path d="M24 67 v6 M21 70 h6" />
      </g>

      {/* Wifi — bottom-right */}
      <g>
        <path d="M62 66 a12 12 0 0 1 18 0" />
        <path d="M65.5 70 a7.5 7.5 0 0 1 11 0" />
        <circle cx="71" cy="74.5" r="1.3" fill="currentColor" stroke="none" />
      </g>
    </svg>
  );
}
