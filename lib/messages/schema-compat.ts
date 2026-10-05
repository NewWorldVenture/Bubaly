// Messaging on a database that has not taken 0475/0476 yet.
//
// The messaging build-out adds two migrations:
//   0475_messaging_conversation_privacy_and_delivery.sql — participant-scoped
//        conversations, the canonical family chat, atomic create/read/react/
//        leave RPCs, family_messages.idempotency_key, is_family_chat, edited_at;
//   0476_messaging_notifications_preferences.sql — durable per-person mute
//        (family_conversation_preferences) and recipient-only chat notices.
//
// Production applies migrations by hand, and its ledger is well behind both.
// The application ships first, so every path that needs one of the new objects
// has to survive the object being absent: it falls back to what main did
// before the build-out, or hides the feature, and says so ONCE in the console,
// naming the migration that would bring it.
//
// The recognition is narrow on purpose. A missing-object error counts only when
// it names exactly the object the caller asked about, so an RPC that exists but
// fails inside (a missing helper it calls, a permission error, a constraint) is
// reported as the failure it is instead of being quietly downgraded.
//
//   function  PGRST202 (PostgREST schema cache) / 42883 undefined_function
//   table     PGRST205 (PostgREST schema cache) / 42P01 undefined_table
//   column    PGRST204 (PostgREST schema cache) / 42703 undefined_column

export const MESSAGING_MIGRATIONS = {
  '0475': '0475_messaging_conversation_privacy_and_delivery.sql',
  '0476': '0476_messaging_notifications_preferences.sql',
} as const;

export type MessagingMigration = keyof typeof MESSAGING_MIGRATIONS;

export type SchemaObject =
  | { kind: 'function'; name: string; migration: MessagingMigration }
  | { kind: 'table'; name: string; migration: MessagingMigration }
  | { kind: 'column'; table: string; name: string; migration: MessagingMigration };

/** Every object the messaging paths may find missing, with the migration that adds it. */
export const MESSAGING_SCHEMA = {
  ensureFamilyConversation: { kind: 'function', name: 'ensure_family_conversation', migration: '0475' },
  createFamilyConversation: { kind: 'function', name: 'create_family_conversation', migration: '0475' },
  leaveFamilyConversation: { kind: 'function', name: 'leave_family_conversation', migration: '0475' },
  toggleReaction: { kind: 'function', name: 'toggle_family_message_reaction', migration: '0475' },
  markReadThrough: { kind: 'function', name: 'mark_conversation_read_through', migration: '0475' },
  conversationOverview: { kind: 'function', name: 'family_conversation_overview', migration: '0475' },
  isFamilyChat: { kind: 'column', table: 'family_conversations', name: 'is_family_chat', migration: '0475' },
  messageIdempotencyKey: { kind: 'column', table: 'family_messages', name: 'idempotency_key', migration: '0475' },
  conversationPreferences: { kind: 'table', name: 'family_conversation_preferences', migration: '0476' },
} as const satisfies Record<string, SchemaObject>;

const CODES: Record<SchemaObject['kind'], readonly string[]> = {
  function: ['PGRST202', '42883'],
  table: ['PGRST205', '42P01'],
  column: ['PGRST204', '42703'],
};

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `name` as a whole identifier, unqualified or qualified only by `public.`. */
function namesIdentifier(message: string, name: string): boolean {
  return new RegExp(`(?:^|[^A-Za-z0-9_.]|(?<![A-Za-z0-9_])public\\.)${escape(name)}(?![A-Za-z0-9_])`).test(message);
}

function namesColumn(message: string, table: string, column: string): boolean {
  const t = escape(table);
  const c = escape(column);
  // PostgREST: Could not find the 'col' column of 'table' in the schema cache
  if (new RegExp(`'${c}' column of '(?:public\\.)?${t}'`).test(message)) return true;
  // Postgres: column table.col does not exist
  if (new RegExp(`(?:^|[^A-Za-z0-9_.])(?:public\\.)?${t}\\.${c}(?![A-Za-z0-9_])`).test(message)) return true;
  // Postgres: column "col" of relation "table" does not exist
  if (new RegExp(`"${c}" of relation "(?:public\\.)?${t}"`).test(message)) return true;
  // Postgres: column "col" does not exist — no relation named, so nothing to contradict.
  return new RegExp(`column "${c}" does not exist`).test(message);
}

/** True only when `error` says that exactly this object does not exist. */
export function isMissingSchemaObject(error: unknown, object: SchemaObject): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || typeof message !== 'string') return false;
  if (!CODES[object.kind].includes(code)) return false;
  return object.kind === 'column'
    ? namesColumn(message, object.table, object.name)
    : namesIdentifier(message, object.name);
}

function describe(object: SchemaObject): string {
  if (object.kind === 'column') return `column public.${object.table}.${object.name}`;
  return `${object.kind} public.${object.name}`;
}

const warned = new Set<string>();

/** One console warning per missing object, naming the migration that adds it. */
export function warnMissingMigration(object: SchemaObject, fallback: string): void {
  const key = describe(object);
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    `[messaging] ${key} is missing: migration ${MESSAGING_MIGRATIONS[object.migration]} has not been applied to this database. ${fallback}`,
  );
}

/**
 * The common shape: if `error` is exactly `object` missing, warn once and
 * return true so the caller takes its fallback. Any other error returns false.
 */
export function fellBackForMissing(error: unknown, object: SchemaObject, fallback: string): boolean {
  if (!isMissingSchemaObject(error, object)) return false;
  warnMissingMigration(object, fallback);
  return true;
}

/** Test seam: forget which warnings were already printed. */
export function resetMissingMigrationWarnings(): void {
  warned.clear();
}
