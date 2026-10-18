import {authenticateClerkSession} from './clerk-auth.js';
import {requireMerchantMembership} from './authorization.js';
function fail(text,status=404){return new Response(text,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});}
export function merchantDashboardSlug(name,id){
 const label=String(name||'merchant').toLowerCase().normalize('NFKD')
  .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-')
  .replace(/^-|-$/g,'').slice(0,45).replace(/-$/,'')||'merchant';
 const suffix=String(id||'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(-15);
 return (label+'-'+suffix).slice(0,75);
}
export async function ensureMerchantDashboardUrl(env,merchantId,merchantName){
 const slug=merchantDashboardSlug(merchantName,merchantId);
 await env.DB.prepare(`INSERT OR IGNORE INTO merchant_dashboard_routes(merchant_id,slug) VALUES(?,?)`)
  .bind(merchantId,slug).run();
 const found=await env.DB.prepare(`SELECT slug FROM merchant_dashboard_routes WHERE merchant_id=?`)
  .bind(merchantId).first();
 if(!found)throw new Error('Merchant dashboard identifier unavailable');
 return '/dashboard/'+found.slug+'/';
}
export async function merchantDashboardUrls(env,merchants){
 const rows=[];
 for(const m of merchants){
  rows.push({...m,dashboard_url:await ensureMerchantDashboardUrl(env,m.id,m.name)});
 }
 return rows;
}
export async function handleVanityMerchantDashboard(request,env){
 const url=new URL(request.url);
 const match=url.pathname.match(/^\/dashboard\/([a-z0-9-]{5,75})\/?$/);
 if(!match)return null;
 if(request.method!=='GET'&&request.method!=='HEAD')return fail('Method not allowed',405);
 const row=await env.DB.prepare(`SELECT merchant_id FROM merchant_dashboard_routes WHERE slug=?`)
  .bind(match[1]).first();
 // Public search engines and unauthenticated users should never learn
 // whether a given business has an account or a working subscription.
 if(!row)return fail('Dashboard not found',404);
 const principal=await authenticateClerkSession(request,env);
 if(!principal?.sub){
  const login=new URL('/login/',url.origin);
  login.searchParams.set('return_to',url.pathname);
  return Response.redirect(login.toString(),302);
 }
 try{await requireMerchantMembership(env,principal,row.merchant_id,'VIEWER');}
 catch{return fail('Dashboard not found',404);}
 if(!env.ASSETS)return fail('Merchant website assets are unavailable',503);
 const assetUrl=new URL('/merchant/',url.origin);
 const assetResponse=await env.ASSETS.fetch(new Request(assetUrl.toString(),{
  method:request.method,headers:request.headers}));
 const headers=new Headers(assetResponse.headers);
 headers.set('cache-control','private, no-store');
 headers.set('x-robots-tag','noindex, nofollow');
 headers.set('referrer-policy','same-origin');
 headers.set('x-content-type-options','nosniff');
 return new Response(request.method==='HEAD'?null:assetResponse.body,{
  status:assetResponse.status,headers});
}
export async function merchantAdoptionMetrics(env){
 const row=await env.DB.prepare(`
 WITH eligible AS (
   SELECT m.id FROM merchants m
   WHERE EXISTS(SELECT 1 FROM transactions t WHERE t.merchant_id=m.id)
      OR EXISTS(SELECT 1 FROM merchant_processor_connections c WHERE c.merchant_id=m.id)
      OR m.processor_account_id IS NOT NULL
 ), marked AS (
   SELECT e.id,
     EXISTS(SELECT 1 FROM merchant_access a
       WHERE a.merchant_id=e.id AND a.status='ACTIVE') AS has_profile,
     EXISTS(SELECT 1 FROM merchant_access a
       WHERE a.merchant_id=e.id AND a.status='ACTIVE' AND a.role='OWNER') AS has_owner
   FROM eligible e
 )
 SELECT COUNT(*) AS eligible_merchants,
  COALESCE(SUM(has_profile),0) AS merchants_with_profiles,
  COALESCE(SUM(has_owner),0) AS merchants_with_owner_profiles,
  COALESCE(SUM(CASE WHEN has_profile=0 THEN 1 ELSE 0 END),0) AS merchants_without_profiles
 FROM marked`).first();
 const links=await env.DB.prepare(`
  SELECT COUNT(DISTINCT merchant_id) AS emailed_merchants,
   COUNT(*) AS issued_transaction_links,
   COALESCE(SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END),0) AS opened_transaction_links,
   COALESCE(SUM(open_count),0) AS total_link_views,
   COALESCE(SUM(CASE WHEN claimed_at IS NOT NULL THEN 1 ELSE 0 END),0) AS claimed_links
  FROM merchant_transaction_email_links WHERE email_state='SENT'`).first();
 const pdfs=await env.DB.prepare(`
  SELECT COUNT(*) AS refund_pdf_downloads,COUNT(DISTINCT merchant_id) AS merchants_downloading_refunds
  FROM merchant_pdf_access_events WHERE event_type='REFUND_PDF'`).first();
 const total=Number(row?.eligible_merchants||0),profile=Number(row?.merchants_with_profiles||0);
 return {scope:'Merchants with a recorded transaction or connected processor; excludes unused test-only merchant shells',
  ...row,...links,...pdfs,
  profile_adoption_percent:total?Math.round(profile/total*10000)/100:0,
  accountless_percent:total?Math.round((total-profile)/total*10000)/100:0,
  generated_at:new Date().toISOString()};
}
