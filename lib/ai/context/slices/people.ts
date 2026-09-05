// The household roster: who is in the family, how old they are, who manages
// it and who is asking. Loaded from the roster the builder already fetched,
// so it costs no query. No contact details — an email or phone number is
// never something a planner needs to say "I'll remind Maya".
import 'server-only';
import { ROLE_LABELS } from '@/lib/constants/roles';
import { fenceUntrusted } from '@/lib/ai/safety/untrusted';
import { ok } from '@/lib/services/types';
import type { SliceDefinition } from '../policy';

export type PeopleSliceData = {
  members: {
    id: string;
    name: string;
    role: string;
    age: number | null;
    canManage: boolean;
    hasLogin: boolean;
    isViewer: boolean;
  }[];
};

export const peopleSlice: SliceDefinition = {
  name: 'people',
  title: 'Household',
  async load(_scope, env) {
    const members = env.members.map((m) => ({
      id: m.id,
      name: m.displayName,
      role: m.role,
      age: m.age,
      canManage: m.canManage,
      hasLogin: m.hasLogin,
      isViewer: m.id === env.viewer.memberId,
    }));

    const lines = members.map((m) => {
      const parts = [ROLE_LABELS[m.role as keyof typeof ROLE_LABELS] ?? m.role];
      if (m.age !== null) parts.push(`age ${m.age}`);
      if (m.canManage) parts.push('manages the family');
      if (!m.hasLogin) parts.push('profile without a login, cannot be messaged directly');
      if (m.isViewer) parts.push('the person asking');
      return `- ${fenceUntrusted('member_name', m.name)} — ${parts.join(', ')}`;
    });

    const data: PeopleSliceData = { members };
    return ok({ data, count: members.length, lines });
  },
};
