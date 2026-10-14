import { evaluateLegalReadiness } from './legal-compliance.js';

export async function assertMerchantLegalReadyForLiveAction(env, merchantId, actionLabel = 'Live merchant activity') {
  const stage = String(env.WATCHDOG_STAGE || 'PREVIEW').toUpperCase();
  if (!['PILOT','LIVE'].includes(stage)) return { enforced: false, stage };

  // The SQL readiness views are deliberately stricter than status labels: they require
  // current evidence, counsel/tax references, vendor reviews, PCI expiry dates, etc.
  const strictPlatform = await env.DB.prepare(`SELECT state,blocker_count,blockers FROM platform_legal_readiness`).first();
  if (!strictPlatform || strictPlatform.state !== 'READY') {
    throw complianceError(
      `${actionLabel} is blocked because evidenced platform compliance is not READY`,
      splitBlockers(strictPlatform?.blockers),
    );
  }

  // Legal exposure cannot be treated as operationally safe merely because launch counsel once
  // approved the product. PILOT/LIVE activity additionally requires a currently usable standing
  // legal-response route so a new subpoena, complaint, breach or regulator notice has somewhere
  // privileged and deadline-controlled to go immediately.
  const legalResponse = await env.DB.prepare(`SELECT state,legal_response_program_status,open_incidents,urgent_incidents FROM legal_response_readiness LIMIT 1`).first();
  if (!legalResponse || legalResponse.state !== 'READY') {
    throw complianceError(`${actionLabel} is blocked because the legal incident response program is not READY`, ['LEGAL_RESPONSE_PROGRAM_NOT_READY']);
  }

  const platform = await evaluateLegalReadiness(env);
  if (platform.state !== 'READY') {
    throw complianceError(`${actionLabel} is blocked because Builtegrity platform compliance is not READY`, platform.reasons);
  }

  const strictMerchant = await env.DB.prepare(`
    SELECT legal_state FROM merchant_legal_readiness WHERE merchant_id=?
  `).bind(merchantId).first();
  if (!strictMerchant || strictMerchant.legal_state !== 'READY') {
    throw complianceError(`${actionLabel} is blocked because evidenced merchant compliance is not READY`, ['MERCHANT_EVIDENCE_GATE_BLOCKED']);
  }

  const merchant = await env.DB.prepare(`
    SELECT m.id,m.status,m.country_code,m.state_code,m.customer_market_scope,m.compliance_status,
           m.restricted_business_status,m.restricted_business_reviewed_at,m.restricted_business_evidence_ref,
           m.sanctions_review_status,m.sanctions_reviewed_at,m.sanctions_evidence_ref,m.sanctions_next_review_due_at,
           m.legal_acceptance_complete_at,
           s.merchant_onboarding_status,s.money_transmission_review_status,s.sales_tax_review_status,
           s.privacy_review_status,s.breach_review_status,s.entity_nexus_review_status,
           s.income_tax_review_status,s.electronic_transactions_review_status,s.next_review_due_at
      FROM merchants m
      LEFT JOIN state_jurisdiction_support s ON s.state_code=m.state_code
     WHERE m.id=?
  `).bind(merchantId).first();
  if (!merchant) throw statusError('Merchant not found', 404);

  const reasons=[];
  if (merchant.country_code !== 'US') reasons.push('MERCHANT_COUNTRY_NOT_US');
  if (!merchant.state_code) reasons.push('MERCHANT_STATE_UNKNOWN');
  if (merchant.customer_market_scope !== 'US_ONLY') reasons.push('MERCHANT_MARKET_NOT_US_ONLY');
  if (merchant.compliance_status !== 'READY') reasons.push('MERCHANT_COMPLIANCE_NOT_READY');
  if (merchant.restricted_business_status !== 'CLEARED') reasons.push('RESTRICTED_BUSINESS_NOT_CLEARED');
  if (!merchant.restricted_business_reviewed_at || !merchant.restricted_business_evidence_ref) reasons.push('RESTRICTED_BUSINESS_EVIDENCE_MISSING');
  if (merchant.sanctions_review_status !== 'CLEAR') reasons.push('SANCTIONS_NOT_CLEAR');
  if (!merchant.sanctions_reviewed_at || !merchant.sanctions_evidence_ref) reasons.push('SANCTIONS_EVIDENCE_MISSING');
  if (!merchant.sanctions_next_review_due_at || Date.parse(merchant.sanctions_next_review_due_at) <= Date.now()) reasons.push('SANCTIONS_REVIEW_EXPIRED');
  if (!merchant.legal_acceptance_complete_at) reasons.push('LEGAL_ACCEPTANCE_INCOMPLETE');

  if (merchant.merchant_onboarding_status !== 'READY') reasons.push('STATE_PACK_NOT_READY');
  if (!['CLEARED_NON_LICENSED','LICENSE_ACTIVE'].includes(merchant.money_transmission_review_status)) reasons.push('STATE_PAYMENTS_REVIEW_NOT_CLEARED');
  if (!['CLEARED','REGISTERED','NOT_APPLICABLE'].includes(merchant.sales_tax_review_status)) reasons.push('STATE_SALES_TAX_REVIEW_NOT_CLEARED');
  if (merchant.privacy_review_status !== 'CLEARED') reasons.push('STATE_PRIVACY_REVIEW_NOT_CLEARED');
  if (merchant.breach_review_status !== 'CLEARED') reasons.push('STATE_BREACH_REVIEW_NOT_CLEARED');
  if (!['CLEARED','REGISTERED'].includes(merchant.entity_nexus_review_status)) reasons.push('STATE_ENTITY_REVIEW_NOT_CLEARED');
  if (!['CLEARED','REGISTERED','NOT_APPLICABLE'].includes(merchant.income_tax_review_status)) reasons.push('STATE_INCOME_TAX_REVIEW_NOT_CLEARED');
  if (merchant.electronic_transactions_review_status !== 'CLEARED') reasons.push('STATE_E_TRANSACTIONS_REVIEW_NOT_CLEARED');
  if (merchant.next_review_due_at && Date.parse(merchant.next_review_due_at) <= Date.now()) reasons.push('STATE_PACK_EXPIRED');

  const pci=platform.controls || {};
  if (pci.pci_status !== 'VALID' || !pci.pci_validation_reference || !pci.pci_attested_at || !pci.pci_expires_at || Date.parse(pci.pci_expires_at)<=Date.now()) {
    reasons.push('PCI_VALIDATION_NOT_CURRENT');
  }
  if (Number(pci.pci_asv_required)===1 && (
    pci.pci_asv_status!=='PASS' || !pci.pci_asv_next_due_at || Date.parse(pci.pci_asv_next_due_at)<=Date.now()
  )) reasons.push('PCI_ASV_NOT_CURRENT');

  if (reasons.length) throw complianceError(`${actionLabel} is blocked for merchant ${merchantId}`, reasons);
  return { enforced:true, stage, merchant_id:merchantId, state_code:merchant.state_code };
}

export async function getLegalEnforcementStatus(env, merchantId = null) {
  const platform = await evaluateLegalReadiness(env);
  const evidenced = await env.DB.prepare(`SELECT state,blocker_count,blockers FROM platform_legal_readiness`).first().catch(()=>null);
  const legalResponse = await env.DB.prepare(`SELECT * FROM legal_response_readiness LIMIT 1`).first().catch(()=>null);
  if (!merchantId) return { platform, evidenced_platform: evidenced, legal_response: legalResponse };
  try {
    const merchant=await assertMerchantLegalReadyForLiveAction(env,merchantId,'Compliance evaluation');
    return { platform, evidenced_platform:evidenced, legal_response:legalResponse, merchant:{ state:'READY', ...merchant } };
  } catch(error) {
    if (error.status !== 503 && error.status !== 409) throw error;
    return { platform, evidenced_platform:evidenced, legal_response:legalResponse, merchant:{ state:'BLOCKED', reasons:error.compliance_reasons || [error.message] } };
  }
}

function splitBlockers(value){return String(value||'PLATFORM_EVIDENCE_GATE_BLOCKED').split('|').filter(Boolean);}
function complianceError(message,reasons=[]){
  const error=new Error(`${message}: ${reasons.join('; ')}`);
  error.status=503;
  error.compliance_reasons=reasons;
  return error;
}
function statusError(message,status){const error=new Error(message);error.status=status;return error;}
