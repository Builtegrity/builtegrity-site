const SUPPORTED_DENSITY_MODES = new Set(['FLAT', 'BANDS']);

export function calculateFeeCents(amountCents, rule) {
  const amount = Number(amountCents);
  const percentageBps = Number(rule?.percentage_bps);
  const minimumCents = Number(rule?.minimum_cents);
  const maximumCents = Number(rule?.maximum_cents);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('Pricing requires a positive integer amount_cents');
  }
  if (!Number.isSafeInteger(percentageBps) || percentageBps < 0) {
    throw new Error('Pricing percentage_bps is invalid');
  }
  if (!Number.isSafeInteger(minimumCents) || minimumCents < 0) {
    throw new Error('Pricing minimum_cents is invalid');
  }
  if (!Number.isSafeInteger(maximumCents) || maximumCents < minimumCents) {
    throw new Error('Pricing maximum_cents is invalid');
  }

  // Half-up rounding in cents using integer math. Example: $50 x 0.15% = 7.5 cents -> 8 cents.
  const percentageCents = Math.floor((amount * percentageBps + 5000) / 10000);
  const beforeChargeLimit = Math.min(maximumCents, Math.max(minimumCents, percentageCents));

  // A platform fee may never exceed the underlying payment amount.
  return Math.min(amount, beforeChargeLimit);
}

export async function getActivePricingVersion(env, currency = 'USD') {
  const normalizedCurrency = String(currency || 'USD').toUpperCase();
  const pricing = await env.DB.prepare(`
    SELECT *
    FROM pricing_versions
    WHERE status = 'ACTIVE' AND currency = ?
    ORDER BY effective_from DESC, created_at DESC, id DESC
    LIMIT 1
  `).bind(normalizedCurrency).first();

  if (!pricing) {
    const error = new Error(`No active Builtegrity pricing version exists for ${normalizedCurrency}`);
    error.status = 409;
    throw error;
  }
  if (!SUPPORTED_DENSITY_MODES.has(pricing.density_mode)) {
    throw new Error(`Unsupported pricing density mode: ${pricing.density_mode}`);
  }
  return pricing;
}

export async function priceTransaction(env, amountCents, options = {}) {
  const currency = String(options.currency || 'USD').toUpperCase();
  const pricing = await getActivePricingVersion(env, currency);

  let minimumCents = Number(pricing.minimum_cents);
  let densityBandId = null;

  // V1 is FLAT. BANDS is retained as a future global-version capability only.
  // It requires an explicit, deterministically allocated ordinal; it never guesses from COUNT(*).
  if (pricing.density_mode === 'BANDS') {
    const monthlyOrdinal = Number(options.monthlyOrdinal);
    if (!Number.isSafeInteger(monthlyOrdinal) || monthlyOrdinal < 1) {
      const error = new Error('Band-based pricing requires a deterministic monthly transaction ordinal');
      error.status = 409;
      throw error;
    }

    const band = await env.DB.prepare(`
      SELECT *
      FROM pricing_density_bands
      WHERE pricing_version_id = ?
        AND start_ordinal <= ?
        AND (end_ordinal IS NULL OR end_ordinal >= ?)
      ORDER BY start_ordinal DESC
      LIMIT 1
    `).bind(pricing.id, monthlyOrdinal, monthlyOrdinal).first();

    if (!band) {
      const error = new Error(`No density band covers ordinal ${monthlyOrdinal} for ${pricing.id}`);
      error.status = 409;
      throw error;
    }
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
    pricing_calculated_cents: feeCents,
    integrity_fee_earned_cents: feeCents,
    currency,
    pricing_locked_at: new Date().toISOString(),
  };
}

export async function getPricingHealth(env) {
  const [floor, operations] = await Promise.all([
    env.DB.prepare(`
      SELECT h.*, g.human_touch_warn_ppm, g.human_touch_critical_ppm,
             g.effective_rate_warn_bps
      FROM pricing_floor_health h
      JOIN pricing_economic_guardrails g ON g.pricing_version_id = h.pricing_version_id
      LIMIT 1
    `).first(),
    env.DB.prepare(`SELECT * FROM internal_operations_metrics LIMIT 1`).first().catch(() => null),
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
    status: critical ? 'CRITICAL' : warning ? 'WARN' : 'HEALTHY',
  };
}
