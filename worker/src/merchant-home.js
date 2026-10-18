import {authenticateClerkSession} from './clerk-auth.js';
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,
 headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
export async function handleMerchantHomeRoute(request,env){
 const url=new URL(request.url);
 if(url.pathname!=='/api/merchant/home')return null;
 if(request.method!=='GET')return json({error:'Method not allowed'},405);
 const principal=await authenticateClerkSession(request,env);
 if(!principal?.sub||principal.claims?.act)
  return json({error:'Merchant sign-in required'},401);
 const result=await env.DB.prepare(`
 SELECT m.id,m.name,m.status AS merchant_status,a.role,
  (SELECT COUNT(*) FROM transactions t WHERE t.merchant_id=m.id) AS total_transactions,
  (SELECT COUNT(*) FROM transactions t WHERE t.merchant_id=m.id
     AND t.integrity_status='NEEDS_ATTENTION') AS attention_transactions,
  (SELECT COUNT(*) FROM merchant_custom_field_definitions d
     WHERE d.merchant_id=m.id AND d.active=1) AS custom_fields,
  (SELECT COUNT(*) FROM merchant_custom_sync_sources s
     WHERE s.merchant_id=m.id AND s.status='ACTIVE') AS data_sources
 FROM merchant_access a JOIN merchants m ON m.id=a.merchant_id
 WHERE a.external_user_id=? AND a.status='ACTIVE'
 ORDER BY m.name ASC LIMIT 50
 `).bind(principal.sub).all();
 return json({merchants:result.results||[],
  next_steps:'/merchant/setup/',
  portal_actions:[
    {title:'Transaction integrity',url:'/merchant/transactions/'},
    {title:'Customers & custom fields',url:'/merchant/integrations/'},
    {title:'Complete integrations',url:'/merchant/setup/'},
    {title:'Help & requests',url:'/merchant/help/'}
  ]});
}
