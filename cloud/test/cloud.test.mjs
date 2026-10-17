import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { CLIENT } from '../ui.mjs';
import worker, { digest } from '../worker.mjs';
import { isFreeModel, generate, reserve, validateMessages } from '../free-router.mjs';

function database() {
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const prepare=sql=>({bind(...args){return {first:async()=>db.prepare(sql).get(...args)||null,all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>db.prepare(sql).run(...args)};}});
  return {prepare,batch:async statements=>{db.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
}
async function environment(){return {DB:database(),SESSION_SECRET:'local-test-session-secret',ADMIN_PASSWORD_HASH:await digest('test-password'),RUNNER_TOKEN:'test-runner',REPOSITORY:'sriram369/cloud67',AI:{run:async()=>({response:'A real persisted test response.'})}};}
const request=(path,method='GET',data,cookie)=>new Request('https://cloud67.example'+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(data?{body:JSON.stringify(data)}:{})});
async function login(env){const r=await worker.fetch(request('/api/login','POST',{password:'test-password'}),env);assert.equal(r.status,200);return r.headers.get('Set-Cookie').split(';')[0];}

test('browser client is valid JavaScript',()=>{assert.doesNotThrow(()=>new Script(CLIENT));});

test('free policy rejects paid, missing, malformed, and hidden request charges',()=>{
  assert.equal(isFreeModel({id:'a:free',pricing:{prompt:'0',completion:'0',request:'0'}}),true);
  for(const m of [{id:'paid',pricing:{prompt:'0',completion:'0'}},{id:'a:free',pricing:{prompt:'0',completion:'1'}},{id:'a:free',pricing:{prompt:'0',completion:'0',request:'.01'}},{id:'a:free'},{id:'a:free',pricing:{prompt:'oops',completion:'0'}}])assert.equal(isFreeModel(m),false);
});
test('oversized prompts are rejected before inference',()=>{assert.throws(()=>validateMessages([{role:'user',content:'x'.repeat(13000)}]),/too large/);});
test('coding requests use a schema and accept object responses without changing chat',async()=>{
  const seen=[];const env={DB:{},AI:{run:async(model,options)=>{seen.push(options);return {response:options.response_format?{action:'run_tests'}:'Plain chat'};}}};
  const options={reserveCall:async()=>true};
  const action=await generate(env,[{role:'user',content:'Run tests'}],{...options,structured:true});
  assert.deepEqual(JSON.parse(action.content),{action:'run_tests'});assert.equal(seen[0].response_format.type,'json_schema');
  assert.equal((await generate(env,[{role:'user',content:'hello'}],options)).content,'Plain chat');assert.equal(seen[1].response_format,undefined);
});
test('daily reservation fails closed and resets on a new UTC date',async()=>{const db=database();const t=Date.UTC(2026,9,16);assert.equal(await reserve(db,'cf',2,t),true);assert.equal(await reserve(db,'cf',2,t),true);assert.equal(await reserve(db,'cf',2,t),false);assert.equal(await reserve(db,'cf',2,t+86400000),true);});
test('paid OpenRouter catalog never results in inference',async()=>{
  let calls=0;await assert.rejects(()=>generate({DB:{},OPENROUTER_API_KEY:'test'},[{role:'user',content:'hello'}],{reserveCall:async()=>false,fetcher:async()=>{calls++;return Response.json({data:[{id:'openrouter/free',pricing:{prompt:'1',completion:'1'}}]});}}),/pricing/);assert.equal(calls,1);
});
test('fallback sends only the free router and zero price bounds',async()=>{
  const seen=[];const r=await generate({DB:{},AI:{run:async()=>{throw Error('outage');}},OPENROUTER_API_KEY:'test'},[{role:'user',content:'hello'}],{reserveCall:async()=>true,fetcher:async(url,init)=>{seen.push({url,init});return seen.length===1?Response.json({data:[{id:'openrouter/free',pricing:{prompt:'0',completion:'0'}}]}):Response.json({model:'some:free',choices:[{message:{content:'hello'}}]});}});assert.equal(r.content,'hello');const sent=JSON.parse(seen[1].init.body);assert.equal(sent.model,'openrouter/free');assert.deepEqual(sent.provider.max_price,{prompt:0,completion:0});
});
test('owner authentication, CSRF and tampered cookies are enforced',async()=>{const env=await environment();assert.equal((await worker.fetch(request('/api/state'),env)).status,401);assert.equal((await worker.fetch(request('/api/login','POST',{password:'wrong'}),env)).status,401);const cookie=await login(env);assert.equal((await worker.fetch(request('/api/state','GET',undefined,cookie),env)).status,200);assert.equal((await worker.fetch(request('/api/state','GET',undefined,cookie+'bad'),env)).status,401);const cross=request('/api/tasks','POST',{instruction:'test'},cookie);cross.headers.set('Origin','https://evil.example');assert.equal((await worker.fetch(cross,env)).status,403);});
test('retired prototype writes cannot queue work or consume inference',async()=>{
  const env=await environment(),cookie=await login(env);let inference=0;env.AI.run=async()=>{inference++;return {response:'should not run'};};
  for(const [path,data] of [['/api/tasks',{instruction:'frd02'}],['/api/threads',{title:'old chat'}],['/api/threads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/messages',{content:'old message'}]]) {
    const response=await worker.fetch(request(path,'POST',data,cookie),env);assert.equal(response.status,410);assert.match((await response.json()).error,/Refresh Cloud67/);
  }
  assert.equal(inference,0);assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM tasks').bind().first()).n,0);
});
test('old scheduled workflows cannot claim or execute prototype tasks',async()=>{
  const env=await environment();const req=request('/internal/claim','POST',{});req.headers.set('Authorization','Bearer test-runner');const response=await worker.fetch(req,env);assert.equal(response.status,200);assert.deepEqual(await response.json(),{task:null,repository:'sriram369/cloud67',retired:true});
});
