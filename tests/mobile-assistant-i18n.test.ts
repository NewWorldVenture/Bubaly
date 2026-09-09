import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import messages from '../mobile/src/lib/assistant-messages.json';
import { mobileLocale, mobileTranslate } from '../mobile/src/lib/mobile-i18n';
import { buildAssistantRequest, cardSections, parseAssistantResponse } from '../mobile/src/lib/assistant-core';
import { buildTranscribeRequest, parseTranscribeResponse } from '../mobile/src/lib/voice-core';

const root = process.cwd();
const locales = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('assistant-only mobile locale catalogue', () => {
  it('is reproducibly generated and mirrors all seven source catalogues including placeholders', () => {
    execFileSync(process.execPath, ['scripts/generate-mobile-assistant-messages.mjs', '--check'], { cwd: root });
    expect(Object.keys(messages).sort()).toEqual([...locales].sort());
    for (const locale of locales) {
      const base = JSON.parse(readFileSync(join(root, 'lib/i18n/messages', `${locale}.json`), 'utf8'));
      const subset = Object.fromEntries(Object.entries(base).filter(([key]) => key.startsWith('mobileAssistant.')));
      expect(messages[locale]).toEqual(subset);
      for (const [key, value] of Object.entries(messages[locale])) {
        expect(value.trim(), `${locale} ${key}`).not.toBe('');
        expect(placeholders(value)).toEqual(placeholders((messages['en-US'] as Record<string, string>)[key]));
      }
    }
  });

  it('chooses a supported base language from the device locale, with English fallback', () => {
    expect(mobileLocale('de-AT')).toBe('de-DE'); expect(mobileLocale('pt_BR')).toBe('pt-PT');
    expect(mobileLocale('FR-ca')).toBe('fr-FR'); expect(mobileLocale('ja-JP')).toBe('en-US');
    expect(mobileLocale(null)).toBe('en-US');
    expect(mobileTranslate('de-AT', 'mobileAssistant.subtitle', { family: 'Müller' })).toContain('Müller');
    expect(mobileTranslate('de-DE', 'mobileAssistant.familyUnavailable')).not.toBe(messages['en-US']['mobileAssistant.familyUnavailable']);
  });

  it('feeds translated permission copy into the actual Expo configuration for each supported language', () => {
    const require = createRequire(import.meta.url);
    const config = require('../mobile/app.config.js')({ config: require('../mobile/app.json').expo });
    const audio = config.plugins.find((plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-audio');
    expect(audio[1].microphonePermission).toBe(messages['en-US']['mobileAssistant.permission']);
    expect(audio[1].microphonePermission).not.toContain('hold');
    expect(audio[1].enableBackgroundPlayback).toBe(false);
    for (const locale of locales) expect(config.locales[locale.split('-')[0]].ios.NSMicrophoneUsageDescription).toBe(messages[locale]['mobileAssistant.permission']);
  });

  it.each(locales)('distinguishes unavailable context from disabled voice in %s', (locale) => {
    const t = (key: string) => mobileTranslate(locale, key);
    expect(parseTranscribeResponse(503, { code: 'not_configured' }, t)).toMatchObject({ ok: false, error: messages[locale]['mobileAssistant.voiceNotConfigured'] });
    expect(parseTranscribeResponse(503, { code: 'unavailable' }, t)).toMatchObject({ ok: false, error: messages[locale]['mobileAssistant.familyUnavailable'] });
    expect(parseTranscribeResponse(503, { error: 'Provider temporarily offline' }, t)).toMatchObject({ ok: false, error: 'Provider temporarily offline' });
    expect(parseAssistantResponse(409, { code: 'family_changed' }, t)).toMatchObject({ ok: false, error: messages[locale]['mobileAssistant.contextChanged'] });
    expect(parseAssistantResponse(503, { code: 'unavailable' }, t)).toMatchObject({ ok: false, error: messages[locale]['mobileAssistant.familyUnavailable'] });
    expect(parseAssistantResponse(503, { code: 'not_configured' }, t)).toMatchObject({ ok: false, error: messages[locale]['mobileAssistant.notConfigured'] });
  });

  it('formats authored card fragments and money with the selected locale', () => {
    const t = (key: string, params?: Record<string, string | number>) => mobileTranslate('de-DE', key, params);
    const section = cardSections({ kind: 'budget_analysis', title: 'Budget', total_spent: 1234.5, total_limit: 2000, currency: 'EUR' }, t, 'de-DE');
    expect(section.lines[0]).toContain(new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(1234.5));
    const groceries = cardSections({ kind: 'grocery_list', title: 'Einkaufen', items: [{ name: 'Milch' }] }, t, 'de-DE');
    expect(groceries.subtitle).toBe(messages['de-DE']['mobileAssistant.singleItem']);
  });
});

describe('phone request context transport', () => {
  it('sends expected household, selected locale, and abort signal on both APIs', () => {
    const signal = new AbortController().signal;
    const context = { apiUrl: 'https://www.bubaly.com', token: 'bearer-token', expectedFamilyId: '86b36c49-a21d-4f9d-8187-e5fc3307e159', locale: 'de-DE', signal };
    const assistant = buildAssistantRequest({ ...context, conversationId: 'conversation-1', message: 'Hallo' });
    const transcribe = buildTranscribeRequest({ ...context, recording: { uri: 'file:///voice.m4a' } });
    for (const { init } of [assistant, transcribe]) {
      expect(init.headers).toMatchObject({ Authorization: 'Bearer bearer-token', 'X-Bubaly-Family-Id': context.expectedFamilyId, 'Accept-Language': 'de-DE' });
      expect(init.signal).toBe(signal);
    }
    expect(transcribe.init.headers).not.toHaveProperty('Content-Type');
    expect(JSON.parse(String(assistant.init.body))).not.toHaveProperty('familyId');
  });

  it('keeps callers without an expected household or locale compatible', () => {
    const { init } = buildTranscribeRequest({ apiUrl: 'https://www.bubaly.com', token: 'token', recording: { uri: 'file:///voice.m4a' } });
    expect(init.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer token' });
    expect(init.signal).toBeUndefined();
  });

  it('preserves an explicitly empty assertion so the API rejects it instead of treating it as absent', () => {
    const base = { apiUrl: 'https://www.bubaly.com', token: 'token', expectedFamilyId: '' };
    const assistant = buildAssistantRequest({ ...base, message: 'hello', conversationId: 'conversation' });
    const transcribe = buildTranscribeRequest({ ...base, recording: { uri: 'file:///voice.m4a' } });
    for (const { init } of [assistant, transcribe]) expect(init.headers).toHaveProperty('X-Bubaly-Family-Id', '');
  });
});
