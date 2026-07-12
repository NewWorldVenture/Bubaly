// lib/ui/role-surface.ts — role-tailored surfaces (Friction Backlog #8).
// Pure, deterministic mapping from a family member's role to how a surface
// should read to THEM: information density, language tone, whether to show
// management affordances, and how many "focus" shortcuts to surface. No React —
// components consume this to adapt copy/limits per role. Fully unit-testable.

import type { MemberRole } from '@/lib/constants/roles';
import type { DayPhase } from '@/lib/home/time-of-day';

export type Density = 'comfortable' | 'cozy' | 'playful';
export type Tone = 'formal' | 'casual' | 'kid';

export interface RoleSurface {
  density: Density;
  tone: Tone;
  /** Surface admin/management affordances (e.g. "Manage", invite, settings). */
  canManage: boolean;
  /** How many focus shortcuts to show — kids/guests see a shorter, simpler set. */
  focusMax: number;
}

const SURFACES: Record<MemberRole, RoleSurface> = {
  parent:    { density: 'comfortable', tone: 'formal', canManage: true,  focusMax: 6 },
  adult:     { density: 'comfortable', tone: 'casual', canManage: true,  focusMax: 6 },
  caregiver: { density: 'comfortable', tone: 'casual', canManage: true,  focusMax: 5 },
  teen:      { density: 'cozy',        tone: 'casual', canManage: false, focusMax: 5 },
  child:     { density: 'playful',     tone: 'kid',    canManage: false, focusMax: 4 },
  guest:     { density: 'cozy',        tone: 'casual', canManage: false, focusMax: 4 },
};

/** The surface config for a role (falls back to `adult` for unknown roles). */
export function roleSurface(role: MemberRole | null | undefined): RoleSurface {
  return (role && SURFACES[role]) || SURFACES.adult;
}

/** Personalized greeting line, tone-matched to the reader's role + time of day. */
export function roleGreeting(role: MemberRole | null | undefined, firstName: string, phase: DayPhase): string {
  const name = firstName.trim() || 'there';
  const tone = roleSurface(role).tone;
  if (tone === 'kid') {
    switch (phase) {
      case 'morning': return `Good morning, ${name}! ☀️`;
      case 'midday':  return `Hi ${name}! 👋`;
      case 'evening': return `Hey ${name}! 🌙`;
      default:        return `Night night soon, ${name} 🌟`;
    }
  }
  const hi = tone === 'formal' ? 'Good' : 'Hey';
  switch (phase) {
    case 'morning': return `${tone === 'formal' ? 'Good morning' : 'Morning'}, ${name}`;
    case 'midday':  return `${hi} ${tone === 'formal' ? 'afternoon' : 'there'}, ${name}`;
    case 'evening': return `${tone === 'formal' ? 'Good evening' : 'Evening'}, ${name}`;
    default:        return `${tone === 'formal' ? 'Good night' : 'Night'}, ${name}`;
  }
}

/** Heading for the Home "Focus now" strip, tailored to the reader. */
export function focusHeadline(role: MemberRole | null | undefined): string {
  switch (roleSurface(role).tone) {
    case 'kid':    return "Let's go";
    case 'formal': return 'Focus now';
    default:       return 'Your focus';
  }
}

// ── App-wide density rollout (Friction #8) ───────────────────────────────────
// The density above tailored individual chips; this scales the WHOLE app for a
// role by setting the root font size (Tailwind's rem units cascade), applied by
// <RoleDensity/>. Parents keep 100%; teens/guests get a touch more room; kids
// get the largest, most tappable surface. A user can override the role default
// from Settings → Display comfort.

/** Root font-size (percent of the browser default) for each density. */
export const DENSITY_FONT_PCT: Record<Density, number> = {
  comfortable: 100, cozy: 104, playful: 110,
};

export const DENSITY_LABELS: Record<Density, string> = {
  comfortable: 'Standard', cozy: 'Cozy', playful: 'Relaxed',
};

export const DENSITY_DESCRIPTIONS: Record<Density, string> = {
  comfortable: 'The default text size and spacing.',
  cozy: 'A little larger text and spacing.',
  playful: 'The biggest text and roomiest tap targets.',
};

/** Densities a user can pick in Settings (in order), plus 'auto' = role default. */
export const DENSITY_OPTIONS: Density[] = ['comfortable', 'cozy', 'playful'];

/** Effective density: an explicit user override wins over the role default. */
export function resolveDensity(role: MemberRole | null | undefined, override: string | null | undefined): Density {
  if (override === 'comfortable' || override === 'cozy' || override === 'playful') return override;
  return roleSurface(role).density;
}

/** Tailwind sizing for a "focus"/action chip at the reader's role density
 *  (Friction #8, density rollout). Kids ('playful') get larger, rounder, more
 *  tappable chips (easier for small fingers); adults ('comfortable') keep the
 *  compact chip; teens/guests ('cozy') sit between. Pure class-token map so it's
 *  unit-testable and drives the same treatment anywhere action chips render. */
export function focusChipClasses(role: MemberRole | null | undefined): { chip: string; icon: string } {
  switch (roleSurface(role).density) {
    case 'playful': return { chip: 'gap-2 rounded-2xl px-4 py-3 text-base', icon: 'h-5 w-5' };
    case 'cozy':    return { chip: 'gap-2 rounded-xl px-3.5 py-2.5 text-sm', icon: 'h-4 w-4' };
    default:        return { chip: 'gap-1.5 rounded-xl px-3 py-2 text-sm', icon: 'h-4 w-4' }; // comfortable
  }
}
