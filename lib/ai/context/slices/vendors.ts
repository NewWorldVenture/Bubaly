// The contractors and service providers the family already trusts — the
// first place "find a plumber" looks (Workflow D: "identify previous plumber
// if one exists"). Contact details are shown to managers only; everyone else
// sees who the family uses and for what.
import 'server-only';
import { fenceUntrusted, sanitizeUntrusted } from '@/lib/ai/safety/untrusted';
import { listContractors } from '@/lib/services/home';
import { ok } from '@/lib/services/types';
import type { SliceDefinition } from '../policy';
import { dayKeyLabel } from '../render';

const MAX_CONTRACTORS = 30;

export type VendorsSliceData = {
  contractors: {
    id: string;
    name: string;
    trade: string | null;
    company: string | null;
    isPreferred: boolean;
    rating: number | null;
    lastUsedOn: string | null;
    /** Present only for managers. */
    phone: string | null;
    email: string | null;
    notes: string | null;
  }[];
};

export const vendorsSlice: SliceDefinition = {
  name: 'vendors',
  title: 'Trusted providers',
  async load(scope, env) {
    const contractors = await listContractors(scope, { limit: MAX_CONTRACTORS });
    if (!contractors.ok) return contractors;
    const showContact = env.viewer.canManage;

    const data: VendorsSliceData = {
      contractors: contractors.data.map((c) => ({
        id: c.id, name: c.name, trade: c.trade, company: c.company, isPreferred: c.is_preferred, rating: c.rating, lastUsedOn: c.last_used_on,
        phone: showContact ? c.phone : null, email: showContact ? c.email : null, notes: c.notes,
      })),
    };
    data.contractors.sort((a, b) => Number(b.isPreferred) - Number(a.isPreferred) || (b.lastUsedOn ?? '').localeCompare(a.lastUsedOn ?? ''));

    const lines = data.contractors.map((c) => {
      const bits = [`- ${fenceUntrusted('contractor', c.name)}`];
      if (c.trade) bits.push(`(${sanitizeUntrusted(c.trade, 30)})`);
      if (c.company) bits.push(`at ${fenceUntrusted('company', c.company)}`);
      if (c.isPreferred) bits.push('— preferred');
      if (c.rating !== null) bits.push(`rated ${c.rating}/5`);
      if (c.lastUsedOn) bits.push(`last used ${dayKeyLabel(c.lastUsedOn)}`);
      if (c.phone) bits.push(`phone ${fenceUntrusted('phone', c.phone)}`);
      if (c.email) bits.push(`email ${fenceUntrusted('email', c.email)}`);
      if (c.notes) bits.push(`— ${fenceUntrusted('contractor_notes', c.notes)}`);
      return bits.join(' ');
    });
    if (!lines.length) lines.push('- No saved providers yet.');

    return ok({ data, count: data.contractors.length, lines });
  },
};
