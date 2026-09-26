// The Guardian routing form's shape, its two decisions, and the one payload
// builder the server writes from.
//
// Everything here is pure and framework-free so the page, the client form and
// the server action all agree on it, and so a test can drive the whole
// round-trip — what the form shows, what it sends, what reaches the columns —
// without a browser or a database.
//
// Three defects lived in the gap this module closes:
//
//   1. The form was handed `Profile | null`, and `null` meant BOTH "this member
//      has no profile yet" and "the read failed". A failed read therefore
//      rendered the factory defaults, and Save upserted them over the family's
//      real call routing. `RoutingProfileSource` makes the two different
//      values, so no caller can conflate them again.
//
//   2. The form rendered a row for six trust tiers but sent only three of them.
//      Nothing anywhere wrote `default_mode_immediate`, `default_mode_close` or
//      `default_mode_trusted` — the columns only ever held their DEFAULT — while
//      `resolveFromProfile` in ./pipeline routes every inbound call from
//      immediate family, close family and trusted friends through exactly those
//      three. Changing one showed as changed, reported "Settings saved", and
//      reverted on reload.
//
//   3. `value || undefined` dropped a CLEARED greeting, so a family could not
//      delete a custom AI greeting or voicemail greeting: the old text stayed in
//      the column and came back on the next load. Both columns are nullable;
//      cleared now sends null.

import type { RoutingMode } from './pipeline';
import { TRUST_LEVELS, type TrustLevel } from './trust';

/** The column that holds the routing mode for one trust tier. */
export type RoutingModeField =
  | 'default_mode_immediate'
  | 'default_mode_close'
  | 'default_mode_trusted'
  | 'default_mode_known'
  | 'default_mode_unknown'
  | 'default_mode_suspected_spam'
  | 'default_mode_blocked';

/** One member's Guardian profile, as the settings form edits it. */
export type RoutingProfile = {
  id: string;
  member_id: string;
  ai_persona_name: string;
  ai_greeting_template: string | null;
  voicemail_greeting: string | null;
  current_context: string;
  guardian_phone: string | null;
  context_overrides: Record<string, RoutingMode>;
} & Record<RoutingModeField, RoutingMode>;

/**
 * What the page actually learned about the stored profile.
 *
 * `absent` is a fact — the member has no row yet, so the defaults are the
 * honest starting point. `error` is the ABSENCE of a fact, and the only safe
 * thing to do with it is refuse to render a form whose Save button would
 * overwrite settings nobody has read.
 */
export type RoutingProfileSource =
  | { status: 'ok'; profile: RoutingProfile }
  | { status: 'absent' }
  | { status: 'error' };

export const TRUST_TO_FIELD: Record<TrustLevel, RoutingModeField> = {
  immediate_family: 'default_mode_immediate',
  close_family: 'default_mode_close',
  trusted_friend: 'default_mode_trusted',
  known_contact: 'default_mode_known',
  unknown: 'default_mode_unknown',
  suspected_spam: 'default_mode_suspected_spam',
  blocked: 'default_mode_blocked',
};

/**
 * The trust tiers the form renders an editable row for.
 *
 * `blocked` is deliberately not one of them: a blocked caller is blocked, and
 * the tier exists so the trust graph can say so, not so it can be re-routed.
 * Exported because the guard needs the same list the JSX uses — deriving it
 * twice is how three of these rows became decorative in the first place.
 */
export const EDITABLE_TRUST_LEVELS: TrustLevel[] = TRUST_LEVELS.filter((t) => t !== 'blocked');

/** The starting point for a member who has no profile row yet. */
export function routingDefaults(memberId: string): RoutingProfile {
  return {
    id: '',
    member_id: memberId,
    ai_persona_name: 'Bubaly',
    ai_greeting_template: '',
    voicemail_greeting: '',
    current_context: 'normal',
    guardian_phone: null,
    default_mode_immediate: 'immediate_ring',
    default_mode_close: 'immediate_ring',
    default_mode_trusted: 'immediate_ring',
    default_mode_known: 'ai_handle_first',
    default_mode_unknown: 'ai_handle_first',
    default_mode_suspected_spam: 'silent_handling',
    default_mode_blocked: 'blocked',
    context_overrides: {
      driving: 'voicemail_first',
      meeting: 'ai_handle_first',
      sleeping: 'silent_handling',
      vacation: 'ai_handle_first',
      do_not_disturb: 'silent_handling',
    },
  };
}

/**
 * What the form should start from, or `null` when it must not be shown at all.
 *
 * The `null` is the whole point: a failed read has no safe form, because every
 * field the user then sees is a value the server never sent.
 */
export function initialRoutingForm(
  source: RoutingProfileSource,
  memberId: string,
): RoutingProfile | null {
  if (source.status === 'error') return null;
  return source.status === 'ok' ? source.profile : routingDefaults(memberId);
}

/**
 * The Guardian member-profile fields a client may ask the server to write.
 *
 * Every field is optional so a caller can update one of them without blanking
 * the rest; `null` on a nullable column means "clear it", which is different
 * from omitting the key. Declared here rather than inline in the action so the
 * form and the server cannot drift about what is writable.
 */
export type GuardianProfileWrite = {
  member_id: string;
  ai_persona_name?: string;
  ai_greeting_template?: string | null;
  voicemail_greeting?: string | null;
  current_context?: string;
  context_overrides?: Record<string, RoutingMode>;
} & Partial<Record<RoutingModeField, RoutingMode>>;

/** Blank input the user cleared becomes null; anything else is sent as typed. */
function clearedToNull(value: string | null): string | null {
  return value && value.trim() !== '' ? value : null;
}

/** Everything the routing form asks the server to persist. */
export function routingUpdate(form: RoutingProfile, memberId: string): GuardianProfileWrite {
  const modes = Object.fromEntries(
    EDITABLE_TRUST_LEVELS.map((trust) => [TRUST_TO_FIELD[trust], form[TRUST_TO_FIELD[trust]]]),
  ) as Partial<Record<RoutingModeField, RoutingMode>>;
  return {
    member_id: memberId,
    ai_persona_name: form.ai_persona_name,
    ai_greeting_template: clearedToNull(form.ai_greeting_template),
    voicemail_greeting: clearedToNull(form.voicemail_greeting),
    context_overrides: form.context_overrides,
    ...modes,
  };
}

/** Every column a write request names, ready to upsert. */
const WRITABLE_COLUMNS = [
  'ai_persona_name',
  'ai_greeting_template',
  'voicemail_greeting',
  'current_context',
  'context_overrides',
  'default_mode_immediate',
  'default_mode_close',
  'default_mode_trusted',
  'default_mode_known',
  'default_mode_unknown',
  'default_mode_suspected_spam',
  'default_mode_blocked',
] as const satisfies readonly (keyof GuardianProfileWrite)[];

/**
 * Turn a write request into the row to upsert.
 *
 * Copies only the keys the caller actually sent — an upsert writes every column
 * in the payload, so including a key the caller omitted would blank it. Iterates
 * one list instead of repeating `if (input.x !== undefined) payload.x = input.x`
 * per column, which is how three columns came to have no writer at all.
 */
export function guardianProfilePayload(
  input: GuardianProfileWrite,
  familyId: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    family_id: familyId,
    member_id: input.member_id,
  };
  for (const column of WRITABLE_COLUMNS) {
    const value = input[column];
    if (value !== undefined) payload[column] = value;
  }
  return payload;
}
