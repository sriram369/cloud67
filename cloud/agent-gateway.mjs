import { boundedJson, isFreeModel, reserve, RouteError, CF_DAILY_CALLS, OPENROUTER_DAILY_CALLS } from './free-router.mjs';

export const AGENT_MODEL='@cf/qwen/qwen3-30b-a3b-fp8';
export const AGENT_OUTPUT_TOKENS=2048;
export function agentInput(input) {
  if (!input || input.stream === true || !Array.isArray(input.messages) || !input.messages.length || input.messages.length>80) throw new RouteError('Invalid agent conversation.',400);
  if (new TextEncoder().encode(JSON.stringify(input)).length>80000) throw new RouteError('Agent context limit reached. Start a new conversation.',413);
  const messages=input.messages.map(m=>{
    if (!['system','user','assistant','tool'].includes(m.role)) throw new RouteError('Invalid agent message.',400);
    let content=m.content;
    if (Array.isArray(content)) { if(content.some(c=>c.type!=='text'||typeof c.text!=='string')) throw new RouteError('Only text agent messages are supported.',400);content=content.map(c=>c.text).join('\n'); }
    if (content!==null && content!==undefined && typeof content!=='string') throw new RouteError('Invalid message content.',400);
    const out={role:m.role,content:content??''};
    if(m.tool_call_id)out.tool_call_id=String(m.tool_call_id);
    if(m.tool_calls) {if(!Array.isArray(m.tool_calls)||m.tool_calls.length>8)throw new RouteError('Too many tool calls.',400);out.tool_calls=m.tool_calls;}
    return out;
  });
  if(input.tools && (!Array.isArray(input.tools)||input.tools.length>8||input.tools.some(t=>t.type!=='function'||!/^[-\w]{1,64}$/.test(t.function?.name||'')))) throw new RouteError('Invalid agent tools.',400);
  return {messages,...(input.tools?.length?{tools:input.tools,tool_choice:'auto',parallel_tool_calls:false}:{}),max_tokens:AGENT_OUTPUT_TOKENS,temperature:0.1};
}
export function completionResult(result) {
  const original=result.choices?.[0]?.message;
  const calls=(original?.tool_calls||result.tool_calls||[]).map((call,i)=>({id:call.id||'call_'+i+'_'+crypto.randomUUID(),type:'function',function:{name:call.function?.name||call.name,arguments:typeof(call.function?.arguments??call.arguments)==='string'?(call.function?.arguments??call.arguments):JSON.stringify(call.function?.arguments??call.arguments??{})}}));
  const content=original?.content??(typeof result.response==='string'?result.response:null);
  if(!content && !calls.length) throw new RouteError('The free model returned no usable response.',503);
  return {id:result.id||'chatcmpl-'+crypto.randomUUID(),object:'chat.completion',created:Math.floor(Date.now()/1000),model:'cloud67-free',choices:[{index:0,message:{role:'assistant',content:content||null,...(calls.length?{tool_calls:calls}:{})},finish_reason:calls.length?'tool_calls':'stop'}],usage:result.usage||{prompt_tokens:0,completion_tokens:0,total_tokens:0}};
}
export async function agentCompletion(env,input,{fetcher=fetch,reserveCall=reserve}={}) {
  const request=agentInput(input);
  if(env.AI && await reserveCall(env.DB,'cloudflare',CF_DAILY_CALLS)) {
    try { return {completion:completionResult(await env.AI.run(AGENT_MODEL,request)),provider:'cloudflare',model:AGENT_MODEL}; }
    catch { if(!env.OPENROUTER_API_KEY) throw new RouteError('Free Workers AI is unavailable or returned no usable response. No paid fallback was used.',503); }
  }
  if(!env.OPENROUTER_API_KEY) throw new RouteError('Daily free application allowance exhausted. It resets at 00:00 UTC. OpenRouter is not connected.',429);
  const catalog=await fetcher('https://openrouter.ai/api/v1/models',{signal:AbortSignal.timeout(15000)});
  if(!catalog.ok) throw new RouteError('Cannot verify free-model prices. Inference was not sent.',503);
  const model=(await boundedJson(catalog)).data?.find(m=>m.id==='openrouter/free');
  if(!isFreeModel(model))throw new RouteError('Free-router pricing cannot be verified. Paid routes are disabled.',503);
  if(!await reserveCall(env.DB,'openrouter',OPENROUTER_DAILY_CALLS))throw new RouteError('Daily free application allowance exhausted.',429);
  const response=await fetcher('https://openrouter.ai/api/v1/chat/completions',{method:'POST',signal:AbortSignal.timeout(90000),headers:{Authorization:'Bearer '+env.OPENROUTER_API_KEY,'Content-Type':'application/json','X-Title':'Cloud67 OpenHands'},body:JSON.stringify({...request,model:'openrouter/free',provider:{max_price:{prompt:0,completion:0},require_parameters:true}})});
  if(!response.ok)throw new RouteError('The free OpenRouter route is unavailable. Paid fallback is disabled.',response.status===429?429:503);
  const result=await boundedJson(response,200000);
  return {completion:completionResult(result),provider:'openrouter',model:result.model||'openrouter/free'};
}
