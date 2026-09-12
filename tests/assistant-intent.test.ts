import { describe, it, expect } from 'vitest';
import {
  classifyAssistantUtterance, toSpeakable, speakList, boundSpeech,
  captureSpeech, unknownSpeech, HELP_SPEECH, MAX_SPEECH_CHARS,
} from '@/lib/assistant/intent';
import { classifyVoiceCommand } from '@/lib/voice/command-router';

const NOW = new Date('2026-03-10T09:00:00Z');
const kindOf = (text: string) => classifyAssistantUtterance(text, NOW).kind;

describe('a question is not a to-do', () => {
  // The defect this ordering exists to prevent: "what's on today" contains a
  // date, so the capture parser reads it as an event and Bubaly silently
  // creates a calendar entry called "what's on" instead of answering. Every
  // question form is therefore matched before capture is even tried.
  it('the capture parser really would get these wrong on its own', () => {
    // Not a hypothetical. Handed straight to the capture router, these become
    // saved rows: a calendar event titled "What's on today" and a task called
    // "What am i forgetting". That is what the ordering above prevents, and
    // asserting it here means a future reorder fails loudly instead of quietly
    // filling someone's calendar with their own questions.
    expect(classifyVoiceCommand("what's on today", NOW)).toMatchObject({ kind: 'event' });
    expect(classifyVoiceCommand('what is happening tomorrow', NOW)).toMatchObject({ kind: 'event' });
    expect(classifyVoiceCommand('what am i forgetting', NOW)).toMatchObject({ kind: 'task' });
  });

  it.each([
    "what's on today",
    'what is on today',
    'what are my plans today',
    'what is happening tomorrow',
    'read me my agenda',
    'what does my schedule look like',
  ])('%s asks about the day', (utterance) => {
    expect(kindOf(utterance)).toBe('agenda');
  });

  it('hears tomorrow when tomorrow is said, and today otherwise', () => {
    expect(classifyAssistantUtterance("what's on tomorrow", NOW)).toEqual({ kind: 'agenda', day: 'tomorrow' });
    expect(classifyAssistantUtterance("what's on today", NOW)).toEqual({ kind: 'agenda', day: 'today' });
    expect(classifyAssistantUtterance("what's on", NOW)).toEqual({ kind: 'agenda', day: 'today' });
  });

  it.each(["what's next", 'what is next', 'next up', 'what do i do now'])(
    '%s asks for the next thing', (utterance) => expect(kindOf(utterance)).toBe('next'),
  );

  it.each(['what am i forgetting', 'am i missing anything', 'did i forget anything'])(
    '%s asks the forgetting check', (utterance) => expect(kindOf(utterance)).toBe('forgetting'),
  );

  it.each(['help', 'what can you do', 'what can i say', 'how does this work'])(
    '%s asks for help', (utterance) => expect(kindOf(utterance)).toBe('help'),
  );
});

describe('capture still works through an assistant', () => {
  it('routes a shopping command', () => {
    const intent = classifyAssistantUtterance('hey bubaly add milk to the shopping list', NOW);
    expect(intent).toMatchObject({ kind: 'capture', route: { kind: 'shopping' } });
    if (intent.kind === 'capture') expect(intent.route.text.toLowerCase()).toContain('milk');
  });

  it('routes a reminder to a task', () => {
    const intent = classifyAssistantUtterance('remind me to call the dentist', NOW);
    expect(intent).toMatchObject({ kind: 'capture', route: { kind: 'task' } });
  });

  it('strips the wake word an assistant leaves on the transcript', () => {
    const intent = classifyAssistantUtterance('okay bubaly note that the boiler is making a noise', NOW);
    expect(intent).toMatchObject({ kind: 'capture', route: { kind: 'note' } });
    if (intent.kind === 'capture') expect(intent.route.text.toLowerCase()).not.toContain('bubaly');
  });
});

describe('speech an assistant actually reads well', () => {
  it('treats an empty transcript as a request for help, not as a command', () => {
    // Alexa sends an empty slot rather than omitting it, so this is a real
    // request shape and not a defensive nicety.
    expect(kindOf('')).toBe('help');
    expect(kindOf('   ')).toBe('help');
  });

  it('says nothing a speech engine would mangle', () => {
    expect(toSpeakable('**Dentist** at 3pm — see https://example.com/x')).toBe('Dentist at 3pm — see a link');
    expect(toSpeakable('- milk\n- eggs')).toBe('milk eggs');
    expect(toSpeakable('Tom & Jerry')).toBe('Tom and Jerry');
    expect(toSpeakable('`code` #tag |pipe|')).toBe('code tag pipe');
  });

  it('joins items the way a person says them', () => {
    expect(speakList(['milk'])).toBe('milk');
    expect(speakList(['milk', 'eggs'])).toBe('milk and eggs');
    expect(speakList(['milk', 'eggs', 'bread'])).toBe('milk, eggs and bread');
    expect(speakList([])).toBe('');
    expect(speakList(['  ', 'milk'])).toBe('milk');
  });

  it('stops at a sentence rather than mid-word', () => {
    const long = `${'Dentist at three. '.repeat(60)}`;
    const bounded = boundSpeech(long);
    expect(bounded.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
    expect(bounded.endsWith('.')).toBe(true);
  });

  it('falls back to an ellipsis when there is no sentence break to use', () => {
    const bounded = boundSpeech('word '.repeat(400));
    expect(bounded.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS + 1);
    expect(bounded.endsWith('…')).toBe(true);
  });

  it('never emits markdown even from user-written titles', () => {
    // Titles come from whatever a person typed into Bubaly, so the sanitiser
    // has to survive hostile-ish input rather than assume clean data.
    const nasty = '**URGENT** — pay #123 & see http://x.test/a_b_c';
    expect(boundSpeech(nasty)).not.toMatch(/[*_`#>|]|https?:/);
  });

  it('confirms a capture by naming what it became', () => {
    expect(captureSpeech({ text: 'milk', kind: 'shopping', explicit: true })).toBe('Added milk to the shopping list.');
    expect(captureSpeech({ text: 'call the dentist', kind: 'task', explicit: true })).toBe('Added a task: call the dentist.');
    expect(captureSpeech({ text: 'school play', kind: 'event', explicit: true })).toBe('Added school play to the calendar.');
    expect(captureSpeech({ text: 'boiler noise', kind: 'note', explicit: true })).toBe('Noted: boiler noise.');
  });

  it('repeats back what it heard when it did not understand', () => {
    const speech = unknownSpeech('florgle the bimbulator');
    expect(speech).toContain('florgle the bimbulator');
    expect(speech).toContain('You can ask what is on today');
  });

  it('offers help rather than quoting silence', () => {
    expect(unknownSpeech('')).toBe(HELP_SPEECH);
  });
});
