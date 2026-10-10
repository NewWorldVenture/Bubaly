import type {ImportedSourceTimezone, SourceTime} from './imported-source';
import {expandSourceRule, type CivilDateTime} from './source-rule';

/** RFC source clocks. Intl uses the host's ICU data, not a pinned TZDB release.
 * Embedded definitions take precedence and never fall through to an IANA zone.
 * Leap-second materialization is deliberately refused by this POSIX resolver. */
export class SourceClockError extends Error {
  constructor(message: string) {super(`Source calendar clock: ${message}`);this.name='SourceClockError';}
}
const DAY=86_400_000, SECOND=1000;
function fail(message:string):never {throw new SourceClockError(message);}
export interface SourceClockOptions {
  timezones?:readonly ImportedSourceTimezone[];
  floatingTimezone?:string;
  dateTimezone?:string;
  /** Inclusive UTC preparation horizon. No unbounded recurrence expansion. */
  through:number;
  maxWork?:number;
  /** Optional enclosing event-set budget; callback errors propagate. */
  consumeWork?:(amount:number)=>void;
}
interface Transition {at:number;from:number;to:number}
interface Zone {offsetAt:(instant:number)=>number; transitions?:Transition[]; offsets?:number[]}
function epoch(p:CivilDateTime):number {
  const date=new Date(0);date.setUTCFullYear(p.year,p.month-1,p.day);date.setUTCHours(p.hour,p.minute,p.second,0);
  if(!Number.isInteger(p.year)||p.year<1||p.year>9999||date.getUTCFullYear()!==p.year||date.getUTCMonth()!==p.month-1||date.getUTCDate()!==p.day||date.getUTCHours()!==p.hour||date.getUTCMinutes()!==p.minute||date.getUTCSeconds()!==p.second)fail('invalid civil date or unsupported leap second');
  return date.getTime();
}
function civil(token:string,dateOnly=false):CivilDateTime {
  if(!(dateOnly?/^\d{8}$/:/^\d{8}T\d{6}Z?$/).test(token))fail('invalid compact source time');
  const p={year:Number(token.slice(0,4)),month:Number(token.slice(4,6)),day:Number(token.slice(6,8)),hour:dateOnly?0:Number(token.slice(9,11)),minute:dateOnly?0:Number(token.slice(11,13)),second:dateOnly?0:Number(token.slice(13,15))};epoch(p);return p;
}
function offset(value:string):number {
  if(!/^[+-]\d{4}(\d{2})?$/.test(value)||value==='-0000'||value==='-000000')fail('invalid UTC offset');
  const h=Number(value.slice(1,3)),m=Number(value.slice(3,5)),s=Number(value.slice(5)||0);
  if(h>23||m>59||s>59)fail('invalid UTC offset fields');
  return (value[0]==='-'?-1:1)*(h*3600+m*60+s)*SECOND;
}
function content(line:string):{key:string;params:string;value:string} {
  let quoted=false,index=-1;
  for(let i=0;i<line.length;i++){if(line[i]==='"')quoted=!quoted;else if(line[i]===':'&&!quoted){index=i;break;}}
  if(index<1||quoted)fail('malformed timezone content line');
  const header=line.slice(0,index),semicolon=header.indexOf(';');
  return {key:(semicolon<0?header:header.slice(0,semicolon)).toUpperCase(),params:semicolon<0?'':header.slice(semicolon+1),value:line.slice(index+1)};
}
function decode(value:string):string {return value.replace(/\\([nN,;\\])/g,(_,c:string)=>c.toLowerCase()==='n'?'\n':c);}
function embedded(definition:ImportedSourceTimezone,through:number,maxWork:number,charge:()=>void):Zone {
  if(definition.raw.length>262144||/[^\S\r\n]*\r(?!\n)/.test(definition.raw)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(definition.raw))fail('invalid embedded timezone bytes');
  const lines=definition.raw.replace(/\r\n/g,'\n').replace(/\n[ \t]/g,'').split('\n').filter(Boolean);
  let depth=0,kind='',tzid:string|undefined,fields:Map<string,string[]>|undefined;
  const observances:Map<string,string[]>[]=[];
  for(const line of lines){
    charge();
    const p=content(line);
    if(p.key==='BEGIN'){
      depth++;
      if(depth===1&&p.value.toUpperCase()!=='VTIMEZONE')fail('expected VTIMEZONE');
      if(depth===2){kind=p.value.toUpperCase();if(kind!=='STANDARD'&&kind!=='DAYLIGHT')fail('unsupported timezone child');fields=new Map();}
      if(depth>2)fail('nested timezone observance');
    }else if(p.key==='END'){
      if(depth===2){if(p.value.toUpperCase()!==kind||!fields)fail('unbalanced observance');observances.push(fields);fields=undefined;}
      else if(depth!==1||p.value.toUpperCase()!=='VTIMEZONE')fail('unbalanced timezone');
      depth--;
    }else if(depth===1){
      if(p.key==='TZID'){if(tzid!==undefined)fail('duplicate TZID');tzid=decode(p.value);}
      else if(!['LAST-MODIFIED','TZURL'].includes(p.key)&&!p.key.startsWith('X-'))fail('unsupported timezone property');
    }else if(depth===2&&fields){
      if(['DTSTART','RDATE','RRULE','TZOFFSETFROM','TZOFFSETTO'].includes(p.key)){
        const expectedType=['DTSTART','RDATE'].includes(p.key)?'DATE-TIME':p.key==='RRULE'?'RECUR':'UTC-OFFSET';
        if(p.params&&p.params.toUpperCase().replace(/"/g,'')!==`VALUE=${expectedType}`)fail('unsupported observance parameter');
        const values=fields.get(p.key)??[];values.push(p.value);fields.set(p.key,values);
      }else if(!['TZNAME','COMMENT'].includes(p.key)&&!p.key.startsWith('X-'))fail('unsupported observance property');
    }else fail('timezone property outside frame');
  }
  if(depth!==0||tzid!==definition.tzid||!observances.length||observances.length>64)fail('invalid embedded timezone identity/observances');
  const transitions:Transition[]=[];
  for(const fields of observances){
    charge();
    const one=(key:string,required=true):string|undefined=>{const values=fields.get(key)??[];if(values.length>1||(required&&values.length!==1))fail(`invalid observance ${key}`);return values[0];};
    const start=one('DTSTART')!,from=offset(one('TZOFFSETFROM')!),to=offset(one('TZOFFSETTO')!);
    if(start.endsWith('Z'))fail('observance DTSTART must be local');
    const startCivil=civil(start),at=epoch(startCivil)-from;
    const add=(instant:number)=>{charge();if(!Number.isFinite(instant))fail('invalid observance instant');transitions.push({at:instant,from,to});if(transitions.length>20000)fail('timezone transition limit');};
    add(at);
    for(const list of fields.get('RDATE')??[])for(const value of list.split(',')){if(value.endsWith('Z'))fail('observance RDATE must be local');add(epoch(civil(value))-from);}
    const rule=one('RRULE',false);
    if(rule){
      const generated=expandSourceRule({start:{kind:'zoned',value:start,tzid:definition.tzid},rule,resolve:p=>epoch(p)-from,through:through+3*DAY,maxWork,consumeWork:charge,maxOccurrences:20000});
      for(const item of generated)add(item.instant);
    }
  }
  transitions.sort((a,b)=>a.at-b.at);
  const initial=transitions[0].from;
  const unique:Transition[]=[];
  for(const item of transitions){charge();if(item.at>through+3*DAY)continue;const last=unique.at(-1);if(last?.at===item.at){if(last.from!==item.from||last.to!==item.to)fail('conflicting simultaneous observances');continue;}if(last&&last.to!==item.from)fail('inconsistent timezone offset chain');unique.push(item);}
  return {transitions:unique,offsets:[...new Set([initial,...unique.map(t=>t.to)])],offsetAt(instant){let low=0,high=unique.length;while(low<high){const mid=(low+high)>>>1;if(unique[mid].at<=instant)low=mid+1;else high=mid;}return low?unique[low-1].to:initial;}};
}
function iana(name:string):Zone {
  let formatter:Intl.DateTimeFormat;
  try{formatter=new Intl.DateTimeFormat('en-GB-u-ca-iso8601-nu-latn',{timeZone:name,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});}catch{fail(`unknown timezone ${name}`);}
  return {offsetAt(instant){const parts:Record<string,number>={};for(const p of formatter.formatToParts(new Date(instant)))if(p.type!=='literal')parts[p.type]=Number(p.value);return epoch(parts as unknown as CivilDateTime)-Math.floor(instant/SECOND)*SECOND;}};
}

export function createSourceClock(options:SourceClockOptions):{
  coverageEnd:number;
  resolve:(time:SourceTime,mode?:'explicit'|'generated')=>number|null;
} {
  if(!Number.isFinite(options.through))fail('finite preparation horizon required');
  const horizonYear=new Date(options.through).getUTCFullYear();if(horizonYear<1||horizonYear>9997)fail('preparation horizon outside supported Gregorian years');
  // BYSETPOS evaluates a complete frequency period before cropping. Include
  // the entire following year for a final yearly period crossing the horizon.
  const coverageEnd=epoch({year:horizonYear+2,month:1,day:1,hour:0,minute:0,second:0})-SECOND;
  const maxWork=options.maxWork??200000;if(!Number.isSafeInteger(maxWork)||maxWork<1||maxWork>2000000)fail('invalid work bound');
  const definitions=new Map<string,ImportedSourceTimezone>();
  for(const value of options.timezones??[]){if(definitions.has(value.tzid))fail('duplicate embedded timezone');definitions.set(value.tzid,value);}
  if(definitions.size>32)fail('timezone count limit');
  const zones=new Map<string,Zone>();let work=0;
  const charge=()=>{options.consumeWork?.(1);if(++work>maxWork)fail('clock work limit');};
  const getZone=(name:string)=>{let zone=zones.get(name);if(!zone){const definition=definitions.get(name);zone=definition?embedded(definition,coverageEnd,maxWork,charge):iana(name);zones.set(name,zone);}return zone;};
  return {coverageEnd,resolve(time:SourceTime,mode:'explicit'|'generated'='explicit'):number|null {
    charge();const p=civil(time.value,time.kind==='date'),wall=epoch(p);
    if(time.kind==='utc'){if(!time.value.endsWith('Z'))fail('UTC source requires Z');return wall;}
    if(time.value.endsWith('Z'))fail('local source must not carry Z');
    if(wall>coverageEnd)fail('outside prepared clock coverage');
    const name=time.kind==='zoned'?time.tzid:time.kind==='date'?options.dateTimezone:options.floatingTimezone;
    if(!name)fail(`${time.kind} source requires explicit timezone context`);
    const zone=getZone(name),offsets=new Set(zone.offsets??[]),samples:{at:number;offset:number}[]=[];
    if(!zone.offsets)for(let delta=-3*DAY;delta<=3*DAY;delta+=6*3600000){charge();const at=wall+delta,off=zone.offsetAt(at);offsets.add(off);samples.push({at,offset:off});}
    const exact=[...offsets].map(off=>wall-off).filter(at=>{charge();return zone.offsetAt(at)+at===wall;}).sort((a,b)=>a-b);
    if(exact.length)return exact[0];
    let transitions=zone.transitions;
    if(!transitions){
      transitions=[];
      for(let i=1;i<samples.length;i++)if(samples[i-1].offset!==samples[i].offset){
        let low=samples[i-1].at,high=samples[i].at;const from=samples[i-1].offset;
        while(high-low>SECOND){charge();const mid=Math.floor((low+high)/(2*SECOND))*SECOND;if(zone.offsetAt(mid)===from)low=mid;else high=mid;}
        transitions.push({at:high,from,to:zone.offsetAt(high)});
      }
    }
    for(const transition of transitions)if(transition.to>transition.from&&wall>=transition.at+transition.from&&wall<transition.at+transition.to)return mode==='generated'?null:wall-transition.from;
    fail('unresolved local reading; no qualified gap transition');
  }};
}
