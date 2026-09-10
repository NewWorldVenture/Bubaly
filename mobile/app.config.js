// Native permission copy comes from the same generated assistant catalogue.
// Regenerate from the seven base catalogues with the repository script.
const messages = require('./src/lib/assistant-messages.json');

module.exports = ({ config }) => ({
  ...config,
  plugins: config.plugins.map((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-audio'
    ? [plugin[0], { ...plugin[1], microphonePermission: messages['en-US']['mobileAssistant.permission'] }]
    : plugin),
  locales: Object.fromEntries(Object.entries(messages).map(([locale, catalog]) => [
    locale.split('-')[0], { ios: { NSMicrophoneUsageDescription: catalog['mobileAssistant.permission'] } },
  ])),
});
