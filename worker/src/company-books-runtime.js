import { requireOperator } from './auth.js';
import { createQuickBooksConnectUrl, completeQuickBooksOAuth, disconnectQuickBooks } from './quickbooks-oauth.js';
import { getCompanyBooksStatus, runCompanyBooksSync, updateCompanyBooksSettings } from './company-books-sync.js';

export async function handleCompanyBooksRoute(request, env) {
  const url=new URL(request.url); const path=url.pathname;

  if(path==='/api/accounting/quickbooks/callback' && request.method==='GET'){
    await completeQuickBooksOAuth(env,url);
    await runCompanyBooksSync(env,{force:true}).catch(()=>null);
    const target=new URL('/console/',String(env.ADMIN_BASE_URL||url.origin));
    target.searchParams.set('books','connected');
    return Response.redirect(target.toString(),302);
  }

  if(path==='/api/accounting/quickbooks/connect-url' && request.method==='POST'){
    await requireOperator(request,env);
    return json(await createQuickBooksConnectUrl(env));
  }
  if(path==='/api/accounting/quickbooks/disconnect' && request.method==='POST'){
    await requireOperator(request,env);
    const result=await disconnectQuickBooks(env);
    await runCompanyBooksSync(env).catch(()=>null);
    return json(result);
  }
  if(path==='/api/accounting/status' && request.method==='GET'){
    await requireOperator(request,env);
    return json(await getCompanyBooksStatus(env));
  }
  if(path==='/api/accounting/sync' && request.method==='POST'){
    await requireOperator(request,env);
    return json(await runCompanyBooksSync(env,{force:true}));
  }
  if(path==='/api/accounting/settings' && request.method==='POST'){
    const principal=await requireOperator(request,env);
    return json(await updateCompanyBooksSettings(env,await readJson(request),principal));
  }
  return null;
}

async function readJson(request){try{return await request.json();}catch{const e=new Error('Invalid JSON request body');e.status=400;throw e;}}
function json(value,status=200){return new Response(JSON.stringify(value,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});}
