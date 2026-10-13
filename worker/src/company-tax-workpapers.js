import { periodBounds, previousCompletedQuarter, normalizeYear, normalizeQuarter } from './tax-periods.js';
import { companyAutomationState } from './company-tax-profile.js';

export async function generateBuiltegrityTaxWorkpaper(env, input = {}) {
  const periodType = String(input.period_type || '').toUpperCase();
  if (!['QUARTER','YEAR'].includes(periodType)) throw Object.assign(new Error('period_type must be QUARTER or YEAR'), { status: 400 });
  const taxYear = normalizeYear(input.tax_year);
  const quarter = periodType === 'QUARTER' ? normalizeQuarter(input.quarter) : null;
  const period = periodBounds(taxYear, quarter);
  const id = periodType === 'QUARTER' ? `BTW-${taxYear}-Q${quarter}` : `BTW-${taxYear}-YEAR`;
  const existing = await env.DB.prepare(`SELECT * FROM builtegrity_tax_workpapers WHERE id=?`).bind(id).first();
  if (existing) return hydrate(existing);

  const profile = await env.DB.prepare(`SELECT * FROM builtegrity_tax_profile WHERE id='GLOBAL'`).first();
  if (!profile) throw new Error('Builtegrity tax profile is missing');
  const economics = await env.DB.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN basis='ACTUAL' AND entry_kind='REVENUE' THEN amount_micros ELSE 0 END),0) AS revenue,
      COALESCE(SUM(CASE WHEN basis='ACTUAL' AND entry_kind='ADJUSTMENT' THEN amount_micros ELSE 0 END),0) AS adjustment,
      COALESCE(SUM(CASE WHEN basis='ACTUAL' AND entry_kind='PARTNER_SHARE' THEN amount_micros ELSE 0 END),0) AS partner_share,
      COALESCE(SUM(CASE WHEN basis='ACTUAL' AND entry_kind='COST' THEN amount_micros ELSE 0 END),0) AS cost
      FROM transaction_economics_ledger
     WHERE datetime(created_at)>=datetime(?) AND datetime(created_at)<datetime(?)
  `).bind(period.start, period.endExclusive).first();

  const revenue = Number(economics?.revenue || 0);
  const adjustment = Number(economics?.adjustment || 0);
  const partnerShare = Number(economics?.partner_share || 0);
  const cost = Number(economics?.cost || 0);
  const contribution = revenue + adjustment - partnerShare - cost;
  const automationState = companyAutomationState(profile);
  const ready = ['READY_FOR_CALCULATION','READY_FOR_PROVIDER_REVIEW'].includes(automationState);
  const snapshot = {
    kind: 'BUILTEGRITY_TAX_WORKPAPER', id, period_type: periodType, tax_year: taxYear, quarter,
    period_start: period.start, period_end_exclusive: period.endExclusive,
    profile: {
      legal_entity_status: profile.legal_entity_status,
      federal_tax_classification: profile.federal_tax_classification,
      home_state: profile.home_state,
      has_employees: profile.has_employees,
      federal_payroll_return: profile.federal_payroll_return,
      accounting_data_status: profile.accounting_data_status,
      prior_year_tax_data_status: profile.prior_year_tax_data_status,
      filing_authorization_status: profile.filing_authorization_status,
    },
    tracked_platform_economics: {
      actual_revenue_micros: revenue,
      actual_adjustment_micros: adjustment,
      actual_partner_share_micros: partnerShare,
      actual_cost_micros: cost,
      tracked_contribution_micros: contribution,
    },
    estimated_tax_amount_micros: null,
    automation_state: automationState,
    disclaimer: 'Tracked Builtegrity economics are bookkeeping evidence, not taxable income. A tax amount requires a confirmed entity classification, complete verified books and prior-year tax inputs.',
  };

  await env.DB.prepare(`
    INSERT INTO builtegrity_tax_workpapers
      (id,period_type,tax_year,quarter,period_start,period_end_exclusive,status,
       profile_status_snapshot,federal_tax_classification_snapshot,accounting_data_status_snapshot,
       actual_revenue_micros,actual_adjustment_micros,actual_partner_share_micros,actual_cost_micros,
       tracked_contribution_micros,estimated_tax_amount_micros,automation_state,snapshot_json,generated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
  `).bind(
    id, periodType, taxYear, quarter, period.start, period.endExclusive,
    ready ? 'READY_FOR_PROVIDER' : 'NEEDS_REVIEW',
    profile.legal_entity_status, profile.federal_tax_classification, profile.accounting_data_status,
    revenue, adjustment, partnerShare, cost, contribution, null, automationState, JSON.stringify(snapshot),
  ).run();
  return hydrate(await env.DB.prepare(`SELECT * FROM builtegrity_tax_workpapers WHERE id=?`).bind(id).first());
}

export async function runBuiltegrityTaxWorkpaperPipeline(env, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid tax workpaper pipeline clock');
  const completed = previousCompletedQuarter(now);
  const quarter = await generateBuiltegrityTaxWorkpaper(env, {
    period_type: 'QUARTER', tax_year: completed.year, quarter: completed.quarter,
  });
  let year = null;
  if (now.getUTCMonth() === 0) {
    year = await generateBuiltegrityTaxWorkpaper(env, { period_type: 'YEAR', tax_year: now.getUTCFullYear() - 1 });
  }
  return { quarter, year };
}

export async function listBuiltegrityTaxWorkpapers(env, options = {}) {
  const year = options.taxYear ? normalizeYear(options.taxYear) : null;
  const result = year
    ? await env.DB.prepare(`SELECT * FROM builtegrity_tax_workpapers WHERE tax_year=? ORDER BY period_type,quarter`).bind(year).all()
    : await env.DB.prepare(`SELECT * FROM builtegrity_tax_workpapers ORDER BY tax_year DESC,period_type,quarter LIMIT 100`).all();
  return (result.results || []).map(hydrate);
}

function hydrate(row) {
  if (!row) return null;
  return { ...row, snapshot: parse(row.snapshot_json) };
}
function parse(value) { if (!value) return null; try { return JSON.parse(value); } catch { return null; } }
