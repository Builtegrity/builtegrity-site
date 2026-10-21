import core from './index.js';
import { authProvider, handleAuthRoute, requireOperator } from './auth.js';
import {
  buildStripeOAuthUrl,
  deauthorizeStripeAccount,
  exchangeStripeOAuthCode,
} from './stripe-oauth.js';
import { verifyStripeSignature } from './stripe.js';
import { verifySquareWebhook,processSquareWebhook } from './square.js';
import {
  SQUARE_SCOPES,squareAuthorizeUrl,squareTokenExchange,squareAuthorizeLocation,
  saveSquareConnection,squareBase,squareApi,squareAccessToken,squareConnection
} from './square-oauth.js';
import { processStripeWebhook } from './webhooks.js';
import { runSquarePayoutRecovery } from './square-reconciliation.js';
import { runBankSyncRecovery } from './bank-evidence.js';
import { runMerchantSetupNotifications } from './merchant-setup-autopilot.js';
import {handleVanityMerchantDashboard,merchantAdoptionMetrics} from './merchant-dashboard-adoption.js';
import { deliverMerchantHelpRequests } from './merchant-help.js';
import {dispatchMerchantRecordEmails} from './merchant-record-links.js';
import {dispatchCustomerTransactionEmails,enqueueEligibleCustomerTransactions,enqueueEligibleCustomerRefunds} from './customer-delivery.js';
import { normalizeProviderEvent, recordProviderReceipt, recordProviderResult, webhookTimingSummary } from './processor-event-delivery.js';
import { verifyIntegritySnapshotBatch } from './integrity-verifier.js';
import { processStripeAccountWebhook } from './stripe-account-events.js';
import { projectStripeEventToTransactionIntelligence } from './stripe-intelligence.js';
import { getWatchdogStatus, runWatchdogs, systemReadiness } from './watchdogs.js';
import { handlePublicRecordRoute, serveOperatorTransactionPdf } from './records.js';
import {
  executeInternalCaseAction,
  getInternalCase,
  getInternalOperationsMetrics,
  listInternalCases,
  verifyInternalCase,
} from './cases.js';
import { syncInternalCasesFromWatchdogs } from './case-router.js';
import {
  confirmComponentRule,
  getMerchantTransactionProfile,
  getTransactionGraph,
  linkTransactionArtifact,
  observeTransactionComponent,
  recordTransactionSourceObject,
  registerMerchantTransactionSource,
  updateMerchantTransactionPreferences,
} from './transaction-intelligence.js';
import {
  getFinancialSafetyStatus,
  recordFinancialModelReview,
  recordFinancialPosition,
} from './financial-safety.js';
import { monitorFinancialSafety, syncFinancialSafetyAlerts } from './financial-safety-monitor.js';
import {
  getMonthlyStatementStatus,
  loadMonthlyStatementPdf,
  runMonthlyStatementPipeline,
} from './monthly-statements.js';
import { getMerchantTaxProfile, updateMerchantTaxProfile } from './merchant-tax.js';
import { getTaxDocumentStatus, runTaxDocumentPipeline } from './tax-document-pipeline.js';
import { getBuiltegrityTaxComplianceStatus, updateBuiltegrityTaxProfile } from './company-tax-profile.js';
import {
  generateBuiltegrityTaxWorkpaper,
  runBuiltegrityTaxWorkpaperPipeline,
} from './company-tax-workpapers.js';

const FINANCIAL_DECISION_MAX_AGE_MINUTES = 30;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // Customer transaction records use unguessable Builtegrity-owned tokens.
      // They deliberately do not depend on Clerk users or Clerk Organizations.
      const publicRecordResponse = await handlePublicRecordRoute(request, env, ctx);
      if (publicRecordResponse) return publicRecordResponse;

      if (isAdminSurface(path) && !isAdminHost(url, env)) {
        return new Response('Not found', { status: 404 });
      }

      if (isAdminSurface(path) && isStateChanging(request.method)) {
        requireSameOriginBrowserRequest(request, url);
      }

      if (path === '/api/health/ready' && request.method === 'GET') {
        const readiness = await systemReadiness(env);
        return json({
          ok: readiness.ok,
          service: 'builtegrity-transaction-engine',
          stage: readiness.stage,
          database: readiness.database,
          config_complete: readiness.config_complete,
          missing_config_count: readiness.missing_config_count,
          last_watchdog: readiness.last_watchdog,
        }, readiness.ok ? 200 : 503);
      }

      const vanityResponse=await handleVanityMerchantDashboard(request,env);
      if(vanityResponse)return vanityResponse;
      if(path==='/api/operations/merchant-profile-adoption'&&request.method==='GET'){
        await requireOperator(request,env);
        return json(await merchantAdoptionMetrics(env));
      }

      // Production webhook entrypoint. Account-level events are routed to merchant self-service;
      // transaction events continue through the transaction engine's idempotent processor.
      if (path === '/api/webhooks/stripe' && request.method === 'POST') {
        return handleRuntimeStripeWebhook(request, env);
      }
      if (path === '/api/webhooks/square' && request.method === 'POST') {
        return handleRuntimeSquareWebhook(request,env);
      }

      const authResponse = await handleAuthRoute(request, env);
      if (authResponse) return authResponse;

      if (path === '/api/stripe/oauth/callback' && request.method === 'GET') {
        return handleOAuthCallback(url, env);
      }
      if (path === '/api/square/oauth/callback' && request.method === 'GET') {
        return handleSquareOAuthCallback(url,env);
      }

      const connectMatch = path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/stripe\/connect-url$/);
      if (connectMatch && request.method === 'POST') {
        await requireOperator(request, env);
        return handleConnectUrl(env, connectMatch[1]);
      }

      const disconnectMatch = path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/stripe\/disconnect$/);
      if (disconnectMatch && request.method === 'POST') {
        await requireOperator(request, env);
        return handleDisconnect(env, disconnectMatch[1]);
      }

      const squareConnect = path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/square\/connect-url$/);
      if(squareConnect&&request.method==='POST'){
        await requireOperator(request,env);
        return handleSquareConnectUrl(env,squareConnect[1]);
      }
      const squareVerify = path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/square\/verify$/);
      if(squareVerify&&request.method==='POST'){
        await requireOperator(request,env);
        return handleSquareVerify(env,squareVerify[1]);
      }
      const squareDisconnect = path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/square\/disconnect$/);
      if(squareDisconnect&&request.method==='POST'){
        await requireOperator(request,env);
        return handleSquareDisconnect(env,squareDisconnect[1]);
      }
      const emailConsent=path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/record-email-consent$/);
      if(emailConsent&&request.method==='POST'){
        await requireOperator(request,env);
        const origin=request.headers.get('origin');
        if(origin&&origin!==url.origin)return json({error:'Cross-origin action denied'},403);
        const data=await readJson(request);
        if(typeof data.opt_in!=='boolean')return json({error:'Explicit opt_in boolean required'},400);
        const evidence=String(data.consent_reference||'').trim();
        if(data.opt_in&&(evidence.length<8||evidence.length>180))
          return json({error:'Verified onboarding consent evidence reference required'},400);
        const merchant=await env.DB.prepare('SELECT id,email FROM merchants WHERE id=?')
          .bind(emailConsent[1]).first();
        if(!merchant)return json({error:'Merchant not found'},404);
        if(data.opt_in&&!/^\S+@\S+\.\S+$/.test(String(merchant.email||'')))
          return json({error:'Merchant needs verified onboarding email before enabling invitation delivery'},409);
        await env.DB.prepare(`UPDATE merchants SET
          record_email_opt_in=?,record_email_consent_reference=?,
          record_email_consent_at=CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE NULL END
          WHERE id=?`).bind(data.opt_in?1:0,data.opt_in?evidence:null,
             data.opt_in?1:0,merchant.id).run();
        if(!data.opt_in){
          await env.DB.prepare(`UPDATE merchant_transaction_email_links
             SET revoked_at=CURRENT_TIMESTAMP,email_state='DISABLED'
             WHERE merchant_id=? AND revoked_at IS NULL`).bind(merchant.id).run();
        }
        return json({merchant_id:merchant.id,opt_in:data.opt_in,
          emails_active:env.MERCHANT_TRANSACTION_EMAILS_ENABLED==='true'});
      }

      const processorConnections=path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/processors$/);
      if(processorConnections&&request.method==='GET'){
        await requireOperator(request,env);
        const merchant=await env.DB.prepare('SELECT id,processor_account_id FROM merchants WHERE id=?').bind(processorConnections[1]).first();
        if(!merchant)return json({error:'Merchant not found'},404);
        const rows=await env.DB.prepare(`SELECT processor,external_account_id,location_id,status,scopes,
          access_expires_at,updated_at FROM merchant_processor_connections WHERE merchant_id=?`).bind(merchant.id).all();
        return json({merchant_id:merchant.id,processors:rows.results||[],
          legacy_stripe_connected:Boolean(merchant.processor_account_id)});
      }

      const merchantProfileMatch = path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/transaction-profile$/);
      if (merchantProfileMatch && request.method === 'GET') {
        await requireOperator(request, env);
        return json(await getMerchantTransactionProfile(env, merchantProfileMatch[1]));
      }

      const merchantPreferencesMatch = path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/transaction-profile\/preferences$/);
      if (merchantPreferencesMatch && request.method === 'POST') {
        await requireOperator(request, env);
        return json(await updateMerchantTransactionPreferences(env, merchantPreferencesMatch[1], await readJson(request)));
      }

      const merchantRuleMatch = path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/transaction-profile\/rules\/(RULE-[A-Za-z0-9-]+)\/confirm$/);
      if (merchantRuleMatch && request.method === 'POST') {
        await requireOperator(request, env);
        const body = await readJson(request);
        if (!body.component_type_code) return json({ error: 'component_type_code is required' }, 400);
        return json(await confirmComponentRule(env, merchantRuleMatch[1], merchantRuleMatch[2], body.component_type_code));
      }

      const merchantTaxMatch = path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/tax-profile$/);
      if (merchantTaxMatch && request.method === 'GET') {
        await requireOperator(request, env);
        return json(await getMerchantTaxProfile(env, merchantTaxMatch[1]));
      }
      if (merchantTaxMatch && request.method === 'POST') {
        await requireOperator(request, env);
        return json(await updateMerchantTaxProfile(env, merchantTaxMatch[1], await readJson(request)));
      }

      const graphMatch = path.match(/^\/api\/transactions\/(TX-[A-Za-z0-9-]+)\/graph$/);
      if (graphMatch && request.method === 'GET') {
        await requireOperator(request, env);
        return json(await getTransactionGraph(env, graphMatch[1]));
      }

      const componentMatch = path.match(/^\/api\/transactions\/(TX-[A-Za-z0-9-]+)\/components$/);
      if (componentMatch && request.method === 'POST') {
        await requireOperator(request, env);
        const body = await readJson(request);
        return json(await observeTransactionComponent(env, { ...body, transaction_id: componentMatch[1] }), 201);
      }

      const artifactMatch = path.match(/^\/api\/transactions\/(TX-[A-Za-z0-9-]+)\/artifacts$/);
      if (artifactMatch && request.method === 'POST') {
        await requireOperator(request, env);
        const body = await readJson(request);
        return json(await linkTransactionArtifact(env, { ...body, transaction_id: artifactMatch[1] }), 201);
      }

      const sourceObjectMatch = path.match(/^\/api\/transactions\/(TX-[A-Za-z0-9-]+)\/source-objects$/);
      if (sourceObjectMatch && request.method === 'POST') {
        await requireOperator(request, env);
        const body = await readJson(request);
        return json(await recordTransactionSourceObject(env, { ...body, transaction_id: sourceObjectMatch[1] }), 201);
      }

      const operatorPdfMatch = path.match(/^\/api\/transactions\/(TX-[A-Za-z0-9-]+)\/pdf$/);
      if (operatorPdfMatch && request.method === 'GET') {
        const principal = await requireOperator(request, env);
        return serveOperatorTransactionPdf(env, operatorPdfMatch[1], principal, { view: url.searchParams.get('view') === '1' });
      }

      if (path === '/api/statements' && request.method === 'GET') {
        await requireOperator(request, env);
        return json(await getMonthlyStatementStatus(env, { limit: url.searchParams.get('limit') }));
      }

      if (path === '/api/statements/reconcile' && request.method === 'POST') {
        await requireOperator(request, env);
        requireSameOriginBrowserRequest(request, url);
        return json(await runMonthlyStatementPipeline(env));
      }

      const statementPdfMatch = path.match(/^\/api\/statements\/(STM-[A-Za-z0-9-]+)\/pdf$/);
      if (statementPdfMatch && request.method === 'GET') {
        await requireOperator(request, env);
        const result = await loadMonthlyStatementPdf(env, statementPdfMatch[1]);
        if (!result) return json({ error: 'Monthly statement not found or not generated' }, 404);
        return new Response(result.bytes, {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': `attachment; filename="${result.statement.id}.pdf"`,
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
          },
        });
      }

      if (path === '/api/tax/documents' && request.method === 'GET') {
        await requireOperator(request, env);
        return json(await getTaxDocumentStatus(env, { limit: url.searchParams.get('limit') }));
      }
      if (path === '/api/tax/documents/reconcile' && request.method === 'POST') {
        await requireOperator(request, env);
        return json(await runTaxDocumentPipeline(env));
      }
      if (path === '/api/tax/company/status' && request.method === 'GET') {
        await requireOperator(request, env);
        return json(await getBuiltegrityTaxComplianceStatus(env, { taxYear: url.searchParams.get('tax_year') }));
      }
      if (path === '/api/tax/company/profile' && request.method === 'POST') {
        const principal = await requireOperator(request, env);
        return json(await updateBuiltegrityTaxProfile(env, await readJson(request), principal));
      }
      if (path === '/api/tax/company/workpapers/reconcile' && request.method === 'POST') {
        await requireOperator(request, env);
        return json(await runBuiltegrityTaxWorkpaperPipeline(env));
      }
      if (path === '/api/tax/company/workpapers/generate' && request.method === 'POST') {
        await requireOperator(request, env);
        return json(await generateBuiltegrityTaxWorkpaper(env, await readJson(request)), 201);
      }

      if (path === '/api/cases/metrics' && request.method === 'GET') {
        await requireOperator(request, env);
        return json(await getInternalOperationsMetrics(env));
      }

      if (path === '/api/cases' && request.method === 'GET') {
        await requireOperator(request, env);
        return json({
          cases: await listInternalCases(env, {
            status: url.searchParams.get('status'),
            limit: url.searchParams.get('limit'),
          }),
        });
      }

      const caseMatch = path.match(/^\/api\/cases\/(CASE-[A-Za-z0-9-]+)$/);
      if (caseMatch && request.method === 'GET') {
        await requireOperator(request, env);
        const item = await getInternalCase(env, caseMatch[1]);
        return item ? json(item) : json({ error: 'Internal case not found' }, 404);
      }

      const caseActionMatch = path.match(/^\/api\/cases\/(CASE-[A-Za-z0-9-]+)\/actions\/([A-Z0-9_]+)$/);
      if (caseActionMatch && request.method === 'POST') {
        const principal = await requireOperator(request, env);
        const body = await readJson(request);
        const executed = await executeInternalCaseAction(env, caseActionMatch[1], caseActionMatch[2], principal, body);

        // Every operator action is verified by the machine; humans never decide that a technical alert is cleared.
        const financial = await monitorFinancialSafety(env, { refreshProcessorBalance: true });
        const watchdog = await runWatchdogs(env, { kind: 'FAST', trigger: `case:${caseActionMatch[1]}:${caseActionMatch[2]}` });
        const routing = await syncInternalCasesFromWatchdogs(env);
        const verified = await verifyInternalCase(env, caseActionMatch[1]);
        return json({ executed, financial_safety: financial, watchdog, routing, case: verified });
      }

      if (path === '/api/finance/status' && request.method === 'GET') {
        await requireOperator(request, env);
        return json(await getFinancialSafetyStatus(env));
      }

      if (path === '/api/finance/snapshot' && request.method === 'POST') {
        const principal = await requireOperator(request, env);
        const result = await recordFinancialPosition(env, await readJson(request), principal);
        await syncFinancialSafetyAlerts(env, result.safety);
        return json(result, 201);
      }

      if (path === '/api/finance/model-review' && request.method === 'POST') {
        const principal = await requireOperator(request, env);
        const result = await recordFinancialModelReview(env, await readJson(request), principal);
        await syncFinancialSafetyAlerts(env, result.safety);
        return json(result, 201);
      }

      if (path === '/api/finance/evaluate' && request.method === 'POST') {
        await requireOperator(request, env);
        return json(await monitorFinancialSafety(env, { refreshProcessorBalance: true }));
      }

      if (path === '/api/watchdogs/provider-timing' && request.method === 'GET') {
        await requireOperator(request,env);
        return json(await webhookTimingSummary(env));
      }

      if (path === '/api/watchdogs/status' && request.method === 'GET') {
        await requireOperator(request, env);
        return json(await getWatchdogStatus(env));
      }

      if (path === '/api/watchdogs/run' && request.method === 'POST') {
        await requireOperator(request, env);
        requireSameOriginBrowserRequest(request, url);
        const financial = await monitorFinancialSafety(env, { refreshProcessorBalance: true });
        const statements = await runMonthlyStatementPipeline(env);
        const taxDocuments = await runTaxDocumentPipeline(env);
        const taxWorkpapers = await runBuiltegrityTaxWorkpaperPipeline(env);
        const watchdog = await runWatchdogs(env, { kind: 'MANUAL', trigger: 'operator' });
        const routing = await syncInternalCasesFromWatchdogs(env);
        return json({ ...watchdog, financial_safety: financial, monthly_statements: statements, tax_documents: taxDocuments, tax_workpapers: taxWorkpapers, case_routing: routing });
      }

      if (path.startsWith('/console')) {
        const principal = await requireOperatorOrRedirect(request, env, url);
        if (principal instanceof Response) return principal;
        return env.ASSETS.fetch(request);
      }

      // Catastrophic and financial controls are enforced before requests enter the core engine.
      if (path === '/api/transactions' && request.method === 'POST') {
        await requireOperator(request, env);
        await requirePlatformControl(env, 'transaction_creation_enabled', 'New transaction creation');
        return forwardAuthenticatedToCore(request, env, ctx);
      }

      const publicCheckoutMatch = path.match(/^\/api\/payments\/[^/]+\/checkout$/);
      if (publicCheckoutMatch && request.method === 'POST') {
        await requirePlatformControl(env, 'payment_creation_enabled', 'New payment creation');
        return core.fetch(request, env, ctx);
      }

      if (isInternalApi(path)) {
        await requireOperator(request, env);
        return forwardAuthenticatedToCore(request, env, ctx);
      }

      return core.fetch(request, env, ctx);
    } catch (error) {
      console.error(error);
      return json({ error: error.message || 'Internal error' }, error.status || 500);
    }
  },

  async scheduled(controller, env) {
    // Fast truth verification does not trigger costly processor/accounting/report pipelines.
    if(controller.cron==='*/2 * * * *'){
      const verification=await verifyIntegritySnapshotBatch(env);
      console.log('Builtegrity 2-minute integrity verification',verification);
      if(verification.failed>0)throw new Error('Integrity verification encountered errors');
      return;
    }
    // Independent 10-minute watchdog (plus daily deep checks) monitors verification lag.
    const kind = controller.cron === '17 13 * * *' ? 'DEEP' : 'FAST';
    const squareRecovery = kind === 'DEEP' ? await runSquarePayoutRecovery(env) : null;
    const bankRecovery = await runBankSyncRecovery(env);
    const merchantSetup = await runMerchantSetupNotifications(env);
    const merchantHelp = await deliverMerchantHelpRequests(env);
    const merchantRecordEmail=await dispatchMerchantRecordEmails(env);
    const financial = await monitorFinancialSafety(env, { refreshProcessorBalance: true });
    const statements = await runMonthlyStatementPipeline(env);
    const taxDocuments = await runTaxDocumentPipeline(env);
    const taxWorkpapers = await runBuiltegrityTaxWorkpaperPipeline(env);
    const result = await runWatchdogs(env, { kind, trigger: controller.cron || 'cron' });
    const routing = await syncInternalCasesFromWatchdogs(env);
    console.log('Builtegrity watchdog run', {
      ...result,
      financial_safety: financial,
      monthly_statements: statements,
      tax_documents: taxDocuments,
      tax_workpapers: taxWorkpapers,
      case_routing: routing,
      square_payout_recovery: squareRecovery,
      bank_payout_recovery: bankRecovery,
      merchant_self_service_notifications:merchantSetup,
      merchant_record_email:merchantRecordEmail,
      merchant_help_mail:merchantHelp,
    });
    if(squareRecovery?.errors>0 && ['PILOT','LIVE'].includes(String(env.WATCHDOG_STAGE||'').toUpperCase())) throw new Error('Square payout reconciliation errors require review');
    if (result.status === 'FAIL' || financial.state === 'RED' || statements.generated.failed > 0 || statements.delivered.failed > 0 || taxDocuments.delivered.failed > 0) {
      throw new Error(`Builtegrity safety monitor failed: watchdog_critical=${result.critical}, financial_state=${financial.state}, statement_generation_failures=${statements.generated.failed}, statement_delivery_failures=${statements.delivered.failed}, tax_document_delivery_failures=${taxDocuments.delivered.failed}`);
    }
  },
};

function isInternalApi(path) {
  if (!path.startsWith('/api/')) return false;
  if (path.startsWith('/api/health')) return false;
  if (path === '/api/webhooks/stripe' || path === '/api/webhooks/square') return false;
  if (path.startsWith('/api/payments/')) return false;
  if (path.startsWith('/api/records/')) return false;
  if (path === '/api/stripe/oauth/callback' || path === '/api/square/oauth/callback') return false;
  return true;
}

function isAdminSurface(path) {
  return path.startsWith('/console') ||
    path.startsWith('/auth/') ||
    isInternalApi(path);
}

function isAdminHost(url, env) {
  const configured = String(env.ADMIN_HOSTNAME || '').trim().toLowerCase();
  if (!configured) return env.DEV_MODE === 'true';
  return url.hostname.toLowerCase() === configured;
}

function isStateChanging(method) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(method || '').toUpperCase());
}

function requireSameOriginBrowserRequest(request, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) {
    const error = new Error('Cross-origin admin request rejected');
    error.status = 403;
    throw error;
  }

  const fetchSite = String(request.headers.get('Sec-Fetch-Site') || '').toLowerCase();
  if (fetchSite === 'cross-site') {
    const error = new Error('Cross-site admin request rejected');
    error.status = 403;
    throw error;
  }
}

async function forwardAuthenticatedToCore(request, env, ctx) {
  const bridgeToken = randomToken();
  const headers = new Headers(request.headers);
  headers.set('X-Builtegrity-Admin', bridgeToken);
  const forwarded = new Request(request, { headers });
  const internalEnv = { ...env, INTERNAL_ADMIN_TOKEN: bridgeToken };
  return core.fetch(forwarded, internalEnv, ctx);
}

async function requireOperatorOrRedirect(request, env, url) {
  try {
    return await requireOperator(request, env);
  } catch (error) {
    if (error.status !== 401) throw error;
    if (authProvider(env) === 'CLOUDFLARE_ACCESS') {
      return new Response('Cloudflare Access authentication required', { status: 403 });
    }
    const login = new URL('/login/', url.origin);
    login.searchParams.set('return_to', `${url.pathname}${url.search}`);
    return Response.redirect(login.toString(), 302);
  }
}

async function handleRuntimeStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'Stripe webhook secret is not configured' }, 503);
  const receivedAt=new Date().toISOString();
  const rawBody=await request.text();
  const valid=await verifyStripeSignature(rawBody,request.headers.get('Stripe-Signature'),env.STRIPE_WEBHOOK_SECRET);
  if(!valid)return json({error:'Invalid Stripe signature'},400);
  let event;
  try{event=JSON.parse(rawBody)}catch{return json({error:'Invalid JSON'},400)}
  const receipt=normalizeProviderEvent('STRIPE',event,receivedAt);
  await recordProviderReceipt(env,receipt).catch(e=>console.error('Stripe timing audit unavailable',e.message));
  try{
    const accountEvent=event.type==='account.updated'||event.type==='account.application.deauthorized';
    if(accountEvent){
      const result=await processStripeAccountWebhook(env,event);
      await recordProviderResult(env,receipt).catch(e=>console.error('Stripe timing completion audit unavailable',e.message));
      return json({received:true,...result});
    }
    const result=await processStripeWebhook(env,event);
    const intelligence=await projectStripeEventToTransactionIntelligence(env,event);
    await recordProviderResult(env,receipt).catch(e=>console.error('Stripe timing completion audit unavailable',e.message));
    return json({received:true,...result,transaction_intelligence:intelligence});
  }catch(e){
    await recordProviderResult(env,receipt,e).catch(x=>console.error('Stripe timing failure audit unavailable',x.message));
    throw e;
  }
}

async function handleRuntimeSquareWebhook(request,env) {
  if(!env.SQUARE_WEBHOOK_SIGNATURE_KEY||!env.SQUARE_WEBHOOK_NOTIFICATION_URL)
    return json({error:'Square webhook configuration is incomplete'},503);
  const receivedAt=new Date().toISOString();
  const raw=await request.text();
  if(raw.length>1024*1024)return json({error:'Square webhook body too large'},413);
  const ok=await verifySquareWebhook(raw,request.headers.get('x-square-hmacsha256-signature'),
    env.SQUARE_WEBHOOK_SIGNATURE_KEY,env.SQUARE_WEBHOOK_NOTIFICATION_URL);
  if(!ok)return json({error:'Invalid Square webhook signature'},403);
  let event;
  try{event=JSON.parse(raw)}catch{return json({error:'Invalid Square webhook JSON'},400)}
  const receipt=normalizeProviderEvent('SQUARE',event,receivedAt);
  await recordProviderReceipt(env,receipt).catch(e=>console.error('Square timing audit unavailable',e.message));
  try{
    const result=await processSquareWebhook(env,event);
    await recordProviderResult(env,receipt).catch(e=>console.error('Square timing completion audit unavailable',e.message));
    return json({received:true,...result});
  }catch(e){
    await recordProviderResult(env,receipt,e).catch(x=>console.error('Square timing failure audit unavailable',x.message));
    throw e;
  }
}
async function handleSquareConnectUrl(env,merchantId) {
  await requirePlatformControl(env,'merchant_onboarding_enabled','Merchant onboarding');
  const merchant=await env.DB.prepare('SELECT id FROM merchants WHERE id=?').bind(merchantId).first();
  if(!merchant)return json({error:'Merchant not found'},404);
  const state=randomToken();
  const expires=new Date(Date.now()+10*60000).toISOString();
  await env.DB.prepare('INSERT INTO square_oauth_states(state_token,merchant_id,expires_at) VALUES(?,?,?)')
    .bind(state,merchantId,expires).run();
  return json({merchant_id:merchantId,authorize_url:squareAuthorizeUrl(env,state),expires_at:expires});
}
async function handleSquareOAuthCallback(url,env) {
  const state=url.searchParams.get('state');
  if(!state)return new Response('Missing Square authorization state',{status:400});
  const row=await env.DB.prepare('SELECT * FROM square_oauth_states WHERE state_token=? AND consumed_at IS NULL').bind(state).first();
  if(!row||Date.parse(row.expires_at)<=Date.now())return new Response('Square authorization expired or already used',{status:400});
  const consumed=await env.DB.prepare('UPDATE square_oauth_states SET consumed_at=CURRENT_TIMESTAMP WHERE state_token=? AND consumed_at IS NULL')
    .bind(state).run();
  if(Number(consumed.meta?.changes||0)!==1)return new Response('Square authorization was already used',{status:400});
  const denied=url.searchParams.get('error');
  if(denied)return redirectToConsole(env,{square:'denied',merchant:row.merchant_id});
  const code=url.searchParams.get('code');
  if(!code)return new Response('Missing Square authorization code',{status:400});
  await requirePlatformControl(env,'merchant_onboarding_enabled','Merchant onboarding');
  const grant=await squareTokenExchange(env,'authorization_code',code);
  const locationId=await squareAuthorizeLocation(env,grant.access_token);
  await saveSquareConnection(env,row.merchant_id,grant,locationId);
  await registerMerchantTransactionSource(env,row.merchant_id,{
    source_system:'SQUARE',source_type:'PROCESSOR',external_account_id:grant.merchant_id,
    capabilities:{payments:true,application_fees:true,refunds:true,payouts:true}
  });
  return redirectToConsole(env,{square:'connected',merchant:row.merchant_id,status:'TEST'});
}
async function handleSquareVerify(env,merchantId) {
  const connection=await squareConnection(env,merchantId);
  const {token}=await squareAccessToken(env,merchantId);
  const response=await fetch(squareBase(env)+'/oauth2/token/status',{
    method:'POST',headers:{Authorization:'Bearer '+token,'Square-Version':'2026-09-16','Content-Type':'application/json'}
  });
  const info=await response.json().catch(()=>({}));
  if(!response.ok||info.merchant_id!==connection.external_account_id)
    return json({compatible:false,reason:'Square token is invalid or belongs to another merchant'},409);
  const missing=SQUARE_SCOPES.filter(scope=>!(info.scopes||[]).includes(scope));
  if(missing.length)return json({compatible:false,missing_scopes:missing},409);
  const locations=await squareApi(env,merchantId,'/v2/locations');
  const location=(locations.locations||[]).find(loc=>loc.id===connection.location_id&&loc.status==='ACTIVE'&&loc.country==='US'&&loc.currency==='USD');
  if(!location)return json({compatible:false,reason:'Square US/USD location is no longer eligible'},409);
  await env.DB.prepare(`UPDATE merchant_processor_connections SET status='ACTIVE',
    scopes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind((info.scopes||[]).join(' '),connection.id).run();
  return json({compatible:true,processor:'SQUARE',status:'ACTIVE',location_id:connection.location_id});
}
async function handleSquareDisconnect(env,merchantId) {
  let connection;
  try{connection=await squareConnection(env,merchantId)}
  catch{return json({disconnected:true,already_disconnected:true})}
  const response=await fetch(squareBase(env)+'/oauth2/revoke',{
    method:'POST',headers:{Authorization:'Client '+env.SQUARE_APP_SECRET,
      'Square-Version':'2026-09-16','Content-Type':'application/json'},
    body:JSON.stringify({client_id:env.SQUARE_APP_ID,merchant_id:connection.external_account_id})
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok||result.success!==true)
    return json({error:'Square authorization could not be revoked; connection remains active'},502);
  await env.DB.prepare(`UPDATE merchant_processor_connections SET status='DISCONNECTED',
    encrypted_access_token=NULL,encrypted_refresh_token=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(connection.id).run();
  await env.DB.prepare(`UPDATE merchant_transaction_sources SET status='DISCONNECTED',last_seen_at=CURRENT_TIMESTAMP
     WHERE merchant_id=? AND source_system='SQUARE' AND external_account_id=?`)
    .bind(merchantId,connection.external_account_id).run().catch(()=>null);
  return json({disconnected:true,processor:'SQUARE'});
}

async function handleConnectUrl(env, merchantId) {
  await requirePlatformControl(env, 'merchant_onboarding_enabled', 'Merchant onboarding');

  const merchant = await env.DB.prepare(`SELECT id, email FROM merchants WHERE id = ?`).bind(merchantId).first();
  if (!merchant) return json({ error: 'Merchant not found' }, 404);

  const stateToken = randomToken();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await env.DB.prepare(`
    INSERT INTO stripe_oauth_states (state_token, merchant_id, expires_at)
    VALUES (?, ?, ?)
  `).bind(stateToken, merchantId, expiresAt).run();

  return json({
    merchant_id: merchantId,
    authorize_url: buildStripeOAuthUrl(env, stateToken),
    expires_at: expiresAt,
  });
}

async function handleOAuthCallback(url, env) {
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const oauthError = url.searchParams.get('error');
  const oauthDescription = url.searchParams.get('error_description');

  if (!state) return new Response('Missing Stripe OAuth state.', { status: 400 });

  const stateRow = await env.DB.prepare(`
    SELECT * FROM stripe_oauth_states
    WHERE state_token = ?
      AND consumed_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP
    LIMIT 1
  `).bind(state).first();

  if (!stateRow) return new Response('Stripe connection state is invalid or expired.', { status: 400 });

  if (oauthError) {
    await env.DB.prepare(`UPDATE stripe_oauth_states SET consumed_at = CURRENT_TIMESTAMP WHERE state_token = ?`).bind(state).run();
    return redirectToConsole(env, {
      stripe: 'denied',
      merchant: stateRow.merchant_id,
      reason: oauthDescription || oauthError,
    });
  }

  if (!code) return new Response('Missing Stripe authorization code.', { status: 400 });

  const result = await exchangeStripeOAuthCode(env, code);
  await env.DB.prepare(`
    UPDATE stripe_oauth_states SET consumed_at = CURRENT_TIMESTAMP WHERE state_token = ?
  `).bind(state).run();

  let merchantStatus = 'TEST';
  try {
    await requirePlatformControl(env, 'merchant_onboarding_enabled', 'Merchant onboarding');
  } catch {
    merchantStatus = 'PAUSED';
  }

  await env.DB.prepare(`
    UPDATE merchants
       SET processor_account_id = ?,
           integration_mode = 'STRIPE_CONNECT',
           status = ?,
           stripe_fee_payer = NULL,
           stripe_loss_liability = NULL,
           stripe_financial_responsibility_checked_at = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(result.stripe_user_id, merchantStatus, stateRow.merchant_id).run();

  await registerMerchantTransactionSource(env, stateRow.merchant_id, {
    source_system: 'STRIPE',
    source_type: 'PROCESSOR',
    external_account_id: result.stripe_user_id,
    capabilities: {
      payments: true,
      application_fees: true,
      refunds: true,
      disputes: true,
      payouts: true,
      receipts: true,
    },
  });

  return redirectToConsole(env, {
    stripe: 'connected',
    merchant: stateRow.merchant_id,
    status: merchantStatus,
  });
}

async function handleDisconnect(env, merchantId) {
  const merchant = await env.DB.prepare(`SELECT * FROM merchants WHERE id = ?`).bind(merchantId).first();
  if (!merchant) return json({ error: 'Merchant not found' }, 404);
  if (!merchant.processor_account_id) return json({ disconnected: true, already_disconnected: true });

  const result = await deauthorizeStripeAccount(env, merchant.processor_account_id);
  await env.DB.prepare(`
    UPDATE merchant_transaction_sources
       SET status = 'DISCONNECTED', last_seen_at = CURRENT_TIMESTAMP
     WHERE merchant_id = ? AND source_system = 'STRIPE' AND external_account_id = ?
  `).bind(merchantId, merchant.processor_account_id).run().catch(() => null);

  await env.DB.prepare(`
    UPDATE merchants
       SET processor_account_id = NULL,
           status = 'DISCONNECTED',
           stripe_charges_enabled = NULL,
           stripe_payouts_enabled = NULL,
           stripe_details_submitted = NULL,
           stripe_payout_interval = NULL,
           stripe_requirements_due_json = NULL,
           stripe_fee_payer = NULL,
           stripe_loss_liability = NULL,
           stripe_financial_responsibility_checked_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(merchantId).run();

  return json({ disconnected: true, stripe_user_id: result.stripe_user_id || null });
}

async function requirePlatformControl(env, column, label) {
  const allowed = new Set(['transaction_creation_enabled', 'payment_creation_enabled', 'merchant_onboarding_enabled']);
  if (!allowed.has(column)) throw new Error(`Unknown platform control: ${column}`);

  const controls = await env.DB.prepare(`SELECT ${column} AS enabled, reason FROM platform_controls WHERE id = 'GLOBAL'`).first().catch(() => null);
  if (controls && Number(controls.enabled) !== 1) {
    const error = new Error(`${label} is temporarily paused by Builtegrity safety controls${controls.reason ? `: ${controls.reason}` : ''}`);
    error.status = 503;
    throw error;
  }

  const stage = String(env.WATCHDOG_STAGE || 'PREVIEW').toUpperCase();
  const mustHaveFinancialSafety = ['PILOT', 'LIVE'].includes(stage);
  const financialColumn = {
    merchant_onboarding_enabled: 'merchant_onboarding_allowed',
    transaction_creation_enabled: 'transaction_creation_allowed',
    payment_creation_enabled: 'payment_creation_allowed',
  }[column];

  const financial = await env.DB.prepare(`
    SELECT state, enforcement_active, ${financialColumn} AS allowed, reason_codes_json, evaluated_at
    FROM financial_safety_state WHERE id='GLOBAL'
  `).first().catch(() => null);

  if (!financial) {
    if (mustHaveFinancialSafety) {
      const error = new Error(`${label} is paused because the financial safety engine is unavailable.`);
      error.status = 503;
      throw error;
    }
    return;
  }

  if (mustHaveFinancialSafety && Number(financial.enforcement_active) !== 1) {
    const error = new Error(`${label} is paused until the financial safety engine completes an enforced evaluation.`);
    error.status = 503;
    throw error;
  }

  if (mustHaveFinancialSafety && minutesAgo(financial.evaluated_at) > FINANCIAL_DECISION_MAX_AGE_MINUTES) {
    const error = new Error(`${label} is paused because the financial safety decision is stale. The monitor must complete a fresh evaluation before activity resumes.`);
    error.status = 503;
    throw error;
  }

  if (Number(financial.enforcement_active) === 1 && Number(financial.allowed) !== 1) {
    const reasons = parseReasonCodes(financial.reason_codes_json);
    const error = new Error(`${label} is paused by Builtegrity financial safety${reasons.length ? `: ${reasons.join(', ')}` : ''}`);
    error.status = 503;
    throw error;
  }
}

function minutesAgo(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - time) / 60000);
}

function parseReasonCodes(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.slice(0, 10).map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function redirectToConsole(env, values) {
  const base = String(env.ADMIN_BASE_URL || env.APP_BASE_URL || 'http://localhost:8787').replace(/\/$/, '');
  const target = new URL(`${base}/console/`);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  }
  return Response.redirect(target.toString(), 302);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readJson(request) {
  try { return await request.json(); } catch {
    const error = new Error('Invalid JSON request body');
    error.status = 400;
    throw error;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
