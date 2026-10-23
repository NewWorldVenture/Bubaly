import React, { useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, RefreshControl, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText } from '../../src/components/AppText';
import { Button } from '../../src/components/Button';
import { EmptyState } from '../../src/components/EmptyState';
import { FamilyGate } from '../../src/components/FamilyGate';
import { Field } from '../../src/components/Field';
import { GlassCard } from '../../src/components/GlassCard';
import { Divider, ListRow } from '../../src/components/ListRow';
import { Screen } from '../../src/components/Screen';
import { useAsyncData } from '../../src/hooks/use-async-data';
import { useAuth } from '../../src/lib/auth';
import { messageFor } from '../../src/lib/errors';
import { deviceLocale, mobileTranslate } from '../../src/lib/mobile-i18n';
import { addGroceryItem, fetchGroceryList, setGroceryChecked, type GroceryItemRow, type GroceryPage } from '../../src/lib/queries';
import { supabase } from '../../src/lib/supabase';
import { useTheme } from '../../src/theme/theme';

const empty = (familyId: string | null): GroceryPage => ({ familyId: familyId ?? '', listId: null, listName: null, otherLists: 0, items: [], count: 0 });

export default function GroceryScreen() {
  const { colors, spacing } = useTheme();
  const { family, session, familyLoading, familyError, refreshFamily } = useAuth();
  const familyId = family?.familyId ?? null;
  const t = (key: string, params?: Record<string, string | number>) => mobileTranslate(deviceLocale(), key, params);
  const list = useAsyncData<GroceryPage>((signal) => (familyId ? fetchGroceryList(supabase, familyId, signal) : Promise.resolve(empty(familyId))), [familyId]);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  // In-flight guards as refs: two submits from one render (return key, then
  // Add) both read that render's `adding`, which is still false; and two quick
  // taps on one row would issue two updates whose server order is not fixed.
  const addInFlight = useRef(false);
  const togglesInFlight = useRef(new Set<string>());
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const flip = (id: string, checked: boolean) => list.setData((prev) => (prev ? { ...prev, items: prev.items.map((i) => (i.id === id ? { ...i, is_checked: checked } : i)) } : prev));
  const setPending = (id: string, pending: boolean) => {
    if (pending) togglesInFlight.current.add(id); else togglesInFlight.current.delete(id);
    setPendingIds((prev) => { const next = new Set(prev); if (pending) next.add(id); else next.delete(id); return next; });
  };

  const toggle = async (item: GroceryItemRow) => {
    if (!familyId || togglesInFlight.current.has(item.id)) return;
    const next = !item.is_checked;
    setPending(item.id, true);
    flip(item.id, next);
    try {
      const written = await setGroceryChecked(supabase, familyId, item.id, next);
      if (!written) {
        // No row matched: removed or cleared on the web since this list was
        // read. The flip is undone and the list re-read, rather than a tick
        // kept on an item that is gone.
        flip(item.id, !next);
        setActionError(t('mobileAssistant.groceryItemGone'));
        await list.refresh();
      }
    } catch (e) {
      flip(item.id, !next);
      setActionError(messageFor(e, t('mobileAssistant.groceryUpdateFailed')));
    } finally {
      setPending(item.id, false);
    }
  };

  const add = async () => {
    const name = draft.trim();
    if (!name || !familyId || !session || addInFlight.current) return;
    addInFlight.current = true;
    setAdding(true);
    setActionError(null);
    setNotice(null);
    try {
      // The loaded list's id only while that list is this family's; a page read
      // for another family passes null and the database's get-or-create answers.
      const listId = list.data && list.data.familyId === familyId ? list.data.listId : null;
      const added = await addGroceryItem(supabase, { familyId, listId, name, userId: session.user.id });
      setDraft('');
      if (added.duplicate) { setNotice(t('mobileAssistant.groceryAlreadyListed', { name })); return; }
      // The inserted row is shown at once, so a follow-up refresh that fails
      // cannot make a write that landed look like one that did not.
      if (added.item) {
        const row = added.item;
        list.setData((prev) => prev && prev.familyId === familyId && !prev.items.some((i) => i.id === row.id)
          ? { ...prev, listId: prev.listId ?? added.listId, items: [row, ...prev.items], count: prev.count + 1 }
          : prev);
      }
      await list.refresh();
    } catch (e) {
      setActionError(messageFor(e, t('mobileAssistant.groceryAddFailed')));
    } finally {
      addInFlight.current = false;
      setAdding(false);
    }
  };

  if (!family) {
    return (
      <Screen title="Grocery">
        <FamilyGate loading={familyLoading} error={familyError} onRetry={() => void refreshFamily()} />
      </Screen>
    );
  }

  const items = list.data?.items ?? [];
  const toBuy = items.filter((i) => !i.is_checked);
  const done = items.filter((i) => i.is_checked);
  const listName = list.data?.listName;
  const subtitle = items.length ? `${listName ? `${listName} · ` : ''}${toBuy.length} to buy · ${done.length} in the cart` : listName ?? undefined;
  const otherLists = list.data?.otherLists ?? 0;
  const readError = list.error ? (list.data ? t('mobileAssistant.refreshFailed') : list.error) : null;

  return (
    <Screen title="Grocery" subtitle={subtitle} scroll={false}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }} keyboardVerticalOffset={90}>
        <FlatList
          data={[...toBuy, ...done]}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: spacing[5], paddingBottom: spacing[10] }}
          refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} tintColor={colors.brandText} colors={[colors.brand]} />}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <View style={{ gap: spacing[3], marginBottom: spacing[3] }}>
              <View style={{ flexDirection: 'row', gap: spacing[2], alignItems: 'flex-end' }}>
                <View style={{ flex: 1 }}>
                  <Field placeholder="Add an item…" value={draft} onChangeText={setDraft} returnKeyType="done" onSubmitEditing={adding ? undefined : add} accessibilityLabel="New grocery item" />
                </View>
                <Button title="Add" onPress={add} loading={adding} disabled={!draft.trim()} />
              </View>
              {readError ? <AppText accessibilityRole="alert" color={colors.danger}>{readError}</AppText> : null}
              {actionError ? <AppText accessibilityRole="alert" color={colors.danger}>{actionError}</AppText> : null}
              {notice ? <AppText variant="muted">{notice}</AppText> : null}
              {otherLists > 0 ? <AppText variant="muted">{t(otherLists === 1 ? 'mobileAssistant.otherListsOne' : 'mobileAssistant.otherListsOther', { count: otherLists })}</AppText> : null}
            </View>
          }
          ItemSeparatorComponent={Divider}
          renderItem={({ item }) => {
            const pending = pendingIds.has(item.id);
            return (
              <ListRow
                title={item.name}
                subtitle={item.quantity ?? undefined}
                muted={item.is_checked}
                onPress={pending ? undefined : () => toggle(item)}
                accessibilityLabel={`${item.is_checked ? 'Uncheck' : 'Check'} ${item.name}`}
                leading={
                  <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: item.is_checked, busy: pending, disabled: pending }} disabled={pending} onPress={() => toggle(item)} hitSlop={8}>
                    <Ionicons name={item.is_checked ? 'checkmark-circle' : 'ellipse-outline'} size={26} color={item.is_checked ? colors.success : colors.muted} />
                  </Pressable>
                }
              />
            );
          }}
          ListFooterComponent={list.data && list.data.count > items.length
            ? <AppText variant="muted" style={{ marginTop: spacing[3] }}>{t('mobileAssistant.showingItems', { shown: items.length, total: list.data.count })}</AppText>
            : null}
          ListEmptyComponent={
            list.loading || list.error ? null : (
              <GlassCard style={{ marginTop: spacing[2] }}>
                <EmptyState icon="cart-outline" title="Your list is empty" body="Add items above, or ask the assistant to build one from this week’s meals." />
              </GlassCard>
            )
          }
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}
