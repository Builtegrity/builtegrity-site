import { stripeRequest } from './stripe.js';

const STAGE_RANK = { PREVIEW: 0, TEST: 1, PILOT: 2, LIVE: 3 };
const STATE_RANK = { GREEN: 0, YELLOW: 1, ORANGE: 2, UNKNOWN: 3, RED: 4 };
const MICROS_PER_CENT = 10000;
const LIVE_FINANCIAL_SOURCES = new Set(['BANK', 'ACCOUNTING', 'COMPOSITE']);

export async function recordFinancialPosition(env, input = {}, principal = null) {
  if (input.attested_complete !== true) {
    throw statusError('Financial position must explicitly attest that all known cash, commitments, near-term liabilities, reserves, debt, guarantees, and overdue critical obligations are included.', 400);
  }

  const capturedAt = normalizeTimestamp(input.captured_at) || new Date().toISOString();
  const source = String(input.source || 'MANUAL').toUpperCase();
  if (!['MANUAL', 'BANK', 'ACCOUNTING', 'COMPOSITE', 'SYSTEM_TEST'].includes(source)) {
    throw statusError('Unsupported financial position source', 400);
  }

  const values = {
    unrestrictedCash: centsToMicros(input.unrestricted_cash_cents, 'unrestricted_cash_cents', { allowNegative: true }),
    restrictedCash: centsToMicros(input.restricted_cash_cents || 0, 'restricted_cash_cents'),
    monthlyFixed: centsToMicros(input.monthly_fixed_commitments_cents || 0, 'monthly_fixed_commitments_cents'),
    due30d: centsToMicros(input.liabilities_due_30d_cents || 0, 'liabilities_due_30d_cents'),
    statutory: centsToMicros(input.statutory_reserve_required_cents || 0, 'statutory_reserve_required_cents'),
    contingency: centsToMicros(input.contingency_reserve_required_cents || 0, 'contingency_reserve_required_cents'),
    debt: centsToMicros(input.interest_bearing_debt_cents || 0, 'interest_bearing_debt_cents'),
    guarantees: centsToMicros(input.personal_guarantee_exposure_cents || 0, 'personal_guarantee_exposure_cents'),
    overdue: centsToMicros(input.overdue_critical_obligations_cents || 0, 'overdue_critical_obligations_cents'),
  };

  const id = `FINPOS-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO financial_position_snapshots (
      id, source, currency, unrestricted_cash_micros, restricted_cash_micros,
      monthly_fixed_commitments_micros, liabilities_due_30d_micros,
      statutory_reserve_required_micros, contingency_reserve_required_micros,
      interest_bearing_debt_micros, personal_guarantee_exposure_micros,
      overdue_critical_obligations_micros, attested_complete,
      actor_ref, notes, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).bind(
    id,
    source,
    String(input.currency || 'USD').toUpperCase(),
    values.unrestrictedCash,
    values.restrictedCash,
    values.monthlyFixed,
    values.due30d,
    values.statutory,
    values.contingency,
    values.debt,
    values.guarantees,
    values.overdue,
    actorRef(principal),
    String(input.notes || '').slice(0, 4000) || null,
    capturedAt,
  ).run();

  const safety = await evaluateFinancialSafety(env, { refreshProcessorBalance: true });
  return { snapshot_id: id, safety };
}

export async function recordFinancialModelReview(env, input = {}, principal = null) {
  if (input.reviewed_provider_pricing !== true || input.reviewed_processor_responsibility !== true) {
    throw statusError('Model review must confirm both current provider pricing and processor responsibility assumptions were reviewed.', 400);
  }

  const [pricing, costModel] = await Promise.all([
    env.DB.prepare(`SELECT id FROM pricing_versions WHERE status='ACTIVE' ORDER BY effective_from DESC LIMIT 1`).first(),
    env.DB.prepare(`SELECT id FROM transaction_cost_models WHERE status='ACTIVE' ORDER BY created_at DESC, id DESC LIMIT 1`).first(),
  ]);
  if (!pricing || !costModel) throw statusError('Active pricing version and cost model are required before financial model review.', 409);

  const reviewedAt = normalizeTimestamp(input.reviewed_at) || new Date().toISOString();
  const id = `FMR-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO financial_model_reviews (
      id, pricing_version_id, cost_model_id,
      reviewed_provider_pricing, reviewed_processor_responsibility,
      actor_ref, notes, reviewed_at
    ) VALUES (?, ?, ?, 1, 1, ?, ?, ?)
  `).bind(
    id,
    pricing.id,
    costModel.id,
    actorRef(principal),
    String(input.notes || '').slice(0, 4000) || null,
    reviewedAt,
  ).run();

  const safety = await evaluateFinancialSafety(env, { refreshProcessorBalance: true });
  return { review_id: id, safety };
}

export async function refreshStripePlatformBalance(env) {
  if (!env.STRIPE_SECRET_KEY) throw statusError('Stripe platform balance cannot be checked without STRIPE_SECRET_KEY', 503);
  const balance = await stripeRequest(env, '/v1/balance');
  const capturedAt = new Date().toISOString();
  const currencies = new Set([
    ...(balance.available || []).map((row) => String(row.currency || '').toLowerCase()),
    ...(balance.pending || []).map((row) => String(row.currency || '').toLowerCase()),
    ...(balance.connect_reserved || []).map((row) => String(row.currency || '').toLowerCase()),
  ].filter(Boolean));
  if (currencies.size === 0) currencies.add('usd');

  const rows = [];
  for (const currency of currencies) {
    const availableCents = sumCurrency(balance.available, currency);
    const pendingCents = sumCurrency(balance.pending, currency);
    const reservedCents = sumCurrency(balance.connect_reserved, currency);
    const id = `PBAL-${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO processor_platform_balance_snapshots (
        id, processor, currency, available_micros, pending_micros,
        connect_reserved_micros, livemode, captured_at
      ) VALUES (?, 'STRIPE', ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      currency.toUpperCase(),
      availableCents * MICROS_PER_CENT,
      pendingCents * MICROS_PER_CENT,
      reservedCents * MICROS_PER_CENT,
      balance.livemode === true ? 1 : balance.livemode === false ? 0 : null,
      capturedAt,
    ).run();
    rows.push({ id, currency: currency.toUpperCase(), available_cents: availableCents, pending_cents: pendingCents, connect_reserved_cents: reservedCents });
  }
  return { captured_at: capturedAt, balances: rows };
}

export async function evaluateFinancialSafety(env, options = {}) {
  const policy = await env.DB.prepare(`SELECT * FROM financial_safety_policy WHERE id='GLOBAL'`).first();
  if (!policy) throw new Error('Financial safety policy is not initialized');

  let processorRefreshError = null;
  if (options.refreshProcessorBalance !== false && env.STRIPE_SECRET_KEY) {
    try {
      await refreshStripePlatformBalance(env);
    } catch (error) {
      processorRefreshError = String(error?.message || error || 'Stripe platform balance refresh failed').slice(0, 1000);
    }
  }

  const [position, modelReview, processor, floor, operations, unsafeActive] = await Promise.all([
    env.DB.prepare(`
      SELECT * FROM financial_position_snapshots
      WHERE attested_complete=1 AND currency='USD'
      ORDER BY captured_at DESC, created_at DESC LIMIT 1
    `).first(),
    env.DB.prepare(`
      SELECT * FROM financial_model_reviews
      WHERE reviewed_provider_pricing=1 AND reviewed_processor_responsibility=1
      ORDER BY reviewed_at DESC, created_at DESC LIMIT 1
    `).first(),
    env.DB.prepare(`
      SELECT * FROM processor_platform_balance_snapshots
      WHERE processor='STRIPE' AND currency='USD'
      ORDER BY captured_at DESC, created_at DESC LIMIT 1
    `).first(),
    env.DB.prepare(`SELECT * FROM pricing_floor_health LIMIT 1`).first(),
    env.DB.prepare(`SELECT * FROM internal_operations_metrics LIMIT 1`).first().catch(() => null),
    env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM merchants
      WHERE status='ACTIVE' AND integration_mode='STRIPE_CONNECT'
        AND (stripe_fee_payer IS NOT 'stripe' OR stripe_loss_liability IS NOT 'stripe')
    `).first(),
  ]);

  const stage = String(env.WATCHDOG_STAGE || 'PREVIEW').toUpperCase();
  const enforcementActive = stageRank(stage) >= stageRank(String(policy.enforcement_stage || 'PILOT').toUpperCase());
  const now = Date.now();
  const reasons = [];
  let state = 'GREEN';
  let merchantOnboardingAllowed = true;
  let transactionCreationAllowed = true;
  let paymentCreationAllowed = true;

  const worsen = (nextState, code, flags = {}) => {
    if (STATE_RANK[nextState] > STATE_RANK[state]) state = nextState;
    if (code && !reasons.includes(code)) reasons.push(code);
    if (flags.onboarding === false) merchantOnboardingAllowed = false;
    if (flags.transactions === false) transactionCreationAllowed = false;
    if (flags.payments === false) paymentCreationAllowed = false;
  };

  const positionAgeHours = ageHours(position?.captured_at, now);
  const modelAgeDays = ageHours(modelReview?.reviewed_at, now) / 24;
  const processorAgeMinutes = ageHours(processor?.captured_at, now) * 60;

  if (!position || !Number.isFinite(positionAgeHours) || positionAgeHours > Number(policy.position_max_age_hours)) {
    worsen('UNKNOWN', position ? 'FINANCIAL_POSITION_STALE' : 'FINANCIAL_POSITION_MISSING', {
      onboarding: false,
      transactions: false,
    });
  }

  // Manual attestations are a PILOT bridge, not a scaled-production control.
  if (stage === 'LIVE' && position && !LIVE_FINANCIAL_SOURCES.has(String(position.source || '').toUpperCase())) {
    worsen('UNKNOWN', 'LIVE_AUTOMATED_FINANCIAL_SOURCE_REQUIRED', {
      onboarding: false,
      transactions: false,
    });
  }

  if (!modelReview || !Number.isFinite(modelAgeDays) || modelAgeDays > Number(policy.model_review_max_age_days)) {
    worsen('UNKNOWN', modelReview ? 'ECONOMIC_MODEL_REVIEW_STALE' : 'ECONOMIC_MODEL_REVIEW_MISSING', {
      onboarding: false,
      transactions: false,
    });
  }

  if (processorRefreshError) {
    worsen('YELLOW', 'PROCESSOR_BALANCE_REFRESH_FAILED');
  }
  if (!processor || !Number.isFinite(processorAgeMinutes) || processorAgeMinutes > Number(policy.processor_balance_max_age_minutes)) {
    worsen('UNKNOWN', processor ? 'PROCESSOR_BALANCE_STALE' : 'PROCESSOR_BALANCE_MISSING', {
      onboarding: false,
      transactions: false,
      payments: false,
    });
  }

  const floorContribution = Number(floor?.floor_planning_contribution_micros);
  const floorMargin = Number(floor?.floor_planning_margin_ppm);
  if (!floor || !Number.isFinite(floorContribution) || !Number.isFinite(floorMargin)) {
    worsen('UNKNOWN', 'UNIT_ECONOMICS_UNAVAILABLE', { onboarding: false, transactions: false, payments: false });
  } else if (floorContribution <= 0 || floorMargin < Number(policy.minimum_floor_margin_ppm)) {
    worsen('RED', 'UNIT_ECONOMICS_BELOW_SAFETY_FLOOR', { onboarding: false, transactions: false, payments: false });
  }

  const humanTouchRate = Number(operations?.human_touch_rate || 0);
  const humanTouchPpm = Math.max(0, Math.round(humanTouchRate * 1000000));
  if (humanTouchPpm >= Number(policy.human_touch_red_ppm)) {
    worsen('RED', 'HUMAN_TOUCH_RATE_NEAR_ECONOMIC_CLIFF', { onboarding: false, transactions: false });
  } else if (humanTouchPpm >= Number(policy.human_touch_orange_ppm)) {
    worsen('ORANGE', 'HUMAN_TOUCH_RATE_TOO_HIGH', { onboarding: false, transactions: false });
  }

  const processorAvailable = processor ? Number(processor.available_micros || 0) : null;
  const processorPending = processor ? Number(processor.pending_micros || 0) : null;
  const processorReserved = processor ? Number(processor.connect_reserved_micros || 0) : null;
  if (processor && processorAvailable < 0) {
    worsen('RED', 'PROCESSOR_PLATFORM_BALANCE_NEGATIVE', { onboarding: false, transactions: false, payments: false });
  }
  if (processor && processorReserved > 0) {
    worsen('YELLOW', 'PROCESSOR_CONNECT_RESERVE_PRESENT');
  }

  if (Number(unsafeActive?.count || 0) > 0) {
    worsen('RED', 'ACTIVE_MERCHANT_PROCESSOR_RESPONSIBILITY_UNSAFE', { onboarding: false, transactions: false, payments: false });
  }

  let reserveRequired = null;
  let reserveSurplus = null;
  let runwayMonths = null;
  if (position) {
    const unrestricted = Number(position.unrestricted_cash_micros || 0);
    const monthlyFixed = Number(position.monthly_fixed_commitments_micros || 0);
    const nearTerm = Number(position.liabilities_due_30d_micros || 0) +
      Number(position.statutory_reserve_required_micros || 0) +
      Number(position.contingency_reserve_required_micros || 0);
    reserveRequired = nearTerm + monthlyFixed * Number(policy.target_reserve_months);
    reserveSurplus = unrestricted - reserveRequired;
    const cashAfterNearTerm = unrestricted - nearTerm;
    runwayMonths = monthlyFixed > 0 ? cashAfterNearTerm / monthlyFixed : (cashAfterNearTerm >= 0 ? 999 : -999);

    if (Number(policy.forbid_interest_bearing_debt) === 1 && Number(position.interest_bearing_debt_micros || 0) > 0) {
      worsen('RED', 'INTEREST_BEARING_DEBT_PRESENT', { onboarding: false, transactions: false });
    }
    if (Number(policy.forbid_personal_guarantees) === 1 && Number(position.personal_guarantee_exposure_micros || 0) > 0) {
      worsen('RED', 'PERSONAL_GUARANTEE_EXPOSURE_PRESENT', { onboarding: false, transactions: false });
    }
    if (Number(position.overdue_critical_obligations_micros || 0) > 0) {
      worsen('RED', 'CRITICAL_OBLIGATION_OVERDUE', { onboarding: false, transactions: false });
    }
    if (cashAfterNearTerm < 0 || runwayMonths < Number(policy.red_reserve_months)) {
      worsen('RED', 'LESS_THAN_ONE_MONTH_SAFE_RESERVE', { onboarding: false, transactions: false });
    } else if (runwayMonths < Number(policy.warning_reserve_months)) {
      worsen('ORANGE', 'LESS_THAN_TWO_MONTHS_SAFE_RESERVE', { onboarding: false });
    } else if (runwayMonths < Number(policy.target_reserve_months)) {
      worsen('YELLOW', 'BELOW_THREE_MONTH_RESERVE_TARGET');
    }
  }

  const metrics = {
    stage,
    financial_position_source: position?.source || null,
    position_age_hours: finiteOrNull(positionAgeHours),
    model_review_age_days: finiteOrNull(modelAgeDays),
    processor_balance_age_minutes: finiteOrNull(processorAgeMinutes),
    processor_refresh_error: processorRefreshError,
    unrestricted_cash_micros: position ? Number(position.unrestricted_cash_micros || 0) : null,
    monthly_fixed_commitments_micros: position ? Number(position.monthly_fixed_commitments_micros || 0) : null,
    liabilities_due_30d_micros: position ? Number(position.liabilities_due_30d_micros || 0) : null,
    statutory_reserve_required_micros: position ? Number(position.statutory_reserve_required_micros || 0) : null,
    contingency_reserve_required_micros: position ? Number(position.contingency_reserve_required_micros || 0) : null,
    reserve_required_micros: reserveRequired,
    reserve_surplus_micros: reserveSurplus,
    runway_months: runwayMonths,
    processor_available_micros: processorAvailable,
    processor_pending_micros: processorPending,
    processor_connect_reserved_micros: processorReserved,
    floor_planning_contribution_micros: Number.isFinite(floorContribution) ? floorContribution : null,
    floor_planning_margin_ppm: Number.isFinite(floorMargin) ? floorMargin : null,
    observed_human_touch_ppm: humanTouchPpm,
    unsafe_active_merchant_count: Number(unsafeActive?.count || 0),
  };

  const evaluatedAt = new Date().toISOString();
  const evaluationId = `FSE-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    UPDATE financial_safety_state
       SET state=?, enforcement_active=?, merchant_onboarding_allowed=?,
           transaction_creation_allowed=?, payment_creation_allowed=?,
           reason_codes_json=?, latest_position_at=?, latest_model_review_at=?, latest_processor_balance_at=?,
           unrestricted_cash_micros=?, reserve_required_micros=?, reserve_surplus_micros=?, runway_months=?,
           processor_available_micros=?, processor_pending_micros=?, processor_connect_reserved_micros=?,
           floor_planning_contribution_micros=?, floor_planning_margin_ppm=?, observed_human_touch_ppm=?,
           evaluated_at=?
     WHERE id='GLOBAL'
  `).bind(
    state,
    enforcementActive ? 1 : 0,
    merchantOnboardingAllowed ? 1 : 0,
    transactionCreationAllowed ? 1 : 0,
    paymentCreationAllowed ? 1 : 0,
    JSON.stringify(reasons),
    position?.captured_at || null,
    modelReview?.reviewed_at || null,
    processor?.captured_at || null,
    metrics.unrestricted_cash_micros,
    reserveRequired,
    reserveSurplus,
    runwayMonths,
    processorAvailable,
    processorPending,
    processorReserved,
    metrics.floor_planning_contribution_micros,
    metrics.floor_planning_margin_ppm,
    humanTouchPpm,
    evaluatedAt,
  ).run();

  await env.DB.prepare(`
    INSERT INTO financial_safety_evaluations (
      id, state, enforcement_active, merchant_onboarding_allowed,
      transaction_creation_allowed, payment_creation_allowed,
      reason_codes_json, metrics_json, evaluated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    evaluationId,
    state,
    enforcementActive ? 1 : 0,
    merchantOnboardingAllowed ? 1 : 0,
    transactionCreationAllowed ? 1 : 0,
    paymentCreationAllowed ? 1 : 0,
    JSON.stringify(reasons),
    JSON.stringify(metrics),
    evaluatedAt,
  ).run();

  return {
    state,
    enforcement_active: enforcementActive,
    merchant_onboarding_allowed: merchantOnboardingAllowed,
    transaction_creation_allowed: transactionCreationAllowed,
    payment_creation_allowed: paymentCreationAllowed,
    reason_codes: reasons,
    metrics,
    evaluated_at: evaluatedAt,
  };
}

export async function getFinancialSafetyStatus(env) {
  const [state, position, review, processor] = await Promise.all([
    env.DB.prepare(`SELECT * FROM financial_safety_dashboard WHERE id='GLOBAL'`).first(),
    env.DB.prepare(`SELECT * FROM financial_position_snapshots WHERE attested_complete=1 AND currency='USD' ORDER BY captured_at DESC LIMIT 1`).first(),
    env.DB.prepare(`SELECT * FROM financial_model_reviews ORDER BY reviewed_at DESC LIMIT 1`).first(),
    env.DB.prepare(`SELECT * FROM processor_platform_balance_snapshots WHERE processor='STRIPE' AND currency='USD' ORDER BY captured_at DESC LIMIT 1`).first(),
  ]);
  if (!state) return null;
  return {
    ...state,
    reason_codes: safeJson(state.reason_codes_json, []),
    latest_position: position || null,
    latest_model_review: review || null,
    latest_processor_balance: processor || null,
  };
}

export function assertMerchantProcessorEconomicsSafe(merchant) {
  if (!merchant) throw statusError('Merchant not found', 404);
  if (merchant.integration_mode !== 'STRIPE_CONNECT') return;
  if (merchant.status !== 'ACTIVE') {
    throw statusError(`Merchant ${merchant.id} is not ACTIVE and cannot create protected transactions`, 409);
  }
  if (merchant.stripe_fee_payer !== 'stripe') {
    throw statusError(`Merchant ${merchant.id} cannot activate because Stripe processing fees are not confirmed as Stripe/merchant-paid`, 409);
  }
  if (merchant.stripe_loss_liability !== 'stripe') {
    throw statusError(`Merchant ${merchant.id} cannot activate because connected-account payment losses are not confirmed as Stripe-owned`, 409);
  }
}

function stageRank(stage) {
  return STAGE_RANK[stage] ?? 0;
}

function centsToMicros(value, label, options = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw statusError(`${label} must be an integer number of cents`, 400);
  if (!options.allowNegative && number < 0) throw statusError(`${label} cannot be negative`, 400);
  return number * MICROS_PER_CENT;
}

function actorRef(principal) {
  return String(principal?.sub || principal?.email || principal?.user_id || 'operator').slice(0, 500);
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw statusError('Invalid timestamp', 400);
  return new Date(time).toISOString();
}

function ageHours(value, now = Date.now()) {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now - time) / 3600000);
}

function sumCurrency(rows, currency) {
  return (rows || [])
    .filter((row) => String(row.currency || '').toLowerCase() === currency)
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function safeJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
