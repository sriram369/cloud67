import { agentCompletion, AGENT_MODEL } from './agent-gateway.mjs';
import { boundedJson, RouteError, CF_DAILY_CALLS, OPENROUTER_DAILY_CALLS } from './free-router.mjs';

const now=()=>Math.floor(Date.now()/1000);
const respond=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
const validText=(s,max,label)=>{if(typeof s!=='string'||!s.trim()||s.length>max)throw new RouteError('Invalid '+label+'.',400);return s.trim();};
export function repositoryName(value) {
  let name=String(value||'').trim().replace(/^https:\/\/github\.com\//,'').replace(/\/$/,'').replace(/\.git$/,'');
  if(!/^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i.test(name)||['.','..'].includes(name.split('/')[1]))throw new RouteError('Attach a full GitHub repository URL or owner/repository. An organization name alone is not enough.',400);
  return name;
}
export async function resolveRepository(value,{fetcher=fetch,token}={}) {
  const name=repositoryName(value),headers={'User-Agent':'cloud67-openhands','Accept':'application/vnd.github+json',...(token?{Authorization:'Bearer '+token}:{})};
  const response=await fetcher('https://api.github.com/repos/'+name,{headers,signal:AbortSignal.timeout(15000)});
  if(response.status===404)throw new RouteError('Repository not accessible. Check the URL. Private repositories require a repository-scoped GitHub connection; the website login does not grant GitHub access.',422);
  if(!response.ok)throw new RouteError('GitHub could not verify repository access ('+response.status+'). No job was queued.',503);
  const repo=await boundedJson(response,100000);
  if(!repo.full_name||!repo.default_branch||!repo.owner)throw new RouteError('GitHub returned invalid repository information.',503);
  const ref=await fetcher('https://api.github.com/repos/'+repo.full_name+'/git/ref/heads/'+encodeURIComponent(repo.default_branch),{headers,signal:AbortSignal.timeout(15000)});
  if(!ref.ok)throw new RouteError('Cannot read the repository default branch. No job was queued.',422);
  const data=await boundedJson(ref,20000),sha=data.object?.sha;
  if(!/^[a-f0-9]{40}$/.test(sha||''))throw new RouteError('GitHub returned an invalid revision.',503);
  return {repository:repo.full_name,branch:repo.default_branch,base_sha:sha,private:Boolean(repo.private)};
}

export async function conversationRoutes(request,env,h) {
  const path=new URL(request.url).pathname;
  if(!/^\/(api\/(conversations|turns|history)|internal\/v2|agent\/)/.test(path))return null;
  const q=(sql,...params)=>h.query(env,sql,...params);
  const log=async(id,kind,content,key=crypto.randomUUID())=>q('INSERT OR IGNORE INTO agent_events(turn_id,event_key,kind,content,created_at) SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM agent_events WHERE turn_id=?)<250',id,key,kind,String(content).slice(0,12000),now(),id).run();
  const active=async(id,lease)=>{const t=await q('SELECT * FROM turns WHERE id=?',id).first();if(!t||t.status!=='running'||t.lease!==lease||t.lease_until<=now())throw new RouteError('Run cancelled or lease expired.',409);return t;};
  if(path==='/api/conversations'&&request.method==='GET') {
    const day=new Date().toISOString().slice(0,10);
    const [c,u]=await Promise.all([q(`SELECT c.*,(SELECT status FROM turns WHERE conversation_id=c.id ORDER BY created_at DESC,rowid DESC LIMIT 1) AS status FROM conversations c ORDER BY updated_at DESC LIMIT 100`).all(),q('SELECT bucket,count FROM usage WHERE bucket IN (?,?)','cloudflare:'+day,'openrouter:'+day).all()]);
    return respond({conversations:c.results,usage:u.results,limits:{cloudflare:CF_DAILY_CALLS,openrouter:OPENROUTER_DAILY_CALLS},openrouterConnected:Boolean(env.OPENROUTER_API_KEY),engine:'OpenHands SDK 1.55.1',model:AGENT_MODEL,repository:env.REPOSITORY,runnerEnabled:env.RUNNER_ENABLED==='true',workflow_url:'https://github.com/'+env.REPOSITORY+'/actions/workflows/cloud67-agent.yml'});
  }
  if(path==='/api/history'&&request.method==='GET')return respond({tasks:(await q('SELECT id,instruction,status,summary FROM tasks ORDER BY created_at DESC LIMIT 50').all()).results});
  if(path==='/api/conversations'&&request.method==='POST') {
    const input=await h.body(request),mode=input.mode||'inspect';
    if(!['inspect','edit'].includes(mode))throw new RouteError('Choose inspect or edit mode.',400);
    const repo=await resolveRepository(input.repository,{token:env.GITHUB_READ_TOKEN});
    if(repo.private)throw new RouteError('Private sandbox checkout is not connected yet. No job was queued.',422);
    if(mode==='edit'&&repo.repository.toLowerCase()!==env.REPOSITORY.toLowerCase())throw new RouteError('Editing is currently connected only to '+env.REPOSITORY+'. Use inspect mode for another public repository.',422);
    const test=input.test_command?validText(input.test_command,300,'test command'):null;
    if(mode==='edit'&&!test)throw new RouteError('Edit mode needs a verification command to run in the sandbox.',400);
    const id=crypto.randomUUID();
    const saved=await q('INSERT INTO conversations(id,title,repository,branch,base_sha,mode,test_command,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM conversations)<100 RETURNING id',id,input.title?validText(input.title,100,'title'):repo.repository.split('/')[1],repo.repository,repo.branch,repo.base_sha,mode,test,now(),now()).first();
    if(!saved)throw new RouteError('Conversation limit reached.',429);
    return respond({id,...repo,mode},201);
  }
  let match=path.match(/^\/api\/conversations\/([a-f0-9-]+)(\/messages)?$/);
  if(match) {
    const conversation=await q('SELECT * FROM conversations WHERE id=?',match[1]).first();
    if(!conversation)throw new RouteError('Conversation not found.',404);
    if(!match[2]&&request.method==='GET') {
      const turns=(await q('SELECT id,prompt,status,runner_url,answer,error,patch,branch_url,created_at,updated_at,model_calls FROM turns WHERE conversation_id=? ORDER BY created_at,rowid LIMIT 100',conversation.id).all()).results;
      const events=(await q('SELECT e.id,e.turn_id,e.kind,e.content,e.created_at FROM agent_events e JOIN turns t ON t.id=e.turn_id WHERE t.conversation_id=? ORDER BY e.id LIMIT 1500',conversation.id).all()).results;
      return respond({conversation,turns,events});
    }
    if(match[2]&&request.method==='POST') {
      const input=await h.body(request),prompt=validText(input.content,4000,'message'),id=crypto.randomUUID();
      const day=new Date().toISOString().slice(0,10),usage=await q('SELECT count FROM usage WHERE bucket=?','cloudflare:'+day).first();
      if((usage?.count||0)>=CF_DAILY_CALLS&&!env.OPENROUTER_API_KEY)throw new RouteError('Free application allowance exhausted. It resets at 00:00 UTC. Your message was not queued.',429);
      const accepted=await q(`INSERT INTO turns(id,conversation_id,prompt,created_at,updated_at) SELECT ?,?,?,?,? WHERE
        (SELECT count(*) FROM turns WHERE status IN ('queued','running'))<10 AND (SELECT count(*) FROM turns WHERE conversation_id=?)<100 RETURNING id`,id,conversation.id,prompt,now(),now(),conversation.id).first();
      if(!accepted)throw new RouteError('Conversation or queue limit reached.',429);
      await q('UPDATE conversations SET updated_at=? WHERE id=?',now(),conversation.id).run();
      await log(id,'queued','Waiting for a cloud runner. Follow-ups stay in this conversation. Scheduled pickup is best-effort, approximately every five minutes.');
      return respond({id,status:'queued'},201);
    }
  }
  match=path.match(/^\/api\/turns\/([a-f0-9-]+)\/cancel$/);
  if(match&&request.method==='POST') {await q("UPDATE turns SET status='cancelled',updated_at=? WHERE id=? AND status IN ('queued','running')",now(),match[1]).run();return respond({ok:true});}
  if(path==='/internal/v2/claim'&&request.method==='POST') {
    await q("UPDATE turns SET status='failed',error='Cloud runner lease expired. The last saved conversation checkpoint is retained.',updated_at=? WHERE status='running' AND lease_until<?",now(),now()).run();
    const lease=crypto.randomUUID(),token=crypto.randomUUID()+crypto.randomUUID();
    const turn=await q(`UPDATE turns SET status='running',lease=?,model_hash=?,lease_until=?,updated_at=? WHERE id=(SELECT id FROM turns WHERE status='queued' ORDER BY created_at,rowid LIMIT 1) AND NOT EXISTS(SELECT 1 FROM turns WHERE status='running') RETURNING *`,lease,await h.digest(token),now()+900,now()).first();
    if(!turn)return respond({turn:null});
    const conversation=await q('SELECT * FROM conversations WHERE id=?',turn.conversation_id).first();
    const checkpoint=await q('SELECT payload FROM conversation_checkpoints WHERE conversation_id=?',conversation.id).first();
    await log(turn.id,'starting','OpenHands is preparing an isolated repository workspace.');
    return respond({turn,conversation,checkpoint:checkpoint?JSON.parse(checkpoint.payload):null,model_token:token,publisher_repository:env.REPOSITORY});
  }
  match=path.match(/^\/agent\/([a-f0-9-]+)\/v1\/chat\/completions$/);
  if(match&&request.method==='POST') {
    const turn=await q('SELECT * FROM turns WHERE id=?',match[1]).first(),token=request.headers.get('Authorization')?.replace(/^Bearer /,'')||'';
    if(!turn||!token||!turn.model_hash||!await h.sameSecret(env,turn.model_hash,await h.digest(token)))throw new RouteError('Agent authentication required.',401);
    if(turn.status!=='running'||turn.lease_until<=now())throw new RouteError('Run cancelled or lease expired.',409);
    const input=await h.body(request,80000);
    const accepted=await q("UPDATE turns SET model_calls=model_calls+1 WHERE id=? AND status='running' AND lease_until>? AND model_calls<8 RETURNING id",turn.id,now()).first();
    if(!accepted)throw new RouteError('This turn reached its eight-call allowance.',429);
    const result=await agentCompletion(env,input);
    await log(turn.id,'model',JSON.stringify({provider:result.provider,model:result.model,usage:result.completion.usage}));
    return respond(result.completion);
  }
  match=path.match(/^\/internal\/v2\/turns\/([a-f0-9-]+)\/(heartbeat|events|finish)$/);
  if(match&&request.method==='POST') {
    const input=await h.body(request,700000),turn=await active(match[1],input.lease);
    if(match[2]==='heartbeat') {await q("UPDATE turns SET lease_until=?,updated_at=? WHERE id=? AND status='running' AND lease=?",now()+900,now(),turn.id,turn.lease).run();return respond({ok:true});}
    if(match[2]==='events') {
      const kind=validText(input.kind,40,'event kind'),content=validText(input.content,12000,'event content');
      if(input.runner_url) {
        if(!new RegExp('^https://github\\.com/'+env.REPOSITORY+'/actions/runs/[0-9]+$').test(input.runner_url))throw new RouteError('Invalid runner URL.',400);
        await q('UPDATE turns SET runner_url=? WHERE id=?',input.runner_url,turn.id).run();
      }
      await log(turn.id,kind,content,input.event_key||crypto.randomUUID());return respond({ok:true});
    }
    if(!['completed','failed','needs_input'].includes(input.status))throw new RouteError('Invalid completion state.',400);
    const answer=String(input.answer||'').slice(0,16000),error=input.error?String(input.error).slice(0,4000):null,patch=input.patch?String(input.patch).slice(0,120000):null;
    const branch=input.branch_url||null;
    if(branch&&!branch.startsWith('https://github.com/'+env.REPOSITORY+'/compare/'))throw new RouteError('Invalid publication URL.',400);
    if(input.checkpoint&&JSON.stringify(input.checkpoint).length>500000)throw new RouteError('Conversation checkpoint exceeds storage limit.',413);
    const saved=await q("UPDATE turns SET status=?,answer=?,error=?,patch=?,branch_url=?,updated_at=? WHERE id=? AND status='running' AND lease=? AND lease_until>? RETURNING id",input.status,answer,error,patch,branch,now(),turn.id,turn.lease,now()).first();
    if(!saved)throw new RouteError('Run no longer accepts completion.',409);
    if(input.checkpoint)await q('INSERT INTO conversation_checkpoints(conversation_id,payload,updated_at) VALUES (?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at',turn.conversation_id,JSON.stringify(input.checkpoint),now()).run();
    await log(turn.id,input.status,error||answer||'Turn ended.');return respond({ok:true});
  }
  throw new RouteError('Conversation endpoint not found.',404);
}
