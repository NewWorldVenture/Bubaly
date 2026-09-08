import React, { useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, View } from 'react-native';
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

type Message = { id: string; role: 'user' | 'assistant' | 'error'; content: string; actions?: AssistantAction[]; cards?: AssistantCard[] };

const SUGGESTIONS = ['What’s on this week?', 'Add milk and eggs to the list', 'Plan tacos for Friday dinner', 'Remind me to change the HVAC filter next month'];

export default function AssistantScreen() {
  const { colors, spacing, radius } = useTheme();
  const { accessToken, family } = useAuth();
  const [conversationId, setConversationId] = useState(() => Crypto.randomUUID());
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [mic, setMic] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const listRef = useRef<FlatList<Message>>(null);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    if (!accessToken) {
      setMessages((m) => [...m, { id: Crypto.randomUUID(), role: 'error', content: 'Sign in again to use the assistant.' }]);
      return;
    }
    setDraft('');
    setBusy(true);
    setMessages((m) => [...m, { id: Crypto.randomUUID(), role: 'user', content: message }]);
    try {
      const reply = await askAssistant({ token: accessToken, conversationId, message });
      setMessages((m) => [...m, { id: Crypto.randomUUID(), role: 'assistant', content: reply.content, actions: reply.actions, cards: reply.cards }]);
    } catch (e) {
      const content = e instanceof AssistantError ? e.message : 'Bubaly hit a snag. Try again in a moment.';
      setMessages((m) => [...m, { id: Crypto.randomUUID(), role: 'error', content }]);
    } finally {
      setBusy(false);
    }
  };

  const fail = (content: string) => setMessages((m) => [...m, { id: Crypto.randomUUID(), role: 'error', content }]);

  // Talk to Bubaly: record -> POST the file to /api/ai/voice/transcribe with the
  // bearer token -> send the transcript as an ordinary turn. Every failure is
  // said out loud (including the honest 503 when transcription is not
  // configured); a recording is never silently dropped.
  const startRecording = async () => {
    if (mic !== 'idle' || busy) return;
    if (!accessToken) { fail('Sign in again to use the assistant.'); return; }
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) { fail('Bubaly needs microphone access to listen. Enable it in Settings.'); return; }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setMic('recording');
    } catch {
      setMic('idle');
      fail('Could not start recording. Try again.');
    }
  };

  const stopRecording = async () => {
    if (mic !== 'recording') return;
    setMic('transcribing');
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
      const uri = recorder.uri;
      if (!uri) { fail('That recording came back empty. Try again.'); return; }
      if (!accessToken) { fail('Sign in again to use the assistant.'); return; }
      const text = await transcribeSpeech({ token: accessToken, recording: { uri } });
      setMic('idle');
      await send(text);
    } catch (e) {
      fail(e instanceof AssistantError ? e.message : 'Bubaly could not transcribe that. Try again.');
    } finally {
      setMic('idle');
    }
  };

  const reset = () => {
    setConversationId(Crypto.randomUUID());
    setMessages([]);
  };

  const newChat = (
    <Pressable accessibilityRole="button" accessibilityLabel="New conversation" onPress={reset} hitSlop={12} style={{ paddingTop: 6 }}>
      <Ionicons name="create-outline" size={24} color={colors.muted} />
    </Pressable>
  );

  return (
    <Screen title="Assistant" subtitle={family ? `Chief of staff for ${family.familyName}` : undefined} right={newChat} scroll={false}>
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
                  <AppText variant="heading">Ask for anything</AppText>
                </View>
                <AppText variant="muted">I can add events, chores, grocery items, reminders, notes, goals and meal plans — and actually do it, not just describe it.</AppText>
              </GlassCard>
              {SUGGESTIONS.map((s) => (
                <Pressable key={s} accessibilityRole="button" onPress={() => send(s)} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
                  <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, paddingHorizontal: spacing[4], paddingVertical: spacing[3] }}>
                    <AppText>{s}</AppText>
                  </View>
                </Pressable>
              ))}
            </View>
          }
          renderItem={({ item }) => <Bubble message={item} />}
          ListFooterComponent={
            busy ? <AppText variant="muted" style={{ paddingVertical: spacing[2] }}>Bubaly is thinking…</AppText>
              : mic === 'recording' ? <AppText variant="muted" style={{ paddingVertical: spacing[2] }}>Listening… tap the square to send.</AppText>
                : mic === 'transcribing' ? <AppText variant="muted" style={{ paddingVertical: spacing[2] }}>Turning that into words…</AppText>
                  : null
          }
        />
        <View style={{ flexDirection: 'row', gap: spacing[2], paddingHorizontal: spacing[5], paddingVertical: spacing[3], borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg, alignItems: 'flex-end' }}>
          <View style={{ flex: 1 }}>
            <Field placeholder="Message Bubaly…" value={draft} onChangeText={setDraft} returnKeyType="send" onSubmitEditing={() => send(draft)} editable={!busy && mic === 'idle'} accessibilityLabel="Message" multiline />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={mic === 'recording' ? 'Stop and send' : 'Speak'}
            accessibilityState={{ busy: mic === 'transcribing', selected: mic === 'recording' }}
            disabled={busy || mic === 'transcribing'}
            onPress={() => { void (mic === 'recording' ? stopRecording() : startRecording()); }}
            style={({ pressed }) => ({
              width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
              borderWidth: 1,
              borderColor: mic === 'recording' ? colors.danger : colors.border,
              backgroundColor: mic === 'recording' ? colors.danger : colors.surface,
              opacity: busy || mic === 'transcribing' ? 0.5 : pressed ? 0.85 : 1,
            })}
          >
            <Ionicons
              name={mic === 'recording' ? 'square' : 'mic-outline'}
              size={mic === 'recording' ? 18 : 22}
              color={mic === 'recording' ? colors.brandFg : colors.muted}
            />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            disabled={busy || !draft.trim()}
            onPress={() => send(draft)}
            style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.brand, alignItems: 'center', justifyContent: 'center', opacity: busy || !draft.trim() ? 0.5 : pressed ? 0.85 : 1 })}
          >
            <Ionicons name="arrow-up" size={22} color={colors.brandFg} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Bubble({ message }: { message: Message }) {
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
          {message.actions.map((a, i) => <Pill key={`${a.summary}-${i}`} label={`${a.ok ? '✓' : '!'} ${a.summary || 'Done'}`} tone={a.ok ? 'success' : 'danger'} />)}
        </View>
      ) : null}
      {message.cards?.map((card, i) => <CardSectionView key={`${card.kind}-${i}`} section={cardSections(card)} />)}
    </View>
  );
}

/**
 * One card as a simple section (§53 on a phone): a heading, an optional
 * subheading, a few lines, and — for a run or a trip — a way to open it on
 * the web. The full card components live in the web app; this is the same
 * outcome at a glance.
 */
function CardSectionView({ section }: { section: CardSection }) {
  const { colors, spacing } = useTheme();
  const accent = { brand: colors.brandText, success: colors.success, warning: colors.warning, danger: colors.danger, muted: colors.muted }[section.tone];
  const open = section.href ? () => { Linking.openURL(webUrl(section.href as string)).catch(() => undefined); } : undefined;
  return (
    <GlassCard style={{ gap: spacing[1], borderLeftWidth: 3, borderLeftColor: accent }} accessibilityRole={open ? 'button' : undefined} accessibilityLabel={section.title}>
      <Pressable onPress={open} disabled={!open} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, gap: spacing[1] })}>
        <AppText variant="heading">{section.title}</AppText>
        {section.subtitle ? <AppText variant="muted">{section.subtitle}</AppText> : null}
        {section.lines.map((line, i) => <AppText key={`${line}-${i}`}>{line}</AppText>)}
        {section.more > 0 ? <AppText variant="caption">+{section.more} more</AppText> : null}
        {open ? <AppText variant="caption" color={colors.brandText}>Open on the web</AppText> : null}
      </Pressable>
    </GlassCard>
  );
}
