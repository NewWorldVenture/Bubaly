import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { Ionicons } from '@expo/vector-icons';
import { AppText } from '../../src/components/AppText';
import { Field } from '../../src/components/Field';
import { GlassCard } from '../../src/components/GlassCard';
import { Pill } from '../../src/components/Pill';
import { Screen } from '../../src/components/Screen';
import { askAssistant, AssistantError, transcribeSpeech } from '../../src/lib/api';
import { cardSections, type CardSection } from '../../src/lib/assistant-core';
import { fetchAssistantConversations, fetchAssistantHistory, mergeAssistantHistory, savedRunIds, type AssistantMessage as Message, type HistoryCursor, type SavedConversation } from '../../src/lib/assistant-history';
import { supabase } from '../../src/lib/supabase';
import { useAuth } from '../../src/lib/auth';
import { webUrl } from '../../src/lib/config';
import { useTheme } from '../../src/theme/theme';
import { deviceLocale, mobileTranslate, type MobileTranslator } from '../../src/lib/mobile-i18n';
import { VoiceSession, VoiceSessionError, type VoicePhase } from '../../src/lib/voice-session';

type Conversation = { owner: string; id: string; messages: Message[]; draft: string; phase: VoicePhase; before?: HistoryCursor | null; notice?: string; retryText?: string };
type HistoryList = { owner: string; open: boolean; rows: SavedConversation[]; loading: boolean; hasMore: boolean; error: boolean };
const emptyHistory = (owner: string): HistoryList => ({ owner, open: false, rows: [], loading: false, hasMore: false, error: false });
const emptyConversation = (owner: string): Conversation => ({ owner, id: Crypto.randomUUID(), messages: [], draft: '', phase: 'idle' });

const SUGGESTIONS = ['suggestionWeek', 'suggestionGroceries', 'suggestionDinner', 'suggestionReminder'];

export default function AssistantScreen() {
  const { colors, spacing, radius } = useTheme();
  const { accessToken, session, family, familyLoading, familyError, freshFamily, refreshFamily } = useAuth();
  const contextKey = [session?.user.id, family?.familyId, family?.memberId, family?.role].join(':');
  const [conversation, setConversation] = useState(() => emptyConversation(contextKey));
  const [history, setHistory] = useState(() => emptyHistory(contextKey));
  const [read, setRead] = useState({ owner: contextKey, loading: false, older: false, error: false, target: '' });
  const ownsConversation = conversation.owner === contextKey;
  const conversationId = conversation.id;
  // Passive cleanup runs after paint. The first render of another context must
  // already hide the previous owner's message, draft and recording state.
  const messages = ownsConversation ? conversation.messages : [];
  const draft = ownsConversation ? conversation.draft : '';
  const phase = ownsConversation ? conversation.phase : 'idle';
  const [locale, setLocale] = useState(deviceLocale);
  const t: MobileTranslator = (key, params) => mobileTranslate(locale, key, params);
  const listRef = useRef<FlatList<Message>>(null);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const mounted = useRef(true);
  const focused = useRef(false);
  const turnEpoch = useRef(0);
  const drafts = useRef(new Map<string, string>());
  const historyRequest = useRef<AbortController | null>(null);
  const messageRequest = useRef<AbortController | null>(null);
  const reading = useRef(false);
  const scrollToLatest = useRef(true);
  const runtime = useRef({ accessToken, session, family, conversationId, contextKey, ownsConversation, locale, freshFamily, recorder });
  runtime.current = { accessToken, session, family, conversationId, contextKey, ownsConversation, locale, freshFamily, recorder };
  const invalidateTurn = useCallback(() => { turnEpoch.current++; }, []);
  const isCurrentConversation = useCallback((owner: string, id: string) => runtime.current.contextKey === owner
    && runtime.current.conversationId === id && runtime.current.ownsConversation, []);
  const updateConversation = useCallback((update: (previous: Conversation) => Conversation, owner = runtime.current.contextKey, id = runtime.current.conversationId) => {
    const epoch = turnEpoch.current;
    setConversation((previous) => mounted.current && epoch === turnEpoch.current && previous.owner === owner && previous.id === id && isCurrentConversation(owner, id) ? update(previous) : previous);
  }, [isCurrentConversation]);
  const setDraft = (value: string) => updateConversation((previous) => ({ ...previous, draft: value }), contextKey, conversationId);
  const [flow] = useState(() => new VoiceSession({
    context: () => {
      const current = runtime.current;
      return current.ownsConversation && current.accessToken && current.session && current.family ? { userId: current.session.user.id,
        familyId: current.family.familyId, memberId: current.family.memberId, role: current.family.role,
        conversationId: current.conversationId, token: current.accessToken, locale: current.locale } : null;
    },
    freshFamily: () => runtime.current.freshFamily(),
    permission: async () => (await requestRecordingPermissionsAsync()).granted,
    audioMode: (recording) => setAudioModeAsync({ allowsRecording: recording, playsInSilentMode: true }),
    prepare: () => runtime.current.recorder.prepareToRecordAsync(), record: () => runtime.current.recorder.record(),
    stop: () => runtime.current.recorder.stop(), recordingUri: () => runtime.current.recorder.uri,
    transcribe: (context, uri, signal) => transcribeSpeech({ token: context.token, recording: { uri }, expectedFamilyId: context.familyId, locale: context.locale, signal }),
    ask: (context, text, signal) => askAssistant({ token: context.token, conversationId: context.conversationId, message: text, expectedFamilyId: context.familyId, locale: context.locale, signal }),
    phase: (next) => { if (mounted.current) updateConversation((previous) => ({ ...previous, phase: next })); },
    user: (text) => { scrollToLatest.current = true; updateConversation((previous) => ({ ...previous, draft: '', notice: undefined, retryText: undefined, messages: [...previous.messages, { id: Crypto.randomUUID(), role: 'user', content: text }] })); },
    reply: (reply) => updateConversation((previous) => ({ ...previous, messages: [...previous.messages, { id: Crypto.randomUUID(), role: 'assistant', content: reply.content, actions: reply.actions, cards: reply.cards, runIds: savedRunIds(reply.runIds) },
      ...(!reply.persisted ? [{ id: Crypto.randomUUID(), role: 'error' as const, content: mobileTranslate(runtime.current.locale, 'mobileAssistant.notSaved') }] : [])] })),
    error: (error) => updateConversation((previous) => ({ ...previous,
      ...(previous.phase === 'sending' ? { notice: 'mobileAssistant.interrupted', retryText: previous.messages.findLast((message) => message.role === 'user')?.content } : {}),
      messages: [...previous.messages, { id: Crypto.randomUUID(), role: 'error', content: error instanceof VoiceSessionError
      ? mobileTranslate(runtime.current.locale, error.key) : error instanceof AssistantError ? error.message : mobileTranslate(runtime.current.locale, 'mobileAssistant.recordingFailed') }] })),
  }));
  const cancelReads = useCallback(() => {
    historyRequest.current?.abort(); messageRequest.current?.abort(); reading.current = false;
    setHistory((previous) => ({ ...previous, loading: false }));
    setRead((previous) => ({ ...previous, loading: false }));
  }, []);
  useEffect(() => {
    invalidateTurn(); cancelReads(); drafts.current.clear(); flow.invalidate();
    setConversation(emptyConversation(contextKey)); setHistory(emptyHistory(contextKey));
    setRead({ owner: contextKey, loading: false, older: false, error: false, target: '' });
  }, [contextKey, flow, cancelReads, invalidateTurn]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; invalidateTurn(); historyRequest.current?.abort(); messageRequest.current?.abort(); flow.suspend(); }; }, [flow, invalidateTurn]);
  const suspend = useCallback(() => {
    invalidateTurn();
    const sent = flow.phase === 'sending';
    flow.suspend(); cancelReads();
    if (sent) updateConversation((previous) => ({ ...previous, notice: 'mobileAssistant.stopped' }));
  }, [flow, invalidateTurn, cancelReads, updateConversation]);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    if (AppState.currentState === 'active') flow.resume(); else flow.suspend();
    setLocale(deviceLocale());
    void runtime.current.freshFamily();
    return () => { focused.current = false; suspend(); };
  }, [flow, suspend]));
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state !== 'active') suspend();
      else if (focused.current) { flow.resume(); setLocale(deviceLocale()); void runtime.current.freshFamily(); }
    });
    return () => listener.remove();
  }, [flow, suspend]);
  const loadingHistory = read.owner === contextKey && read.loading;
  const unavailable = !ownsConversation || !accessToken || !family || !!familyError || loadingHistory;
  const busy = phase !== 'idle' && phase !== 'recording';
  const microphoneDisabled = phase === 'recording' ? false : busy || unavailable || familyLoading;
  const send = (text: string) => { if (isCurrentConversation(contextKey, conversationId) && !reading.current && !familyLoading && !unavailable) return flow.send(text); };

  const loadConversations = async (more = false) => {
    if (!isCurrentConversation(contextKey, conversationId) || !session || !family || familyError) return;
    historyRequest.current?.abort();
    const controller = new AbortController(); historyRequest.current = controller;
    const current = () => mounted.current && runtime.current.contextKey === contextKey && historyRequest.current === controller && !controller.signal.aborted;
    setHistory((previous) => ({ ...(previous.owner === contextKey ? previous : emptyHistory(contextKey)), open: true, loading: true, error: false }));
    try {
      const page = await fetchAssistantConversations(supabase, { userId: session.user.id, familyId: family.familyId }, controller.signal, more ? history.rows.length : 0);
      if (current()) setHistory((previous) => current() ? { ...previous, rows: more ? [...previous.rows, ...page.conversations.filter((row) => !previous.rows.some((existing) => existing.id === row.id))] : page.conversations, loading: false, hasMore: page.hasMore } : previous);
    } catch {
      if (current()) setHistory((previous) => current() ? { ...previous, loading: false, error: true } : previous);
    }
  };

  const openConversation = async (id: string, older = false) => {
    if (!isCurrentConversation(contextKey, conversationId) || !session || !family || familyError) return;
    if (older && (!conversation.before || reading.current)) return;
    const sent = flow.phase === 'sending';
    invalidateTurn(); flow.invalidate(); messageRequest.current?.abort();
    if (sent) updateConversation((previous) => ({ ...previous, notice: 'mobileAssistant.stopped', retryText: undefined }));
    const controller = new AbortController(); messageRequest.current = controller; reading.current = true;
    const current = () => mounted.current && runtime.current.contextKey === contextKey && messageRequest.current === controller && !controller.signal.aborted;
    setRead({ owner: contextKey, loading: true, older, error: false, target: id });
    try {
      const page = await fetchAssistantHistory(supabase, { userId: session.user.id, familyId: family.familyId }, id, controller.signal, older ? conversation.before ?? undefined : undefined);
      if (!current()) return;
      scrollToLatest.current = !older;
      runtime.current.conversationId = id;
      setConversation((previous) => {
        if (!current() || previous.owner !== contextKey) return previous;
        drafts.current.set(previous.id, previous.draft);
        return { owner: contextKey, id, draft: drafts.current.get(id) ?? '', phase: 'idle', before: page.before,
          messages: older ? mergeAssistantHistory(page.messages, previous.messages) : page.messages };
      });
      setHistory((previous) => current() ? { ...previous, open: false } : previous);
      setRead((previous) => current() ? { ...previous, loading: false, error: false } : previous);
    } catch {
      if (current()) setRead((previous) => current() ? { ...previous, loading: false, error: true } : previous);
    } finally { if (current()) reading.current = false; }
  };

  const stop = () => {
    if (!isCurrentConversation(contextKey, conversationId)) return;
    // The transport may have finished while React still has its reply queued.
    const sent = flow.phase === 'sending' || phase === 'sending';
    invalidateTurn(); flow.invalidate();
    if (sent) updateConversation((previous) => ({ ...previous, notice: 'mobileAssistant.stopped', retryText: undefined }));
  };

  const reset = () => {
    if (!isCurrentConversation(contextKey, conversationId)) return;
    invalidateTurn(); cancelReads(); flow.invalidate();
    drafts.current.set(conversationId, draft);
    const next = emptyConversation(contextKey); runtime.current.conversationId = next.id;
    setConversation(next); setHistory((previous) => ({ ...previous, open: false }));
    setRead({ owner: contextKey, loading: false, older: false, error: false, target: '' });
  };

  const newChat = (
    <View style={{ flexDirection: 'row', gap: spacing[3] }}>
    <Pressable accessibilityRole="button" accessibilityLabel={t('mobileAssistant.history')} disabled={!ownsConversation || !family || !session || !!familyError} onPress={() => {
      if (!isCurrentConversation(contextKey, conversationId)) return;
      if (history.owner === contextKey && history.open) setHistory((previous) => ({ ...previous, open: false })); else void loadConversations();
    }} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name="time-outline" size={24} color={colors.muted} />
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel={t('mobileAssistant.newConversation')} onPress={reset} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name="create-outline" size={24} color={colors.muted} />
    </Pressable>
    </View>
  );

  return (
    <Screen title={t('mobileAssistant.title')} subtitle={family ? t('mobileAssistant.subtitle', { family: family.familyName }) : undefined} right={newChat} scroll={false}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }} keyboardVerticalOffset={90}>
        {history.owner === contextKey && history.open && <ScrollView style={{ maxHeight: 240, flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: spacing[5], gap: spacing[2] }} keyboardShouldPersistTaps="handled">
          <AppText variant="heading">{t('mobileAssistant.history')}</AppText>
          {history.rows.map((row) => <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={row.title || t('mobileAssistant.newConversation')} accessibilityState={{ selected: row.id === conversationId }} onPress={() => void openConversation(row.id)} style={{ minHeight: 44, justifyContent: 'center' }}>
            <AppText color={row.id === conversationId ? colors.brandText : colors.fg}>{row.title || t('mobileAssistant.newConversation')}</AppText>
          </Pressable>)}
          {history.loading && <AppText variant="muted">{t('mobileAssistant.loadingHistory')}</AppText>}
          {!history.loading && !history.error && !history.rows.length && <AppText variant="muted">{t('mobileAssistant.emptyHistory')}</AppText>}
          {history.error && <AppText color={colors.danger}>{t('mobileAssistant.historyFailed')}</AppText>}
          {(history.error || history.hasMore) && <Pressable accessibilityRole="button" disabled={history.loading} onPress={() => void loadConversations(!history.error)} style={{ minHeight: 44, justifyContent: 'center' }}><AppText>{t(history.error ? 'mobileAssistant.retry' : 'mobileAssistant.moreChats')}</AppText></Pressable>}
        </ScrollView>}
        {read.owner === contextKey && (read.loading || read.error) && <View style={{ paddingHorizontal: spacing[5], gap: spacing[2] }}>
          <AppText color={read.error ? colors.danger : colors.muted}>{t(read.error ? 'mobileAssistant.historyFailed' : 'mobileAssistant.loadingHistory')}</AppText>
          {read.error && <Pressable accessibilityRole="button" accessibilityLabel={t('mobileAssistant.retryHistory')} onPress={() => void openConversation(read.target, read.older)} style={{ minHeight: 44, justifyContent: 'center' }}><AppText>{t('mobileAssistant.retry')}</AppText></Pressable>}
        </View>}
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ paddingHorizontal: spacing[5], paddingBottom: spacing[4], gap: spacing[3], flexGrow: 1 }}
          onContentSizeChange={() => { if (scrollToLatest.current) listRef.current?.scrollToEnd({ animated: true }); }}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={ownsConversation && conversation.before ? <Pressable accessibilityRole="button" accessibilityLabel={t('mobileAssistant.loadEarlier')} disabled={loadingHistory || phase !== 'idle'} onPress={() => void openConversation(conversationId, true)} style={{ minHeight: 44, justifyContent: 'center' }}><AppText>{t('mobileAssistant.loadEarlier')}</AppText></Pressable> : null}
          ListEmptyComponent={
            <View style={{ gap: spacing[3], marginTop: spacing[2] }}>
              <GlassCard style={{ gap: spacing[2] }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                  <Ionicons name="sparkles" size={18} color={colors.brandText} />
                  <AppText variant="heading">{t('mobileAssistant.askAnything')}</AppText>
                </View>
                <AppText variant="muted">{t('mobileAssistant.capabilities')}</AppText>
              </GlassCard>
              {SUGGESTIONS.map((s) => (
                <Pressable key={s} accessibilityRole="button" disabled={phase !== 'idle' || unavailable || familyLoading} onPress={() => void send(t(`mobileAssistant.${s}`))} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
                  <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, paddingHorizontal: spacing[4], paddingVertical: spacing[3] }}>
                    <AppText>{t(`mobileAssistant.${s}`)}</AppText>
                  </View>
                </Pressable>
              ))}
            </View>
          }
          renderItem={({ item }) => <Bubble message={item} t={t} locale={locale} />}
          ListFooterComponent={
            phase !== 'idle' ? <AppText variant="muted" style={{ paddingVertical: spacing[2] }}>{t(`mobileAssistant.${({ checking: 'checking', preparing: 'preparing', recording: 'listening', stopping: 'stopping', transcribing: 'transcribing', sending: 'thinking' })[phase]}`)}</AppText> : null
          }
        />
        {ownsConversation && conversation.notice && <View style={{ paddingHorizontal: spacing[5], gap: spacing[2] }}>
          <AppText color={colors.warning}>{t(conversation.notice)}</AppText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[3] }}>
            <Pressable accessibilityRole="button" accessibilityLabel={t('mobileAssistant.reviewSaved')} disabled={loadingHistory || phase !== 'idle'} onPress={() => void openConversation(conversationId)} style={{ minHeight: 44, justifyContent: 'center' }}><AppText>{t('mobileAssistant.reviewSaved')}</AppText></Pressable>
            {conversation.retryText && <Pressable accessibilityRole="button" accessibilityLabel={t('mobileAssistant.editRetry')} disabled={loadingHistory || phase !== 'idle'} onPress={() => updateConversation((previous) => ({ ...previous, draft: previous.retryText ?? previous.draft }), contextKey, conversationId)} style={{ minHeight: 44, justifyContent: 'center' }}><AppText>{t('mobileAssistant.editRetry')}</AppText></Pressable>}
          </View>
        </View>}
        {phase !== 'idle' && <Pressable accessibilityRole="button" accessibilityLabel={t('mobileAssistant.cancelTurn')} onPress={stop} style={{ minHeight: 44, paddingHorizontal: spacing[5], justifyContent: 'center' }}><AppText color={colors.danger}>{t('mobileAssistant.cancelTurn')}</AppText></Pressable>}
        {(!family || familyError) && <View style={{ paddingHorizontal: spacing[5], gap: spacing[2] }}>
          <AppText color={colors.danger}>{t(familyLoading ? 'mobileAssistant.checking' : familyError ? 'mobileAssistant.familyUnavailable' : 'mobileAssistant.needsFamily')}</AppText>
          <Pressable accessibilityRole="button" disabled={familyLoading} onPress={() => void refreshFamily()} style={{ minHeight: 44, justifyContent: 'center' }}><AppText>{t('mobileAssistant.retry')}</AppText></Pressable>
        </View>}
        <View style={{ flexDirection: 'row', gap: spacing[2], paddingHorizontal: spacing[5], paddingVertical: spacing[3], borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg, alignItems: 'flex-end' }}>
          <View style={{ flex: 1 }}>
            <Field placeholder={t('mobileAssistant.placeholder')} value={draft} onChangeText={setDraft} returnKeyType="send" onSubmitEditing={() => void send(draft)} editable={phase === 'idle' && !unavailable && !familyLoading} accessibilityLabel={t('mobileAssistant.message')} maxLength={8000} multiline />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(phase === 'recording' ? 'mobileAssistant.stopSend' : 'mobileAssistant.speak')}
            accessibilityState={{ busy, selected: phase === 'recording' }}
            disabled={microphoneDisabled}
            onPress={() => { if (isCurrentConversation(contextKey, conversationId) && !reading.current && !unavailable && !familyLoading) void (phase === 'recording' ? flow.stopAndSend() : flow.startRecording()); }}
            style={({ pressed }) => ({
              width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
              borderWidth: 1,
              borderColor: phase === 'recording' ? colors.danger : colors.border,
              backgroundColor: phase === 'recording' ? colors.danger : colors.surface,
              opacity: microphoneDisabled ? 0.5 : pressed ? 0.85 : 1,
            })}
          >
            <Ionicons
              name={phase === 'recording' ? 'square' : 'mic-outline'}
              size={phase === 'recording' ? 18 : 22}
              color={phase === 'recording' ? colors.brandFg : colors.muted}
            />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('mobileAssistant.send')}
            disabled={phase !== 'idle' || unavailable || familyLoading || !draft.trim()}
            onPress={() => void send(draft)}
            style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.brand, alignItems: 'center', justifyContent: 'center', opacity: phase !== 'idle' || unavailable || familyLoading || !draft.trim() ? 0.5 : pressed ? 0.85 : 1 })}
          >
            <Ionicons name="arrow-up" size={22} color={colors.brandFg} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Bubble({ message, t, locale }: { message: Message; t: MobileTranslator; locale: string }) {
  const { colors, glass, radius, spacing } = useTheme();
  const mine = message.role === 'user';
  const isError = message.role === 'error';
  return (
    <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '88%', gap: spacing[2] }}>
      <View
        style={{
          borderRadius: radius.xl,
          borderBottomRightRadius: mine ? radius.sm : radius.xl,
          borderBottomLeftRadius: mine ? radius.xl : radius.sm,
          paddingHorizontal: spacing[4],
          paddingVertical: spacing[3],
          backgroundColor: mine ? colors.brand : isError ? 'transparent' : glass.background,
          borderWidth: 1,
          borderColor: mine ? colors.brand : isError ? colors.danger : glass.border,
        }}
      >
        <AppText color={mine ? colors.brandFg : isError ? colors.danger : colors.fg}>{message.content}</AppText>
      </View>
      {message.actions?.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] }}>
          {message.actions.map((a, i) => <Pill key={`${a.summary}-${i}`} label={`${a.ok ? '✓' : '!'} ${a.summary || t('mobileAssistant.done')}`} tone={a.ok ? 'success' : 'danger'} />)}
        </View>
      ) : null}
      {message.cards?.map((card, i) => <CardSectionView key={`${card.kind}-${i}`} section={cardSections(card, t, locale)} t={t} />)}
      {message.responseError && <AppText color={colors.danger}>{message.responseError}</AppText>}
      {message.runIds?.filter((id) => !message.cards?.some((card) => card.kind === 'run_status' && card.run_id === id)).map((id) => <CardSectionView key={id} section={{ kind: 'run', title: t('mobileAssistant.openRun'), subtitle: null, lines: [], more: 0, tone: 'brand', href: `/dashboard/concierge/runs/${id}` }} t={t} />)}
    </View>
  );
}

/**
 * One card as a simple section (§53 on a phone): a heading, an optional
 * subheading, a few lines, and — for a run or a trip — a way to open it on
 * the web. The full card components live in the web app; this is the same
 * outcome at a glance.
 */
function CardSectionView({ section, t }: { section: CardSection; t: MobileTranslator }) {
  const { colors, spacing } = useTheme();
  const [failed, setFailed] = useState(false);
  const accent = { brand: colors.brandText, success: colors.success, warning: colors.warning, danger: colors.danger, muted: colors.muted }[section.tone];
  const open = section.href ? () => { setFailed(false); Linking.openURL(webUrl(section.href as string)).catch(() => setFailed(true)); } : undefined;
  return (
    <GlassCard style={{ gap: spacing[1], borderLeftWidth: 3, borderLeftColor: accent }} accessibilityRole={open ? 'button' : undefined} accessibilityLabel={section.title}>
      <Pressable onPress={open} disabled={!open} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, gap: spacing[1] })}>
        <AppText variant="heading">{section.title}</AppText>
        {section.subtitle ? <AppText variant="muted">{section.subtitle}</AppText> : null}
        {section.lines.map((line, i) => <AppText key={`${line}-${i}`}>{line}</AppText>)}
        {section.more > 0 ? <AppText variant="caption">{t('mobileAssistant.more', { count: section.more })}</AppText> : null}
        {open ? <AppText variant="caption" color={colors.brandText}>{t('mobileAssistant.openWeb')}</AppText> : null}
        {failed ? <AppText color={colors.danger}>{t('mobileAssistant.linkFailed')}</AppText> : null}
      </Pressable>
    </GlassCard>
  );
}
