import fs from 'node:fs';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// COMPONENT-FB6088CE0A34: actual component/hooks/refs in React19; every server
// action and Stripe.js operation is replaced before module evaluation. No key,
// card, provider, authentication, database or network workflow is exercised.
const { react, reactDom } = reactBrowserScripts();
const component = ts.transpileModule(fs.readFileSync('components/wallet/card-reveal-modal.tsx', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;
const origin = 'https://card-reveal-lifecycle-fixture.invalid';
type Stage = 'prepare' | 'import' | 'load' | 'nonce' | 'key';
type Call = { stage: string; card: string; data?: unknown };
type Display = { card: string; type: string; mounts: number; destroys: number };
type Snapshot = { calls: Call[]; displays: Display[]; loading: boolean; error: string | null };
type Probe = {
  close(): void;
  open(card: string): void;
  resolve(stage: Stage): Promise<void>;
  settle(): Promise<void>;
  get(): Snapshot;
};
declare global { interface Window { __revealLifecycle: Probe } }

async function fixture(page: Page, options: {
  hold?: Stage; holdCard?: string; refusal?: 'prepare' | 'key'; fail?: 'create' | 'mount'; destroyThrows?: boolean; strict?: boolean;
} = {}) {
  const unexpected: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async route => {
    if (route.request().url() !== `${origin}/`) { unexpected.push(route.request().url()); await route.abort(); return; }
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="icon" href="data:,"><style>.hidden{display:none}</style></head><body><div id="root"></div></body></html>' });
  });
  await page.goto(`${origin}/`);
  for (const content of [react, reactDom]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const options=${JSON.stringify(options)}, calls=[], displays=[], gates={}, h=React.createElement;
    const record=(stage,card,data)=>calls.push({stage,card,...(data===undefined?{}:{data})});
    function gate(stage,card,value){if(options.hold===stage&&card===(options.holdCard??'A'))return new Promise(resolve=>{gates[stage]=()=>resolve(value);});return Promise.resolve(value);}
    const prep=card=>({ok:true,data:{stripeCardId:'card-'+card,publishableKey:'synthetic-public-'+card,stripeAccount:'account-'+card}});
    const key=card=>({ok:true,data:{...prep(card).data,ephemeralKeySecret:'synthetic-secret-'+card}});
    const actions={
      prepareCardRevealAction:card=>{record('prepare',card);return gate('prepare',card,options.refusal==='prepare'?{ok:false,error:'safe prepare refusal'}:prep(card));},
      createCardRevealAction:input=>{record('key',input.cardId,input);return gate('key',input.cardId,options.refusal==='key'?{ok:false,error:'safe key refusal'}:key(input.cardId));},
    };
    const sdk={loadStripe:(publishableKey,config)=>{
      const card=config.stripeAccount.replace('account-','');record('load',card,{publishableKey,config});
      const stripe={
        createEphemeralKeyNonce:input=>{record('nonce',card,input);return gate('nonce',card,{nonce:'synthetic-nonce-'+card});},
        elements:()=>({create:(type,auth)=>{
          record('create',card,{type,auth});
          if(options.fail==='create'&&type==='issuingCardExpiryDisplay')throw new Error('synthetic display failure');
          const item={card,type,mounts:0,destroys:0};displays.push(item);let target;
          return {
            mount(node){item.mounts++;target=node;if(options.fail==='mount'&&type==='issuingCardExpiryDisplay')throw new Error('synthetic display failure');node.textContent='synthetic display '+card;},
            destroy(){item.destroys++;if(target)target.textContent='';if(options.destroyThrows&&type==='issuingCardNumberDisplay')throw new Error('synthetic destruction detail not for logging');},
          };
        }}),
      };return gate('load',card,stripe);
    }};
    const tr=key=>key;
    const modules={
      react:React,'lucide-react':new Proxy({},{get:()=>()=>null}),
      '@/components/ui/modal':{Modal:({children,onClose,title})=>h('section',{'data-modal':true},h('h1',null,title),h('button',{id:'close-reveal',onClick:onClose},'Close reveal'),children)},
      '@/app/(app)/money/actions':{prepareCardRevealAction:actions.prepareCardRevealAction,createCardRevealAction:actions.createCardRevealAction},
      '@/components/i18n/locale-provider':{useTranslations:()=>tr},
    };
    const exports={};new Function('require','exports','React',${JSON.stringify(component)})(name=>{
      if(name==='@stripe/stripe-js'){const card=currentCard;record('import',card);return gate('import',card,sdk);}
      if(!(name in modules))throw new Error('Unexpected fixture module '+name);return modules[name];
    },exports,React);
    let currentCard='A',setCard;const root=ReactDOM.createRoot(document.getElementById('root'));
    function App(){const [card,update]=React.useState('A');setCard=update;currentCard=card;return card?h(exports.CardRevealModal,{cardId:card,childName:'Synthetic '+card,onClose:()=>update(null)}):null;}
    const p=window.__revealLifecycle={
      close:()=>ReactDOM.flushSync(()=>setCard(null)),open:card=>ReactDOM.flushSync(()=>setCard(card)),
      settle:async()=>{for(let i=0;i<16;i++)await Promise.resolve();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));},
      resolve:async stage=>{if(!gates[stage])throw new Error('Missing controlled stage '+stage);gates[stage]();await p.settle();},
      get:()=>({calls,displays,loading:document.body.textContent.includes('cardRevealModal.openingASecureSession'),error:document.body.textContent.includes('safe prepare refusal')?'safe prepare refusal':document.body.textContent.includes('safe key refusal')?'safe key refusal':document.body.textContent.includes('synthetic display failure')?'synthetic display failure':null}),
    };
    ReactDOM.flushSync(()=>root.render(options.strict?h(React.StrictMode,null,h(App)):h(App)));
  })();` });
  await page.waitForFunction(() => typeof window.__revealLifecycle?.get === 'function');
  await page.evaluate(() => window.__revealLifecycle.settle());
  return { errors, unexpected };
}
const snapshot = (page: Page) => page.evaluate(() => window.__revealLifecycle.get());
const count = (state: Snapshot, stage: string, card = 'A') => state.calls.filter(call => call.stage === stage && call.card === card).length;
async function ready(page: Page, card = 'A') {
  await expect.poll(async () => (await snapshot(page)).displays.filter(display => display.card === card && display.mounts === 1).length).toBe(3);
  await page.evaluate(() => window.__revealLifecycle.settle());
}
function cleanReceipt(receipt: { errors: string[]; unexpected: string[] }) {
  expect(receipt.errors).toEqual([]); expect(receipt.unexpected).toEqual([]);
}
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('healthy session preserves exact card/account/nonce parameters and destroys all displays once on close', async ({ page }) => {
  const receipt = await fixture(page); await ready(page);
  const state = await snapshot(page);
  expect(state.loading).toBe(false);
  expect(state.calls.find(call => call.stage === 'load')?.data).toEqual({ publishableKey: 'synthetic-public-A', config: { stripeAccount: 'account-A' } });
  expect(state.calls.find(call => call.stage === 'nonce')?.data).toEqual({ issuingCard: 'card-A' });
  expect(state.calls.find(call => call.stage === 'key')?.data).toEqual({ cardId: 'A', nonce: 'synthetic-nonce-A' });
  for (const call of state.calls.filter(call => call.stage === 'create')) expect(call.data).toMatchObject({ auth: { issuingCard: 'card-A', ephemeralKeySecret: 'synthetic-secret-A', nonce: 'synthetic-nonce-A' } });
  await page.getByRole('button', { name: 'Close reveal' }).click();
  expect((await snapshot(page)).displays.map(display => display.destroys)).toEqual([1, 1, 1]);
  await page.evaluate(() => window.__revealLifecycle.close());
  expect((await snapshot(page)).displays.map(display => display.destroys)).toEqual([1, 1, 1]);
  cleanReceipt(receipt);
});

for (const refusal of ['prepare', 'key'] as const) test(`${refusal} refusal ends loading without display creation`, async ({ page }) => {
  const receipt = await fixture(page, { refusal });
  await expect.poll(async () => (await snapshot(page)).error).toBe(`safe ${refusal} refusal`);
  const state = await snapshot(page);
  expect(state.loading).toBe(false); expect(state.displays).toEqual([]);
  if (refusal === 'prepare') { expect(count(state, 'load')).toBe(0); expect(count(state, 'key')).toBe(0); }
  cleanReceipt(receipt);
});

const next: Record<Stage, string> = { prepare: 'import', import: 'load', load: 'nonce', nonce: 'key', key: 'create' };
for (const hold of ['prepare', 'import', 'load', 'nonce', 'key'] as const) test(`close while ${hold} is pending prevents every subsequent stage`, async ({ page }) => {
  const receipt = await fixture(page, { hold });
  expect(count(await snapshot(page), hold)).toBe(1);
  await page.getByRole('button', { name: 'Close reveal' }).click();
  await page.evaluate(stage => window.__revealLifecycle.resolve(stage), hold);
  const state = await snapshot(page);
  expect(state.calls.filter(call => call.stage === next[hold])).toEqual([]); expect(state.displays).toEqual([]);
  cleanReceipt(receipt);
});

for (const fail of ['create', 'mount'] as const) test(`partial ${fail} failure destroys every owned display exactly once`, async ({ page }) => {
  const receipt = await fixture(page, { fail });
  await expect.poll(async () => (await snapshot(page)).error).toBe('synthetic display failure');
  const expected = fail === 'create' ? [1] : [1, 1];
  expect((await snapshot(page)).displays.map(display => display.destroys)).toEqual(expected);
  await page.getByRole('button', { name: 'Close reveal' }).click();
  expect((await snapshot(page)).displays.map(display => display.destroys)).toEqual(expected);
  cleanReceipt(receipt);
});

test('one failed destruction does not strand the remaining displays or disclose its detail', async ({ page }) => {
  const receipt = await fixture(page, { destroyThrows: true }); await ready(page);
  await page.getByRole('button', { name: 'Close reveal' }).click();
  expect((await snapshot(page)).displays.map(display => display.destroys)).toEqual([1, 1, 1]);
  expect(receipt.errors).toEqual(['[card-reveal] Could not destroy a display Element.']);
  expect(receipt.unexpected).toEqual([]);
});

for (const hold of ['prepare', 'key'] as const) test(`reopening a new card never adopts the old pending ${hold} completion`, async ({ page }) => {
  const receipt = await fixture(page, { hold });
  await page.evaluate(() => { window.__revealLifecycle.close(); window.__revealLifecycle.open('B'); });
  await ready(page, 'B');
  await page.evaluate(stage => window.__revealLifecycle.resolve(stage), hold);
  let state = await snapshot(page);
  expect(state.displays.map(display => display.card)).toEqual(['B', 'B', 'B']);
  expect(count(state, 'key', 'A')).toBe(hold === 'key' ? 1 : 0);
  expect(count(state, 'key', 'B')).toBe(1);
  await page.getByRole('button', { name: 'Close reveal' }).click();
  state = await snapshot(page);
  expect(state.displays.map(display => display.destroys)).toEqual([1, 1, 1]);
  cleanReceipt(receipt);
});

test('changing the card on a mounted component disposes the prior owned displays', async ({ page }) => {
  const receipt = await fixture(page); await ready(page);
  await page.evaluate(() => window.__revealLifecycle.open('B')); await ready(page, 'B');
  expect((await snapshot(page)).displays.map(display => display.destroys)).toEqual([1, 1, 1, 0, 0, 0]);
  await page.getByRole('button', { name: 'Close reveal' }).click();
  expect((await snapshot(page)).displays.map(display => display.destroys)).toEqual([1, 1, 1, 1, 1, 1]);
  cleanReceipt(receipt);
});

test('a pending replacement card returns to loading with the previous displays disposed', async ({ page }) => {
  const receipt = await fixture(page, { hold: 'prepare', holdCard: 'B' }); await ready(page);
  await page.evaluate(() => window.__revealLifecycle.open('B'));
  await page.evaluate(() => window.__revealLifecycle.settle());
  const state = await snapshot(page);
  expect(state.loading).toBe(true);
  expect(state.displays.map(display => display.destroys)).toEqual([1, 1, 1]);
  expect(state.displays.filter(display => display.card === 'B')).toEqual([]);
  await page.evaluate(() => window.__revealLifecycle.resolve('prepare')); await ready(page, 'B');
  expect((await snapshot(page)).loading).toBe(false);
  await page.getByRole('button', { name: 'Close reveal' }).click();
  expect((await snapshot(page)).displays.map(display => display.destroys)).toEqual([1, 1, 1, 1, 1, 1]);
  cleanReceipt(receipt);
});

test('Strict Mode replay does not advance the cancelled effect into nonce or key creation', async ({ page }) => {
  const receipt = await fixture(page, { strict: true }); await ready(page);
  const state = await snapshot(page);
  expect(count(state, 'prepare')).toBe(2);
  expect(count(state, 'load')).toBe(1); expect(count(state, 'nonce')).toBe(1); expect(count(state, 'key')).toBe(1);
  await page.getByRole('button', { name: 'Close reveal' }).click();
  expect((await snapshot(page)).displays.map(display => display.destroys)).toEqual([1, 1, 1]);
  cleanReceipt(receipt);
});
