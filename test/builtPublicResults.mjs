// Execute actual Astro output with a small DOM harness; no network or external libraries.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root=path.resolve('dist');
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const id=t=>`${t.date}:${t.product==null?'legacy:'+t.slot_hour:'dynamic:'+t.product}`;
const escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let serial=0;
const make=(product,slot,result,results)=>({date:today,product,slot_hour:slot,published_at:`${today}T08:00:00Z`,result,
 selections:results.map(r=>({fixture_id:++serial,home_team:`Home ${serial}`,away_team:`Away ${serial}`,league:'League',
 market:'FT OVER 2.5 & BTTS YES',odds:1.5,chance:75,kickoff:`${today}T12:00:00Z`,result:r,
 fixture_status:r==='WIN'?'FT':null,final_score_verified:r==='WIN',final_score:r==='WIN'?{home:2,away:1}:null}))});
const synthetic={tickets:[make(2,null,'WIN',['WIN','WIN']),make(3,null,'WIN',['WIN','VOID']),
 make(5,null,'VOID',['VOID','VOID']),make(null,10,'LOST',['LOST','WIN']),
 make(null,13,'PENDING',['WIN','PENDING']),make(null,18,'LOST',['LOST','PENDING'])]};
const datasets=[['synthetic',synthetic]];
if(process.argv[2])datasets.push(['existing',JSON.parse(fs.readFileSync(process.argv[2],'utf8')).enriched]);
const reports=[];
for(const [name,feed] of datasets)for(const page of ['index.html','todays-accas/index.html','daily-accas/index.html']){
 const html=fs.readFileSync(path.join(root,page),'utf8');
 assert.ok(html.includes('.ab-result--win')&&html.includes('.ab-result--lost')&&html.includes('.ab-result--void'));
 const entry=html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/);assert.ok(entry);
 class Element{
  innerHTML='';textContent='';value='';dataset={};handlers={};
  classList={toggle:()=>false,add:()=>{},remove:()=>{}};
  addEventListener(name,fn){this.handlers[name]=fn;}
  setAttribute(){}getAttribute(){return null;}querySelectorAll(){return [];}before(){}
 }
 const elements=new Map();const el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 const timers=new Map();let timerId=0,fail=false,requests=0;
 const input={tickets:[...feed.tickets,...feed.tickets],count:feed.tickets.length*2};const before=JSON.stringify(input);
 const context=vm.createContext({console,URL,Intl,Date,AbortController,
  setTimeout:(fn,ms)=>{const n=++timerId;timers.set(n,{fn,ms});return n;},clearTimeout:n=>timers.delete(n),
  fetch:async(url,options)=>{requests++;assert.equal(options.method,'GET');assert.match(url,/\/api\/public\/tickets\?limit=/);
   if(fail)throw new Error('simulated offline');return {ok:true,json:async()=>input};},
  document:{hidden:false,addEventListener(){},removeEventListener(){},getElementById:id=>el('#'+id),
   querySelector:id=>el(id),querySelectorAll:()=>[],createElement:()=>new Element()},
  window:{addEventListener(){},location:{reload(){throw new Error('Unexpected navigation');}}}
 });
 const modules=new Map();
 async function load(file){
  if(modules.has(file))return modules.get(file);
  assert.ok(path.resolve(file).startsWith(root+path.sep));
  const module=new vm.SourceTextModule(fs.readFileSync(file,'utf8'),{context,identifier:file});modules.set(file,module);
  await module.link((specifier,parent)=>load(path.resolve(path.dirname(parent.identifier),specifier)));return module;
 }
 await(await load(path.join(root,entry[1].replace(/^\//,'')))).evaluate();
 for(let n=0;n<15;n++)await new Promise(resolve=>setImmediate(resolve));
 const history=page.startsWith('daily-accas/');const target=el(history?'#ticket-list':'#ab-public-tickets');
 const verify=(expected)=>{
  const markup=target.innerHTML;
  const ids=[...markup.matchAll(/data-ticket-id="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(ids.length,expected.length);assert.equal(new Set(ids).size,ids.length);
  for(const t of expected){
   assert.ok(ids.includes(id(t)));const start=markup.indexOf(`data-ticket-id="${id(t)}"`);
   const card=markup.slice(start,markup.indexOf('</article>',start));
   const badges=[...card.matchAll(/class="ab-result ab-result--\w+">(WIN|LOST|VOID|PENDING)<\/span>/g)].map(m=>m[1]);
   const desired=[t.result,...t.selections.map(s=>s.result)];
   assert.deepEqual(badges.sort(),desired.sort());
   const price=t.selections.reduce((acc,s)=>acc*s.odds,1).toFixed(2);assert.ok(card.includes(price));
   for(const s of t.selections){assert.ok(card.includes(escape(s.market)));assert.ok(card.includes(escape(s.home_team)));}
   const finalScores=t.selections.filter(s=>s.final_score_verified&&s.fixture_status==='FT');
   for(const s of finalScores)assert.ok(card.includes(`${s.final_score.home} – ${s.final_score.away}`));
  }
 };
 if(history)verify(feed.tickets.filter(t=>t.date<=today));
 else for(const date of new Set(feed.tickets.map(t=>t.date))){el('#ab-date').value=date;el('#ab-date').handlers.change();verify(feed.tickets.filter(t=>t.date===date));}
 assert.equal(JSON.stringify(input),before);
 const old=target.innerHTML;fail=true;
 const poll=[...timers.values()].find(t=>t.ms===90000);assert.ok(poll,'Automatic refresh registered');
 await poll.fn();for(let n=0;n<15;n++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(target.innerHTML,old,'Failed refresh preserves displayed authoritative results');
 assert.equal(requests,2);
 reports.push({dataset:name,page,status:'PASS',tickets:feed.tickets.length});
}
console.log(JSON.stringify({status:'PASS',checks:reports},null,2));
