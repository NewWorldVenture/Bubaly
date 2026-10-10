/**
 * Rolling caps on model-backed scam analysis and family notifications for
 * inbound Guardian SMS and WhatsApp. Anyone who knows a Guardian number can
 * message it, and every signed delivery used to buy one LLM request and one
 * family notification. Past a cap the deterministic pattern detector decides
 * alone and the family is not pinged again; the message is still retained in
 * the Guardian inbox, and an emergency is never throttled. Nor is a sender the
 * family vouched for: past the per-sender cap a contact at a ring-through trust
 * level (immediate family, close family, trusted friend) loses only the model
 * call, never the delivery.
 */
export const GUARDIAN_INBOUND_WINDOW_MS = 60 * 60 * 1000;
/** Messages from one number to one family, per window; held only for senders the family has not vouched for. */
export const GUARDIAN_INBOUND_SENDER_CAP = 10;
/** Messages to one family from anyone, per window. */
export const GUARDIAN_INBOUND_FAMILY_CAP = 200;
/**
 * Appended to the pipeline's reason when a routine message is held under the
 * cap. The message is recorded as `blocked` (kept in the Guardian inbox, no
 * family alert), and this is the part of the record that says why — the one
 * durable place a retried delivery can read the decision back from.
 */
export const GUARDIAN_INBOUND_CAP_REASON = 'Held under the hourly message cap; kept in the Guardian inbox without a family alert.';
