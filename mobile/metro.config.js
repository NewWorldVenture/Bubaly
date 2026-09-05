// Metro config: the mobile app lives inside the Bubaly monorepo and imports the
// shared design tokens from ../design. Metro only bundles files it watches, so
// we add that folder, and we pin module resolution to mobile/node_modules so it
// never walks up into the web app's node_modules (a different React version).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const designRoot = path.resolve(projectRoot, '..', 'design');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [...(config.watchFolders ?? []), designRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
