// lib/marketing/hero-outcomes.ts — the six outcomes the homepage leads with.
//
// Pure registry: every entry names the in-app outcome it maps to
// (lib/outcomes/launcher.ts), the /features card it deep-links to, the
// catalogue keys for its copy, and the high-stakes trust domains Bubaly asks
// about first before acting there (a subset of HIGH_STAKES_AI_DOMAINS, so the
// "Asks first" line can never promise less caution than the engine enforces).
//
// The hrefs are load-bearing: tests/e2e/marketing-public.spec.ts walks the
// rail's six links in order and expects the first to land on
// /features#smart-calendar. tests/marketing-hero-outcomes.test.ts pins the
// order at source level.

import {
  CalendarDays, CheckSquare2, GraduationCap, HeartPulse, Home, UtensilsCrossed, type LucideIcon,
} from 'lucide-react';
import type { OutcomeId } from '@/lib/outcomes/launcher';

export type HeroOutcomeTone = 'violet' | 'green' | 'orange' | 'blue' | 'pink';

export type HeroOutcome = {
  outcomeId: OutcomeId;
  href: string;
  icon: LucideIcon;
  tone: HeroOutcomeTone;
  titleKey: string;
  bodyKey: string;
  proofKey: string;
  /** Trust domains (⊆ HIGH_STAKES_AI_DOMAINS) Bubaly asks a parent about before acting. */
  asksFirst: string[];
  /** A role-based "asks first" line used when no domain applies (kids' rewards). */
  roleAsksKey?: string;
  /** An extra trust chip shown inside the card (e.g. health records stay family-scoped). */
  trustChipKey?: string;
};

export const HERO_OUTCOMES: HeroOutcome[] = [
  {
    outcomeId: 'run_today',
    href: '/features#smart-calendar',
    icon: CalendarDays,
    tone: 'violet',
    titleKey: 'heroOutcomes.runToday',
    bodyKey: 'heroOutcomes.runTodayBody',
    proofKey: 'heroOutcomes.runTodayProof',
    asksFirst: [],
  },
  {
    outcomeId: 'run_today',
    href: '/features#tasks-chores',
    icon: CheckSquare2,
    tone: 'green',
    titleKey: 'heroOutcomes.chores',
    bodyKey: 'heroOutcomes.choresBody',
    proofKey: 'heroOutcomes.choresProof',
    asksFirst: [],
    roleAsksKey: 'heroOutcomes.choresAsks',
  },
  {
    outcomeId: 'feed_family',
    href: '/features#meal-planning',
    icon: UtensilsCrossed,
    tone: 'orange',
    titleKey: 'heroOutcomes.feedFamily',
    bodyKey: 'heroOutcomes.feedFamilyBody',
    proofKey: 'heroOutcomes.feedFamilyProof',
    asksFirst: ['finances'],
  },
  {
    outcomeId: 'prepare_school',
    href: '/features#school-hub',
    icon: GraduationCap,
    tone: 'blue',
    titleKey: 'heroOutcomes.school',
    bodyKey: 'heroOutcomes.schoolBody',
    proofKey: 'heroOutcomes.schoolProof',
    asksFirst: ['finances'],
  },
  {
    outcomeId: 'stay_healthy',
    href: '/features#health-medications',
    icon: HeartPulse,
    tone: 'pink',
    titleKey: 'heroOutcomes.health',
    bodyKey: 'heroOutcomes.healthBody',
    proofKey: 'heroOutcomes.healthProof',
    asksFirst: ['medical'],
    trustChipKey: 'heroOutcomes.healthTrustChip',
  },
  {
    outcomeId: 'manage_money',
    href: '/features#home-management',
    icon: Home,
    tone: 'violet',
    titleKey: 'heroOutcomes.home',
    bodyKey: 'heroOutcomes.homeBody',
    proofKey: 'heroOutcomes.homeProof',
    asksFirst: ['finances', 'banking'],
  },
];

/** The "when life gets bigger" links beneath the rail, in order. */
export const MORE_OUTCOMES: { outcomeId: OutcomeId; href: string; labelKey: string }[] = [
  { outcomeId: 'plan_trip', href: '/features', labelKey: 'heroOutcomes.moreTrips' },
  { outcomeId: 'celebrate', href: '/features', labelKey: 'heroOutcomes.moreCelebrate' },
  { outcomeId: 'prepare_unexpected', href: '/features', labelKey: 'heroOutcomes.moreUnexpected' },
];
