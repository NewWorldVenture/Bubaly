import fs from 'node:fs';
import ts from 'typescript';
import {test,expect,type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';

const scripts=reactBrowserScripts('development');
const files=['lib/time/zoned.ts','lib/time/local-input.ts','lib/utils/submission-id.ts','lib/calendar/exact-instant.ts','lib/onboarding/ics-time.ts'];
const sources=Object.fromEntries(files.map(file=>['@/'+file.replace(/\.ts$/,''),ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText]));
sources['../onboarding/ics-time']=sources['@/lib/onboarding/ics-time'];
const modalSource=fs.readFileSync('components/modules/calendar-module.tsx','utf8');
const marker='function NewEventModal(';
if(modalSource.indexOf(marker)<0)throw Error('Actual modal not found');
const modal=ts.transpileModule(modalSource.slice(modalSource.indexOf(marker)),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText;
const browserErrors=new WeakMap<Page,string[]>();

async function mount(page:Page,existing:unknown,zone:string){
 const errors:string[]=[];browserErrors.set(page,errors);page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'||m.type()==='warning')errors.push(m.text());});
 await page.route('**/*',route=>route.request().url()==='https://local-input-fixture.invalid/'?route.fulfill({contentType:'text/html',body:'<!doctype html><main id="root"></main>'}):route.abort());
 await page.goto('https://local-input-fixture.invalid/');await page.addScriptTag({content:scripts.react});await page.addScriptTag({content:scripts.reactDom});
 await page.evaluate(({sources,modal,existing,zone})=>{
  const w=window as any,React=w.React;
  const cache:Record<string,any>={};
  function load(name:string):any{if(cache[name])return cache[name];if(!sources[name])throw Error(`Unexpected module ${name}`);const exports={};new Function('exports','require',sources[name])(exports,load);return cache[name]=exports;}
  w.__calls=[];w.__saved=0;w.__errors=[];
  const {fromLocalInput,toLocalInput}=load('@/lib/time/local-input');
  const {newSubmissionId,submissionSettled}=load('@/lib/utils/submission-id');
  const Input=(props:any)=>React.createElement('input',props),Select=(props:any)=>React.createElement('select',props),Textarea=(props:any)=>React.createElement('textarea',props);
  let field=0;const Field=({children}:any)=>React.createElement('div',{},typeof children==='function'?children(`field-${++field}`):children);
  const Modal=({children}:any)=>React.createElement('section',{},children);
  const Button=({children,loading,variant,size,...props}:any)=>React.createElement('button',{...props,disabled:loading},children);
  const useFamilyClock=()=>({timeZone:zone}),useTranslations=()=>(key:string)=>key,useToast=()=>({error:(message:string)=>w.__errors.push(message)});
  // Only schema validation and server-action boundaries are synthetic. The
  // actual modal, helpers, React, browser Intl/Date and native FormData execute.
  // Existing action tests separately exercise real server actions with modeled Auth.
  const eventSchema={safeParse:(input:unknown)=>({success:true,data:input})};
  const fieldErrors=()=>({}),describeDbError=(e:unknown)=>String(e);
  const updateCalendarEventAction=async(id:string,fields:unknown)=>{w.__calls.push({mode:'update',id,fields});return{ok:true};};
  const createCalendarEventAction=async(fields:unknown)=>{w.__calls.push({mode:'create',fields});return{ok:true};};
  const useState=React.useState,useRef=React.useRef;
  const component=new Function('React','useState','useRef','useFamilyClock','useTranslations','useToast','eventSchema','fieldErrors','describeDbError','updateCalendarEventAction','createCalendarEventAction','newSubmissionId','submissionSettled','fromLocalInput','toLocalInput','Modal','Input','Field','Select','Textarea','Button',`${modal};return NewEventModal;`)(React,useState,useRef,useFamilyClock,useTranslations,useToast,eventSchema,fieldErrors,describeDbError,updateCalendarEventAction,createCalendarEventAction,newSubmissionId,submissionSettled,fromLocalInput,toLocalInput,Modal,Input,Field,Select,Textarea,Button);
  w.__root=w.ReactDOM.createRoot(document.getElementById('root'));w.__root.render(React.createElement(component,{existing,onClose:()=>{},onSaved:()=>w.__saved++}));
 },{sources,modal,existing,zone});
 await expect(page.locator('form')).toBeVisible();
}

const cases=[
 ['New York both fold occurrences','America/New_York','2026-11-01T05:30:00.000Z','2026-11-01T06:30:00.000Z'],
 ['London both fold occurrences','Europe/London','2026-10-25T00:30:00.000Z','2026-10-25T01:30:00.000Z'],
 ['imported fractional precision','UTC','2026-10-09T12:30:29.456Z','2026-10-09T13:30:42.789Z'],
 ['declared nanosecond precision','UTC','2026-10-09T12:30:29.456789012Z','2026-10-09T13:30:42.789123456Z'],
] as const;
for(const [name,zone,start,end]of cases)test(name,async({page})=>{
 await mount(page,{id:'synthetic-event',title:'Synthetic event',starts_at:start,ends_at:end,category:'general',recurrence:'none'},zone);
 await page.locator('[name=title]').fill('Unrelated title edit');await page.getByRole('button',{name:'Save Changes'}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.length),{timeout:1500}).toBe(1);
 const observed=await page.evaluate(()=>({call:(window as any).__calls[0],saved:(window as any).__saved,errors:(window as any).__errors}));
 expect(observed.call.mode).toBe('update');expect(observed.call.id).toBe('synthetic-event');
 expect(observed.call.fields.startsAt).toBe(start);expect(observed.call.fields.endsAt).toBe(end);expect(observed.call.fields.title).toBe('Unrelated title edit');
 expect(observed.call.fields).not.toHaveProperty('family_id');expect(observed.call.fields).not.toHaveProperty('created_by');
 expect(observed.saved).toBe(1);expect(observed.errors).toEqual([]);expect(browserErrors.get(page)).toEqual([]);
});

test('changed wall boxes retain inherited conversion and end-order refusal',async({page})=>{
 await mount(page,{id:'synthetic-event',title:'Synthetic',starts_at:'2026-10-09T12:30:29.456Z',ends_at:'2026-10-09T13:30:42.789Z'},'UTC');
 await page.locator('[name=starts_at]').fill('2026-10-09T13:31');await page.getByRole('button',{name:'Save Changes'}).click();
 await expect(page.locator('form')).toBeVisible();expect(await page.evaluate(()=>(window as any).__calls.length)).toBe(0);
 await page.locator('[name=starts_at]').fill('2026-10-09T12:31');await page.getByRole('button',{name:'Save Changes'}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.length),{timeout:1500}).toBe(1);
 const call=await page.evaluate(()=>(window as any).__calls[0]);expect(call.fields.startsAt).toBe('2026-10-09T12:31:00.000Z');expect(call.fields.endsAt).toBe('2026-10-09T13:30:42.789Z');expect(browserErrors.get(page)).toEqual([]);
});

test('new form has no original to preserve',async({page})=>{
 await mount(page,null,'UTC');await page.locator('[name=title]').fill('New synthetic event');await page.locator('[name=starts_at]').fill('2026-10-09T12:30');await page.locator('[name=ends_at]').fill('2026-10-09T13:30');await page.getByRole('button',{name:'Add Event'}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.length),{timeout:1500}).toBe(1);
 const call=await page.evaluate(()=>(window as any).__calls[0]);expect(call.mode).toBe('create');expect(call.fields.startsAt).toBe('2026-10-09T12:30:00.000Z');expect(call.fields.endsAt).toBe('2026-10-09T13:30:00.000Z');expect(call.fields.submissionId).toMatch(/^[\da-f-]{36}$/);expect(browserErrors.get(page)).toEqual([]);
});
