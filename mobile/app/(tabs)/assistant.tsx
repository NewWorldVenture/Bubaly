import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, View } from 'react-native';
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
import { cardSections, type AssistantAction, type AssistantCard, type CardSection } from '../../src/lib/assistant-core';
import { useAuth } from '../../src/lib/auth';
import { webUrl } from '../../src/lib/config';
import { useTheme } from '../../src/theme/theme';
import { deviceLocale, mobileTranslate, type MobileTranslator } from '../../src/lib/mobile-i18n';
import { VoiceSession, VoiceSessionError, type VoicePhase } from '../../src/lib/voice-session';

type Message = { id: string; role: 'user' | 'assistant' | 'error'; content: string; actions?: AssistantAction[]; cards?: AssistantCard[] };

const SUGGESTIONS = ['suggestionWeek', 'suggestionGroceries', 'suggestionDinner', 'suggestionReminder'];

export default function AssistantScreen() {
  const { colors, spacing, radius } = useTheme();
  const { accessToken, session, family, familyLoading, familyError, freshFamily, refreshFamily } = useAuth();
  const [conversationId, setConversationId] = useState(() => Crypto.randomUUID());
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [locale, setLocale] = useState(deviceLocale);
  const t: MobileTranslator = (key, params) => mobileTranslate(locale, key, params);
  const listRef = useRef<FlatList<Message>>(null);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const mounted = useRef(true);
  const focused = useRef(false);
  const runtime = useRef({ accessToken, session, family, conversationId, locale, freshFamily, recorder });
  runtime.current = { accessToken, session, family, conversationId, locale, freshFamily, recorder };
  const [flow] = useState(() => new VoiceSession({
    context: () => {
      const current = runtime.current;
      return current.accessToken && current.session && current.family ? { userId: current.session.user.id,
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
    phase: (next) => { if (mounted.current) setPhase(next); },
    user: (text) => { setDraft(''); setMessages((rows) => [...rows, { id: Crypto.randomUUID(), role: 'user', content: text }]); },
    reply: (reply) => setMessages((rows) => [...rows, { id: Crypto.randomUUID(), role: 'assistant', content: reply.content, actions: reply.actions, cards: reply.cards },
      ...(!reply.persisted ? [{ id: Crypto.randomUUID(), role: 'error' as const, content: mobileTranslate(runtime.current.locale, 'mobileAssistant.notSaved') }] : [])]),
    error: (error) => setMessages((rows) => [...rows, { id: Crypto.randomUUID(), role: 'error', content: error instanceof VoiceSessionError
      ? mobileTranslate(runtime.current.locale, error.key) : error instanceof AssistantError ? error.message : mobileTranslate(runtime.current.locale, 'mobileAssistant.recordingFailed') }]),
  }));
  const contextKey = [session?.user.id, family?.familyId, family?.memberId, family?.role].join(':');
  useEffect(() => {
    flow.invalidate(); setConversationId(Crypto.randomUUID()); setMessages([]); setDraft('');
  }, [contextKey, flow]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; flow.suspend(); }; }, [flow]);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    if (AppState.currentState === 'active') flow.resume(); else flow.suspend();
    setLocale(deviceLocale());
    void runtime.current.freshFamily();
    return () => { focused.current = false; flow.suspend(); };
  }, [flow]));
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state !== 'active') flow.suspend();
      else if (focused.current) { flow.resume(); setLocale(deviceLocale()); void runtime.current.freshFamily(); }
    });
    return () => listener.remove();
  }, [flow]);
  const unavailable = !accessToken || !family || !!familyError;
  const busy = phase !== 'idle' && phase !== 'recording';
  const microphoneDisabled = phase === 'recording' ? false : busy || unavailable || familyLoading;
  const send = (text: string) => flow.send(text);

  const reset = () => {
    flow.invalidate();
    setConversationId(Crypto.randomUUID());
    setMessages([]);
    setDraft('');
  };

  const newChat = (
    <Pressable accessibilityRole="button" accessibilityLabel={t('mobileAssistant.newConversation')} onPress={reset} hitSlop={12} style={{ paddingTop: 6 }}>
      <Ionicons name="create-outline" size={24} color={colors.muted} />
    </Pressable>
  );

  return (
    <Screen title={t('mobileAssistant.title')} subtitle={family ? t('mobileAssistant.subtitle', { family: family.familyName }) : undefined} right={newChat} scroll={false}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }} keyboardVerticalOffset={90}>
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ paddingHorizontal: spacing[5], paddingBottom: spacing[4], gap: spacing[3], flexGrow: 1 }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
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
        {unavailable && <View style={{ paddingHorizontal: spacing[5], gap: spacing[2] }}>
          <AppText color={colors.danger}>{t(familyError ? 'mobileAssistant.familyUnavailable' : 'mobileAssistant.needsFamily')}</AppText>
          <Pressable accessibilityRole="button" disabled={familyLoading} onPress={() => void refreshFamily()} style={{ minHeight: 44, justifyContent: 'center' }}><AppText>{t('mobileAssistant.retry')}</AppText></Pressable>
        </View>}
        <View style={{ flexDirection: 'row', gap: spacing[2], paddingHorizontal: spacing[5], paddingVertical: spacing[3], borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg, alignItems: 'flex-end' }}>
          <View style={{ flex: 1 }}>
            <Field placeholder={t('mobileAssistant.placeholder')} value={draft} onChangeText={setDraft} returnKeyType="send" onSubmitEditing={() => void send(draft)} editable={phase === 'idle' && !unavailable && !familyLoading} accessibilityLabel={t('mobileAssistant.message')} multiline />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(phase === 'recording' ? 'mobileAssistant.stopSend' : 'mobileAssistant.speak')}
            accessibilityState={{ busy, selected: phase === 'recording' }}
            disabled={microphoneDisabled}
            onPress={() => { void (phase === 'recording' ? flow.stopAndSend() : flow.startRecording()); }}
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
