import React, { useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, RefreshControl, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText } from '../../src/components/AppText';
import { Button } from '../../src/components/Button';
import { EmptyState } from '../../src/components/EmptyState';
import { Field } from '../../src/components/Field';
import { GlassCard } from '../../src/components/GlassCard';
import { Divider, ListRow } from '../../src/components/ListRow';
import { Screen } from '../../src/components/Screen';
import { useAsyncData } from '../../src/hooks/use-async-data';
import { useAuth } from '../../src/lib/auth';
import { addGroceryItem, fetchGroceryList, setGroceryChecked, type GroceryItemRow } from '../../src/lib/queries';
import { supabase } from '../../src/lib/supabase';
import { useTheme } from '../../src/theme/theme';

type List = { listId: string | null; items: GroceryItemRow[] };

export default function GroceryScreen() {
  const { colors, spacing } = useTheme();
  const { family, session } = useAuth();
  const familyId = family?.familyId ?? null;
  const list = useAsyncData<List>(() => (familyId ? fetchGroceryList(supabase, familyId) : Promise.resolve({ listId: null, items: [] })), [familyId]);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const toggle = async (item: GroceryItemRow) => {
    const next = !item.is_checked;
    list.setData((prev) => (prev ? { ...prev, items: prev.items.map((i) => (i.id === item.id ? { ...i, is_checked: next } : i)) } : prev));
    try {
      await setGroceryChecked(supabase, item.id, next);
    } catch (e) {
      list.setData((prev) => (prev ? { ...prev, items: prev.items.map((i) => (i.id === item.id ? { ...i, is_checked: !next } : i)) } : prev));
      setActionError(e instanceof Error ? e.message : 'Could not update that item.');
    }
  };

  const add = async () => {
    const name = draft.trim();
    if (!name || !familyId || !session) return;
    setAdding(true);
    setActionError(null);
    try {
      await addGroceryItem(supabase, { familyId, listId: list.data?.listId ?? null, name, userId: session.user.id });
      setDraft('');
      await list.refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not add that item.');
    } finally {
      setAdding(false);
    }
  };

  const items = list.data?.items ?? [];
  const toBuy = items.filter((i) => !i.is_checked);
  const done = items.filter((i) => i.is_checked);

  return (
    <Screen title="Grocery" subtitle={items.length ? `${toBuy.length} to buy · ${done.length} in the cart` : undefined} scroll={false}>
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
                  <Field placeholder="Add an item…" value={draft} onChangeText={setDraft} returnKeyType="done" onSubmitEditing={add} accessibilityLabel="New grocery item" />
                </View>
                <Button title="Add" onPress={add} loading={adding} disabled={!draft.trim()} />
              </View>
              {actionError ? <AppText color={colors.danger}>{actionError}</AppText> : null}
            </View>
          }
          ItemSeparatorComponent={Divider}
          renderItem={({ item }) => (
            <ListRow
              title={item.name}
              subtitle={item.quantity ?? undefined}
              muted={item.is_checked}
              onPress={() => toggle(item)}
              accessibilityLabel={`${item.is_checked ? 'Uncheck' : 'Check'} ${item.name}`}
              leading={
                <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: item.is_checked }} onPress={() => toggle(item)} hitSlop={8}>
                  <Ionicons name={item.is_checked ? 'checkmark-circle' : 'ellipse-outline'} size={26} color={item.is_checked ? colors.success : colors.muted} />
                </Pressable>
              }
            />
          )}
          ListEmptyComponent={
            list.loading ? null : (
              <GlassCard style={{ marginTop: spacing[2] }}>
                {list.error
                  ? <AppText color={colors.danger}>{list.error}</AppText>
                  : <EmptyState icon="cart-outline" title="Your list is empty" body="Add items above, or ask the assistant to build one from this week’s meals." />}
              </GlassCard>
            )
          }
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}
