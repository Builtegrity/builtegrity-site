import { allocateId, parseJson } from './db.js';

const DISPLAY_MODES = new Set(['SHOW', 'SUMMARY', 'HIDE']);
const ALERT_MODES = new Set(['EXCEPTIONS_ONLY', 'MATERIAL_CHANGES', 'ALL']);
const FORBIDDEN_PREFERENCE_KEYS = new Set([
  'accounting_required', 'capture_enabled', 'accounting_enabled', 'reconciliation_enabled',
  'retain_history', 'delete_history', 'ignore_component',
]);

const HEURISTICS = [
  [/processing|processor|card processing|merchant fee/, 'PROCESSOR_FEE'],
  [/authorization fee|auth fee/, 'AUTHORIZATION_FEE'],
  [/payout fee|instant payout/, 'PAYOUT_FEE'],
  [/sales tax/, 'SALES_TAX'],
  [/local tax|city tax|municipal tax/, 'LOCAL_TAX'],
  [/excise/, 'EXCISE_TAX'],
  [/\bvat\b/, 'VAT'],
  [/employee tip|staff tip|gratuity/, 'EMPLOYEE_TIP'],
  [/pooled tip|tip pool/, 'POOLED_TIP'],
  [/courier tip|driver tip/, 'COURIER_TIP'],
  [/service charge/, 'SERVICE_CHARGE'],
  [/convenience fee/, 'CONVENIENCE_FEE'],
  [/booking fee|reservation fee/, 'BOOKING_FEE'],
  [/delivery charge/, 'DELIVERY_CHARGE'],
  [/shipping charge/, 'SHIPPING_CHARGE'],
  [/rush fee|expedite/, 'RUSH_FEE'],
  [/surcharge/, 'CARD_SURCHARGE'],
  [/marketplace commission/, 'MARKETPLACE_COMMISSION'],
  [/delivery.*commission|commission.*delivery/, 'DELIVERY_PLATFORM_COMMISSION'],
  [/platform commission/, 'PLATFORM_COMMISSION'],
  [/referral fee|lead fee/, 'REFERRAL_FEE'],
  [/builtegrity|integrity fee/, 'INTEGRITY_FEE'],
  [/franchise.*royalty|royalty/, 'FRANCHISE_ROYALTY'],
  [/franchise.*marketing|brand.*marketing fee/, 'FRANCHISE_MARKETING_FEE'],
  [/franchise.*tech|technology fee/, 'FRANCHISE_TECH_FEE'],
  [/rolling reserve/, 'ROLLING_RESERVE'],
  [/processor reserve|reserve hold/, 'PROCESSOR_RESERVE'],
  [/temporary hold|payment hold/, 'TEMPORARY_HOLD'],
  [/tax withholding|withholding tax/, 'TAX_WITHHOLDING'],
  [/statutory|regulatory fee/, 'STATUTORY_FEE'],
  [/employee commission|sales commission/, 'EMPLOYEE_COMMISSION'],
  [/courier cost/, 'COURIER_COST'],
  [/delivery platform cost|delivery partner cost/, 'DELIVERY_PLATFORM_COST'],
  [/shipping cost/, 'SHIPPING_COST'],
  [/gift card/, 'GIFT_CARD_REDEMPTION'],
  [/store credit/, 'STORE_CREDIT_REDEMPTION'],
  [/loyalty.*redeem|points.*redeem/, 'LOYALTY_REDEMPTION'],
  [/promotional credit|promo credit/, 'PROMOTIONAL_CREDIT'],
  [/bnpl|buy now pay later/, 'BNPL_FEE'],
  [/financing fee|finance fee/, 'FINANCING_FEE'],
  [/fx fee|foreign exchange/, 'FX_FEE'],
  [/rounding/, 'ROUNDING_ADJUSTMENT'],
  [/reconciliation adjustment/, 'RECONCILIATION_ADJUSTMENT'],
];

export async function ensureMerchantTransactionProfile(env, merchantId) {
  const merchant = await env.DB.prepare(`SELECT id FROM merchants WHERE id = ?`).bind(merchantId).first();
  if (!merchant) throw notFound(`Merchant not found: ${merchantId}`);

  await env.DB.prepare(`
    INSERT OR IGNORE INTO merchant_transaction_profiles (merchant_id)
    VALUES (?)
  `).bind(merchantId).run();

  await env.DB.prepare(`
    INSERT OR IGNORE INTO merchant_profile_modules (merchant_id, module_code, activation_state)
    SELECT ?, code, 'MANDATORY' FROM transaction_modules WHERE mandatory = 1
  `).bind(merchantId).run();

  return env.DB.prepare(`SELECT * FROM merchant_transaction_profiles WHERE merchant_id = ?`).bind(merchantId).first();
}

export async function registerMerchantTransactionSource(env, merchantId, source = {}) {
  await ensureMerchantTransactionProfile(env, merchantId);
  const sourceSystem = String(source.source_system || '').trim().toUpperCase();
  const sourceType = String(source.source_type || 'OTHER').trim().toUpperCase();
  const externalAccountId = source.external_account_id ? String(source.external_account_id) : null;
  if (!sourceSystem) throw badRequest('source_system is required');

  const existing = externalAccountId
    ? await env.DB.prepare(`
        SELECT * FROM merchant_transaction_sources
        WHERE merchant_id = ? AND source_system = ? AND external_account_id = ?
        LIMIT 1
      `).bind(merchantId, sourceSystem, externalAccountId).first()
    : await env.DB.prepare(`
        SELECT * FROM merchant_transaction_sources
        WHERE merchant_id = ? AND source_system = ? AND external_account_id IS NULL
        LIMIT 1
      `).bind(merchantId, sourceSystem).first();

  if (existing) {
    await env.DB.prepare(`
      UPDATE merchant_transaction_sources
         SET source_type = ?, status = 'ACTIVE', capabilities_json = ?, last_seen_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).bind(sourceType, JSON.stringify(source.capabilities || {}), existing.id).run();
    return { ...existing, refreshed: true };
  }

  const id = await allocateId(env, 'SRC', 6);
  await env.DB.prepare(`
    INSERT INTO merchant_transaction_sources
      (id, merchant_id, source_system, external_account_id, source_type, status, capabilities_json)
    VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)
  `).bind(id, merchantId, sourceSystem, externalAccountId, sourceType, JSON.stringify(source.capabilities || {})).run();

  await recordDiscovery(env, merchantId, 'SOURCE_CONNECTED', sourceSystem, externalAccountId, {
    source_type: sourceType,
    capabilities: source.capabilities || {},
  });
  return { id, merchant_id: merchantId, source_system: sourceSystem, external_account_id: externalAccountId, source_type: sourceType };
}

export async function observeTransactionComponent(env, input = {}) {
  const tx = await env.DB.prepare(`
    SELECT id, merchant_id, purchase_id, currency
    FROM transactions WHERE id = ?
  `).bind(input.transaction_id).first();
  if (!tx) throw notFound(`Transaction not found: ${input.transaction_id}`);
  if (input.merchant_id && input.merchant_id !== tx.merchant_id) throw badRequest('Component merchant does not match transaction merchant');

  await ensureMerchantTransactionProfile(env, tx.merchant_id);
  const sourceSystem = String(input.source_system || 'BUILTEGRITY').trim().toUpperCase();
  const sourceKey = normalizeSourceKey(input.source_key || input.raw_label || input.display_label || input.source_ref || '');
  const classification = await classifyComponent(env, tx.merchant_id, sourceSystem, sourceKey, input);
  const type = await env.DB.prepare(`
    SELECT * FROM transaction_component_types WHERE code = ? AND active = 1
  `).bind(classification.component_type_code).first();
  if (!type) throw badRequest(`Unknown/inactive component type: ${classification.component_type_code}`);

  const previouslyKnown = await env.DB.prepare(`
    SELECT occurrence_count FROM merchant_component_profiles
    WHERE merchant_id = ? AND component_type_code = ?
  `).bind(tx.merchant_id, type.code).first();

  const id = await allocateId(env, 'CMP', 8);
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO transaction_components (
      id, transaction_id, merchant_id, purchase_id, component_type_code, parent_component_id,
      scope, basis, direction, beneficiary, amount_cents, currency, quantity, unit_amount_cents,
      rate_ppm, raw_label, display_label, source_system, source_ref, classification_confidence_ppm,
      status, metadata_json, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
  `).bind(
    id,
    tx.id,
    tx.merchant_id,
    input.purchase_id || tx.purchase_id || null,
    type.code,
    input.parent_component_id || null,
    String(input.scope || 'TRANSACTION').toUpperCase(),
    String(input.basis || 'OBSERVED').toUpperCase(),
    String(input.direction || type.default_direction).toUpperCase(),
    String(input.beneficiary || type.default_beneficiary).toUpperCase(),
    nullableInteger(input.amount_cents),
    String(input.currency || tx.currency || 'USD').toUpperCase(),
    nullableNumber(input.quantity),
    nullableInteger(input.unit_amount_cents),
    nullableInteger(input.rate_ppm),
    input.raw_label || null,
    input.display_label || null,
    sourceSystem,
    input.source_ref || null,
    classification.confidence_ppm,
    type.code === 'UNKNOWN_OTHER' ? 'UNKNOWN' : String(input.status || 'ACCOUNTED').toUpperCase(),
    JSON.stringify(input.metadata || {}),
    input.observed_at || null,
  ).run();

  const inserted = Number(result.meta?.changes || 0) > 0;
  if (!inserted) return { inserted: false, component_type_code: type.code, duplicate: true };

  if (!previouslyKnown) {
    await recordDiscovery(
      env,
      tx.merchant_id,
      type.code === 'UNKNOWN_OTHER' ? 'UNKNOWN_COMPONENT' : 'COMPONENT_DISCOVERED',
      sourceSystem,
      input.source_ref || sourceKey || id,
      { component_type_code: type.code, raw_label: input.raw_label || null, confidence_ppm: classification.confidence_ppm },
    );
  }

  if (sourceKey) {
    await rememberComponentRule(env, tx.merchant_id, sourceSystem, sourceKey, input.raw_label || input.display_label || null, type.code, classification);
  }

  return { id, inserted: true, component_type_code: type.code, confidence_ppm: classification.confidence_ppm };
}

export async function linkTransactionArtifact(env, input = {}) {
  const tx = await env.DB.prepare(`
    SELECT id, merchant_id, purchase_id FROM transactions WHERE id = ?
  `).bind(input.transaction_id).first();
  if (!tx) throw notFound(`Transaction not found: ${input.transaction_id}`);

  const id = await allocateId(env, 'ART', 8);
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO transaction_artifacts (
      id, transaction_id, merchant_id, purchase_id, artifact_type, source_system, source_ref,
      external_url, object_key, sha256, mime_type, metadata_json, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
  `).bind(
    id,
    tx.id,
    tx.merchant_id,
    input.purchase_id || tx.purchase_id || null,
    String(input.artifact_type || 'OTHER').toUpperCase(),
    String(input.source_system || 'BUILTEGRITY').toUpperCase(),
    input.source_ref || null,
    input.external_url || null,
    input.object_key || null,
    input.sha256 || null,
    input.mime_type || null,
    JSON.stringify(input.metadata || {}),
    input.observed_at || null,
  ).run();

  return { id, inserted: Number(result.meta?.changes || 0) > 0 };
}

export async function recordTransactionSourceObject(env, input = {}) {
  const tx = await env.DB.prepare(`SELECT id, merchant_id FROM transactions WHERE id = ?`).bind(input.transaction_id).first();
  if (!tx) throw notFound(`Transaction not found: ${input.transaction_id}`);
  if (!input.external_id || !input.object_type) throw badRequest('object_type and external_id are required');

  const sourceSystem = String(input.source_system || 'BUILTEGRITY').toUpperCase();
  const objectType = String(input.object_type).toUpperCase();
  const externalId = String(input.external_id);
  let object = await env.DB.prepare(`
    SELECT id FROM source_objects
    WHERE merchant_id = ? AND source_system = ? AND object_type = ? AND external_id = ?
    LIMIT 1
  `).bind(tx.merchant_id, sourceSystem, objectType, externalId).first();

  let created = false;
  if (!object) {
    const id = await allocateId(env, 'OBJ', 8);
    const result = await env.DB.prepare(`
      INSERT OR IGNORE INTO source_objects
        (id, merchant_id, source_system, object_type, external_id, external_parent_id, metadata_json, first_observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
    `).bind(
      id,
      tx.merchant_id,
      sourceSystem,
      objectType,
      externalId,
      input.external_parent_id || null,
      JSON.stringify(input.metadata || {}),
      input.observed_at || null,
    ).run();
    created = Number(result.meta?.changes || 0) > 0;
    object = created
      ? { id }
      : await env.DB.prepare(`
          SELECT id FROM source_objects
          WHERE merchant_id = ? AND source_system = ? AND object_type = ? AND external_id = ?
          LIMIT 1
        `).bind(tx.merchant_id, sourceSystem, objectType, externalId).first();
  }

  if (!object) throw new Error('Unable to resolve source object');
  const relationshipType = String(input.relationship_type || relationshipForObjectType(objectType)).toUpperCase();
  const linkResult = await env.DB.prepare(`
    INSERT OR IGNORE INTO transaction_source_object_links
      (transaction_id, source_object_id, relationship_type, linked_at)
    VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
  `).bind(tx.id, object.id, relationshipType, input.observed_at || null).run();

  return {
    id: object.id,
    created,
    linked: Number(linkResult.meta?.changes || 0) > 0,
    relationship_type: relationshipType,
  };
}

export async function getMerchantTransactionProfile(env, merchantId) {
  await ensureMerchantTransactionProfile(env, merchantId);
  const [profile, sources, modules, components, rules, discoveries] = await Promise.all([
    env.DB.prepare(`SELECT * FROM merchant_transaction_profiles WHERE merchant_id = ?`).bind(merchantId).first(),
    env.DB.prepare(`SELECT * FROM merchant_transaction_sources WHERE merchant_id = ? ORDER BY source_system, first_seen_at`).bind(merchantId).all(),
    env.DB.prepare(`
      SELECT pm.*, m.title, m.description, m.mandatory
      FROM merchant_profile_modules pm JOIN transaction_modules m ON m.code = pm.module_code
      WHERE pm.merchant_id = ? ORDER BY m.mandatory DESC, pm.module_code
    `).bind(merchantId).all(),
    env.DB.prepare(`
      SELECT cp.*, t.module_code, t.name, t.family, t.accounting_required, t.description
      FROM merchant_component_profiles cp JOIN transaction_component_types t ON t.code = cp.component_type_code
      WHERE cp.merchant_id = ? ORDER BY t.module_code, cp.component_type_code
    `).bind(merchantId).all(),
    env.DB.prepare(`SELECT * FROM merchant_component_rules WHERE merchant_id = ? AND rule_status <> 'RETIRED' ORDER BY last_seen_at DESC`).bind(merchantId).all(),
    env.DB.prepare(`SELECT * FROM merchant_profile_discovery_events WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 100`).bind(merchantId).all(),
  ]);

  return {
    profile,
    sources: (sources.results || []).map((row) => ({ ...row, capabilities: parseJson(row.capabilities_json) || {} })),
    modules: modules.results || [],
    components: components.results || [],
    rules: (rules.results || []).map((row) => ({ ...row, metadata: parseJson(row.metadata_json) || {} })),
    discoveries: (discoveries.results || []).map((row) => ({ ...row, details: parseJson(row.details_json) || {} })),
  };
}

export async function getTransactionGraph(env, transactionId) {
  const tx = await env.DB.prepare(`
    SELECT t.*, p.merchant_reference, p.description AS purchase_description,
           m.name AS merchant_name, c.name AS customer_name
    FROM transactions t
    JOIN purchases p ON p.id = t.purchase_id
    JOIN merchants m ON m.id = t.merchant_id
    JOIN customers c ON c.id = t.customer_id
    WHERE t.id = ?
  `).bind(transactionId).first();
  if (!tx) throw notFound(`Transaction not found: ${transactionId}`);

  const [components, artifacts, objects] = await Promise.all([
    env.DB.prepare(`SELECT * FROM transaction_component_stream WHERE transaction_id = ? ORDER BY observed_at, id`).bind(transactionId).all(),
    env.DB.prepare(`SELECT * FROM transaction_artifacts WHERE transaction_id = ? ORDER BY observed_at, id`).bind(transactionId).all(),
    env.DB.prepare(`
      SELECT so.*, l.relationship_type, l.linked_at
      FROM transaction_source_object_links l
      JOIN source_objects so ON so.id = l.source_object_id
      WHERE l.transaction_id = ?
      ORDER BY l.linked_at, so.object_type, so.id
    `).bind(transactionId).all(),
  ]);

  const componentRows = (components.results || []).map((row) => ({ ...row }));
  return {
    transaction: tx,
    components: componentRows,
    visible_components: componentRows.filter((row) => row.display_mode !== 'HIDE'),
    artifacts: (artifacts.results || []).map((row) => ({ ...row, metadata: parseJson(row.metadata_json) || {} })),
    source_objects: (objects.results || []).map((row) => ({ ...row, metadata: parseJson(row.metadata_json) || {} })),
  };
}

export async function updateMerchantTransactionPreferences(env, merchantId, body = {}) {
  rejectTruthMutation(body);
  await ensureMerchantTransactionProfile(env, merchantId);

  if (body.stream_detail_level || body.default_alert_mode) {
    const detail = body.stream_detail_level ? String(body.stream_detail_level).toUpperCase() : null;
    const alert = body.default_alert_mode ? String(body.default_alert_mode).toUpperCase() : null;
    if (detail && !['SUMMARY', 'DETAILED'].includes(detail)) throw badRequest('Invalid stream_detail_level');
    if (alert && !ALERT_MODES.has(alert)) throw badRequest('Invalid default_alert_mode');
    await env.DB.prepare(`
      UPDATE merchant_transaction_profiles
         SET stream_detail_level = COALESCE(?, stream_detail_level),
             default_alert_mode = COALESCE(?, default_alert_mode),
             updated_at = CURRENT_TIMESTAMP
       WHERE merchant_id = ?
    `).bind(detail, alert, merchantId).run();
  }

  if (body.module_code) {
    const moduleCode = String(body.module_code).toUpperCase();
    const displayMode = String(body.display_mode || 'SHOW').toUpperCase();
    const alertMode = String(body.alert_mode || 'EXCEPTIONS_ONLY').toUpperCase();
    if (!DISPLAY_MODES.has(displayMode)) throw badRequest('Invalid display_mode');
    if (!ALERT_MODES.has(alertMode)) throw badRequest('Invalid alert_mode');
    const exists = await env.DB.prepare(`SELECT code, mandatory FROM transaction_modules WHERE code = ?`).bind(moduleCode).first();
    if (!exists) throw badRequest(`Unknown module_code: ${moduleCode}`);
    await env.DB.prepare(`
      INSERT INTO merchant_profile_modules
        (merchant_id, module_code, activation_state, display_mode, alert_mode, materiality_threshold_cents)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(merchant_id, module_code) DO UPDATE SET
        display_mode = excluded.display_mode,
        alert_mode = excluded.alert_mode,
        materiality_threshold_cents = excluded.materiality_threshold_cents,
        last_seen_at = CURRENT_TIMESTAMP
    `).bind(
      merchantId,
      moduleCode,
      Number(exists.mandatory) === 1 ? 'MANDATORY' : 'CONFIRMED',
      displayMode,
      alertMode,
      nullableInteger(body.materiality_threshold_cents),
    ).run();
  }

  if (body.component_type_code) {
    const typeCode = String(body.component_type_code).toUpperCase();
    const displayMode = String(body.display_mode || 'SHOW').toUpperCase();
    if (!DISPLAY_MODES.has(displayMode)) throw badRequest('Invalid display_mode');
    const exists = await env.DB.prepare(`SELECT code FROM transaction_component_types WHERE code = ?`).bind(typeCode).first();
    if (!exists) throw badRequest(`Unknown component_type_code: ${typeCode}`);
    await env.DB.prepare(`
      INSERT INTO merchant_component_profiles (merchant_id, component_type_code, display_mode, occurrence_count)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(merchant_id, component_type_code) DO UPDATE SET display_mode = excluded.display_mode
    `).bind(merchantId, typeCode, displayMode).run();
  }

  await recordDiscovery(env, merchantId, 'PREFERENCE_CHANGED', 'BUILTEGRITY', null, {
    module_code: body.module_code || null,
    component_type_code: body.component_type_code || null,
    display_mode: body.display_mode || null,
    alert_mode: body.alert_mode || null,
  });
  return getMerchantTransactionProfile(env, merchantId);
}

export async function confirmComponentRule(env, merchantId, ruleId, componentTypeCode) {
  const typeCode = String(componentTypeCode || '').toUpperCase();
  const type = await env.DB.prepare(`SELECT code FROM transaction_component_types WHERE code = ? AND active = 1`).bind(typeCode).first();
  if (!type) throw badRequest(`Unknown component type: ${typeCode}`);
  const rule = await env.DB.prepare(`SELECT * FROM merchant_component_rules WHERE id = ? AND merchant_id = ?`).bind(ruleId, merchantId).first();
  if (!rule) throw notFound('Component classification rule not found');

  await env.DB.prepare(`
    UPDATE merchant_component_rules
       SET component_type_code = ?, rule_status = 'CONFIRMED', confidence_ppm = 1000000, last_seen_at = CURRENT_TIMESTAMP
     WHERE id = ? AND merchant_id = ?
  `).bind(typeCode, ruleId, merchantId).run();
  await recordDiscovery(env, merchantId, 'CLASSIFICATION_LEARNED', rule.source_system, rule.source_key, {
    from: rule.component_type_code,
    to: typeCode,
    rule_id: ruleId,
  });
  return getMerchantTransactionProfile(env, merchantId);
}

async function classifyComponent(env, merchantId, sourceSystem, sourceKey, input) {
  if (input.component_type_code) {
    return { component_type_code: String(input.component_type_code).toUpperCase(), confidence_ppm: 1000000, method: 'EXPLICIT' };
  }

  if (sourceKey) {
    const rule = await env.DB.prepare(`
      SELECT component_type_code, confidence_ppm FROM merchant_component_rules
      WHERE merchant_id = ? AND source_system = ? AND source_key = ? AND rule_status <> 'RETIRED'
      LIMIT 1
    `).bind(merchantId, sourceSystem, sourceKey).first();
    if (rule) return { component_type_code: rule.component_type_code, confidence_ppm: Number(rule.confidence_ppm || 0), method: 'LEARNED_RULE' };
  }

  const label = String(input.raw_label || input.display_label || sourceKey || '').toLowerCase();
  for (const [pattern, componentType] of HEURISTICS) {
    if (pattern.test(label)) return { component_type_code: componentType, confidence_ppm: 850000, method: 'HEURISTIC' };
  }

  return { component_type_code: 'UNKNOWN_OTHER', confidence_ppm: 0, method: 'UNKNOWN' };
}

async function rememberComponentRule(env, merchantId, sourceSystem, sourceKey, label, componentType, classification) {
  const existing = await env.DB.prepare(`
    SELECT id, rule_status FROM merchant_component_rules
    WHERE merchant_id = ? AND source_system = ? AND source_key = ?
  `).bind(merchantId, sourceSystem, sourceKey).first();

  if (existing) {
    await env.DB.prepare(`
      UPDATE merchant_component_rules
         SET last_seen_at = CURRENT_TIMESTAMP,
             occurrence_count = occurrence_count + 1
       WHERE id = ?
    `).bind(existing.id).run();
    return existing.id;
  }

  const id = await allocateId(env, 'RULE', 7);
  await env.DB.prepare(`
    INSERT INTO merchant_component_rules
      (id, merchant_id, source_system, source_key, normalized_label, component_type_code,
       rule_status, calculation_method, confidence_ppm, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'PROVIDER_REPORTED', ?, ?)
  `).bind(
    id,
    merchantId,
    sourceSystem,
    sourceKey,
    label || sourceKey,
    componentType,
    componentType === 'UNKNOWN_OTHER' ? 'NEEDS_REVIEW' : 'AUTO_DISCOVERED',
    Number(classification.confidence_ppm || 0),
    JSON.stringify({ classification_method: classification.method || null }),
  ).run();
  return id;
}

async function recordDiscovery(env, merchantId, eventType, sourceSystem, sourceRef, details) {
  const id = await allocateId(env, 'DISC', 8);
  await env.DB.prepare(`
    INSERT INTO merchant_profile_discovery_events
      (id, merchant_id, event_type, source_system, source_ref, details_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, merchantId, eventType, sourceSystem || null, sourceRef || null, JSON.stringify(details || {})).run();
  return id;
}

function rejectTruthMutation(body) {
  for (const key of FORBIDDEN_PREFERENCE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      throw badRequest(`Merchant preferences cannot modify accounting truth: ${key}`);
    }
  }
}

function relationshipForObjectType(objectType) {
  switch (objectType) {
    case 'CHECKOUT_SESSION': return 'CREATED_BY';
    case 'PAYMENT_INTENT':
    case 'CHARGE':
    case 'BALANCE_TRANSACTION': return 'PAYMENT';
    case 'APPLICATION_FEE': return 'FEE';
    case 'REFUND': return 'REFUND';
    case 'DISPUTE': return 'DISPUTE';
    case 'PAYOUT': return 'PAYOUT';
    case 'RECEIPT': return 'EVIDENCE';
    default: return 'RELATED';
  }
}

function normalizeSourceKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 160);
}

function nullableInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw badRequest(`Expected numeric value, received ${value}`);
  return Math.trunc(number);
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw badRequest(`Expected numeric value, received ${value}`);
  return number;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}
