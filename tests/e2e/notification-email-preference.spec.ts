import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Actual preference card, SettingsModule tab/hash, NotificationsModule branches
// and shared controls execute. The serialized action bridge, account context,
// inbox query, icons and unrelated modules are declared inert seams. Actual
// action authentication/query/ack behavior is covered separately by SDK tests.
const root = process.env.BUBALY_EMAIL_UI_SOURCE_ROOT ?? process.cwd();
const css = process.env.BUBALY_EMAIL_UI_CSS ? fs.readFileSync(process.env.BUBALY_EMAIL_UI_CSS, 'utf8') : '';
const { react, reactDom } = reactBrowserScripts('development');
const files = [
  'components/settings/notification-email-preference.tsx', 'components/modules/settings-module.tsx',
  'components/modules/notifications-module.tsx', 'components/ui/card.tsx', 'components/ui/button.tsx',
  'components/ui/input.tsx', 'components/ui/badge.tsx', 'components/ui/states.tsx', 'components/ui/states-client.tsx',
  'components/app/page-header.tsx', 'lib/notifications/priority.ts', 'lib/tone/partner-phrasing.ts',
  'lib/constants/roles.ts', 'lib/constants/dashboards.ts', 'lib/onboarding/profile.ts', 'lib/i18n/nav-label.ts',
];
const sources = Object.fromEntries(files.map(file => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(
  fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  } },
).outputText]));
const messages = JSON.parse(fs.readFileSync(path.join(root, 'lib/i18n/messages/en-US.json'), 'utf8')) as Record<string, string>;
const origin = 'https://notification-email-ui-fixture.invalid';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
type Screen = 'card' | 'settings' | 'notifications';
type Outcome = 'healthy' | 'error' | 'throw' | 'foreign' | 'malformed';
type Probe = { mount: (screen: Screen, userId?: string, inbox?: 'ready' | 'loading' | 'error') => void };
declare global { interface Window { __emailPreferenceUI: Probe } }

async function fixture(page: Page) {
  const rows = new Map<string, boolean>([[A, true], [B, true]]);
  const calls: { kind: 'load' | 'save'; userId: string; enabled?: boolean }[] = [];
  const held: { kind: 'load' | 'save'; userId: string; release: () => void }[] = [];
  const hold = new Set<string>();
  const modes = { load: 'healthy', save: 'healthy' } as Record<'load' | 'save', Outcome>;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(`${message.type()}: ${message.text()}`);
  });
  page.on('requestfailed', request => errors.push(`request failed: ${request.url()} ${request.failure()?.errorText ?? ''}`));
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== origin) throw new Error('Unexpected fixture network request');
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html class="dark"><body><main id="root" style="padding:16px;max-width:960px;margin:auto"></main></body></html>' });
  });
  await page.exposeFunction('__emailPreferenceAction', async (kind: 'load' | 'save', userId: string, enabled?: boolean) => {
    calls.push({ kind, userId, ...(kind === 'save' ? { enabled } : {}) });
    if (hold.has(`${kind}:${userId}`)) await new Promise<void>(release => held.push({ kind, userId, release }));
    const mode = modes[kind];
    if (mode === 'throw') throw new Error('Synthetic action transport unavailable');
    if (mode === 'error') return { ok: false, error: 'Synthetic preference unavailable' };
    if (mode === 'foreign') return { ok: true, userId: userId === A ? B : A, enabled: false };
    if (mode === 'malformed') return { ok: true, userId, enabled: 'false' };
    if (kind === 'save') rows.set(userId, enabled!);
    return { ok: true, userId, enabled: rows.get(userId) ?? true };
  });
  const bundle = `(() => {
    const definitions = ${JSON.stringify(sources)}, messages = ${JSON.stringify(messages)};
    const React = window.React, context = React.createContext(null), cache = {};
    let currentUser = ${JSON.stringify(A)}, inbox = 'ready', rendered = null;
    const Empty = () => null;
    const icons = new Proxy({}, {get: () => props => React.createElement('svg', {'aria-hidden':true, className:props.className})});
    const t = (key, params) => Object.entries(params || {}).reduce((value,[name,replacement]) => value.replaceAll('{'+name+'}',String(replacement)), messages[key] || key);
    const profileQuery = {select(){return this},eq(){return this},maybeSingle:async()=>({data:{full_name:'Synthetic Member',phone:null,avatar_url:null},error:null})};
    const noop = async () => ({ok:true});
    const externals = {
      react:React, 'lucide-react':icons,
      'next/link':{default:({children,...props})=>React.createElement('a',props,children)},
      '@/components/app/app-context':{useApp:()=>React.useContext(context)},
      '@/components/i18n/locale-provider':{useTranslations:()=>t},
      '@/components/i18n/use-format':{useFormat:()=>({fmtMoney:()=>'$0',fmtRelative:()=> 'now'})},
      '@/components/ui/toast':{useToast:()=>({success:()=>{},error:()=>{}})},
      '@/lib/utils/cn':{cn:(...values)=>values.filter(Boolean).join(' ')},
      '@/lib/supabase/client':{createClient:()=>({from:(table)=>{if(table!=='profiles')throw Error('Unexpected unrelated data read');return profileQuery}})},
      '@/lib/hooks/use-realtime-query':{useRealtimeQuery:()=>({data:[],loading:inbox==='loading',error:inbox==='error'?'Synthetic inbox unavailable':null,refresh:async()=>{}})},
      '@/lib/supabase/settle':{settle:async result=>result},
      '@/lib/supabase/errors':{describeDbError:()=> 'Synthetic error',wroteNoRows:rows=>!rows?.length},
      '@/lib/referrals/core':{DEFAULT_REFERRAL_CONFIG:{}},
      '@/lib/utils/phone':{guessDialCodeFromPhone:()=>'+1',extractLocalNumber:value=>value,COUNTRY_DIAL_CODES:[{dialCode:'+1',code:'US'}]},
      '@/lib/notifications/actions':{notificationAction:()=>({href:'#',isFallback:true})},
      '@/app/(app)/actions':{setDefaultDashboardAction:noop,updateMyProfileAction:noop},
      '@/app/(app)/dashboard/approvals-actions':{decideApproval:noop},
      '@/app/(app)/dashboard/chores/actions':{setChoreStatusAction:noop},
      '@/app/(app)/settings/notification-actions':{
        getEmailPreferenceAction:()=>window.__emailPreferenceAction('load',currentUser),
        setEmailPreferenceAction:enabled=>window.__emailPreferenceAction('save',currentUser,enabled),
      },
    };
    function load(name) {
      if (externals[name]) return externals[name];
      if (!definitions[name]) {
        if(name.startsWith('@/components/')) return new Proxy({}, {get:()=>Empty});
        throw Error('Unmapped fixture dependency '+name);
      }
      if(cache[name]) return cache[name].exports;
      const module={exports:{}};cache[name]=module;
      new Function('require','module','exports',definitions[name])(child=>load(child==='./states-client'?'@/components/ui/states-client':child),module,module.exports);
      return module.exports;
    }
    const Card=load('@/components/settings/notification-email-preference').NotificationEmailPreference;
    const Settings=load('@/components/modules/settings-module').SettingsModule;
    const Notifications=load('@/components/modules/notifications-module').NotificationsModule;
    window.__emailPreferenceUI={mount(screen,userId=${JSON.stringify(A)},feed='ready') {
      currentUser=userId;inbox=feed;
      if(!rendered) rendered=window.ReactDOM.createRoot(document.getElementById('root'));
      const value={userId,userEmail:'synthetic@fixture.invalid',familyId:'synthetic-family',family:{id:'synthetic-family',name:'Synthetic family'},role:'adult',members:[],defaultDashboard:'personal'};
      const Component=screen==='settings'?Settings:screen==='notifications'?Notifications:Card;
      rendered.render(React.createElement(context.Provider,{value},React.createElement(Component)));
    }};
  })();`;
  async function boot(screen: Screen = 'card', userId = A, hash = '') {
    await page.goto(origin + '/' + hash);
    await page.addScriptTag({ content: react });
    await page.addScriptTag({ content: reactDom });
    await page.addScriptTag({ content: bundle });
    if (css) await page.addStyleTag({ content: css });
    await page.evaluate(({ screen, userId }) => window.__emailPreferenceUI.mount(screen, userId), { screen, userId });
  }
  async function release(kind: 'load' | 'save', userId = A) {
    hold.delete(`${kind}:${userId}`);
    held.filter(item => item.kind === kind && item.userId === userId).forEach(item => item.release());
  }
  return { rows, calls, hold, modes, errors, boot, release };
}

test('an acknowledged email change survives a new mount and document reload', async ({ page }) => {
  const f = await fixture(page); await f.boot();
  const email = page.getByRole('checkbox', { name: 'Email', exact: true });
  await expect(email).toBeChecked(); await email.click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await expect(email).not.toBeChecked(); expect(f.rows.get(A)).toBe(false);
  await f.boot(); await expect(email).not.toBeChecked(); await expect(email).toBeEnabled();
  expect(f.calls.filter(call => call.kind === 'load')).toHaveLength(2);
  expect(f.errors).toEqual([]);
});

test('a pending save keeps the last acknowledged value and prevents duplicate keyboard saves', async ({ page }) => {
  const f = await fixture(page); await f.boot(); f.hold.add(`save:${A}`);
  const email = page.getByRole('checkbox', { name: 'Email', exact: true });
  await expect(email).toBeEnabled(); await email.focus(); await page.keyboard.press('Space');
  await expect(email).toBeDisabled(); await expect(email).toBeChecked();
  await page.keyboard.press('Space');
  expect(f.calls.filter(call => call.kind === 'save')).toHaveLength(1);
  await f.release('save'); await expect(email).not.toBeChecked(); await expect(email).toBeEnabled();
  expect(f.errors).toEqual([]);
});

for (const mode of ['error', 'throw', 'foreign', 'malformed'] as const) {
  test(`a ${mode} initial read disables the control until a successful retry`, async ({ page }) => {
    const f = await fixture(page); f.modes.load = mode; await f.boot();
    const email = page.getByRole('checkbox', { name: 'Email', exact: true });
    await expect(page.getByRole('alert')).toBeVisible(); await expect(email).toBeDisabled();
    expect(f.calls.filter(call => call.kind === 'save')).toEqual([]);
    f.modes.load = 'healthy'; await page.getByRole('button', { name: 'Try again' }).click();
    await expect(email).toBeChecked(); await expect(email).toBeEnabled();
    expect(f.errors).toEqual([]);
  });

  test(`a ${mode} save cannot change the confirmed control or claim success`, async ({ page }) => {
    const f = await fixture(page); await f.boot(); f.modes.save = mode;
    const email = page.getByRole('checkbox', { name: 'Email', exact: true });
    await expect(email).toBeEnabled(); await email.click();
    await expect(page.getByRole('alert')).toBeVisible(); await expect(email).toBeChecked();
    await expect(email).toBeEnabled(); await expect(page.getByText('Saved', { exact: true })).toHaveCount(0);
    expect(f.rows.get(A)).toBe(true);
    f.modes.save = 'healthy'; await email.click();
    await expect(email).not.toBeChecked(); await expect(page.getByRole('status')).toHaveText('Saved');
    expect(f.errors).toEqual([]);
  });
}

test('a late read from a previous account cannot replace the current account control', async ({ page }) => {
  const f = await fixture(page); f.rows.set(A, false); f.hold.add(`load:${A}`); await f.boot();
  await expect.poll(() => f.calls.filter(call => call.kind === 'load')).toHaveLength(1);
  await page.evaluate(userId => window.__emailPreferenceUI.mount('card', userId), B);
  const email = page.getByRole('checkbox', { name: 'Email', exact: true });
  await expect(email).toBeEnabled(); await expect(email).toBeChecked();
  await f.release('load', A); await page.waitForTimeout(25); await expect(email).toBeChecked();
  expect(f.errors).toEqual([]);
});

test('a late save from a previous account cannot change the current control or its feedback', async ({ page }) => {
  const f = await fixture(page); await f.boot(); f.hold.add(`save:${A}`);
  const email = page.getByRole('checkbox', { name: 'Email', exact: true });
  await expect(email).toBeEnabled(); await email.click(); await expect(email).toBeDisabled();
  await page.evaluate(userId => window.__emailPreferenceUI.mount('card', userId), B);
  await expect(email).toBeEnabled(); await expect(email).toBeChecked();
  await f.release('save', A); await expect.poll(() => f.rows.get(A)).toBe(false);
  await expect(email).toBeChecked(); await expect(page.getByText('Saved', { exact: true })).toHaveCount(0);
  expect(f.rows.get(B)).toBe(true); expect(f.errors).toEqual([]);
});

test('the actual Settings notifications tab, hash and returned view keep the preference reachable', async ({ page }) => {
  const f = await fixture(page); await f.boot('settings', A, '#notifications');
  const tab = page.getByRole('tab', { name: 'Notifications', exact: true });
  const email = page.getByRole('checkbox', { name: 'Email', exact: true });
  await expect(tab).toHaveAttribute('aria-selected', 'true'); await expect(email).toBeChecked();
  await email.click(); await expect(page.getByRole('status')).toHaveText('Saved');
  await page.getByRole('tab', { name: 'Profile', exact: true }).click(); await expect(email).toHaveCount(0);
  await tab.click(); await expect(email).not.toBeChecked(); await expect(email).toBeEnabled();
  expect(new URL(page.url()).hash).toBe('#notifications');
  await f.boot('settings', A, '#notifications'); await expect(email).not.toBeChecked();
  expect(f.errors).toEqual([]);
});

test('the actual notifications module preserves empty, loading and error views while email settings remain accessible', async ({ page }) => {
  const f = await fixture(page); await f.boot('notifications');
  const email = page.getByRole('checkbox', { name: 'Email', exact: true });
  await expect(email).toBeEnabled(); await expect(page.getByText('All caught up', { exact: true })).toBeVisible();
  await page.evaluate(() => window.__emailPreferenceUI.mount('notifications', undefined, 'loading'));
  await expect(page.getByRole('status', { name: 'Loading', exact: true })).toHaveCount(3); await expect(email).toBeEnabled();
  await page.evaluate(() => window.__emailPreferenceUI.mount('notifications', undefined, 'error'));
  await expect(page.getByText('Synthetic inbox unavailable', { exact: true })).toBeVisible(); await expect(email).toBeEnabled();
  await email.click(); await expect(page.getByRole('status')).toHaveText('Saved'); expect(f.rows.get(A)).toBe(false);
  expect(f.errors).toEqual([]);
});

for (const width of [320, 390, 1280]) {
  test(`compiled current CSS keeps the control usable at ${width}px`, async ({ page }) => {
    test.skip(!css, 'Provide the isolated current-source Tailwind output for viewport checks.');
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page); await f.boot('settings', A, '#notifications');
    const email = page.getByRole('checkbox', { name: 'Email', exact: true }); await expect(email).toBeEnabled();
    expect(await email.locator('..').evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await email.focus(); await page.keyboard.press('Space'); await expect(email).not.toBeChecked();
    expect(f.errors).toEqual([]);
  });
}
