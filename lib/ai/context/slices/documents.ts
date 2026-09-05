// Document titles, categories and expiry dates — never contents, never a
// storage path. That is enough for "your passports expire before the trip"
// and nothing more. Manager-only by policy (§4); the documents service also
// drops secure-vault rows for anyone else, so the two rules back each other.
import 'server-only';
import { fenceUntrusted, sanitizeUntrusted } from '@/lib/ai/safety/untrusted';
import { expiringBefore, listDocuments } from '@/lib/services/documents';
import { ok } from '@/lib/services/types';
import { memberName, type SliceDefinition } from '../policy';
import { dayKeyLabel, shiftDayKey } from '../render';

const MAX_DOCUMENTS = 40;
const EXPIRY_HORIZON_DAYS = 90;

export type DocumentsSliceData = {
  expiring: { id: string; title: string; category: string | null; expiresAt: string | null; member: string | null; expired: boolean }[];
  recent: { id: string; title: string; category: string | null; expiresAt: string | null; member: string | null; secure: boolean }[];
};

export const documentsSlice: SliceDefinition = {
  name: 'documents',
  title: 'Documents (titles and expiry only)',
  async load(scope, env) {
    const horizon = shiftDayKey(env.todayKey, EXPIRY_HORIZON_DAYS, env.tz);
    const [expiring, recent] = await Promise.all([
      expiringBefore(scope, horizon),
      listDocuments(scope, { limit: MAX_DOCUMENTS }),
    ]);
    if (!expiring.ok) return expiring;
    if (!recent.ok) return recent;

    const expiringIds = new Set(expiring.data.map((d) => d.id));
    const data: DocumentsSliceData = {
      expiring: expiring.data.map((d) => ({
        id: d.id, title: d.title, category: d.category, expiresAt: d.expiresAt, member: memberName(env, d.memberId),
        expired: Boolean(d.expiresAt && d.expiresAt.slice(0, 10) < env.todayKey),
      })),
      recent: recent.data.filter((d) => !expiringIds.has(d.id)).map((d) => ({
        id: d.id, title: d.title, category: d.category, expiresAt: d.expiresAt, member: memberName(env, d.memberId), secure: d.isSecure,
      })),
    };

    const lines: string[] = [];
    for (const d of data.expiring) {
      const bits = [`- ${d.expired ? 'EXPIRED' : 'Expiring'} ${fenceUntrusted('document', d.title)}`];
      if (d.category) bits.push(`[${sanitizeUntrusted(d.category, 20)}]`);
      if (d.member) bits.push(`(${d.member})`);
      if (d.expiresAt) bits.push(`${d.expired ? 'since' : 'on'} ${dayKeyLabel(d.expiresAt.slice(0, 10))}`);
      lines.push(bits.join(' '));
    }
    for (const d of data.recent) {
      const bits = [`- ${fenceUntrusted('document', d.title)}`];
      if (d.category) bits.push(`[${sanitizeUntrusted(d.category, 20)}]`);
      if (d.member) bits.push(`(${d.member})`);
      if (d.expiresAt) bits.push(`expires ${dayKeyLabel(d.expiresAt.slice(0, 10))}`);
      if (d.secure) bits.push('(secure vault)');
      lines.push(bits.join(' '));
    }
    if (!lines.length) lines.push('- No documents on file.');

    return ok({ data, count: data.expiring.length + data.recent.length, lines });
  },
};
