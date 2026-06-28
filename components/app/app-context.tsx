'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Tables, DashboardView } from '@/lib/database.types';
import type { MemberRole } from '@/lib/constants/roles';
import type { FeatureTier } from '@/lib/constants/feature-catalog';

export type FamilyOption = { familyId: string; name: string };

export type AppContextValue = {
  userId: string;
  userEmail: string | null;
  familyId: string;
  family: Tables<'families'>;
  role: MemberRole;
  families: FamilyOption[];
  /** Site-wide Super Administrator — independent of any family role. */
  isSuperAdmin: boolean;
  /** The user's chosen default dashboard (personal vs. family Command Center). */
  defaultDashboard: DashboardView;
  /** Active family's subscription level: 0 = Free, 1 = Family Basic, 2 = Family+. */
  planLevel: number;
  /** Admin Tier & Features, resolved per route href ({ href → tier }); drives nav gating. */
  featureTiers: Record<string, FeatureTier>;
  /** Unread family messages for this user (drives the sidebar Messages badge). */
  unreadMessages: number;
  members: Tables<'family_members'>[];
  /** The current user's member row in the active family (if they have one). */
  selfMember: Tables<'family_members'> | null;
  refreshMembers: () => Promise<void>;
};

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within <AppProvider>');
  return ctx;
}

export function AppProvider({
  value,
  initialMembers,
  children,
}: {
  value: Omit<AppContextValue, 'members' | 'refreshMembers' | 'selfMember' | 'unreadMessages'> & { unreadMessages?: number };
  initialMembers: Tables<'family_members'>[];
  children: React.ReactNode;
}) {
  const [members, setMembers] = useState(initialMembers);

  const refreshMembers = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('family_members')
      .select('*')
      .eq('family_id', value.familyId)
      .eq('is_active', true)
      .order('created_at');
    if (data) setMembers(data);
  }, [value.familyId]);

  // Keep the member roster live across the app.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`members:${value.familyId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'family_members', filter: `family_id=eq.${value.familyId}` },
        () => { void refreshMembers(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [value.familyId, refreshMembers]);

  const selfMember = members.find((m) => m.user_id === value.userId) ?? null;

  return (
    <AppContext.Provider value={{ unreadMessages: 0, ...value, members, selfMember, refreshMembers }}>
      {children}
    </AppContext.Provider>
  );
}
