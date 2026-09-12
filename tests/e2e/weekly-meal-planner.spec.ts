import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import { expect, test, type Page } from '@playwright/test';

// Actual MealsModule, Modal, form controls, query hook and application CSS.
// Session context, PostgREST reads and server-action transport are explicit
// boundaries. Service/action tests separately verify database persistence and
// authorization; these tests do not claim to execute production RLS.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const icons = fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')), 'dist/umd/lucide-react.min.js'), 'utf8');
const isolated = new Set([
  'react', 'react-dom', 'lucide-react', 'next/link', '@/components/app/app-context',
  '@/components/i18n/locale-provider', '@/components/ui/toast', '@/components/ai/ai-insight',
  '@/lib/supabase/client', '@/lib/offline/cache-scope',
  '@/app/(app)/dashboard/meals/actions', '@/app/(app)/dashboard/grocery/actions',
]);
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function sourceFile(filename: string) {
  return [filename, `${filename}.ts`, `${filename}.tsx`, path.join(filename, 'index.ts')]
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? filename;
}
function collect(filename: string): string {
  const id = path.resolve(sourceFile(filename));
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = /\.tsx?$/.test(id) ? ts.transpileModule(raw, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (isolated.has(name)) { item.imports[name] = name; continue; }
    const target = name.startsWith('@/') ? path.resolve(name.slice(2))
      : name.startsWith('.') && /\.tsx?$/.test(id) ? path.resolve(path.dirname(id), name)
        : require.resolve(name, { paths: [path.dirname(id)] });
    item.imports[name] = collect(target);
  }
  return id;
}
const entry = collect('components/modules/meals-module.tsx');
const origin = 'https://weekly-meals-fixture.invalid';
type Row = Record<string, unknown>;
type ActionKind = 'plan' | 'create' | 'remove' | 'grocery';
type ActionMode = 'success' | 'hold' | 'reject' | 'throw' | 'wrong-slot' | 'missing-slot' | 'lost-response' | 'duplicate-slot';
type ApiMode = 'success' | 'hold' | 'reject' | 'not-written' | 'zero-count' | 'no-rows' | 'wrong-row' | 'duplicate-row';
type Call = { kind: ActionKind; input: Row | string; familyId: string };
type Probe = {
  familyId: string; timezone: string; calls: Call[]; notices: Array<{ kind: string; message: string }>;
  errors: string[]; modes: Partial<Record<ActionKind, ActionMode>>; tables: Record<string, Row[]>;
  readErrors: Record<string, boolean>; reads: Array<{ table: string; filters: Array<[string, string, unknown]> }>;
  finish: (index: number, mode?: ActionMode) => void; render: (patch?: { familyId?: string; timezone?: string }) => void;
  unmount: () => void; flush: () => Promise<void>; captured: (() => unknown) | null;
  captureClick: (label: string) => void; captureSubmit: () => void; fireCaptured: (count: number) => void;
  apiMode: ApiMode; apiCalls: Row[]; api: (input: Row) => Promise<{ status: number; body: Row }>;
  finishApi: (mode?: ApiMode) => void;
};
declare global { interface Window { __weeklyMeals: Probe } }

let css = '';
test.beforeAll(async () => {
  // Use the checked-in Tailwind configuration and CSS, rather than teaching
  // the fixture an approximation of the responsive/hidden/focus classes.
  const configModule = { exports: {} as { default?: Parameters<typeof tailwindcss>[0] } };
  const compiled = ts.transpileModule(fs.readFileSync('tailwind.config.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function('module', 'exports', 'require', compiled)(configModule, configModule.exports, require);
  css = (await postcss([tailwindcss(configModule.exports.default),autoprefixer()]).process(fs.readFileSync('app/globals.css', 'utf8'), { from: 'app/globals.css' })).css;
});

async function fixture(page: Page, options: { familyId?: string; timezone?: string; now?: string; mode?: ActionMode; meals?: Row[]; plans?: Row[]; readErrors?: Record<string, boolean> } = {}) {
  await page.clock.setFixedTime(new Date(options.now ?? '2026-09-12T12:00:00Z'));
  await page.route('**/*', async route => {
    if (route.request().url() === `${origin}/api/ai/meals/plan` && route.request().method() === 'POST') {
      const response = await page.evaluate(input => window.__weeklyMeals.api(input), route.request().postDataJSON());
      await route.fulfill({ status:response.status,contentType:'application/json',body:JSON.stringify(response.body) });
      return;
    }
    if (route.request().url() !== `${origin}/`) throw new Error(`Unexpected fixture request: ${route.request().url()}`);
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html class="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="root"></main></body></html>' });
  });
  await page.goto(origin);
  await page.addStyleTag({ content: css });
  for (const content of [react, reactDom, 'window.react = window.React;', icons]) await page.addScriptTag({ content });
  const messages = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8'));
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(modules)}, entry = ${JSON.stringify(entry)}, messages = ${JSON.stringify(messages)};
    const loaded = {}, h = React.createElement, pending = new Map();
    const options = ${JSON.stringify(options)};
    const p = window.__weeklyMeals = { familyId: options.familyId || 'family-A', timezone: options.timezone || 'America/New_York', calls: [], notices: [], errors: [],
      modes: { plan: options.mode || 'success' }, readErrors: options.readErrors || {}, reads: [], captured: null, apiMode:'success',apiCalls:[] };
    const meal = (id, name, ingredients, family = 'family-A') => ({ id, name, ingredients, family_id: family, meal_type: 'dinner', image_url: null, recipe_url: null, created_by: 'user-A' });
    p.tables = { meals: options.meals || [
      meal('meal-tacos', 'Lime tacos', [{name:'Chicken',qty:'1',unit:'lb'},{name:'Lime',qty:'2',unit:null}]),
      meal('meal-curry', 'Coconut curry', [{name:'Rice',qty:'1',unit:'cup'}]),
      meal('meal-B', 'Other family dinner', [], 'family-B')],
      meal_plans: options.plans || [], family_recipes: [
        {id:'recipe-soup',family_id:'family-A',name:'Tomato soup',ingredients:[{name:'Tomato',quantity:'3',unit:'cups'}],source_url:'https://recipe.invalid/soup',servings:4,is_favorite:false,last_made_at:null,category:'dinner'},
        {id:'recipe-B',family_id:'family-B',name:'Other family recipe',ingredients:[],is_favorite:false,last_made_at:null}],
      grocery_items: [], meal_votes: [] };
    window.addEventListener('error', event => p.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    const translate = (key, vars = {}) => Object.entries(vars).reduce((text, [name,value]) => text.split('{' + name + '}').join(String(value)), messages[key] || key);
    function from(table) {
      const filters = [];
      let limit = Infinity;
      const builder = { select() { return this; }, order() { return this; }, limit(value) { limit = value; return this; },
        eq(column,value) { filters.push(['eq',column,value]); return this; },
        gte(column,value) { filters.push(['gte',column,value]); return this; },
        lte(column,value) { filters.push(['lte',column,value]); return this; },
        in(column,value) { filters.push(['in',column,value]); return this; },
        then(resolve,reject) {
          p.reads.push({table,filters:structuredClone(filters)});
          const isJoin = table === 'meals' && filters.some(([op]) => op === 'in');
          const fail = p.readErrors[isJoin ? 'meal-join' : table];
          const rows = (p.tables[table] || []).filter(row => filters.every(([op,column,value]) => op === 'eq' ? row[column] === value
            : op === 'gte' ? row[column] >= value : op === 'lte' ? row[column] <= value : value.includes(row[column]))).slice(0,limit);
          return Promise.resolve(fail ? {data:null,error:{message:'Fixture read unavailable',code:'XX000'}} : {data:structuredClone(rows),error:null}).then(resolve,reject);
        },
      };
      return builder;
    }
    const db = { from, channel: () => ({on(){return this;},subscribe(){return this;}}), removeChannel: async () => {} };
    const ingredients = values => (values || []).map(value => ({ name:value.name,quantity:value.quantity ?? value.qty ?? null,unit:value.unit ?? null }));
    function execute(call, index, mode) {
      if (mode === 'reject') return {ok:false,error:'Fixture save rejected. Try again.'};
      if (mode === 'throw') throw new Error('Fixture action unavailable');
      const input = call.input, family = call.familyId;
      if (call.kind === 'remove') {
        p.tables.meal_plans = p.tables.meal_plans.filter(row => row.id !== input || row.family_id !== family);
        return {ok:true,id:input};
      }
      if (call.kind === 'grocery') {
        const rows = [
          {id:'groceries-rice',family_id:family,list_id:'list-A',name:'Rice',quantity:'1 cup',is_checked:false},
          {id:'groceries-tomato',family_id:family,list_id:'list-A',name:'Tomato',quantity:'3 cups',is_checked:false}];
        p.tables.grocery_items.push(...rows);
        return {ok:true,listId:'list-A',added:rows.length,skipped:['Lime'],inPantry:['Olive oil'],meals:[],substitutions:[]};
      }
      let dish;
      if (call.kind === 'create') {
        dish = meal('created-' + index,input.name,ingredients(input.ingredients),family);
        p.tables.meals.push(dish); return {ok:true,meal:dish};
      }
      if (input.mealId) dish = p.tables.meals.find(row => row.id === input.mealId && row.family_id === family);
      else if (input.recipeId) {
        const recipe = p.tables.family_recipes.find(row => row.id === input.recipeId && row.family_id === family);
        if (recipe) dish = meal('converted-' + index,recipe.name,ingredients(recipe.ingredients),family);
      } else dish = meal('custom-' + index,input.mealName,ingredients(input.ingredients),family);
      if (!dish) return {ok:false,error:'Fixture meal unavailable'};
      if (!p.tables.meals.some(row => row.id === dish.id)) p.tables.meals.push(dish);
      const row = { id:'plan-' + index,family_id:family,meal_id:dish.id,plan_date:input.date,meal_type:input.mealType,created_by:'user-A' };
      p.tables.meal_plans = p.tables.meal_plans.filter(old => old.family_id !== family || old.plan_date !== input.date || old.meal_type !== input.mealType);
      p.tables.meal_plans.push(row);
      if (mode === 'duplicate-slot') p.tables.meal_plans.push({...row,id:'competing-slot',meal_id:'meal-curry'});
      if (mode === 'lost-response') throw new Error('Fixture response lost after commit');
      if (mode === 'missing-slot') return {ok:true,id:row.id};
      return {ok:true,id:row.id,slot:{id:row.id,date:mode === 'wrong-slot' ? '2026-10-01' : input.date,mealType:input.mealType,mealId:dish.id,name:dish.name,ingredients:ingredients(dish.ingredients)}};
    }
    function action(kind, input) {
      const index = p.calls.length, call = {kind,input:structuredClone(input),familyId:p.familyId}; p.calls.push(call);
      const mode = p.modes[kind] || 'success';
      return new Promise((resolve,reject) => {
        const finish = resultMode => { try { resolve(execute(call,index,resultMode)); } catch(error) { reject(error); } };
        if (mode === 'hold') pending.set(index,finish); else finish(mode);
      });
    }
    p.finish = (index, mode = 'success') => { const finish = pending.get(index); if (!finish) throw new Error('No pending action ' + index); pending.delete(index); finish(mode); };
    p.api = async input => {
      p.apiCalls.push(structuredClone(input)); const familyId=p.familyId;
      const mode = p.apiMode === 'hold' ? await new Promise(resolve=>{p.finishApi=(value='success')=>resolve(value);}) : p.apiMode;
      if(mode==='reject') return {status:503,body:{error:'Fixture planner unavailable'}};
      const slots=Array.from({length:7},(_,index)=>({id:'auto-'+index,date:new Date(Date.parse(input.weekStart+'T00:00:00Z')+index*86400000).toISOString().slice(0,10),
        mealType:'dinner',mealId:'meal-tacos',name:'Lime tacos',ingredients:ingredients(p.tables.meals.find(row=>row.id==='meal-tacos').ingredients)}));
      if(mode!=='no-rows' && mode!=='not-written' && mode!=='zero-count') {
        p.tables.meal_plans=p.tables.meal_plans.filter(row=>row.family_id!==familyId);
        p.tables.meal_plans.push(...slots.map(slot=>({id:slot.id,family_id:familyId,meal_id:mode==='wrong-row'?'meal-curry':slot.mealId,plan_date:slot.date,meal_type:slot.mealType})));
        if(mode==='duplicate-row') p.tables.meal_plans.push({id:'competing-slot',family_id:familyId,meal_id:'meal-curry',plan_date:slots[0].date,meal_type:slots[0].mealType});
      }
      return {status:200,body:{written:mode!=='not-written',count:mode==='zero-count'?0:7,slots,
        assignments:slots.map(slot=>({date:slot.date,meal_type:slot.mealType,ref:'meal:'+slot.mealId,name:slot.name}))}};
    };
    const mocks = {
      react:React, 'react-dom':ReactDOM, 'lucide-react':window.LucideReact,
      'next/link':{default:({children,...props})=>h('a',props,children)},
      '@/components/app/app-context':{useApp:()=>({familyId:p.familyId,userId:'user-A',family:{id:p.familyId,name:p.familyId,timezone:p.timezone},members:[],selfMember:null,role:'parent',planLevel:2})},
      '@/components/i18n/locale-provider':{useTranslations:()=>translate,useLocale:()=> ({code:'en-US'})},
      '@/components/ui/toast':{useToast:()=>({success:message=>p.notices.push({kind:'success',message}),error:message=>p.notices.push({kind:'error',message})})},
      '@/components/ai/ai-insight':{AiInsight:()=>null},
      '@/lib/supabase/client':{createClient:()=>db},
      '@/lib/offline/cache-scope':{useAuthenticatedCacheScope:()=>null,isAuthenticatedCacheScopeCurrent:()=>true},
      '@/app/(app)/dashboard/meals/actions':{planMealAction:input=>action('plan',input),createMealAction:input=>action('create',input),removeMealPlanAction:input=>action('remove',input)},
      '@/app/(app)/dashboard/grocery/actions':{addMealPlanToGroceryListAction:input=>action('grocery',input),setGroceryItemCheckedAction:async()=>({ok:true})},
    };
    function load(id) {
      if (id in mocks) return mocks[id]; if (loaded[id]) return loaded[id].exports;
      const item = sources[id]; if (!item) throw new Error('Unexpected fixture module: ' + id);
      const module = loaded[id] = {exports:{}};
      new Function('require','module','exports',item.source)(name=>load(item.imports[name]),module,module.exports);
      return module.exports;
    }
    const MealsModule = load(entry).MealsModule;
    let root = ReactDOM.createRoot(document.getElementById('root'));
    p.render = patch => { Object.assign(p,patch || {}); ReactDOM.flushSync(()=>root.render(h(MealsModule))); };
    p.unmount = () => ReactDOM.flushSync(()=>root.render(null));
    p.flush = () => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const propsFor = element => element[Object.keys(element).find(key=>key.startsWith('__reactProps'))];
    p.captureClick = label => {
      const button = [...document.querySelectorAll('button')].find(element=>(element.getAttribute('aria-label') || element.textContent.trim()) === label && !element.disabled && element.getClientRects().length);
      if (!button) throw new Error('Enabled button not found: ' + label);
      const form = button.type === 'submit' ? button.closest('form') : null;
      const callback = form ? propsFor(form).onSubmit : propsFor(button).onClick;
      p.captured = () => callback({preventDefault(){},stopPropagation(){},currentTarget:form || button});
    };
    p.captureSubmit = () => { const form=document.querySelector('[role=dialog] form'); if(!form) throw new Error('No form'); const callback=propsFor(form).onSubmit;
      p.captured=()=>callback({preventDefault(){},currentTarget:form}); };
    p.fireCaptured = count => { for(let index=0;index<count;index++) Promise.resolve(p.captured()).catch(error=>p.errors.push(String(error))); };
    p.render();
  })();` });
  await page.evaluate(() => window.__weeklyMeals.flush());
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

const dialog = (page: Page) => page.getByRole('dialog');
const slot = (page: Page, weekday = 'Monday') => page.getByRole('button', { name: new RegExp(`Dinner for ${weekday}`) });
const save = (page: Page) => dialog(page).getByRole('button', { name: 'Save meal', exact: true });
async function choose(page: Page, meal = 'Lime tacos', weekday = 'Monday') {
  await slot(page, weekday).click();
  await dialog(page).getByRole('button', { name: new RegExp(meal) }).click();
}
async function notices(page: Page, kind = 'error') {
  return page.evaluate(value => window.__weeklyMeals.notices.filter(item => item.kind === value), kind);
}
async function calls(page: Page, kind: ActionKind = 'plan') {
  return page.evaluate(value => window.__weeklyMeals.calls.filter(item => item.kind === value), kind);
}
async function finish(page: Page, index = 0, mode: ActionMode = 'success') {
  await page.evaluate(({index,mode}) => window.__weeklyMeals.finish(index,mode), {index,mode});
  await page.evaluate(() => window.__weeklyMeals.flush());
}
test.afterEach(async ({page}) => {
  expect(await page.evaluate(() => window.__weeklyMeals?.errors ?? [])).toEqual([]);
});

test('starts with seven accessible dinners and exposes other meal types on request', async ({page}) => {
  await fixture(page);
  await expect(page.getByRole('button', {name:/Dinner for /})).toHaveCount(7);
  await expect(page.getByRole('button', {name:/Breakfast for /})).toHaveCount(0);
  await page.getByRole('button', {name:'Show all meals',exact:true}).click();
  await expect(page.getByRole('button', {name:/Breakfast for /})).toHaveCount(7);
  await page.getByRole('button', {name:'Dinners only',exact:true}).click();
  await expect(page.getByRole('button', {name:/Breakfast for /})).toHaveCount(0);
});

test('searches meals and recipes within the active family', async ({page}) => {
  await fixture(page);
  await slot(page).click();
  const search = dialog(page).getByRole('textbox', {name:'Search meals and recipes'});
  await search.fill('tomato');
  await expect(dialog(page).getByRole('button', {name:/Tomato soup/})).toBeVisible();
  await expect(dialog(page).getByRole('button', {name:/Lime tacos/})).toHaveCount(0);
  await search.fill('other family');
  await expect(dialog(page).getByRole('button', {name:/Other family/})).toHaveCount(0);
});

test('saves a recipe into the selected day with its returned ingredients', async ({page}) => {
  await fixture(page);
  await choose(page,'Tomato soup','Wednesday');
  await save(page).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await calls(page)).toEqual([{kind:'plan',familyId:'family-A',input:{date:'2026-09-09',mealType:'dinner',recipeId:'recipe-soup'}}]);
  const rows = await page.evaluate(() => ({plans:window.__weeklyMeals.tables.meal_plans,meals:window.__weeklyMeals.tables.meals}));
  expect(rows.plans).toHaveLength(1);
  expect(rows.meals.find(row=>row.id === rows.plans[0].meal_id)?.ingredients).toEqual([{name:'Tomato',quantity:'3',unit:'cups'}]);
  await expect(slot(page,'Wednesday')).toContainText('Tomato soup');
});

test('replaces and removes only the selected dinner, preserving lunch and another week', async ({page}) => {
  await fixture(page,{plans:[
    {id:'old-dinner',family_id:'family-A',meal_id:'meal-tacos',plan_date:'2026-09-07',meal_type:'dinner'},
    {id:'lunch',family_id:'family-A',meal_id:'meal-tacos',plan_date:'2026-09-07',meal_type:'lunch'},
    {id:'later',family_id:'family-A',meal_id:'meal-tacos',plan_date:'2026-09-14',meal_type:'dinner'},
  ]});
  await choose(page,'Coconut curry');
  await save(page).click();
  await expect(slot(page)).toContainText('Coconut curry');
  const remove = page.getByRole('button', {name:/Remove.*Monday/});
  await remove.click();
  await expect(slot(page)).not.toContainText('Coconut curry');
  expect(await page.evaluate(()=>window.__weeklyMeals.tables.meal_plans.map(row=>row.id).sort())).toEqual(['later','lunch']);
});

test('retains the chosen slot while creating a meal with editable ingredients', async ({page}) => {
  await fixture(page);
  await slot(page,'Friday').click();
  await dialog(page).getByRole('button',{name:'Create a meal',exact:true}).click();
  await dialog(page).getByRole('textbox',{name:/^Meal name/}).fill('Herbed beans');
  await dialog(page).getByRole('textbox',{name:'Ingredient 1',exact:true}).fill('White beans');
  await dialog(page).getByRole('textbox',{name:'Quantity 1',exact:true}).fill('1 1/2');
  await dialog(page).getByRole('textbox',{name:'Unit 1',exact:true}).fill('cups');
  await save(page).click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await calls(page))[0].input).toMatchObject({date:'2026-09-11',mealType:'dinner',mealName:'Herbed beans',ingredients:[{name:'White beans',quantity:'1 1/2',unit:'cups'}]});
  await expect(slot(page,'Friday')).toContainText('Herbed beans');
});

test('coalesces repeated callbacks captured from an enabled Save meal button', async ({page}) => {
  await fixture(page,{mode:'hold'});
  await choose(page);
  await page.evaluate(()=>{window.__weeklyMeals.captureClick('Save meal');window.__weeklyMeals.fireCaptured(3);});
  await expect.poll(async()=> (await calls(page)).length).toBe(1);
  await finish(page);
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(()=>window.__weeklyMeals.tables.meal_plans.length)).toBe(1);
});

for (const mode of ['reject','throw','lost-response'] as const) {
  test(`${mode} preserves the selected meal and permits a deliberate retry`, async ({page}) => {
    await fixture(page,{mode});
    await choose(page);
    await save(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole('alert')).toBeVisible();
    expect(await notices(page,'success')).toEqual([]);
    await page.evaluate(()=>{window.__weeklyMeals.modes.plan='success';});
    await save(page).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await page.evaluate(()=>window.__weeklyMeals.tables.meal_plans.length)).toBe(1);
  });
}

for (const mode of ['wrong-slot','missing-slot'] as const) {
  test(`${mode} success payload is rejected as an unverified save`, async ({page}) => {
    await fixture(page,{mode});
    await choose(page);
    await save(page).click();
    await expect(dialog(page).getByRole('alert')).toBeVisible();
    expect(await notices(page,'success')).toEqual([]);
    await expect(dialog(page)).toBeVisible();
  });
}

test('failed plan readback does not close the draft or repeat the committed mutation', async ({page}) => {
  await fixture(page,{mode:'hold'});
  await choose(page);
  await save(page).click();
  await page.evaluate(()=>{window.__weeklyMeals.readErrors.meal_plans=true;});
  await finish(page);
  expect(await notices(page,'success')).toEqual([]);
  await page.evaluate(()=>{window.__weeklyMeals.readErrors.meal_plans=false;});
  await page.getByRole('button',{name:'Retry loading',exact:true}).click();
  await expect(slot(page)).toContainText('Lime tacos');
  expect(await calls(page)).toHaveLength(1);
});

test('a late save from the old family cannot close a new family picker', async ({page}) => {
  await fixture(page,{mode:'hold'});
  await choose(page);
  await save(page).click();
  await page.evaluate(()=>window.__weeklyMeals.render({familyId:'family-B'}));
  await expect(dialog(page)).toHaveCount(0);
  await slot(page).click();
  await expect(dialog(page).getByRole('button',{name:/Other family dinner/})).toBeVisible();
  await finish(page);
  await expect(dialog(page)).toBeVisible();
  expect(await notices(page,'success')).toEqual([]);
  expect(await page.evaluate(()=>window.__weeklyMeals.tables.meal_plans.filter(row=>row.family_id==='family-B'))).toEqual([]);
});

test('unmount retires a pending save without a late notice', async ({page}) => {
  await fixture(page,{mode:'hold'});
  await choose(page);
  await save(page).click();
  await page.evaluate(()=>window.__weeklyMeals.unmount());
  await finish(page);
  expect(await notices(page,'success')).toEqual([]);
});

test('builds the visible week and displays the server grocery receipt', async ({page}) => {
  await fixture(page,{plans:[{id:'dinner',family_id:'family-A',meal_id:'meal-curry',plan_date:'2026-09-07',meal_type:'dinner'}]});
  await page.getByRole('button',{name:'Add this week to the list',exact:true}).click();
  expect((await calls(page,'grocery'))[0].input).toEqual({from:'2026-09-07',to:'2026-09-13',usePantry:false});
  await expect.poll(async()=> (await notices(page,'success')).map(item=>item.message).join(' ')).toContain('2');
  await expect(page.getByText('3 cups',{exact:true}).first()).toBeVisible();
  await expect(page.getByText(/Already on the list.*1|1.*already on the list/i)).toBeVisible();
  await expect(page.getByText(/Already in the pantry.*1|1.*already in the pantry/i)).toBeVisible();
});

test('a failed grocery action leaves the meal plan available for retry', async ({page}) => {
  await fixture(page,{plans:[{id:'dinner',family_id:'family-A',meal_id:'meal-curry',plan_date:'2026-09-07',meal_type:'dinner'}]});
  await page.evaluate(()=>{window.__weeklyMeals.modes.grocery='reject';});
  await page.getByRole('button',{name:'Add this week to the list',exact:true}).click();
  await expect.poll(async()=> (await notices(page)).length).toBe(1);
  await expect(slot(page)).toBeVisible();
  expect(await notices(page,'success')).toEqual([]);
  expect(await page.evaluate(()=>window.__weeklyMeals.tables.grocery_items)).toEqual([]);
});

test.describe('touchscreen picker',()=>{
test.use({isMobile:true,hasTouch:true,viewport:{width:390,height:844}});
test('mobile dinner picker traps keyboard focus and returns it on Escape', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await fixture(page);
  const target=slot(page,'Thursday');
  await target.focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  const focusables=dialog(page).locator('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled])');
  await focusables.last().focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(()=>document.querySelector('[role=dialog]')?.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(target).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await target.tap();
  await expect(dialog(page)).toBeVisible();
  const box=await save(page).boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
});
});

test('uses the family calendar week when the browser is already on Monday', async ({page}) => {
  await fixture(page,{timezone:'America/Los_Angeles',now:'2026-09-14T01:00:00Z'});
  await choose(page);
  await save(page).click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await calls(page))[0].input).toMatchObject({date:'2026-09-07',mealType:'dinner'});
  await page.getByRole('button',{name:'Next week',exact:true}).click();
  await choose(page,'Lime tacos','Sunday');
  await save(page).click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await calls(page))[1].input).toMatchObject({date:'2026-09-20',mealType:'dinner'});
});

for (const table of ['meals','family_recipes']) {
  test(`${table} read failure offers a retry without pretending the library is empty`, async ({page}) => {
    await fixture(page,{readErrors:{[table]:true}});
    await slot(page).click();
    await expect(dialog(page).getByRole('alert')).toContainText('We couldn’t load all meal choices. Please retry.');
    await page.evaluate(value=>{window.__weeklyMeals.readErrors[value]=false;},table);
    await dialog(page).getByRole('button',{name:'Retry loading',exact:true}).click();
    await expect(dialog(page).getByRole('button',{name:/Lime tacos/})).toBeVisible();
    await expect(dialog(page).getByRole('button',{name:/Tomato soup/})).toBeVisible();
    expect(await calls(page)).toHaveLength(0);
  });
}

test('a meal join error cannot confirm a saved slot', async ({page}) => {
  await fixture(page,{mode:'hold'});
  await choose(page);
  await save(page).click();
  await page.evaluate(()=>{window.__weeklyMeals.readErrors['meal-join']=true;});
  await finish(page);
  expect(await notices(page,'success')).toEqual([]);
  expect(await calls(page)).toHaveLength(1);
  await page.evaluate(()=>{window.__weeklyMeals.readErrors['meal-join']=false;});
  await page.getByRole('button',{name:'Retry loading',exact:true}).last().click();
  await expect(slot(page)).toContainText('Lime tacos');
  expect(await calls(page)).toHaveLength(1);
});

test('closing a pending picker allows another day without the late result closing it', async ({page}) => {
  await fixture(page,{mode:'hold'});
  await choose(page);
  await save(page).click();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await slot(page,'Tuesday').click();
  await expect(dialog(page)).toContainText('Tuesday');
  await finish(page);
  await expect(dialog(page)).toContainText('Tuesday');
  expect(await notices(page,'success')).toEqual([]);
});

test('coalesces enabled grocery callbacks and retires their receipt after a week change', async ({page}) => {
  await fixture(page,{plans:[{id:'dinner',family_id:'family-A',meal_id:'meal-curry',plan_date:'2026-09-07',meal_type:'dinner'}]});
  await page.evaluate(()=>{window.__weeklyMeals.modes.grocery='hold';window.__weeklyMeals.captureClick('Add this week to the list');window.__weeklyMeals.fireCaptured(3);});
  await expect.poll(async()=> (await calls(page,'grocery')).length).toBe(1);
  await page.getByRole('button',{name:'Next week',exact:true}).click();
  await finish(page);
  await expect(slot(page)).toBeVisible();
  expect(await notices(page,'success')).toEqual([]);
  expect((await calls(page,'grocery'))[0].input).toEqual({from:'2026-09-07',to:'2026-09-13',usePantry:false});
});

test('grocery readback failure keeps the committed rows but does not claim completion', async ({page}) => {
  await fixture(page,{plans:[{id:'dinner',family_id:'family-A',meal_id:'meal-curry',plan_date:'2026-09-07',meal_type:'dinner'}]});
  await page.evaluate(()=>{window.__weeklyMeals.modes.grocery='hold';});
  await page.getByRole('button',{name:'Add this week to the list',exact:true}).click();
  await page.evaluate(()=>{window.__weeklyMeals.readErrors.grocery_items=true;});
  await finish(page);
  await expect.poll(async()=> (await notices(page)).length).toBe(1);
  expect(await notices(page,'success')).toEqual([]);
  expect(await page.evaluate(()=>window.__weeklyMeals.tables.grocery_items.length)).toBe(2);
  await expect(page.getByText('Fixture read unavailable',{exact:true}).first()).toBeVisible();
  await page.evaluate(()=>{window.__weeklyMeals.readErrors.grocery_items=false;});
  await page.getByRole('button',{name:'Try again',exact:true}).click();
  await expect(page.getByText('3 cups',{exact:true}).first()).toBeVisible();
  expect(await calls(page,'grocery')).toHaveLength(1);
});

test('keeps focus in search and custom fields while typing character by character', async ({page}) => {
  await fixture(page);
  await slot(page).click();
  const search = dialog(page).getByRole('textbox',{name:'Search meals and recipes'});
  await search.focus();
  await page.keyboard.type('tomato',{delay:20});
  await expect(search).toHaveValue('tomato');
  await expect(search).toBeFocused();
  await dialog(page).getByRole('button',{name:'Create a meal',exact:true}).click();
  const name = dialog(page).getByRole('textbox',{name:/^Meal name/});
  await name.focus();
  await page.keyboard.type('Herbed beans',{delay:20});
  await expect(name).toHaveValue('Herbed beans');
  await expect(name).toBeFocused();
  const ingredient = dialog(page).getByRole('textbox',{name:'Ingredient 1',exact:true});
  await ingredient.focus();
  await page.keyboard.type('White beans',{delay:20});
  await expect(ingredient).toHaveValue('White beans');
  await expect(ingredient).toBeFocused();
});

for (const width of [280,320]) {
  test(`${width}px planner and ingredient dialog stay within the viewport`, async ({page}) => {
    await page.setViewportSize({width,height:800});
    await fixture(page);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await slot(page).click();
    await dialog(page).getByRole('button',{name:'Create a meal',exact:true}).click();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    const panel=await dialog(page).boundingBox();
    expect(panel).not.toBeNull();
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.x+panel!.width).toBeLessThanOrEqual(width);
    const saveBox=await save(page).boundingBox();
    expect(saveBox).not.toBeNull();
    expect(saveBox!.width).toBeGreaterThanOrEqual(44);
  });
}

test('standalone meal creation preserves ingredient rows and submits once', async ({page}) => {
  await fixture(page);
  const trigger=page.getByRole('button',{name:'Add Meal',exact:true});
  await trigger.click();
  await dialog(page).getByRole('textbox',{name:/^Meal name/}).fill('Garden pasta');
  await dialog(page).getByRole('textbox',{name:'Ingredient 1',exact:true}).fill('Pasta');
  await dialog(page).getByRole('textbox',{name:'Quantity 1',exact:true}).fill('12');
  await dialog(page).getByRole('textbox',{name:'Unit 1',exact:true}).fill('oz');
  await dialog(page).getByRole('button',{name:'Add ingredient',exact:true}).click();
  await dialog(page).getByRole('textbox',{name:'Ingredient 2',exact:true}).fill('Basil');
  await dialog(page).getByRole('textbox',{name:'Quantity 2',exact:true}).fill('to taste');
  await dialog(page).getByRole('button',{name:'Add ingredient',exact:true}).click();
  await dialog(page).getByRole('button',{name:'Remove ingredient 3',exact:true}).click();
  await page.evaluate(()=>{window.__weeklyMeals.modes.create='hold';window.__weeklyMeals.captureClick('Save meal');window.__weeklyMeals.fireCaptured(3);});
  await expect.poll(async()=> (await calls(page,'create')).length).toBe(1);
  await finish(page);
  await expect(dialog(page)).toHaveCount(0);
  expect((await calls(page,'create'))[0].input).toMatchObject({name:'Garden pasta',mealType:'dinner',ingredients:[
    {name:'Pasta',quantity:'12',unit:'oz'},{name:'Basil',quantity:'to taste',unit:null},
  ]});
  expect(await page.evaluate(()=>window.__weeklyMeals.tables.meal_plans)).toEqual([]);
  await expect(trigger).toBeFocused();
  await slot(page).click();
  await expect(dialog(page).getByRole('button',{name:/Garden pasta/})).toBeVisible();
});

test('standalone pending creation is retired when the family changes', async ({page}) => {
  await fixture(page);
  await page.getByRole('button',{name:'Add Meal',exact:true}).click();
  await dialog(page).getByRole('textbox',{name:/^Meal name/}).fill('Old family dish');
  await page.evaluate(()=>{window.__weeklyMeals.modes.create='hold';});
  await save(page).click();
  await page.evaluate(()=>window.__weeklyMeals.render({familyId:'family-B'}));
  await page.getByRole('button',{name:'Add Meal',exact:true}).click();
  const name=dialog(page).getByRole('textbox',{name:/^Meal name/});
  await name.fill('New family draft');
  await finish(page);
  await expect(name).toHaveValue('New family draft');
  expect(await page.evaluate(()=>window.__weeklyMeals.tables.meals.filter(row=>row.family_id==='family-B').map(row=>row.name))).toEqual(['Other family dinner']);
});

test('standalone saved meal retries its failed library read without creating it again', async ({page}) => {
  await fixture(page);
  await page.getByRole('button',{name:'Add Meal',exact:true}).click();
  await dialog(page).getByRole('textbox',{name:/^Meal name/}).fill('Saved beans');
  await page.evaluate(()=>{window.__weeklyMeals.modes.create='hold';});
  await save(page).click();
  await page.evaluate(()=>{window.__weeklyMeals.readErrors.meals=true;});
  await finish(page);
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await page.evaluate(()=>{window.__weeklyMeals.readErrors.meals=false;});
  await dialog(page).getByRole('button',{name:'Retry loading',exact:true}).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await calls(page,'create')).toHaveLength(1);
  expect(await page.evaluate(()=>window.__weeklyMeals.tables.meals.filter(row=>row.name==='Saved beans').length)).toBe(1);
});

test('pantry skipping is an explicit choice in the grocery request', async ({page}) => {
  await fixture(page,{plans:[{id:'dinner',family_id:'family-A',meal_id:'meal-curry',plan_date:'2026-09-07',meal_type:'dinner'}]});
  const pantry=page.getByRole('checkbox',{name:'Skip ingredients already in pantry',exact:true});
  await expect(pantry).not.toBeChecked();
  await pantry.check();
  await page.getByRole('button',{name:'Add this week to the list',exact:true}).click();
  expect((await calls(page,'grocery'))[0].input).toEqual({from:'2026-09-07',to:'2026-09-13',usePantry:true});
});

async function openAutoPlan(page:Page) {
  await page.getByRole('button',{name:'More',exact:true}).click();
  await page.getByRole('button',{name:'Auto-plan the week',exact:true}).click();
  await expect(dialog(page)).toBeVisible();
}

test('auto plan accepts a real write receipt only after its seven saved rows reload', async ({page}) => {
  await fixture(page);
  await openAutoPlan(page);
  await dialog(page).getByRole('button',{name:'Generate plan',exact:true}).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(()=>window.__weeklyMeals.apiCalls)).toHaveLength(1);
  await expect(page.getByRole('status').first()).toContainText('7 of 7');
  expect(await page.evaluate(()=>window.__weeklyMeals.tables.meal_plans.length)).toBe(7);
  expect(await notices(page,'success')).toHaveLength(1);
});

for(const mode of ['reject','not-written','zero-count','no-rows','wrong-row','duplicate-row'] as const) {
  test(`auto plan ${mode} cannot claim a verified saved week`, async ({page}) => {
    await fixture(page);
    await page.evaluate(value=>{window.__weeklyMeals.apiMode=value;},mode);
    await openAutoPlan(page);
    await dialog(page).getByRole('button',{name:'Generate plan',exact:true}).click();
    await expect(dialog(page).getByRole('alert')).toBeVisible();
    expect(await notices(page,'success')).toEqual([]);
  });
}

test('auto plan coalesces duplicate callbacks and retires a closed dialog', async ({page}) => {
  await fixture(page);
  await openAutoPlan(page);
  await page.evaluate(()=>{window.__weeklyMeals.apiMode='hold';window.__weeklyMeals.captureClick('Generate plan');window.__weeklyMeals.fireCaptured(3);});
  await expect.poll(()=>page.evaluate(()=>window.__weeklyMeals.apiCalls.length)).toBe(1);
  await page.keyboard.press('Escape');
  await slot(page,'Tuesday').click();
  await page.evaluate(()=>window.__weeklyMeals.finishApi());
  await page.evaluate(()=>window.__weeklyMeals.flush());
  await expect(dialog(page)).toContainText('Tuesday');
  expect(await notices(page,'success')).toEqual([]);
});

test('auto plan retries only the read after a committed week fails to reload', async ({page}) => {
  await fixture(page);
  await openAutoPlan(page);
  await page.evaluate(()=>{window.__weeklyMeals.apiMode='hold';});
  await dialog(page).getByRole('button',{name:'Generate plan',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__weeklyMeals.apiCalls.length)).toBe(1);
  await page.evaluate(()=>{window.__weeklyMeals.readErrors.meal_plans=true;window.__weeklyMeals.finishApi();});
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await page.evaluate(()=>{window.__weeklyMeals.readErrors.meal_plans=false;});
  await dialog(page).getByRole('button',{name:'Retry loading',exact:true}).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(()=>window.__weeklyMeals.apiCalls.length)).toBe(1);
});

test('captures the real responsive meal planner and ingredient dialog for visual review', async ({page},testInfo) => {
  await page.setViewportSize({width:1365,height:1000});
  await fixture(page,{plans:[
    {id:'monday',family_id:'family-A',meal_id:'meal-tacos',plan_date:'2026-09-07',meal_type:'dinner'},
    {id:'wednesday',family_id:'family-A',meal_id:'meal-curry',plan_date:'2026-09-09',meal_type:'dinner'},
  ]});
  await page.screenshot({path:testInfo.outputPath('weekly-meal-planner-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:testInfo.outputPath('weekly-meal-planner-mobile.png'),fullPage:true});
  await slot(page,'Friday').click();
  await dialog(page).getByRole('button',{name:'Create a meal',exact:true}).click();
  await dialog(page).getByRole('textbox',{name:/^Meal name/}).fill('Herbed white beans');
  await dialog(page).getByRole('textbox',{name:'Ingredient 1',exact:true}).fill('White beans');
  await dialog(page).getByRole('textbox',{name:'Quantity 1',exact:true}).fill('1 1/2');
  await dialog(page).getByRole('textbox',{name:'Unit 1',exact:true}).fill('cups');
  await page.screenshot({path:testInfo.outputPath('weekly-meal-planner-custom-mobile.png')});
});

test('a competing row for the same dinner prevents confirmation of the saved receipt', async ({page}) => {
  await fixture(page,{mode:'duplicate-slot'});
  await choose(page);
  await save(page).click();
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  expect(await notices(page,'success')).toEqual([]);
  expect(await page.evaluate(()=>window.__weeklyMeals.tables.meal_plans.length)).toBe(2);
  await expect(slot(page)).toContainText('Coconut curry');
});
