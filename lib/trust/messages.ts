import type { Decision } from './engine';

// A trust decision, told to a person in their language. (I18N-002)
//
// The engine explains itself in English for the audit trail (`reason`). The
// deny paths a member can hit also carry a catalogue key and CODE-valued
// params, and this turns those into the viewer's language, labels included:
// "Finances · Automate is explicitly blocked" becomes "Finanzen · Automatisieren
// ist … gesperrt", not "Finances · Automate ist … gesperrt". A decision with no
// key (every allow, and any path not yet keyed) falls back to its English
// `reason` rather than to nothing.

type Translate = (key: string, params?: Record<string, string | number>) => string;
type Explained = Pick<Decision, 'reason' | 'reasonKey' | 'reasonParams'>;

const camel = (code: string) => code.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** A label from the catalogue, or the code itself when the catalogue has none (as the engine does). */
function label(t: Translate, key: string, code: string): string {
  const value = t(key);
  return value === key ? code : value;
}

export function localizedTrustReason(t: Translate, decision: Explained): string {
  if (!decision.reasonKey) return decision.reason;
  const given = decision.reasonParams ?? {};
  const params: Record<string, string> = {};
  if (given.domain) params.domain = label(t, `trustDomain.${camel(given.domain)}`, given.domain);
  if (given.capability) params.capability = label(t, `trustCapability.${given.capability}`, given.capability);
  if (given.role) params.role = label(t, `trustRole.${given.role}`, given.role);
  return t(decision.reasonKey, params);
}

/** "Blocked by household policy: …", in the viewer's language. */
export function householdPolicyBlocked(t: Translate, decision: Explained): string {
  return t('trust.blockedByHouseholdPolicy', { reason: localizedTrustReason(t, decision) });
}
