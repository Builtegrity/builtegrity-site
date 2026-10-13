const CLASSIFICATIONS = ['UNKNOWN','SOLE_PROPRIETOR','SMLLC_DISREGARDED','PARTNERSHIP','S_CORP','C_CORP'];

export async function getBuiltegrityTaxComplianceStatus(env, options = {}) {
  const year = normalizeYear(options.taxYear || new Date().getUTCFullYear());
  const profile = await env.DB.prepare(`SELECT * FROM builtegrity_tax_profile WHERE id='GLOBAL'`).first();
  if (!profile) throw new Error('Builtegrity tax profile is missing');
  const rules = await relevantRules(env, profile, year);
  const workpapers = await env.DB.prepare(`
    SELECT id,period_type,tax_year,quarter,status,automation_state,tracked_contribution_micros,
           estimated_tax_amount_micros,generated_at
      FROM builtegrity_tax_workpapers WHERE tax_year=? ORDER BY period_type,quarter
  `).bind(year).all();
  const actions = await env.DB.prepare(`SELECT * FROM builtegrity_tax_actions WHERE tax_year=? ORDER BY due_at,obligation_code,action_type`).bind(year).all();
  return {
    tax_year: year,
    profile,
    automation_state: companyAutomationState(profile),
    hard_boundaries: {
      direct_autofiling_allowed: false,
      raw_tax_identifiers_required_in_transaction_db: false,
      provider_confirmation_required_before_marking_filed_or_paid: true,
    },
    obligations: rules,
    workpapers: workpapers.results || [],
    actions: actions.results || [],
  };
}

export async function updateBuiltegrityTaxProfile(env, input = {}, principal = {}) {
  const current = await env.DB.prepare(`SELECT * FROM builtegrity_tax_profile WHERE id='GLOBAL'`).first();
  if (!current) throw new Error('Builtegrity tax profile is missing');
  const legalStatus = enumValue(input.legal_entity_status ?? current.legal_entity_status, ['UNCONFIRMED','CONFIRMED'], 'legal_entity_status');
  const classification = enumValue(input.federal_tax_classification ?? current.federal_tax_classification, CLASSIFICATIONS, 'federal_tax_classification');
  if (legalStatus === 'CONFIRMED' && classification === 'UNKNOWN') throw Object.assign(new Error('Confirmed legal entity requires confirmed federal tax classification'), { status: 400 });
  const employees = boolInt(input.has_employees ?? current.has_employees, 'has_employees');
  const payroll = enumValue(input.federal_payroll_return ?? current.federal_payroll_return, ['UNKNOWN','NONE','FORM_941','FORM_944'], 'federal_payroll_return');
  if (employees === 0 && !['NONE','UNKNOWN'].includes(payroll)) throw Object.assign(new Error('No-employees profile cannot claim Form 941/944 status'), { status: 400 });
  const books = enumValue(input.accounting_data_status ?? current.accounting_data_status, ['PARTIAL','COMPLETE_VERIFIED'], 'accounting_data_status');
  const prior = enumValue(input.prior_year_tax_data_status ?? current.prior_year_tax_data_status, ['MISSING','VERIFIED'], 'prior_year_tax_data_status');
  const auth = enumValue(input.filing_authorization_status ?? current.filing_authorization_status, ['NOT_CONFIGURED','READY_FOR_APPROVAL','AUTHORIZED'], 'filing_authorization_status');
  const paymentProvider = text(input.estimated_payment_provider ?? current.estimated_payment_provider);
  const filingProvider = text(input.return_efiling_provider ?? current.return_efiling_provider);
  const actor = principal?.userId || principal?.ref || principal?.email || 'OPERATOR';
  const snapshot = {
    legal_entity_status: legalStatus, federal_tax_classification: classification,
    home_country: 'US', home_state: 'RI', calendar_tax_year: 1,
    has_employees: employees, federal_payroll_return: payroll,
    accounting_data_status: books, prior_year_tax_data_status: prior,
    estimated_payment_provider: paymentProvider, return_efiling_provider: filingProvider,
    filing_authorization_status: auth, direct_autofiling_allowed: 0,
  };
  await env.DB.prepare(`
    UPDATE builtegrity_tax_profile
       SET legal_entity_status=?,federal_tax_classification=?,home_country='US',home_state='RI',calendar_tax_year=1,
           has_employees=?,federal_payroll_return=?,accounting_data_status=?,prior_year_tax_data_status=?,
           estimated_payment_provider=?,return_efiling_provider=?,filing_authorization_status=?,direct_autofiling_allowed=0,
           updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id='GLOBAL'
  `).bind(legalStatus,classification,employees,payroll,books,prior,paymentProvider,filingProvider,auth,actor).run();
  await env.DB.prepare(`INSERT INTO builtegrity_tax_profile_events(profile_snapshot_json,actor_ref) VALUES(?,?)`).bind(JSON.stringify(snapshot),actor).run();
  return getBuiltegrityTaxComplianceStatus(env);
}

export function companyAutomationState(profile) {
  if (!profile || profile.legal_entity_status !== 'CONFIRMED' || profile.federal_tax_classification === 'UNKNOWN') return 'BLOCKED_PROFILE_UNKNOWN';
  if (profile.accounting_data_status !== 'COMPLETE_VERIFIED') return 'BLOCKED_BOOKS_INCOMPLETE';
  if (profile.prior_year_tax_data_status !== 'VERIFIED') return 'BLOCKED_PRIOR_YEAR_DATA_MISSING';
  if (profile.return_efiling_provider && profile.filing_authorization_status === 'AUTHORIZED') return 'READY_FOR_PROVIDER_REVIEW';
  return 'READY_FOR_CALCULATION';
}

async function relevantRules(env, profile, year) {
  if (profile.legal_entity_status !== 'CONFIRMED' || profile.federal_tax_classification === 'UNKNOWN') return [];
  const result = await env.DB.prepare(`SELECT * FROM tax_compliance_rule_versions WHERE tax_year=? AND jurisdiction IN ('US-FEDERAL','US-RI') ORDER BY jurisdiction,rule_code`).bind(year).all();
  return (result.results || []).filter((rule) => applies(rule,profile)).map((rule) => ({ ...rule, due_dates: parse(rule.due_dates_json), due_dates_json: undefined }));
}

function applies(rule, profile) {
  const list = String(rule.applies_to || '').split(',');
  const c = profile.federal_tax_classification;
  if (profile.has_employees === 1 && (list.includes('EMPLOYER') || list.includes('EMPLOYER_FORM_941') || list.includes('RI_EMPLOYER'))) return true;
  if (list.includes('BUSINESS_PAYER')) return true;
  if (c === 'SOLE_PROPRIETOR' && (list.includes('SOLE_PROPRIETOR') || list.includes('RI_INDIVIDUAL'))) return true;
  if (c === 'SMLLC_DISREGARDED' && (list.includes('SMLLC_DISREGARDED') || list.includes('RI_INDIVIDUAL'))) return true;
  if (c === 'PARTNERSHIP' && (list.includes('PARTNERSHIP') || list.includes('PARTNER'))) return true;
  if (c === 'S_CORP' && (list.includes('S_CORP') || list.includes('S_CORP_SHAREHOLDER'))) return true;
  return c === 'C_CORP' && list.includes('C_CORP');
}

function enumValue(value, allowed, name) { const v=String(value??'').trim().toUpperCase(); if(!allowed.includes(v)) throw Object.assign(new Error(`${name} must be one of: ${allowed.join(', ')}`),{status:400}); return v; }
function boolInt(value,name){ if(value==null||value==='') return null; if(value===true||value===1||value==='1') return 1; if(value===false||value===0||value==='0') return 0; throw Object.assign(new Error(`${name} must be boolean or null`),{status:400}); }
function text(value){ return value==null||String(value).trim()===''?null:String(value).trim().slice(0,200); }
function normalizeYear(value){ const y=Number(value); if(!Number.isInteger(y)||y<2020||y>2100) throw Object.assign(new Error('invalid tax year'),{status:400}); return y; }
function parse(value){ if(!value) return null; try{return JSON.parse(value);}catch{return null;} }
