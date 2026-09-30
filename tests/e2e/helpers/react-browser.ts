import fs from 'node:fs';
import path from 'node:path';

// The browser harness specs load real React into a page as two scripts that
// define `window.React` and `window.ReactDOM`. They used to read React's UMD
// builds (`umd/react.development.js`), and React 19 ships none (BD-02 declared
// React 19). This builds the same two globals from the CommonJS files React 19
// does ship, with a small module registry standing in for `require`: no
// bundler, no new dependency, the installed React bytes unchanged.
//
// `ReactDOM` carries both `react-dom` and `react-dom/client`, as the UMD build
// did, so `ReactDOM.createRoot` and `ReactDOM.hydrateRoot` keep working.
export function reactBrowserScripts(mode: 'development' | 'production' = 'development'): { react: string; reactDom: string } {
  const read = (pkg: string, file: string) =>
    fs.readFileSync(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), file), 'utf8');
  const modules: Record<string, string> = {
    react: read('react', `cjs/react.${mode}.js`),
    scheduler: read('scheduler', `cjs/scheduler.${mode}.js`),
    'react-dom': read('react-dom', `cjs/react-dom.${mode}.js`),
    'react-dom/client': read('react-dom', `cjs/react-dom-client.${mode}.js`),
  };
  const registry = Object.entries(modules)
    .map(([name, source]) => `${JSON.stringify(name)}: function (module, exports, require, process) {\n${source}\n}`)
    .join(',\n');
  const react = `(function () {
var process = { env: { NODE_ENV: ${JSON.stringify(mode)} } };
var definitions = {\n${registry}\n};
var cache = {};
function load(name) {
  if (cache[name]) return cache[name].exports;
  var define = definitions[name];
  if (!define) throw new Error('react-browser: no module named ' + name);
  var module = { exports: {} };
  cache[name] = module;
  define(module, module.exports, load, process);
  return module.exports;
}
window.__reactBrowserLoad = load;
window.React = load('react');
})();`;
  const reactDom = `(function () {
var load = window.__reactBrowserLoad;
window.ReactDOM = Object.assign({}, load('react-dom'), load('react-dom/client'));
})();`;
  return { react, reactDom };
}
