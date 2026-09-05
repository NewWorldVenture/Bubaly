// What a relative routine can be anchored to (§19).
//
// The allow-list is the security boundary: a routine's anchor names a table
// and a date column, and both come from here — never from what a family typed.
// Without it, "two days before every <arbitrary table>" would be a query
// builder pointed at the whole database by a sentence.
export type RoutineAnchor = {
  key: string;
  table: 'vacations' | 'calendar_events' | 'school_events' | 'sports_events' | 'bills';
  /** The date column the offset is measured from. */
  dateField: string;
  /** Words a family uses for it, lowercase, matched as substrings. */
  matches: string[];
  label: string;
};

export const ROUTINE_ANCHORS: RoutineAnchor[] = [
  { key: 'trip', table: 'vacations', dateField: 'start_date', matches: ['trip', 'vacation', 'holiday', 'getaway'], label: 'each trip' },
  { key: 'event', table: 'calendar_events', dateField: 'starts_at', matches: ['event', 'appointment', 'thing on the calendar'], label: 'each calendar event' },
  { key: 'school_event', table: 'school_events', dateField: 'starts_at', matches: ['school event', 'school day', 'parents evening', 'school trip'], label: 'each school event' },
  { key: 'game', table: 'sports_events', dateField: 'starts_at', matches: ['game', 'match', 'practice', 'training'], label: 'each game or practice' },
  { key: 'bill', table: 'bills', dateField: 'due_date', matches: ['bill', 'payment', 'invoice'], label: 'each bill' },
];

export function anchorByKey(key: string): RoutineAnchor | null {
  return ROUTINE_ANCHORS.find((a) => a.key === key) ?? null;
}
