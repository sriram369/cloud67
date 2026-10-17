export const CF_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const CF_DAILY_CALLS = 15;
export const OPENROUTER_DAILY_CALLS = 20;
export const MAX_PROMPT_BYTES = 12000;
export const MAX_OUTPUT_TOKENS = 1024;

export class RouteError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

export function isFreeModel(model) {
  if (!model || !(model.id === 'openrouter/free' || model.id?.endsWith(':free'))) return false;
  const p = model.pricing;
  if (!p || p.prompt == null || p.completion == null) return false;
  return Object.values(p).every(v => v !== '' && v != null && Number.isFinite(Number(v)) && Number(v) === 0);
}

export function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 14) throw new RouteError('Invalid conversation.', 400);
  const valid = messages.map(m => {
    if (!['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') throw new RouteError('Invalid message.', 400);
    return { role: m.role, content: m.content };
  });
  if (new TextEncoder().encode(JSON.stringify(valid)).length > MAX_PROMPT_BYTES) {
    throw new RouteError('Context is too large. Start a new thread or shorten the task.', 413);
  }
  return valid;
}

export async function reserve(db, provider, limit, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const row = await db.prepare(`INSERT INTO usage(bucket,count) VALUES (?,1)
    ON CONFLICT(bucket) DO UPDATE SET count=count+1 WHERE count < ? RETURNING count`)
    .bind(`${provider}:${day}`, limit).first();
  return Boolean(row);
}

export async function boundedJson(response, limit = 2_000_000) {
  const reader = response.body?.getReader();
  if (!reader) throw new RouteError('Provider returned an empty response.');
  const parts = []; let length = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    length += value.length;
    if (length > limit) { await reader.cancel(); throw new RouteError('Provider response exceeded the limit.'); }
    parts.push(value);
  }
  const joined = new Uint8Array(length); let offset = 0;
  for (const p of parts) { joined.set(p, offset); offset += p.length; }
  try { return JSON.parse(new TextDecoder().decode(joined)); } catch { throw new RouteError('Provider returned invalid JSON.'); }
}

export async function generate(env, input, { fetcher = fetch, reserveCall = reserve, structured = false } = {}) {
  const messages = validateMessages(input);
  const failures = [];
  const actionFormat = structured ? { type:'json_schema', json_schema:{type:'object',properties:{action:{type:'string',enum:['list_files','read_file','write_file','run_tests','finish']},path:{type:'string'},content:{type:'string'},summary:{type:'string'}},required:['action'],additionalProperties:false} } : undefined;
  // Fixed model and conservative byte/output/call caps. No user-supplied model IDs.
  if (env.AI && await reserveCall(env.DB, 'cloudflare', CF_DAILY_CALLS)) {
    try {
      const result = await env.AI.run(CF_MODEL, { messages, max_tokens: MAX_OUTPUT_TOKENS, temperature: 0.2, ...(actionFormat ? {response_format:actionFormat} : {}) });
      const content=structured && result.response && typeof result.response==='object' && !Array.isArray(result.response) ? JSON.stringify(result.response) : result.response;
      if (typeof content === 'string' && content.trim()) {
        return { content, model: CF_MODEL, provider: 'cloudflare', usage: result.usage || null };
      }
      failures.push('Cloudflare returned no text');
    } catch { failures.push('Cloudflare unavailable'); }
  } else failures.push('Cloudflare daily application allowance exhausted');

  if (env.OPENROUTER_API_KEY) {
    // Revalidate current prices before every request. Missing prices fail closed.
    let catalog;
    try {
      const response = await fetcher('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('catalog');
      catalog = await boundedJson(response);
    } catch { throw new RouteError('Unable to verify free OpenRouter pricing. No request was sent for inference.'); }
    const freeRouter = catalog.data?.find(m => m.id === 'openrouter/free');
    if (!isFreeModel(freeRouter)) throw new RouteError('OpenRouter free-router pricing could not be verified. Paid fallback is disabled.');
    if (!await reserveCall(env.DB, 'openrouter', OPENROUTER_DAILY_CALLS)) {
      throw new RouteError('All application free allowances are exhausted. Try after the daily reset.', 429);
    }
    const response = await fetcher('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(90000),
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'cloud67' },
      body: JSON.stringify({ model: 'openrouter/free', messages, max_tokens: MAX_OUTPUT_TOKENS,
        ...(structured ? {response_format:{type:'json_object'}} : {}),
        provider: { max_price: { prompt: 0, completion: 0 }, ...(structured ? {require_parameters:true} : {}) } }),
    });
    if (!response.ok) throw new RouteError(`Free OpenRouter request unavailable (${response.status}). Paid fallback is disabled.`, response.status === 429 ? 429 : 503);
    const result = await boundedJson(response, 200000);
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new RouteError('Free model returned no text.');
    return { content, model: result.model || 'openrouter/free', provider: 'openrouter', usage: result.usage || null };
  }
  throw new RouteError(`${failures.join('; ')}. Connect an OpenRouter key for free-model fallback, or wait for reset.`, failures.some(f=>f.includes('exhausted')) ? 429 : 503);
}
