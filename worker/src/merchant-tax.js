const CLASSIFICATIONS = ['UNKNOWN','SOLE_PROPRIETOR','SMLLC_DISREGARDED','PARTNERSHIP','S_CORP','C_CORP','NONPROFIT','OTHER'];

export async function getMerchantTaxProfile(env, merchantId) {
  await ensureMerchantTaxProfile(env, merchantId);
  const profile = await env.DB.prepare(`
    SELECT p.*, m.name, m.email, m.statement_email, m.tax_documentation_enabled
      FROM merchant_tax_profiles p
      JOIN merchants m ON m.id=p.merchant_id
     WHERE p.merchant_id=?
  `).bind(merchantId).first();
  if (!profile) throw Object.assign(new Error(`Merchant ${merchantId} not found`), { status: 404 });
  return {
    ...profile,
    documentation: documentationPurpose(profile.federal_tax_classification),
    filing_guidance: await filingGuidance(env, profile, new Date().getUTCFullYear()),
    raw_tax_identifiers_stored: false,
  };
}

export async function updateMerchantTaxProfile(env, merchantId, input = {}) {
  await ensureMerchantTaxProfile(env, merchantId);
  const current = await env.DB.prepare(`SELECT * FROM merchant_tax_profiles WHERE merchant_id=?`).bind(merchantId).first();
  if (!current) throw Object.assign(new Error(`Merchant ${merchantId} not found`), { status: 404 });

  const classification = enumValue(input.federal_tax_classification ?? current.federal_tax_classification, CLASSIFICATIONS, 'federal_tax_classification');
  const country = String(input.tax_home_country ?? current.tax_home_country ?? 'US').trim().toUpperCase();
  const state = nullableUpper(input.tax_home_state ?? current.tax_home_state);
  const employees = nullableBooleanInt(input.has_employees ?? current.has_employees, 'has_employees');
  const payroll = enumValue(input.federal_payroll_return ?? current.federal_payroll_return, ['UNKNOWN','NONE','FORM_941','FORM_944'], 'federal_payroll_return');
  if (employees === 0 && !['NONE','UNKNOWN'].includes(payroll)) throw Object.assign(new Error('A no-employees merchant cannot claim Form 941/944 filing status'), { status: 400 });
  const status = enumValue(input.profile_status ?? current.profile_status, ['UNKNOWN','SELF_ATTESTED','VERIFIED'], 'profile_status');
  const source = enumValue(input.source ?? 'OPERATOR', ['MERCHANT','PROCESSOR','OPERATOR','TAX_PROVIDER'], 'source');
  const notes = input.notes == null ? current.notes : String(input.notes).slice(0, 2000);

  await env.DB.prepare(`
    UPDATE merchant_tax_profiles
       SET federal_tax_classification=?,tax_home_country=?,tax_home_state=?,has_employees=?,
           federal_payroll_return=?,profile_status=?,source=?,notes=?,updated_at=CURRENT_TIMESTAMP
     WHERE merchant_id=?
  `).bind(classification,country,state,employees,payroll,status,source,notes,merchantId).run();
  await env.DB.prepare(`
    UPDATE merchants
       SET federal_tax_classification=?,tax_home_country=?,tax_home_state=?,has_employees=?,
           tax_profile_status=?,tax_profile_updated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
     WHERE id=?
  `).bind(classification,country,state,employees,status,merchantId).run();
  return getMerchantTaxProfile(env, merchantId);
}

export function documentationPurpose(classification) {
  switch (classification) {
    case 'SOLE_PROPRIETOR':
    case 'SMLLC_DISREGARDED':
      return { quarterly: 'PERSONAL_ESTIMATED_TAX_SUPPORT', annual: 'OWNER_RETURN_RECONCILIATION_SUPPORT' };
    case 'PARTNERSHIP':
      return { quarterly: 'PARTNER_ESTIMATED_TAX_SUPPORT', annual: 'PARTNERSHIP_AND_K1_RECONCILIATION_SUPPORT' };
    case 'S_CORP':
      return { quarterly: 'SHAREHOLDER_ESTIMATED_TAX_SUPPORT', annual: 'S_CORP_AND_SHAREHOLDER_RECONCILIATION_SUPPORT' };
    case 'C_CORP':
      return { quarterly: 'CORPORATE_ESTIMATED_TAX_SUPPORT', annual: 'CORPORATE_RETURN_RECONCILIATION_SUPPORT' };
    default:
      return { quarterly: 'GENERAL_ACCOUNTING_AND_ESTIMATED_TAX_SUPPORT', annual: 'YEAR_END_ACCOUNTING_RECONCILIATION' };
  }
}

export async function ensureMerchantTaxProfile(env, merchantId) {
  const merchant = await env.DB.prepare(`
    SELECT id,federal_tax_classification,tax_home_country,tax_home_state,has_employees,tax_profile_status
      FROM merchants WHERE id=?
  `).bind(merchantId).first();
  if (!merchant) return null;
  await env.DB.prepare(`
    INSERT OR IGNORE INTO merchant_tax_profiles
      (merchant_id,federal_tax_classification,tax_home_country,tax_home_state,has_employees,profile_status,source)
    VALUES (?,?,?,?,?,?,'MERCHANT')
  `).bind(
    merchant.id,
    merchant.federal_tax_classification || 'UNKNOWN',
    merchant.tax_home_country || 'US',
    merchant.tax_home_state || null,
    merchant.has_employees == null ? null : Number(merchant.has_employees),
    merchant.tax_profile_status || 'UNKNOWN',
  ).run();
  return merchant;
}

async function filingGuidance(env, profile, year) {
  const stateJurisdiction = profile.tax_home_state === 'RI' ? 'US-RI' : 'NO_STATE_RULES';
  const result = await env.DB.prepare(`
    SELECT rule_code,jurisdiction,obligation_kind,cadence,filing_form,threshold_cents,
           threshold_basis,due_rule,due_dates_json,automation_level,notes
      FROM tax_compliance_rule_versions
     WHERE tax_year=? AND jurisdiction IN ('US-FEDERAL',?)
     ORDER BY jurisdiction,rule_code
  `).bind(year,stateJurisdiction).all();
  return (result.results || [])
    .filter((rule) => ruleApplies(rule, profile))
    .map((rule) => ({ ...rule, due_dates: safeJson(rule.due_dates_json), due_dates_json: undefined }));
}

function ruleApplies(rule, profile) {
  const applies = String(rule.applies_to || '').split(',');
  const c = profile.federal_tax_classification;
  if (applies.includes('BUSINESS_PAYER')) return true;
  if (profile.has_employees === 1 && applies.includes('EMPLOYER_FORM_941')) return profile.federal_payroll_return !== 'FORM_944';
  if (profile.has_employees === 1 && applies.includes('EMPLOYER_FORM_944')) return profile.federal_payroll_return === 'FORM_944';
  if (profile.has_employees === 1 && applies.includes('EMPLOYER_W2')) return true;
  if (profile.has_employees === 1 && (applies.includes('EMPLOYER') || applies.includes('RI_EMPLOYER'))) return true;
  if (c === 'SOLE_PROPRIETOR' && (applies.includes('SOLE_PROPRIETOR') || applies.includes('RI_INDIVIDUAL'))) return true;
  if (c === 'SMLLC_DISREGARDED' && (applies.includes('SMLLC_DISREGARDED') || applies.includes('RI_INDIVIDUAL'))) return true;
  if (c === 'PARTNERSHIP' && (applies.includes('PARTNERSHIP') || applies.includes('PARTNER'))) return true;
  if (c === 'S_CORP' && (applies.includes('S_CORP') || applies.includes('S_CORP_SHAREHOLDER'))) return true;
  if (c === 'C_CORP' && applies.includes('C_CORP')) return true;
  return false;
}

function enumValue(value, allowed, name) {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (!allowed.includes(normalized)) throw Object.assign(new Error(`${name} must be one of: ${allowed.join(', ')}`), { status: 400 });
  return normalized;
}

function nullableBooleanInt(value, name) {
  if (value == null || value === '') return null;
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  throw Object.assign(new Error(`${name} must be boolean or null`), { status: 400 });
}

function nullableUpper(value) {
  if (value == null || String(value).trim() === '') return null;
  return String(value).trim().toUpperCase().slice(0, 32);
}

function safeJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}
