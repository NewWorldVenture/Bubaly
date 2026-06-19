'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Tables } from '@/lib/database.types';
import type { MemberRole } from '@/lib/constants/roles';

export type FamilyOption = { familyId: string; name: string };

export type AppContextValue = {
  userId: string;
  userEmail: string | null;
  familyId: string;
  family: Tables<'families'>;
  role: MemberRole;
  families: FamilyOption[];
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
  value: Omit<AppContextValue, 'members' | 'refreshMembers' | 'selfMember'>;
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
    <AppContext.Provider value={{ ...value, members, selfMember, refreshMembers }}>
      {children}
    </AppContext.Provider>
  );
}
