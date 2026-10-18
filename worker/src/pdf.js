import {
  completePdfRequest,
  createPdfRequest,
  failPdfRequest,
  recordEconomicEntry,
} from './db.js';

export async function serveTransactionPdf(env, tx, requester = {}) {
  const requestedByType = requester.type || 'SYSTEM';
  const requestedByRef = requester.ref || null;
  const requestId = await createPdfRequest(env, tx.id, requestedByType, requestedByRef);

  try {
    const version = safeVersion([tx.updated_at,tx.events?.length,tx.events?.at(-1)?.id,tx.exceptions?.length,tx.exceptions?.at(-1)?.updated_at].join('_'));
    const audience = requestedByType === 'CUSTOMER_TOKEN' ? 'customer' : 'merchant';
    const objectKey = `transaction-records/${tx.id}/${audience}/${version}.pdf`;

    if (env.TRANSACTION_RECORDS) {
      const cached = await env.TRANSACTION_RECORDS.get(objectKey);
      if (cached) {
        const bytes = await cached.arrayBuffer();
        await completePdfRequest(env, requestId, {
          cache_hit: true,
          object_key: objectKey,
          byte_length: bytes.byteLength,
        });
        await recordPdfCost(env, tx.id, requestId, true, bytes.byteLength);
        return pdfResponse(bytes, `${tx.id}-transaction-record.pdf`, 'HIT');
      }
    }

    const bytes = buildTransactionPdf(tx, { audience: requestedByType === 'CUSTOMER_TOKEN' ? 'customer' : 'merchant' });

    if (env.TRANSACTION_RECORDS) {
      await env.TRANSACTION_RECORDS.put(objectKey, bytes, {
        httpMetadata: { contentType: 'application/pdf' },
        customMetadata: {
          transactionId: tx.id,
          generatedAt: new Date().toISOString(),
          recordVersion: version,
        },
      });
    }

    await completePdfRequest(env, requestId, {
      cache_hit: false,
      object_key: env.TRANSACTION_RECORDS ? objectKey : null,
      byte_length: bytes.byteLength,
    });
    await recordPdfCost(env, tx.id, requestId, false, bytes.byteLength);
    return pdfResponse(bytes, `${tx.id}-transaction-record.pdf`, env.TRANSACTION_RECORDS ? 'MISS' : 'BYPASS');
  } catch (error) {
    await failPdfRequest(env, requestId, error).catch(() => {});
    throw error;
  }
}

export function buildTransactionPdf(tx, options = {}) {
  const lines = [];
  const push = (label, value = '') => lines.push(label ? `${label}: ${display(value)}` : display(value));

  lines.push('BUILTEGRITY TRANSACTION RECORD');
  lines.push('Every payment accounted for.');
  lines.push('');
  push('Transaction', tx.id);
  push('Merchant', tx.merchant_name);
  push('Customer', tx.customer_name);
  push('Purchase reference', tx.merchant_reference || tx.purchase_id);
  push('Description', tx.description || tx.purchase_description);
  push('Amount', formatMoney(tx.amount_cents, tx.currency));
  push('Lifecycle', tx.lifecycle_status);
  push('Integrity status', tx.integrity_status);
  push('Record classification', tx.record_classification || 'PENDING_PROTECTED');
  push('Exception status', tx.exception_status);
  push('Processor', tx.processor);
  push('Last status change', tx.integrity_last_changed_at || tx.updated_at);
  push('Payment status', tx.payment_status || 'pending');
  push('Payout status', tx.processor_payout_status || 'pending');
  push('Created', tx.created_at);
  push('Last updated', tx.updated_at);
  lines.push('');
  lines.push('CONSENT AND TERMS');
  push('Terms version', tx.terms_version || 'n/a');
  push('Consent accepted', Number(tx.consent_accepted) === 1 ? 'yes' : 'no');
  push('Consent accepted at', tx.consent_accepted_at || 'n/a');
  push('Consent method', tx.consent_method || 'n/a');
  push('Terms SHA-256', tx.terms_snapshot_sha256 || 'n/a');
  if (tx.refund_policy_snapshot) push('Refund policy', tx.refund_policy_snapshot);
  if (tx.cancellation_policy_snapshot) push('Cancellation policy', tx.cancellation_policy_snapshot);
  lines.push('');
  lines.push('PROCESSOR TRACE');
  push('Processor', tx.processor);
  push('Payment intent', tx.stripe_payment_intent_id || 'pending');
  push('Charge', tx.stripe_charge_id || 'pending');
  push('Balance transaction', tx.stripe_balance_transaction_id || 'pending');
  push('Payout', tx.stripe_payout_id || 'pending');
  lines.push('');
  lines.push('EVENT HISTORY');

  for (const event of tx.events || []) {
    lines.push(`${display(event.event_at)}  ${display(event.event_type)}  [${display(event.source)}]`);
  }

  lines.push('');
  lines.push('This PDF is a rendered copy of Builtegrity\'s canonical transaction record.');
  lines.push('The canonical structured record and immutable event history remain authoritative.');

  return createSimplePdf(lines);
}

function createSimplePdf(lines) {
  const wrapped = lines.flatMap((line) => wrapLine(line, 92));
  const pageSize = 46;
  const pages = [];
  for (let i = 0; i < wrapped.length; i += pageSize) pages.push(wrapped.slice(i, i + pageSize));
  if (!pages.length) pages.push(['Builtegrity Transaction Record']);

  const objects = [];
  const reserve = () => { objects.push(''); return objects.length; };
  const set = (id, value) => { objects[id - 1] = value; };

  const catalogId = reserve();
  const pagesId = reserve();
  const fontId = reserve();
  set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pageIds = [];
  for (const pageLines of pages) {
    const contentId = reserve();
    const pageId = reserve();
    pageIds.push(pageId);

    const stream = pageStream(pageLines);
    set(contentId, `<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
  }

  set(pagesId, `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`);
  set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let pdf = '%PDF-1.4\n% Builtegrity\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

function pageStream(lines) {
  const commands = ['BT', '/F1 10 Tf', '48 744 Td', '13 TL'];
  lines.forEach((line, index) => {
    if (index > 0) commands.push('T*');
    commands.push(`(${escapePdf(line)}) Tj`);
  });
  commands.push('ET');
  return commands.join('\n');
}

function wrapLine(value, width) {
  const text = display(value);
  if (text.length <= width) return [text];
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function escapePdf(value) {
  return display(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function display(value) {
  return String(value ?? '').normalize('NFKD').replace(/[^\x20-\x7E]/g, '?');
}

function formatMoney(cents, currency = 'USD') {
  const value = Number(cents || 0) / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: String(currency || 'USD').toUpperCase() }).format(value);
  } catch {
    return `${String(currency || 'USD').toUpperCase()} ${value.toFixed(2)}`;
  }
}

function safeVersion(value) {
  return String(value || 'current').replace(/[^A-Za-z0-9._-]/g, '-');
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function pdfResponse(bytes, filename, cacheStatus) {
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
      'x-builtegrity-pdf-cache': cacheStatus,
      'x-content-type-options': 'nosniff',
    },
  });
}

async function recordPdfCost(env, transactionId, requestId, cacheHit, byteLengthValue) {
  const configured = cacheHit
    ? Number(env.PDF_CACHE_HIT_COST_MICROS || 0)
    : Number(env.PDF_GENERATION_COST_MICROS || 0);

  await recordEconomicEntry(env, transactionId, {
    entry_kind: 'COST',
    category: cacheHit ? 'PDF_CACHE_DELIVERY' : 'PDF_GENERATION',
    amount_micros: Math.max(0, Math.trunc(configured)),
    basis: 'ESTIMATED',
    quantity: 1,
    unit_cost_micros: Math.max(0, Math.trunc(configured)),
    source_ref: `pdf:${requestId}`,
    details: { cache_hit: cacheHit, bytes: byteLengthValue },
  });
}
