import base from '../../../../../playwright.config';
const projects = (process.env.PROBE_PROJECTS ?? 'ipad').split(',');
export default {
  ...base,
  testDir: '<probe dir>',
  testMatch: '**/*.spec.ts',
  retries: 0,
  reporter: [['line']],
  outputDir: process.env.PROBE_RESULTS ?? '<repo>-probe-results',
  use: { ...base.use, baseURL: process.env.PROBE_BASE ?? 'http://localhost:3127', trace: 'retain-on-failure' },
  projects: base.projects!.filter(p => projects.includes(p.name!)).map(p => ({ ...p, testMatch: '**/*.spec.ts' })),
  webServer: undefined,
};
