// Metro config: the mobile app lives inside the Bubaly monorepo and imports the
// shared design tokens and portable auth transport. Metro only bundles files it
// watches, so we add those folders and pin resolution to mobile/node_modules so it
// never walks up into the web app's node_modules (a different React version).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const designRoot = path.resolve(projectRoot, '..', 'design');
const sharedRoot = path.resolve(projectRoot, '..', 'shared');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [...(config.watchFolders ?? []), designRoot, sharedRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
