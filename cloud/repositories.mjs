import { RouteError } from './free-router.mjs';

const accountPattern=/^[a-z\d](?:[a-z\d-]{0,38})$/i;
export function publicCatalog(input) {
  if(!Array.isArray(input.accounts)||!input.accounts.length||input.accounts.length>10||input.accounts.some(a=>typeof a!=='string'||!accountPattern.test(a)))throw new RouteError('Invalid repository accounts.',400);
  if(!Array.isArray(input.repositories)||input.repositories.length>1000)throw new RouteError('Invalid repository catalog.',400);
  const accounts=[...new Set(input.accounts.map(a=>a.toLowerCase()))],seen=new Set();
  const repositories=input.repositories.map(r=>{
    if(!r||r.private!==false||typeof r.full_name!=='string'||!new RegExp('^[a-z\\d-]+/[a-z\\d_.-]{1,100}$','i').test(r.full_name)||!accounts.includes(r.full_name.split('/')[0].toLowerCase())||['.','..'].includes(r.full_name.split('/')[1]))throw new RouteError('Only public repositories from catalog accounts are allowed.',400);
    const key=r.full_name.toLowerCase();if(seen.has(key))throw new RouteError('Duplicate repository.',400);seen.add(key);
    return {full_name:r.full_name,description:String(r.description||'').slice(0,250),language:String(r.language||'').slice(0,60),fork:r.fork===true,archived:r.archived===true,updated_at:String(r.updated_at||'').slice(0,40)};
  });
  return {accounts:input.accounts.filter((a,i)=>input.accounts.findIndex(b=>a.toLowerCase()===b.toLowerCase())===i),repositories};
}

export async function repositoryRoutes(request,env,{query,body}) {
  const path=new URL(request.url).pathname;
  if(!['/api/repositories','/internal/repositories/status','/internal/repositories/sync'].includes(path))return null;
  const q=(sql,...params)=>query(env,sql,...params);
  if(path==='/internal/repositories/sync'&&request.method==='POST') {
    const catalog=publicCatalog(await body(request,650000));
    if(!catalog.accounts.some(a=>a.toLowerCase()===env.REPOSITORY.split('/')[0].toLowerCase()))throw new RouteError('Catalog must include the workspace account.',400);
    const updated_at=Math.floor(Date.now()/1000);
    await q("INSERT INTO repository_catalog(id,payload,updated_at) VALUES ('public',?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",JSON.stringify(catalog),updated_at).run();
    return Response.json({ok:true,count:catalog.repositories.length,updated_at},{headers:{'Cache-Control':'no-store'}});
  }
  if((path==='/api/repositories'&&request.method==='GET')||(path==='/internal/repositories/status'&&request.method==='POST')) {
    const row=await q("SELECT payload,updated_at FROM repository_catalog WHERE id='public'").first();
    const value=path.startsWith('/internal/')?{updated_at:row?.updated_at||0}:{...(row?JSON.parse(row.payload):{accounts:[env.REPOSITORY.split('/')[0]],repositories:[]}),updated_at:row?.updated_at||null,public_only:true};
    return Response.json(value,{headers:{'Cache-Control':'no-store'}});
  }
  throw new RouteError('Method not allowed.',405);
}
