/**
 * The newest devices of one account that push is sent to.
 *
 * Nothing bounded how many push_devices rows an account could hold — through
 * /api/push/subscribe, or a direct insert push_devices_insert allows — and the
 * dispatch sends to each in turn. Registration switches off an account's
 * devices past this many (oldest first), and dispatch reads no more than this
 * many per recipient, so neither path depends on the other.
 */
export const MAX_PUSH_DEVICES_PER_USER = 10;
