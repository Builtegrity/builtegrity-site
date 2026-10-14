const SUPPORTED_DENSITY_MODES = new Set(['FLAT', 'BANDS']);
const SUPPORTED_PRICING_MODELS = new Set(['LEGACY_FLOOR', 'AMOUNT_BANDS']);
const MICROS_PER_CENT = 10000;

export function calculateFeeCents(amountCents, rule) {
  const amount = Number(amountCents);
  const percentageBps = Number(rule?.percentage_bps);
  const minimumCents = Number(rule?.minimum_cents);
  const maximumCents = Number(rule?.maximum_cents);

  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Pricing requires a positive integer amount_cents');
  if (!Number.isSafeInteger(percentageBps) || percentageBps < 0) throw new Error('Pricing percentage_bps is invalid');
  if (!Number.isSafeInteger(minimumCents) || minimumCents < 0) throw new Error('Pricing minimum_cents is invalid');
  if (!Number.isSafeInteger(maximumCents) || maximumCents < minimumCents) throw new Error('Pricing maximum_cents is invalid');

  const percentageCents = Math.floor((amount * percentageBps + 5000) / 10000);
  const beforeChargeLimit = Math.min(maximumCents, Math.max(minimumCents, percentageCents));
  return Math.min(amount, beforeChargeLimit);
}

export function calculateAmountBandFee(amountCents, rule, band) {
  const amount = Number(amountCents);
  const percentageBps = Number(rule?.percentage_bps);
  const baseFeeCents = Number(band?.base_fee_cents);
  const uncapped = Number(rule?.uncapped || 0) === 1;
  const maximumCents = Number(rule?.maximum_cents);

  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Pricing requires a positive integer amount_cents');
  if (!Number.isSafeInteger(percentageBps) || percentageBps < 0) throw new Error('Pricing percentage_bps is invalid');
  if (!Number.isSafeInteger(baseFeeCents) || baseFeeCents < 0) throw new Error('Pricing base fee is invalid');
  if (!uncapped && (!Number.isSafeInteger(maximumCents) || maximumCents < 0)) throw new Error('Pricing maximum_cents is invalid');

  // amount is cents. amount_cents * basis_points equals exact dollar micros.
  // Example: 99 cents * 10 bps = 990 micros = 0.099 cent.
  const percentageMicros = amount * percentageBps;
  let feeMicros = (baseFeeCents * MICROS_PER_CENT) + percentageMicros;
  if (!Number.isSafeInteger(feeMicros) || feeMicros < 0) throw new Error('Calculated pricing exceeds safe integer precision');
  if (!uncapped) feeMicros = Math.min(feeMicros, maximumCents * MICROS_PER_CENT);

  // Never round the merchant upward. Stripe receives whole cents. A residual becomes
  // economically entitled only after the transaction reaches PROTECTED; it can then be
  // carried forward exactly and collected on a later PROTECTED payment.
  const processorCents = Math.min(amount, Math.floor(feeMicros / MICROS_PER_CENT));
  const residualMicros = Math.max(0, feeMicros - (processorCents * MICROS_PER_CENT));

  return {
    base_fee_cents: baseFeeCents,
    percentage_fee_micros: percentageMicros,
    fee_micros: feeMicros,
    processor_fee_cents: processorCents,
    residual_micros: residualMicros,
    uncapped,
  };
}

export async function getActivePricingVersion(env, currency = 'USD') {
  const normalizedCurrency = String(currency || 'USD').toUpperCase();
  const pricing = await env.DB.prepare(`
    SELECT *
    FROM pricing_versions
    WHERE status = 'ACTIVE' AND currency = ? AND datetime(effective_from) <= CURRENT_TIMESTAMP
    ORDER BY datetime(effective_from) DESC, datetime(created_at) DESC, id DESC
    LIMIT 1
  `).bind(normalizedCurrency).first();

  if (!pricing) throw statusError(`No active Builtegrity pricing version exists for ${normalizedCurrency}`, 409);
  const pricingModel = String(pricing.pricing_model || 'LEGACY_FLOOR').toUpperCase();
  const densityMode = String(pricing.density_mode || 'FLAT').toUpperCase();
  if (!SUPPORTED_PRICING_MODELS.has(pricingModel)) throw new Error(`Unsupported pricing model: ${pricingModel}`);
  if (!SUPPORTED_DENSITY_MODES.has(densityMode)) throw new Error(`Unsupported pricing density mode: ${densityMode}`);
  return { ...pricing, pricing_model: pricingModel, density_mode: densityMode };
}

async function getAmountBand(env, pricingVersionId, amountCents) {
  const band = await env.DB.prepare(`
    SELECT * FROM pricing_amount_bands
    WHERE pricing_version_id = ?
      AND min_amount_cents <= ?
      AND (max_amount_cents IS NULL OR max_amount_cents >= ?)
    ORDER BY min_amount_cents DESC
    LIMIT 1
  `).bind(pricingVersionId, amountCents, amountCents).first();
  if (!band) throw statusError(`No amount pricing band covers ${amountCents} cents`, 409);
  return band;
}

export async function priceTransaction(env, amountCents, options = {}) {
  const currency = String(options.currency || 'USD').toUpperCase();
  const pricing = await getActivePricingVersion(env, currency);

  if (pricing.pricing_model === 'AMOUNT_BANDS') {
    const band = await getAmountBand(env, pricing.id, amountCents);
    const quote = calculateAmountBandFee(amountCents, pricing, band);
    return {
      pricing_version_id: pricing.id,
      pricing_percentage_bps: Number(pricing.percentage_bps),
      pricing_minimum_cents: Number(pricing.minimum_cents),
      pricing_maximum_cents: Number(pricing.maximum_cents),
      pricing_density_band_id: null,
      pricing_amount_band_id: band.id,
      pricing_base_cents: quote.base_fee_cents,
      pricing_fee_micros: quote.fee_micros,
      integrity_fee_earned_micros: quote.fee_micros,
      pricing_fee_residual_micros: quote.residual_micros,
      pricing_uncapped: quote.uncapped ? 1 : 0,
      pricing_calculated_cents: quote.processor_fee_cents,
      integrity_fee_earned_cents: quote.processor_fee_cents,
      currency,
      pricing_locked_at: new Date().toISOString(),
    };
  }

  let minimumCents = Number(pricing.minimum_cents);
  let densityBandId = null;
  if (pricing.density_mode === 'BANDS') {
    const monthlyOrdinal = Number(options.monthlyOrdinal);
    if (!Number.isSafeInteger(monthlyOrdinal) || monthlyOrdinal < 1) throw statusError('Band-based pricing requires a deterministic monthly transaction ordinal', 409);
    const band = await env.DB.prepare(`
      SELECT * FROM pricing_density_bands
      WHERE pricing_version_id = ? AND start_ordinal <= ?
        AND (end_ordinal IS NULL OR end_ordinal >= ?)
      ORDER BY start_ordinal DESC LIMIT 1
    `).bind(pricing.id, monthlyOrdinal, monthlyOrdinal).first();
    if (!band) throw statusError(`No density band covers ordinal ${monthlyOrdinal} for ${pricing.id}`, 409);
    minimumCents = Number(band.minimum_cents);
    densityBandId = band.id;
  }

  const feeCents = calculateFeeCents(amountCents, {
    percentage_bps: Number(pricing.percentage_bps),
    minimum_cents: minimumCents,
    maximum_cents: Number(pricing.maximum_cents),
  });

  return {
    pricing_version_id: pricing.id,
    pricing_percentage_bps: Number(pricing.percentage_bps),
    pricing_minimum_cents: minimumCents,
    pricing_maximum_cents: Number(pricing.maximum_cents),
    pricing_density_band_id: densityBandId,
    pricing_amount_band_id: null,
    pricing_base_cents: 0,
    pricing_fee_micros: feeCents * MICROS_PER_CENT,
    integrity_fee_earned_micros: feeCents * MICROS_PER_CENT,
    pricing_fee_residual_micros: 0,
    pricing_uncapped: Number(pricing.uncapped || 0),
    pricing_calculated_cents: feeCents,
    integrity_fee_earned_cents: feeCents,
    currency,
    pricing_locked_at: new Date().toISOString(),
  };
}

export async function reserveAvailableFeeCarry(env, transactionId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tx = await env.DB.prepare(`
      SELECT id, merchant_id, currency, amount_cents, pricing_calculated_cents,
             pricing_carry_reserved_cents, pricing_carry_settled_cents,
             pricing_carry_released_at, pricing_carry_settlement_confirmed_at,
             stripe_checkout_session_id, payment_at, record_classification
      FROM transactions WHERE id = ?
    `).bind(transactionId).first();
    if (!tx) throw statusError('Transaction not found while reserving fee carry', 404);
    if (
      tx.payment_at ||
      tx.stripe_checkout_session_id ||
      tx.pricing_carry_released_at ||
      tx.pricing_carry_settlement_confirmed_at ||
      tx.record_classification === 'PROTECTED' ||
      Number(tx.pricing_carry_settled_cents || 0) > 0
    ) return tx;
    if (Number(tx.pricing_carry_reserved_cents || 0) > 0) return tx;

    const balance = await env.DB.prepare(`
      SELECT available_micros FROM merchant_fee_carry WHERE merchant_id = ? AND currency = ?
    `).bind(tx.merchant_id, tx.currency).first();
    const availableWholeCents = Math.floor(Number(balance?.available_micros || 0) / MICROS_PER_CENT);
    const currentFee = Number(tx.pricing_calculated_cents || 0);
    const capacity = Math.max(0, Number(tx.amount_cents || 0) - currentFee);
    const reserveCents = Math.min(availableWholeCents, capacity);
    if (reserveCents <= 0) return tx;

    try {
      await env.DB.prepare(`
        UPDATE transactions
           SET pricing_carry_reserved_cents = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND payment_at IS NULL
           AND stripe_checkout_session_id IS NULL
           AND pricing_carry_released_at IS NULL
           AND pricing_carry_settlement_confirmed_at IS NULL
           AND record_classification <> 'PROTECTED'
           AND pricing_carry_reserved_cents = 0
           AND pricing_carry_settled_cents = 0
      `).bind(reserveCents, transactionId).run();
      return await env.DB.prepare(`SELECT * FROM transactions WHERE id = ?`).bind(transactionId).first();
    } catch (error) {
      if (!String(error?.message || error).includes('insufficient merchant fee carry') || attempt === 2) throw error;
    }
  }
  return env.DB.prepare(`SELECT * FROM transactions WHERE id = ?`).bind(transactionId).first();
}

export async function releaseFeeCarryReservation(env, transactionId, reason = 'abandoned checkout') {
  const tx = await env.DB.prepare(`
    SELECT id, payment_at, record_classification,
           pricing_carry_reserved_cents, pricing_carry_settled_cents,
           pricing_carry_released_at, pricing_carry_settlement_confirmed_at
    FROM transactions WHERE id = ?
  `).bind(transactionId).first();

  const reservedCents = Number(tx?.pricing_carry_reserved_cents || 0);
  const settledCents = Number(tx?.pricing_carry_settled_cents || 0);
  const canReleaseAfterPayment = Boolean(tx?.payment_at) && tx?.record_classification === 'FEE_EXCEPTION';
  const canReleaseBeforePayment = !tx?.payment_at;

  if (
    !tx ||
    reservedCents <= 0 ||
    settledCents > 0 ||
    tx.pricing_carry_released_at ||
    tx.pricing_carry_settlement_confirmed_at ||
    tx.record_classification === 'PROTECTED' ||
    (!canReleaseBeforePayment && !canReleaseAfterPayment)
  ) {
    return { released: false };
  }

  const result = await env.DB.prepare(`
    UPDATE transactions
       SET pricing_carry_reserved_cents = 0,
           pricing_carry_released_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND pricing_carry_reserved_cents > 0
       AND pricing_carry_settled_cents = 0
       AND pricing_carry_released_at IS NULL
       AND pricing_carry_settlement_confirmed_at IS NULL
       AND record_classification <> 'PROTECTED'
       AND (payment_at IS NULL OR record_classification = 'FEE_EXCEPTION')
  `).bind(transactionId).run();

  if (Number(result.meta?.changes || 0) === 0) return { released: false };
  return { released: true, transaction_id: transactionId, reason };
}

export async function getPricingHealth(env) {
  const [floor, operations, carry] = await Promise.all([
    env.DB.prepare(`
      SELECT h.*, g.human_touch_warn_ppm, g.human_touch_critical_ppm,
             g.effective_rate_warn_bps
      FROM pricing_floor_health h
      JOIN pricing_economic_guardrails g ON g.pricing_version_id = h.pricing_version_id
      LIMIT 1
    `).first(),
    env.DB.prepare(`SELECT * FROM internal_operations_metrics LIMIT 1`).first().catch(() => null),
    env.DB.prepare(`
      SELECT COUNT(*) AS merchant_balances, COALESCE(SUM(available_micros),0) AS available_micros
      FROM merchant_fee_carry
    `).first().catch(() => null),
  ]);

  if (!floor) return null;
  const observedTouchRate = Number(operations?.human_touch_rate || 0);
  const observedTouchPpm = Math.round(observedTouchRate * 1000000);
  const warning = observedTouchPpm >= Number(floor.human_touch_warn_ppm || 1000);
  const critical = observedTouchPpm >= Number(floor.human_touch_critical_ppm || 1500);

  return {
    ...floor,
    observed_human_touch_rate: observedTouchRate,
    observed_human_touch_ppm: observedTouchPpm,
    fractional_carry: carry || null,
    status: critical ? 'CRITICAL' : warning ? 'WARN' : 'HEALTHY',
  };
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
