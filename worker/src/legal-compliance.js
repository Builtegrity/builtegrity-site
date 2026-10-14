import { launchAssuranceBlockers } from './launch-assurance.js';

const REQUIRED_MERCHANT_DOCUMENTS = [
  'PLATFORM_AGREEMENT',
  'DATA_PROCESSING_ADDENDUM',
  'ACCEPTABLE_USE_POLICY',
  'FEE_SCHEDULE',
  'ELECTRONIC_RECORDS_CONSENT',
];

const REQUIRED_LIVE_DOCUMENTS = [
  ...REQUIRED_MERCHANT_DOCUMENTS,
  'PRIVACY_NOTICE',
  'SECURITY_SUMMARY',
  'SUBPROCESSOR_LIST',
];

export async function evaluateLegalReadiness(env) {
  const controls = await env.DB.prepare(`SELECT * FROM platform_compliance_controls WHERE id='GLOBAL'`).first();
  if (!controls) throw new Error('Platform compliance controls are missing');

  const docs = await env.DB.prepare(`
    SELECT document_type,version,status,effective_at,counsel_reviewed_at,public_path
    FROM legal_document_versions
    WHERE status='APPROVED'
    ORDER BY document_type,effective_at DESC,created_at DESC
  `).all();
  const approvedTypes = new Set((docs.results || []).map((row) => row.document_type));
  const missingDocs = REQUIRED_LIVE_DOCUMENTS.filter((type) => !approvedTypes.has(type));

  const obligations = await env.DB.prepare(`
    SELECT id,jurisdiction,category,title,status,next_review_due_at
    FROM compliance_obligations
    WHERE obligation_type='REQUIRED'
      AND (
        status NOT IN ('SATISFIED','NOT_APPLICABLE')
        OR (next_review_due_at IS NOT NULL AND datetime(next_review_due_at) <= CURRENT_TIMESTAMP)
      )
    ORDER BY jurisdiction,category,id
  `).all();

  const vendors = await env.DB.prepare(`
    SELECT id,provider_name,contract_status,security_review_status,subprocessors_reviewed,next_review_due_at
    FROM service_provider_registry
    WHERE personal_data_access=1 OR financial_data_access=1
  `).all();
  const vendorFailures = (vendors.results || []).filter((v) =>
    v.contract_status !== 'APPROVED' ||
    v.security_review_status !== 'APPROVED' ||
    Number(v.subprocessors_reviewed) !== 1 ||
    (v.next_review_due_at && Date.parse(v.next_review_due_at) <= Date.now())
  );

  const launchState = await env.DB.prepare(`
    SELECT * FROM state_jurisdiction_support WHERE state_code='RI'
  `).first().catch(() => null);

  const reasons = await launchAssuranceBlockers(env);
  if (controls.legal_entity_status !== 'CONFIRMED') reasons.push('LEGAL_ENTITY_UNCONFIRMED');
  if (controls.money_transmission_review_status !== 'CONFIRMED_NON_MSB') reasons.push('MONEY_TRANSMISSION_REVIEW_INCOMPLETE');
  if (!['ACTIVE','NOT_APPLICABLE'].includes(controls.ri_sales_tax_permit_status)) reasons.push('RI_SALES_TAX_PERMIT_NOT_ACTIVE');
  if (!['IMPLEMENTED','NOT_APPLICABLE'].includes(controls.platform_fee_tax_method_status)) reasons.push('PLATFORM_FEE_TAX_METHOD_UNRESOLVED');
  if (controls.pci_status !== 'VALID') reasons.push('PCI_VALIDATION_INCOMPLETE');
  if (controls.vendor_contract_status !== 'COMPLETE') reasons.push('VENDOR_CONTRACT_REVIEW_INCOMPLETE');
  if (controls.privacy_program_status !== 'APPROVED') reasons.push('PRIVACY_PROGRAM_NOT_APPROVED');
  if (controls.information_security_program_status !== 'APPROVED') reasons.push('INFORMATION_SECURITY_PROGRAM_NOT_APPROVED');
  if (!statePackReady(launchState)) reasons.push('RI_STATE_JURISDICTION_PACK_NOT_READY');
  if (missingDocs.length) reasons.push(`LEGAL_DOCUMENTS_MISSING:${missingDocs.join(',')}`);
  if ((obligations.results || []).length) reasons.push(`REQUIRED_OBLIGATIONS_OPEN:${(obligations.results || []).map((o) => o.id).join(',')}`);
  if (vendorFailures.length) reasons.push(`SERVICE_PROVIDER_REVIEWS_OPEN:${vendorFailures.map((v) => v.id).join(',')}`);

  // Architectural invariants are immutable CHECK constraints in D1, but verify them again at runtime.
  const invariantFailures = [];
  if (controls.launch_country !== 'US') invariantFailures.push('NON_US_LAUNCH_COUNTRY');
  if (controls.launch_currency !== 'USD') invariantFailures.push('NON_USD_LAUNCH_CURRENCY');
  if (controls.payment_architecture !== 'STRIPE_DIRECT_CHARGE') invariantFailures.push('NON_DIRECT_CHARGE_ARCHITECTURE');
  for (const [column,value] of Object.entries({
    funds_custody_allowed: controls.funds_custody_allowed,
    platform_transfers_allowed: controls.platform_transfers_allowed,
    marketplace_funds_routing_allowed: controls.marketplace_funds_routing_allowed,
    international_merchants_allowed: controls.international_merchants_allowed,
    international_customer_sales_allowed: controls.international_customer_sales_allowed,
    subscriptions_allowed: controls.subscriptions_allowed,
    manual_payouts_allowed: controls.manual_payouts_allowed,
    raw_card_data_allowed: controls.raw_card_data_allowed,
    prohibited_sensitive_data_allowed: controls.prohibited_sensitive_data_allowed,
    automated_marketing_sms_allowed: controls.automated_marketing_sms_allowed,
    automated_marketing_robocalls_allowed: controls.automated_marketing_robocalls_allowed,
  })) {
    if (Number(value) !== 0) invariantFailures.push(`FORBIDDEN_CAPABILITY_ENABLED:${column}`);
  }
  if (invariantFailures.length) reasons.push(...invariantFailures);

  const state = reasons.length ? 'BLOCKED' : 'READY';
  await env.DB.prepare(`
    UPDATE platform_compliance_controls
       SET legal_launch_state=?,updated_at=CURRENT_TIMESTAMP
     WHERE id='GLOBAL'
  `).bind(state).run();

  return {
    state,
    reasons,
    controls: sanitizeControls(controls),
    launch_state_pack: launchState || null,
    missing_approved_documents: missingDocs,
    open_required_obligations: obligations.results || [],
    service_provider_review_failures: vendorFailures,
    approved_documents: docs.results || [],
  };
}

export async function assertLegalReadyForLiveAction(env, actionLabel='Live platform activity') {
  const stage = String(env.WATCHDOG_STAGE || 'PREVIEW').trim().toUpperCase();
  if (!['PILOT','LIVE'].includes(stage)) return { enforced: false, stage };
  const status = await evaluateLegalReadiness(env);
  if (status.state !== 'READY') {
    const error = new Error(`${actionLabel} is blocked by Builtegrity legal/compliance controls: ${status.reasons.join('; ')}`);
    error.status = 503;
    error.compliance = status;
    throw error;
  }
  return { enforced: true, stage, ...status };
}

export async function getMerchantComplianceStatus(env, merchantId) {
  const merchant = await env.DB.prepare(`
    SELECT id,name,country_code,state_code,customer_market_scope,compliance_status,
           restricted_business_status,sanctions_review_status,sanctions_reviewed_at,
           legal_acceptance_complete_at,status
      FROM merchants WHERE id=?
  `).bind(merchantId).first();
  if (!merchant) throw Object.assign(new Error('Merchant not found'), { status: 404 });

  const approved = await currentApprovedDocuments(env, REQUIRED_MERCHANT_DOCUMENTS);
  const acceptances = await env.DB.prepare(`
    SELECT document_type,document_version,external_user_id,accepted_at,acceptance_method
      FROM merchant_legal_acceptances
     WHERE merchant_id=?
     ORDER BY accepted_at DESC
  `).bind(merchantId).all();
  const statePack = merchant.state_code
    ? await env.DB.prepare(`SELECT * FROM state_jurisdiction_support WHERE state_code=?`).bind(merchant.state_code).first().catch(() => null)
    : null;
  const acceptedKeys = new Set((acceptances.results || []).map((a) => `${a.document_type}:${a.document_version}`));
  const missing = approved.filter((doc) => !acceptedKeys.has(`${doc.document_type}:${doc.version}`));
  const reasons=[];
  if (merchant.country_code !== 'US') reasons.push('MERCHANT_COUNTRY_NOT_US');
  if (!merchant.state_code) reasons.push('MERCHANT_STATE_MISSING');
  if (merchant.customer_market_scope !== 'US_ONLY') reasons.push('MERCHANT_MARKET_NOT_US_ONLY');
  if (merchant.restricted_business_status !== 'CLEARED') reasons.push('RESTRICTED_BUSINESS_REVIEW_NOT_CLEARED');
  if (merchant.sanctions_review_status !== 'CLEAR') reasons.push('SANCTIONS_REVIEW_NOT_CLEAR');
  if (!statePack) reasons.push('MERCHANT_STATE_NOT_SUPPORTED');
  else if (!statePackReady(statePack)) reasons.push('MERCHANT_STATE_PACK_NOT_READY');
  if (approved.length !== REQUIRED_MERCHANT_DOCUMENTS.length) reasons.push('REQUIRED_LEGAL_DOCUMENTS_NOT_APPROVED');
  if (missing.length) reasons.push(`LEGAL_ACCEPTANCES_MISSING:${missing.map((d) => d.document_type).join(',')}`);
  const ready=reasons.length===0;
  return {
    merchant,
    state_pack: statePack || null,
    ready,
    reasons,
    required_documents:approved,
    acceptances:acceptances.results||[],
    missing_acceptances:missing,
  };
}

export async function recordMerchantLegalAcceptances(env, merchantId, externalUserId, input={}, requestEvidence={}) {
  if (!externalUserId) throw Object.assign(new Error('Authenticated merchant user is required'), { status: 401 });
  const access = await env.DB.prepare(`
    SELECT role,status FROM merchant_access
    WHERE merchant_id=? AND external_user_id=? AND status='ACTIVE'
  `).bind(merchantId,externalUserId).first();
  if (!access || !['OWNER','ADMIN'].includes(access.role)) {
    throw Object.assign(new Error('Merchant owner/admin access is required to accept legal terms'), { status: 403 });
  }
  if (input.accepted !== true) throw Object.assign(new Error('Explicit acceptance is required'), { status: 400 });

  const docs = await currentApprovedDocuments(env, REQUIRED_MERCHANT_DOCUMENTS);
  if (docs.length !== REQUIRED_MERCHANT_DOCUMENTS.length) {
    throw Object.assign(new Error('Builtegrity legal documents are not approved for merchant acceptance'), { status: 503 });
  }

  const networkHash = await evidenceHash(env, requestEvidence.ip || '');
  const uaHash = await evidenceHash(env, requestEvidence.userAgent || '');
  for (const doc of docs) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO merchant_legal_acceptances
        (id,merchant_id,external_user_id,document_type,document_version,acceptance_method,
         network_evidence_hash,user_agent_hash,evidence_json)
      VALUES(?,?,?,?,?,'CLICKWRAP',?,?,?)
    `).bind(
      `MLA-${crypto.randomUUID()}`,merchantId,externalUserId,doc.document_type,doc.version,
      networkHash,uaHash,JSON.stringify({document_id:doc.id,public_path:doc.public_path})
    ).run();
  }
  return refreshMerchantCompliance(env, merchantId);
}

export async function refreshMerchantCompliance(env, merchantId) {
  const status = await getMerchantComplianceStatus(env, merchantId);
  const next=status.ready?'READY':'INCOMPLETE';
  await env.DB.prepare(`
    UPDATE merchants
       SET compliance_status=?,legal_acceptance_complete_at=CASE WHEN ?=1 THEN COALESCE(legal_acceptance_complete_at,CURRENT_TIMESTAMP) ELSE NULL END,
           updated_at=CURRENT_TIMESTAMP
     WHERE id=?
  `).bind(next,status.ready?1:0,merchantId).run();
  return getMerchantComplianceStatus(env,merchantId);
}

export function assertV1TransactionEnvelope(input={}) {
  const currency=String(input.currency||'USD').toUpperCase();
  const customerCountry=String(input.customer_country_code||input.customer?.country_code||'').toUpperCase();
  if (currency!=='USD') throw Object.assign(new Error('Builtegrity V1 supports USD transactions only'),{status:400});
  if (customerCountry!=='US') throw Object.assign(new Error('Builtegrity V1 supports U.S. customer transactions only'),{status:400});
  assertNoProhibitedSensitiveInput(input);
}

export function assertNoProhibitedSensitiveInput(input={}) {
  const forbiddenKeys=new Set([
    'card_number','pan','cvc','cvv','security_code','ssn','social_security_number',
    'routing_number','bank_account_number','password','password_hash','medical_record_number'
  ]);
  walk(input,(key,value)=>{
    const normalized=String(key||'').toLowerCase();
    if(forbiddenKeys.has(normalized)) throw Object.assign(new Error(`Prohibited sensitive field supplied: ${normalized}`),{status:400});
    if(typeof value==='string'){
      if(/\b\d{3}-\d{2}-\d{4}\b/.test(value)) throw Object.assign(new Error('Do not place Social Security numbers in Builtegrity transaction records'),{status:400});
      for(const candidate of value.match(/(?:\d[ -]?){13,19}/g)||[]){
        const digits=candidate.replace(/\D/g,'');
        if(digits.length>=13&&digits.length<=19&&luhn(digits)) throw Object.assign(new Error('Do not place payment card numbers in Builtegrity records; Stripe must collect card data'),{status:400});
      }
    }
  });
}

export async function createPrivacyRequest(env,input={}){
  const requestType=String(input.request_type||'').toUpperCase();
  if(!['ACCESS','CORRECT','DELETE','PORTABILITY','OPT_OUT','APPEAL','OTHER'].includes(requestType)) throw Object.assign(new Error('Invalid privacy request type'),{status:400});
  const now=new Date(); const target=new Date(now.getTime()+30*86400000);
  const id=`PRIV-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO privacy_requests(id,subject_type,subject_ref,request_type,jurisdiction_code,internal_target_at,evidence_json)
    VALUES(?,?,?,?,?,?,?)
  `).bind(id,String(input.subject_type||'OTHER').toUpperCase(),input.subject_ref||null,requestType,input.jurisdiction_code||null,target.toISOString(),JSON.stringify(input.evidence||{})).run();
  return env.DB.prepare(`SELECT * FROM privacy_requests WHERE id=?`).bind(id).first();
}

export async function openSecurityIncident(env,input={}){
  if(!input.description) throw Object.assign(new Error('Incident description is required'),{status:400});
  const discovered=new Date(input.discovered_at||Date.now());
  if(!Number.isFinite(discovered.getTime())) throw Object.assign(new Error('Invalid discovered_at'),{status:400});
  const confirmed=input.confirmed_breach_at?new Date(input.confirmed_breach_at):null;
  if(confirmed&&!Number.isFinite(confirmed.getTime())) throw Object.assign(new Error('Invalid confirmed_breach_at'),{status:400});
  const affectedRI=Math.max(0,Number(input.affected_ri_residents||0));
  const deadline=confirmed&&affectedRI>0?new Date(confirmed.getTime()+45*86400000):null;
  const id=`INC-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO security_incidents
      (id,severity,status,discovered_at,confirmed_breach_at,description,personal_information_involved,
       affected_ri_residents,ri_notice_deadline_at,ri_ag_notice_required,ri_credit_bureau_notice_required,containment_notes)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(id,String(input.severity||'HIGH').toUpperCase(),'OPEN',discovered.toISOString(),confirmed?.toISOString()||null,String(input.description),input.personal_information_involved?1:0,affectedRI,deadline?.toISOString()||null,affectedRI>500?1:0,affectedRI>500?1:0,input.containment_notes||null).run();
  return env.DB.prepare(`SELECT * FROM security_incidents WHERE id=?`).bind(id).first();
}

async function currentApprovedDocuments(env,types){
  const result=await env.DB.prepare(`
    SELECT d.* FROM legal_document_versions d
    JOIN (
      SELECT document_type,MAX(COALESCE(effective_at,created_at)) AS latest
      FROM legal_document_versions
      WHERE status='APPROVED'
      GROUP BY document_type
    ) x ON x.document_type=d.document_type AND x.latest=COALESCE(d.effective_at,d.created_at)
    WHERE d.status='APPROVED'
  `).all();
  const wanted=new Set(types);
  return (result.results||[]).filter((d)=>wanted.has(d.document_type));
}

function statePackReady(state){
  if(!state)return false;
  if(state.merchant_onboarding_status!=='READY')return false;
  if(!['CLEARED_NON_LICENSED','LICENSE_ACTIVE'].includes(state.money_transmission_review_status))return false;
  if(!['CLEARED','REGISTERED','NOT_APPLICABLE'].includes(state.sales_tax_review_status))return false;
  if(state.privacy_review_status!=='CLEARED')return false;
  if(state.breach_review_status!=='CLEARED')return false;
  if(!['CLEARED','REGISTERED'].includes(state.entity_nexus_review_status))return false;
  if(!['CLEARED','REGISTERED','NOT_APPLICABLE'].includes(state.income_tax_review_status))return false;
  if(state.electronic_transactions_review_status!=='CLEARED')return false;
  if(state.next_review_due_at&&Date.parse(state.next_review_due_at)<=Date.now())return false;
  return true;
}

function sanitizeControls(row){
  if(!row)return null;
  return {...row};
}

async function evidenceHash(env,value){
  if(!value)return null;
  const salt=String(env.COMPLIANCE_EVIDENCE_SALT||'');
  if(!salt) throw Object.assign(new Error('COMPLIANCE_EVIDENCE_SALT is required to record legal acceptance evidence'),{status:503});
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${salt}:${value}`));
  return [...new Uint8Array(digest)].map((b)=>b.toString(16).padStart(2,'0')).join('');
}
function walk(value,visit,key='root'){
  visit(key,value);
  if(Array.isArray(value)) value.forEach((v,i)=>walk(v,visit,String(i)));
  else if(value&&typeof value==='object') for(const [k,v] of Object.entries(value)) walk(v,visit,k);
}
function luhn(digits){let sum=0,alt=false;for(let i=digits.length-1;i>=0;i--){let n=Number(digits[i]);if(alt){n*=2;if(n>9)n-=9;}sum+=n;alt=!alt;}return sum%10===0;}
