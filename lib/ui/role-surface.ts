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
