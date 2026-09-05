// lib/language/practice.ts — pure, deterministic language-practice engine.
//
// Kids and parents practising a language together. The engine owns what a
// tutor app charges for: SM-2 spaced repetition for vocabulary, weekly-minute
// progress and streaks, a CEFR hours-to-target estimate, the practice mix,
// and a "what to do today" suggestion. The AI adds conversation with gentle
// corrections in the target language.

import type { CefrLevel, LanguageSessionKind } from '@/lib/database.types';

export const CEFR: { value: CefrLevel; label: string; hours: number }[] = [
  { value: 'A0', label: 'Just starting', hours: 0 }, { value: 'A1', label: 'A1 · Beginner', hours: 100 }, { value: 'A2', label: 'A2 · Elementary', hours: 200 },
  { value: 'B1', label: 'B1 · Intermediate', hours: 400 }, { value: 'B2', label: 'B2 · Upper intermediate', hours: 600 },
  { value: 'C1', label: 'C1 · Advanced', hours: 800 }, { value: 'C2', label: 'C2 · Mastery', hours: 1000 },
];
export const cefrMeta = (l: CefrLevel) => CEFR.find((x) => x.value === l) ?? CEFR[0];

export const SESSION_KINDS: { value: LanguageSessionKind; label: string; emoji: string }[] = [
  { value: 'vocab', label: 'Vocabulary', emoji: '🃏' }, { value: 'conversation', label: 'Conversation', emoji: '🗣️' }, { value: 'listening', label: 'Listening', emoji: '🎧' },
  { value: 'reading', label: 'Reading', emoji: '📖' }, { value: 'writing', label: 'Writing', emoji: '✍️' }, { value: 'grammar', label: 'Grammar', emoji: '🧩' },
  { value: 'lesson', label: 'Lesson / class', emoji: '🏫' }, { value: 'tutor', label: 'AI tutor chat', emoji: '🤖' }, { value: 'immersion', label: 'Immersion (film, music, family dinner)', emoji: '🎬' },
];
export const kindMeta = (k: LanguageSessionKind) => SESSION_KINDS.find((x) => x.value === k) ?? SESSION_KINDS[0];

export const LANGUAGES: { code: string; label: string; flag: string }[] = [
  { code: 'es', label: 'Spanish', flag: '🇪🇸' }, { code: 'fr', label: 'French', flag: '🇫🇷' }, { code: 'de', label: 'German', flag: '🇩🇪' }, { code: 'it', label: 'Italian', flag: '🇮🇹' },
  { code: 'pt', label: 'Portuguese', flag: '🇧🇷' }, { code: 'ja', label: 'Japanese', flag: '🇯🇵' }, { code: 'zh', label: 'Mandarin', flag: '🇨🇳' }, { code: 'ko', label: 'Korean', flag: '🇰🇷' },
  { code: 'ar', label: 'Arabic', flag: '🇸🇦' }, { code: 'hi', label: 'Hindi', flag: '🇮🇳' }, { code: 'en', label: 'English', flag: '🇬🇧' }, { code: 'asl', label: 'American Sign Language', flag: '🤟' }, { code: 'other', label: 'Other', flag: '🌍' },
];
export const languageMeta = (code: string) => LANGUAGES.find((l) => l.code === code) ?? { code, label: code, flag: '🌍' };

export type StarterCard = { term: string; translation: string; example?: string; pos?: string };

/** Twenty high-frequency starters per language so a new goal has a deck on day one. */
export const STARTER_DECKS: Record<string, StarterCard[]> = {
  es: [
    { term: 'hola', translation: 'hello', example: '¡Hola! ¿Cómo estás?' }, { term: 'gracias', translation: 'thank you' }, { term: 'por favor', translation: 'please' }, { term: 'agua', translation: 'water', pos: 'noun' },
    { term: 'comer', translation: 'to eat', pos: 'verb', example: 'Vamos a comer.' }, { term: 'casa', translation: 'house', pos: 'noun' }, { term: 'familia', translation: 'family', pos: 'noun' }, { term: 'hoy', translation: 'today' },
    { term: 'mañana', translation: 'tomorrow / morning' }, { term: 'escuela', translation: 'school', pos: 'noun' }, { term: 'amigo', translation: 'friend', pos: 'noun' }, { term: 'grande', translation: 'big', pos: 'adjective' },
    { term: 'pequeño', translation: 'small', pos: 'adjective' }, { term: '¿dónde?', translation: 'where?' }, { term: 'tener', translation: 'to have', pos: 'verb' }, { term: 'querer', translation: 'to want', pos: 'verb' },
    { term: 'tiempo', translation: 'time / weather', pos: 'noun' }, { term: 'bueno', translation: 'good', pos: 'adjective' }, { term: 'ayudar', translation: 'to help', pos: 'verb' }, { term: 'juntos', translation: 'together' },
  ],
  fr: [
    { term: 'bonjour', translation: 'hello', example: 'Bonjour, ça va ?' }, { term: 'merci', translation: 'thank you' }, { term: 's’il vous plaît', translation: 'please' }, { term: 'eau', translation: 'water', pos: 'noun' },
    { term: 'manger', translation: 'to eat', pos: 'verb' }, { term: 'maison', translation: 'house', pos: 'noun' }, { term: 'famille', translation: 'family', pos: 'noun' }, { term: 'aujourd’hui', translation: 'today' },
    { term: 'demain', translation: 'tomorrow' }, { term: 'école', translation: 'school', pos: 'noun' }, { term: 'ami', translation: 'friend', pos: 'noun' }, { term: 'grand', translation: 'big', pos: 'adjective' },
    { term: 'petit', translation: 'small', pos: 'adjective' }, { term: 'où ?', translation: 'where?' }, { term: 'avoir', translation: 'to have', pos: 'verb' }, { term: 'vouloir', translation: 'to want', pos: 'verb' },
    { term: 'temps', translation: 'time / weather', pos: 'noun' }, { term: 'bon', translation: 'good', pos: 'adjective' }, { term: 'aider', translation: 'to help', pos: 'verb' }, { term: 'ensemble', translation: 'together' },
  ],
  de: [
    { term: 'hallo', translation: 'hello' }, { term: 'danke', translation: 'thank you' }, { term: 'bitte', translation: 'please / you’re welcome' }, { term: 'Wasser', translation: 'water', pos: 'noun' },
    { term: 'essen', translation: 'to eat', pos: 'verb' }, { term: 'Haus', translation: 'house', pos: 'noun' }, { term: 'Familie', translation: 'family', pos: 'noun' }, { term: 'heute', translation: 'today' },
    { term: 'morgen', translation: 'tomorrow' }, { term: 'Schule', translation: 'school', pos: 'noun' }, { term: 'Freund', translation: 'friend', pos: 'noun' }, { term: 'groß', translation: 'big', pos: 'adjective' },
    { term: 'klein', translation: 'small', pos: 'adjective' }, { term: 'wo?', translation: 'where?' }, { term: 'haben', translation: 'to have', pos: 'verb' }, { term: 'wollen', translation: 'to want', pos: 'verb' },
    { term: 'Zeit', translation: 'time', pos: 'noun' }, { term: 'gut', translation: 'good', pos: 'adjective' }, { term: 'helfen', translation: 'to help', pos: 'verb' }, { term: 'zusammen', translation: 'together' },
  ],
  it: [
    { term: 'ciao', translation: 'hello / bye' }, { term: 'grazie', translation: 'thank you' }, { term: 'per favore', translation: 'please' }, { term: 'acqua', translation: 'water', pos: 'noun' },
    { term: 'mangiare', translation: 'to eat', pos: 'verb' }, { term: 'casa', translation: 'house', pos: 'noun' }, { term: 'famiglia', translation: 'family', pos: 'noun' }, { term: 'oggi', translation: 'today' },
    { term: 'domani', translation: 'tomorrow' }, { term: 'scuola', translation: 'school', pos: 'noun' }, { term: 'amico', translation: 'friend', pos: 'noun' }, { term: 'grande', translation: 'big', pos: 'adjective' },
    { term: 'piccolo', translation: 'small', pos: 'adjective' }, { term: 'dove?', translation: 'where?' }, { term: 'avere', translation: 'to have', pos: 'verb' }, { term: 'volere', translation: 'to want', pos: 'verb' },
    { term: 'tempo', translation: 'time / weather', pos: 'noun' }, { term: 'buono', translation: 'good', pos: 'adjective' }, { term: 'aiutare', translation: 'to help', pos: 'verb' }, { term: 'insieme', translation: 'together' },
  ],
  pt: [
    { term: 'olá', translation: 'hello' }, { term: 'obrigado / obrigada', translation: 'thank you' }, { term: 'por favor', translation: 'please' }, { term: 'água', translation: 'water', pos: 'noun' },
    { term: 'comer', translation: 'to eat', pos: 'verb' }, { term: 'casa', translation: 'house', pos: 'noun' }, { term: 'família', translation: 'family', pos: 'noun' }, { term: 'hoje', translation: 'today' },
    { term: 'amanhã', translation: 'tomorrow' }, { term: 'escola', translation: 'school', pos: 'noun' }, { term: 'amigo', translation: 'friend', pos: 'noun' }, { term: 'grande', translation: 'big', pos: 'adjective' },
    { term: 'pequeno', translation: 'small', pos: 'adjective' }, { term: 'onde?', translation: 'where?' }, { term: 'ter', translation: 'to have', pos: 'verb' }, { term: 'querer', translation: 'to want', pos: 'verb' },
    { term: 'tempo', translation: 'time / weather', pos: 'noun' }, { term: 'bom', translation: 'good', pos: 'adjective' }, { term: 'ajudar', translation: 'to help', pos: 'verb' }, { term: 'juntos', translation: 'together' },
  ],
  ja: [
    { term: 'こんにちは (konnichiwa)', translation: 'hello' }, { term: 'ありがとう (arigatō)', translation: 'thank you' }, { term: 'お願いします (onegaishimasu)', translation: 'please' }, { term: '水 (mizu)', translation: 'water', pos: 'noun' },
    { term: '食べる (taberu)', translation: 'to eat', pos: 'verb' }, { term: '家 (ie)', translation: 'house', pos: 'noun' }, { term: '家族 (kazoku)', translation: 'family', pos: 'noun' }, { term: '今日 (kyō)', translation: 'today' },
    { term: '明日 (ashita)', translation: 'tomorrow' }, { term: '学校 (gakkō)', translation: 'school', pos: 'noun' }, { term: '友達 (tomodachi)', translation: 'friend', pos: 'noun' }, { term: '大きい (ōkii)', translation: 'big', pos: 'adjective' },
    { term: '小さい (chiisai)', translation: 'small', pos: 'adjective' }, { term: 'どこ (doko)', translation: 'where?' }, { term: 'ある / いる (aru / iru)', translation: 'to have / to exist', pos: 'verb' }, { term: '欲しい (hoshii)', translation: 'to want', pos: 'adjective' },
    { term: '時間 (jikan)', translation: 'time', pos: 'noun' }, { term: 'いい (ii)', translation: 'good', pos: 'adjective' }, { term: '手伝う (tetsudau)', translation: 'to help', pos: 'verb' }, { term: '一緒に (issho ni)', translation: 'together' },
  ],
  zh: [
    { term: '你好 (nǐ hǎo)', translation: 'hello' }, { term: '谢谢 (xièxie)', translation: 'thank you' }, { term: '请 (qǐng)', translation: 'please' }, { term: '水 (shuǐ)', translation: 'water', pos: 'noun' },
    { term: '吃 (chī)', translation: 'to eat', pos: 'verb' }, { term: '家 (jiā)', translation: 'home / family', pos: 'noun' }, { term: '家人 (jiārén)', translation: 'family members', pos: 'noun' }, { term: '今天 (jīntiān)', translation: 'today' },
    { term: '明天 (míngtiān)', translation: 'tomorrow' }, { term: '学校 (xuéxiào)', translation: 'school', pos: 'noun' }, { term: '朋友 (péngyou)', translation: 'friend', pos: 'noun' }, { term: '大 (dà)', translation: 'big', pos: 'adjective' },
    { term: '小 (xiǎo)', translation: 'small', pos: 'adjective' }, { term: '哪里 (nǎlǐ)', translation: 'where?' }, { term: '有 (yǒu)', translation: 'to have', pos: 'verb' }, { term: '想 (xiǎng)', translation: 'to want / to think', pos: 'verb' },
    { term: '时间 (shíjiān)', translation: 'time', pos: 'noun' }, { term: '好 (hǎo)', translation: 'good', pos: 'adjective' }, { term: '帮助 (bāngzhù)', translation: 'to help', pos: 'verb' }, { term: '一起 (yìqǐ)', translation: 'together' },
  ],
};
export const starterDeck = (code: string): StarterCard[] => STARTER_DECKS[code] ?? [];

export type GoalLike = { id: string; member_id: string; language_code: string; current_level: CefrLevel; target_level: Exclude<CefrLevel, 'A0'>; weekly_minutes: number; is_active: boolean; started_on: string };
export type SessionLike = { id: string; goal_id: string; kind: LanguageSessionKind; minutes: number; score: number | null; practiced_on: string };
export type CardLike = { id: string; goal_id: string; term: string; ease: number; interval_days: number; repetitions: number; lapses: number; due_on: string; is_suspended: boolean };

const DAY_MS = 86_400_000;
const dateOnly = (v: string | Date) => (typeof v === 'string' ? new Date(`${v.slice(0, 10)}T00:00:00`) : new Date(v.getFullYear(), v.getMonth(), v.getDate()));
export const dayDiff = (from: string | Date, to: string | Date) => Math.round((dateOnly(to).getTime() - dateOnly(from).getTime()) / DAY_MS);
export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const addDays = (iso: string, days: number) => isoDate(new Date(dateOnly(iso).getTime() + days * DAY_MS));

/** Review grades: 0 = blank, 1 = wrong but recognised, 2 = wrong, easy recall, 3 = hard, 4 = good, 5 = easy. */
export type Grade = 0 | 1 | 2 | 3 | 4 | 5;
export const GRADES: { value: Grade; label: string; hint: string }[] = [
  { value: 1, label: 'Again', hint: 'Forgot it' }, { value: 3, label: 'Hard', hint: 'Got it, slowly' }, { value: 4, label: 'Good', hint: 'Got it' }, { value: 5, label: 'Easy', hint: 'Instant' },
];

/** SM-2 (SuperMemo 2) scheduling: the algorithm behind Anki's defaults. */
export function sm2(card: Pick<CardLike, 'ease' | 'interval_days' | 'repetitions' | 'lapses'>, grade: Grade, today: Date): { ease: number; interval_days: number; repetitions: number; lapses: number; due_on: string; last_reviewed_on: string } {
  let ease = card.ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02));
  ease = Math.round(Math.max(1.3, Math.min(4, ease)) * 100) / 100;
  let repetitions: number;
  let interval: number;
  let lapses = card.lapses;
  if (grade < 3) {
    repetitions = 0; interval = 1; lapses += 1;
  } else {
    repetitions = card.repetitions + 1;
    interval = repetitions === 1 ? 1 : repetitions === 2 ? 6 : Math.round(card.interval_days * ease);
    if (grade === 3) interval = Math.max(1, Math.round(interval * 0.8));
    if (grade === 5) interval = Math.round(interval * 1.3);
  }
  const todayIso = isoDate(today);
  return { ease, interval_days: interval, repetitions, lapses, due_on: addDays(todayIso, interval), last_reviewed_on: todayIso };
}

/** Cards due today (or overdue), most overdue first, new cards last so reviews come before learning. */
export function dueCards<T extends CardLike>(cards: T[], goalId: string, today: Date, limit = 30): T[] {
  const todayIso = isoDate(today);
  return cards
    .filter((c) => c.goal_id === goalId && !c.is_suspended && c.due_on <= todayIso)
    .sort((a, b) => (b.repetitions > 0 ? 1 : 0) - (a.repetitions > 0 ? 1 : 0) || a.due_on.localeCompare(b.due_on) || a.term.localeCompare(b.term))
    .slice(0, limit);
}

export type DeckStats = { total: number; due: number; new: number; learning: number; mature: number; suspended: number; retention: number | null };

export function deckStats(cards: CardLike[], goalId: string, today: Date): DeckStats {
  const mine = cards.filter((c) => c.goal_id === goalId);
  const active = mine.filter((c) => !c.is_suspended);
  const reviewed = active.filter((c) => c.repetitions + c.lapses > 0);
  const totalReviews = reviewed.reduce((a, c) => a + c.repetitions + c.lapses, 0);
  const totalLapses = reviewed.reduce((a, c) => a + c.lapses, 0);
  return {
    total: mine.length, due: dueCards(active, goalId, today, 10_000).length,
    new: active.filter((c) => c.repetitions === 0 && c.lapses === 0).length,
    learning: active.filter((c) => (c.repetitions > 0 || c.lapses > 0) && c.interval_days < 21).length,
    mature: active.filter((c) => c.interval_days >= 21).length,
    suspended: mine.length - active.length,
    retention: totalReviews ? Math.round(((totalReviews - totalLapses) / totalReviews) * 100) : null,
  };
}

export type WeekProgress = { minutes: number; goal: number; pct: number; days: number; sessions: number; byKind: Partial<Record<LanguageSessionKind, number>>; avgScore: number | null };

/** Minutes practised in the last 7 days against the weekly goal. */
export function weekProgress(sessions: SessionLike[], goal: Pick<GoalLike, 'id' | 'weekly_minutes'>, today: Date): WeekProgress {
  const todayIso = isoDate(today);
  const since = addDays(todayIso, -6);
  const mine = sessions.filter((s) => s.goal_id === goal.id && s.practiced_on >= since && s.practiced_on <= todayIso);
  const minutes = mine.reduce((a, s) => a + s.minutes, 0);
  const byKind: Partial<Record<LanguageSessionKind, number>> = {};
  for (const s of mine) byKind[s.kind] = (byKind[s.kind] ?? 0) + s.minutes;
  const scored = mine.filter((s) => s.score !== null);
  return {
    minutes, goal: goal.weekly_minutes, pct: goal.weekly_minutes ? Math.min(100, Math.round((minutes / goal.weekly_minutes) * 100)) : 0,
    days: new Set(mine.map((s) => s.practiced_on)).size, sessions: mine.length, byKind,
    avgScore: scored.length ? Math.round(scored.reduce((a, s) => a + (s.score ?? 0), 0) / scored.length) : null,
  };
}

/** Consecutive days with a session, ending today or yesterday. */
export function streak(sessions: SessionLike[], goalId: string, today: Date): number {
  const days = new Set(sessions.filter((s) => s.goal_id === goalId).map((s) => s.practiced_on));
  let cursor = isoDate(today);
  if (!days.has(cursor)) cursor = addDays(cursor, -1);
  let n = 0;
  while (days.has(cursor)) { n += 1; cursor = addDays(cursor, -1); }
  return n;
}

export type LevelEstimate = { hoursDone: number; hoursToTarget: number; pct: number; weeksAtGoal: number | null; targetLabel: string };

/**
 * Hours towards the target level. Guided-learning-hour bands are the usual
 * CEFR rule of thumb; logged minutes count from the current level's floor.
 */
export function levelEstimate(goal: Pick<GoalLike, 'id' | 'current_level' | 'target_level' | 'weekly_minutes'>, sessions: SessionLike[]): LevelEstimate {
  const from = cefrMeta(goal.current_level).hours;
  const to = cefrMeta(goal.target_level).hours;
  const hoursDone = Math.round(sessions.filter((s) => s.goal_id === goal.id).reduce((a, s) => a + s.minutes, 0) / 60);
  const span = Math.max(1, to - from);
  const hoursToTarget = Math.max(0, span - hoursDone);
  return {
    hoursDone, hoursToTarget, pct: Math.min(100, Math.round((Math.min(span, hoursDone) / span) * 100)),
    weeksAtGoal: goal.weekly_minutes ? Math.ceil(hoursToTarget / (goal.weekly_minutes / 60)) : null, targetLabel: cefrMeta(goal.target_level).label,
  };
}

export type Suggestion = { title: string; detail: string; kind: LanguageSessionKind; minutes: number };

/** One concrete thing to do today, from the deck, the week and the mix. */
export function suggestToday(goal: GoalLike, sessions: SessionLike[], cards: CardLike[], today: Date): Suggestion {
  const due = deckStats(cards, goal.id, today).due;
  const week = weekProgress(sessions, goal, today);
  const todayIso = isoDate(today);
  const doneToday = sessions.some((s) => s.goal_id === goal.id && s.practiced_on === todayIso);
  const lastSpoke = sessions.filter((s) => s.goal_id === goal.id && (s.kind === 'conversation' || s.kind === 'tutor')).map((s) => s.practiced_on).sort().pop();
  const daysSinceSpoke = lastSpoke ? dayDiff(lastSpoke, todayIso) : null;
  if (due >= 10) return { title: `Review ${due} due cards`, detail: 'Reviews before new material: the deck is what keeps words from leaking.', kind: 'vocab', minutes: Math.min(20, 2 + Math.ceil(due / 3)) };
  if (daysSinceSpoke === null || daysSinceSpoke >= 4) return { title: 'Ten minutes of conversation', detail: daysSinceSpoke === null ? 'Nothing spoken yet — talk to the AI tutor about today.' : `No speaking in ${daysSinceSpoke} days. Ask the tutor about your day, in ${languageMeta(goal.language_code).label}.`, kind: 'tutor', minutes: 10 };
  if (due > 0) return { title: `Clear ${due} due card${due === 1 ? '' : 's'}`, detail: 'Five minutes, then something new.', kind: 'vocab', minutes: 5 };
  if (!doneToday && week.minutes < week.goal) {
    const left = week.goal - week.minutes;
    const least = SESSION_KINDS.filter((k) => ['listening', 'reading', 'writing', 'grammar'].includes(k.value)).sort((a, b) => (week.byKind[a.value] ?? 0) - (week.byKind[b.value] ?? 0))[0];
    return { title: `${Math.min(20, left)} minutes of ${least.label.toLowerCase()}`, detail: `${left} minutes to this week’s goal; ${least.label.toLowerCase()} is the least practised skill this week.`, kind: least.value, minutes: Math.min(20, left) };
  }
  return { title: 'Immersion tonight', detail: 'Goal met. A show, a song or dinner-table phrases in the language keep the ear warm.', kind: 'immersion', minutes: 20 };
}

export type LanguageSummary = { goals: number; minutesWeek: number; dueCards: number; longestStreak: number; onTrack: number; text: string };

export function languageSummary(goals: GoalLike[], sessions: SessionLike[], cards: CardLike[], today: Date): LanguageSummary {
  const live = goals.filter((g) => g.is_active);
  let minutesWeek = 0, due = 0, longest = 0, onTrack = 0;
  for (const g of live) {
    const w = weekProgress(sessions, g, today);
    minutesWeek += w.minutes; if (w.pct >= 100) onTrack += 1;
    due += deckStats(cards, g.id, today).due;
    longest = Math.max(longest, streak(sessions, g.id, today));
  }
  const text = live.length === 0 ? 'No language goals yet' : due >= 20 ? `${due} cards waiting` : onTrack === live.length ? 'Everyone hit this week’s goal' : `${minutesWeek} min this week · ${onTrack}/${live.length} on track`;
  return { goals: live.length, minutesWeek, dueCards: due, longestStreak: longest, onTrack, text };
}
