import { HTML, CLIENT } from './ui.mjs';
import { generate, RouteError, CF_DAILY_CALLS, OPENROUTER_DAILY_CALLS } from './free-router.mjs';
import { conversationRoutes } from './conversations.mjs';

const encoder = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
export async function digest(value) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
async function hmacKey(env) { return crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function sameSecret(env, a, b) {
  const key = await hmacKey(env);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(a));
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(b));
}
async function sign(env, value) { return hex(await crypto.subtle.sign('HMAC', await hmacKey(env), encoder.encode(value))); }
async function authenticated(request, env) {
  const match = /(?:^|; )cloud67=([^;]+)/.exec(request.headers.get('Cookie') || '');
  if (!match) return false;
  const [expiry, signature] = match[1].split('.');
  if (!/^\d+$/.test(expiry || '') || Number(expiry) <= now() || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
  return sameSecret(env, await sign(env, expiry), signature);
}

function reply(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}
async function body(request, max = 18000) {
  const reader = request.body?.getReader(); if (!reader) return {};
  let size = 0, text = ''; const decoder = new TextDecoder();
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length;
    if (size > max) { await reader.cancel(); throw new RouteError('Request too large.', 413); }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try { const parsed=JSON.parse(text); if(!parsed || Array.isArray(parsed) || typeof parsed!=='object') throw new Error(); return parsed; }
  catch { throw new RouteError('A JSON object is required.', 400); }
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new RouteError(`Invalid ${label}.`, 400);
  return value.trim();
}
const query = (env, sql, ...params) => env.DB.prepare(sql).bind(...params);
async function event(env, id, kind, content) {
  await query(env, 'INSERT INTO events(task_id,kind,content,created_at) VALUES (?,?,?,?)', id, kind, String(content).slice(0,12000), now()).run();
}
async function getTask(env, id) { return query(env, 'SELECT * FROM tasks WHERE id=?', id).first(); }
async function activeTask(env, id, lease) {
  const task = await getTask(env, id);
  if (!task || task.status !== 'running' || !lease || task.lease !== lease || task.lease_until <= now()) throw new RouteError('Task cancelled or lease expired.', 409);
  return task;
}

async function handle(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (request.method === 'GET' && path === '/') return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
  if (request.method === 'GET' && path === '/app.js') return new Response(CLIENT, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } });
  if (request.method === 'GET' && path === '/api/health') return reply({ name:'cloud67',version:'0.2.0',status:'ok',edition:'free-cloud',execution:'github-actions',paidFallback:false });
  if (!env.SESSION_SECRET || !env.ADMIN_PASSWORD_HASH) throw new RouteError('Cloud67 is not configured.', 503);
  if (request.method !== 'GET') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) throw new RouteError('Origin rejected.', 403);
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new RouteError('Cross-site request rejected.', 403);
    if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) throw new RouteError('JSON required.', 415);
  }
  if (path === '/api/login' && request.method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const bucket = `login:${await digest(ip)}:${Math.floor(now()/300)}`;
    const accepted = await query(env, `INSERT INTO usage(bucket,count) VALUES (?,1) ON CONFLICT(bucket) DO UPDATE SET count=count+1 WHERE count<8 RETURNING count`, bucket).first();
    if (!accepted) throw new RouteError('Too many sign-in attempts. Try again in five minutes.', 429);
    const input = await body(request, 1024);
    if (typeof input.password !== 'string' || !await sameSecret(env, env.ADMIN_PASSWORD_HASH, await digest(input.password))) throw new RouteError('Incorrect workspace password.', 401);
    const expiry = String(now()+43200);
    return reply({ok:true},200,{'Set-Cookie':`cloud67=${expiry}.${await sign(env,expiry)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`});
  }
  const internal = path.startsWith('/internal/');
  if (internal) {
    const token = request.headers.get('Authorization')?.replace(/^Bearer /,'') || '';
    if (!env.RUNNER_TOKEN || !token || !await sameSecret(env, env.RUNNER_TOKEN, token)) throw new RouteError('Runner authentication required.',401);
    if (request.method !== 'POST') throw new RouteError('Method not allowed.',405);
  } else if (!/^\/agent\/[a-f0-9-]+\/v1\/chat\/completions$/.test(path) && !await authenticated(request,env)) throw new RouteError('Sign in to your workspace.',401);
  const conversationResponse=await conversationRoutes(request,env,{body,query,digest,sameSecret});
  if(conversationResponse)return conversationResponse;
  if (path === '/api/logout' && request.method === 'POST') return reply({ok:true},200,{'Set-Cookie':'cloud67=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'});
  if (path === '/api/state' && request.method === 'GET') {
    const day = new Date().toISOString().slice(0,10);
    const [threads,tasks,usage] = await Promise.all([
      query(env,'SELECT id,title,created_at FROM threads ORDER BY created_at DESC LIMIT 50').all(),
      query(env,'SELECT id,instruction,issue_url,status,created_at,updated_at,summary,pr_url,branch_url FROM tasks ORDER BY created_at DESC LIMIT 50').all(),
      query(env,'SELECT bucket,count FROM usage WHERE bucket IN (?,?)',`cloudflare:${day}`,`openrouter:${day}`).all(),
    ]);
    return reply({threads:threads.results,tasks:tasks.results,usage:usage.results,limits:{cloudflare:CF_DAILY_CALLS,openrouter:OPENROUTER_DAILY_CALLS},openrouterConnected:Boolean(env.OPENROUTER_API_KEY),runnerEnabled:env.RUNNER_ENABLED==='true',repository:env.REPOSITORY,scope:'cloud/agent-workspace/',paidFallback:false});
  }
  if (path === '/api/threads' && request.method === 'POST') {
    const input = await body(request), id = crypto.randomUUID();
    const row=await query(env,'INSERT INTO threads(id,title,created_at) SELECT ?,?,? WHERE (SELECT count(*) FROM threads)<200 RETURNING id',id,text(input.title,100,'title'),now()).first();
    if (!row) throw new RouteError('Workspace thread limit reached.',429);
    return reply({id},201);
  }
  let match = path.match(/^\/api\/threads\/([a-f0-9-]+)\/messages$/);
  if (match) {
    const id=match[1];
    if (!await query(env,'SELECT id FROM threads WHERE id=?',id).first()) throw new RouteError('Thread not found.',404);
    if (request.method==='GET') return reply({messages:(await query(env,'SELECT role,content,model,created_at FROM messages WHERE thread_id=? ORDER BY id LIMIT 200',id).all()).results});
    if (request.method==='POST') {
      const input=await body(request), content=text(input.content,4000,'message');
      const lock=await query(env,'UPDATE threads SET busy_until=? WHERE id=? AND busy_until<? RETURNING id',now()+180,id,now()).first();
      if(!lock) throw new RouteError('A response is already running in this thread.',409);
      try {
        const previous=(await query(env,'SELECT role,content FROM messages WHERE thread_id=? ORDER BY id DESC LIMIT 6',id).all()).results.reverse();
        const messages=[{role:'system',content:'You are cloud67, a software engineering assistant. Explain clearly, use evidence, and never claim to execute tools, inspect a repository, run tests, or open a PR from this chat. Coding jobs execute separately in GitHub Actions. Do not reveal secrets. Inference is free-only.'},...previous,{role:'user',content}];
        const result=await generate(env,messages);
        await env.DB.batch([
          query(env,'INSERT INTO messages(thread_id,role,content,created_at) VALUES (?,?,?,?)',id,'user',content,now()),
          query(env,'INSERT INTO messages(thread_id,role,content,model,created_at) VALUES (?,?,?,?,?)',id,'assistant',result.content,result.model,now()),
        ]);
        return reply(result);
      } finally { await query(env,'UPDATE threads SET busy_until=0 WHERE id=?',id).run(); }
    }
  }
  if(path==='/api/tasks' && request.method==='POST') {
    const input=await body(request), id=crypto.randomUUID();
    const instruction=text(input.instruction,4000,'task');
    const issue=input.issue_url || null;
    if(issue && !new RegExp('^https://github\\.com/'+env.REPOSITORY.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/issues/[0-9]+$').test(issue)) throw new RouteError('Use an issue from the connected repository.',400);
    const accepted=await query(env,`INSERT INTO tasks(id,instruction,issue_url,created_at,updated_at)
      SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM tasks WHERE status IN ('queued','running'))<10
      AND (SELECT count(*) FROM tasks)<500 RETURNING id`,id,instruction,issue,now(),now()).first();
    if(!accepted) throw new RouteError('Queue or task history limit reached.',429);
    await event(env,id,'queued','Waiting for a GitHub Actions runner. Initial write scope: cloud/agent-workspace/.');
    return reply({id,status:'queued'},201);
  }
  match=path.match(/^\/api\/tasks\/([a-f0-9-]+)(\/cancel)?$/);
  if(match) {
    const task=await getTask(env,match[1]); if(!task) throw new RouteError('Task not found.',404);
    if(match[2] && request.method==='POST') {
      await query(env,"UPDATE tasks SET status='cancelled',updated_at=? WHERE id=? AND status IN ('queued','running')",now(),task.id).run();
      return reply({ok:true});
    }
    if(request.method==='GET') { const {lease,...safe}=task; return reply({task:safe,events:(await query(env,'SELECT id,kind,content,created_at FROM events WHERE task_id=? ORDER BY id LIMIT 250',task.id).all()).results}); }
  }
  if(path==='/internal/claim') {
    // An expired attempt is failed, not silently replayed with duplicate publication.
    await query(env,"UPDATE tasks SET status='failed',summary='Runner lease expired. Inspect the workflow before retrying.',updated_at=? WHERE status='running' AND lease_until<?",now(),now()).run();
    const lease=crypto.randomUUID();
    const task=await query(env,`UPDATE tasks SET status='running',lease=?,lease_until=?,updated_at=?
      WHERE id=(SELECT id FROM tasks WHERE status='queued' ORDER BY created_at LIMIT 1)
      AND NOT EXISTS(SELECT 1 FROM tasks WHERE status='running') RETURNING *`,lease,now()+900,now()).first();
    if(task) await event(env,task.id,'running','GitHub Actions runner claimed this task.');
    return reply({task,repository:env.REPOSITORY});
  }
  match=path.match(/^\/internal\/tasks\/([a-f0-9-]+)\/(heartbeat|model|events|finish|authorize-publication)$/);
  if(match) {
    const input=await body(request), task=await activeTask(env,match[1],input.lease);
    if(match[2]==='heartbeat') {await query(env,'UPDATE tasks SET lease_until=?,updated_at=? WHERE id=? AND lease=?',now()+900,now(),task.id,input.lease).run();return reply({ok:true});}
    if(match[2]==='model') return reply(await generate(env,input.messages,{structured:true}));
    if(match[2]==='events') {await event(env,task.id,text(input.kind,40,'event kind'),text(input.content,12000,'event content'));return reply({ok:true});}
    if(match[2]==='authorize-publication') return reply({ok:true});
    if(match[2]==='finish') {
      if(!['completed','failed'].includes(input.status)) throw new RouteError('Invalid completion state.',400);
      const pr=input.pr_url || null;
      if(pr && (typeof pr!=='string' || !pr.startsWith(`https://github.com/${env.REPOSITORY}/pull/`))) throw new RouteError('Invalid PR URL.',400);
      const branch=input.branch_url || null;
      if(branch && (typeof branch!=='string' || !branch.startsWith(`https://github.com/${env.REPOSITORY}/compare/`))) throw new RouteError('Invalid branch URL.',400);
      const summary=text(input.summary,4000,'summary');
      const finished=await query(env,'UPDATE tasks SET status=?,summary=?,pr_url=?,branch_url=?,updated_at=? WHERE id=? AND lease=? AND status=\'running\' AND lease_until>? RETURNING id',input.status,summary,pr,branch,now(),task.id,input.lease,now()).first();
      if(!finished) throw new RouteError('Task no longer accepts completion.',409);
      await event(env,task.id,input.status,summary);
      return reply({ok:true});
    }
  }
  throw new RouteError('Not found.',404);
}

export default {
  async fetch(request,env) {
    let response;
    try { response=await handle(request,env); }
    catch(error) {
      const status=error instanceof RouteError?error.status:500;
      console.error(JSON.stringify({event:'request_error',path:new URL(request.url).pathname,status}));
      const message=status===500?'An internal error occurred.':error.message;
      const agentPath=/^\/agent\/[a-f0-9-]+\/v1\/chat\/completions$/.test(new URL(request.url).pathname);
      response=reply({error:agentPath?{message,type:status===429?'rate_limit_error':'api_error',code:String(status)}:message},status);
    }
    const headers=new Headers(response.headers);
    headers.set('X-Content-Type-Options','nosniff');
    headers.set('Referrer-Policy','no-referrer');
    headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return new Response(response.body,{status:response.status,headers});
  },
};
