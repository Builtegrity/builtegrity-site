import { transactionPdfLines } from './pdf-evidence.js';
import { resolveDocumentBranding } from '../../transaction-engine/merchant-themed-delivery.mjs';
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
    const audience = requestedByType === 'CUSTOMER_TOKEN' ? 'customer' : 'merchant';
    const branding = audience === 'merchant' ? await merchantPdfBranding(env, tx.merchant_id) : null;
    const bytes = buildTransactionPdf(tx,{audience,branding});
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    const version=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
    const objectKey=`transaction-records/${tx.id}/${audience}/${version}.pdf`;

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
        return pdfResponse(bytes, `${tx.id}-transaction-record.pdf`, 'HIT',requester.view===true);
      }
    }

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
    return pdfResponse(bytes, `${tx.id}-transaction-record.pdf`, env.TRANSACTION_RECORDS ? 'MISS' : 'BYPASS',requester.view===true);
  } catch (error) {
    await failPdfRequest(env, requestId, error).catch(() => {});
    throw error;
  }
}

export function buildTransactionPdf(tx,options={}) {
  return createSimplePdf(transactionPdfLines(tx,options),options.branding);
}

export function refundPdfLines(refund,transaction){
 if(!refund?.refund_id||!transaction?.id||refund.transaction_id!==transaction.id)
  throw new Error('Refund and transaction evidence must match');
 const completed=String(refund.status||'').toUpperCase()==='COMPLETED';
 const money=(n,currency)=>Number.isFinite(Number(n))?
   (Number(n)/100).toFixed(2)+' '+String(currency||'USD').toUpperCase():'Not available';
 const lines=[
  'BUILTEGRITY - MERCHANT REFUND RECORD',
  'Generated at: '+new Date().toISOString(),
  '',
  completed?'STATUS: REFUND COMPLETED (PROCESSOR-REPORTED)':
    'STATUS: '+String(refund.status||'UNKNOWN')+' - NOT A COMPLETED REFUND',
  'This document is based on recorded processor evidence.',
  'This is not a guarantee against later reversals or bank settlement.',
  '',
  'REFUND IDENTIFICATION',
  'Processor: '+refund.processor,
  'Builtegrity refund ID: '+refund.refund_id,
  'Processor refund/event reference: '+String(refund.processor_ref||'Not recorded'),
  'Original Builtegrity transaction: '+transaction.id,
  'Merchant: '+String(refund.merchant_name||transaction.merchant_name||'Not recorded'),
  'Original merchant invoice ID: '+String(transaction.merchant_payment_reference||'Not recorded'),
  'Customer: '+String(transaction.customer_name||'Not recorded'),
  '',
  'AMOUNTS',
  'Refund amount: '+money(refund.amount_cents,refund.currency),
  'Original payment amount: '+money(transaction.amount_cents,transaction.currency),
  'Transaction total customer refunds recorded (cumulative): '+
    money(transaction.refunded_cents,transaction.currency),
  '',
  'REFUND PROVENANCE AND STATUS',
  'Refund event observed/updated: '+String(refund.occurred_at||'Not recorded'),
  'Refund status: '+String(refund.status||'Unknown'),
  'Recorded processor: '+String(refund.processor||'Not recorded')
 ];
 if(refund.processor==='SQUARE'){
  lines.push('Square refund ID: '+String(refund.refund_id),
   'Square payment ID: '+String(refund.processor_payment_id||'Not recorded'),
   'Square initial observation: '+String(refund.observed_at||'Not recorded'),
   'Square refunded application fee: '+money(refund.app_fee_refunded_cents,refund.currency));
 }else{
  lines.push('Stripe adjustment record: '+String(refund.refund_id),
   'Stripe processor object: '+String(refund.processor_object_id||'Not recorded'),
   'Stripe webhook/event: '+String(refund.processor_event_id||'Not recorded'));
 }
 lines.push('','HOW TO USE THIS RECORD',
  'Download or print this PDF from your authenticated merchant dashboard.',
  'To send this record, attach the downloaded file to your own message.',
  'Status can change: reopen Builtegrity for the latest processor facts.',
  'Refund records do not prove irreversible arrival in any bank account.');
 return lines;
}
export function buildRefundPdf(refund,transaction,options={}){
 return createSimplePdf(refundPdfLines(refund,transaction),options.branding);
}

export async function merchantPdfBranding(env, merchantId) {
  if (!merchantId) return null;
  const row = await env.DB.prepare(`SELECT p.pdf_theme_opt_in, a.template, m.name
    FROM merchants m
    LEFT JOIN merchant_transaction_delivery_preferences p ON p.merchant_id=m.id
    LEFT JOIN merchant_dashboard_appearance a ON a.merchant_id=m.id
    WHERE m.id=?`).bind(merchantId).first().catch(() => null);
  if (!row || Number(row.pdf_theme_opt_in) !== 1) return null;
  return resolveDocumentBranding({theme:row.template || 'builtegrity',themePdfEnabled:true},{name:row.name});
}

function createSimplePdf(lines, branding = null) {
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

    const stream = pageStream(pageLines,branding);
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

function pageStream(lines, branding = null) {
  const accent = branding?.colors?.accent;
  const rgb = accent && /^#[0-9a-f]{6}$/i.test(accent) ? [1,3,5].map(i=>(parseInt(accent.slice(i,i+2),16)/255).toFixed(3)).join(' ') : null;
  const commands = ['BT', '/F1 10 Tf', '48 744 Td', '13 TL'];
  if(rgb) commands.push(rgb + ' rg');
  lines.forEach((line, index) => {
    if (index > 0) { commands.push('T*'); if(index===1 && rgb) commands.push('0 0 0 rg'); }
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
  return lines.flatMap(line => line.length > width ? (line.match(new RegExp('.{1,'+width+'}', 'g')) || []) : [line]);
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

function pdfResponse(bytes, filename, cacheStatus, viewInline=false) {
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `${viewInline ? 'inline' : 'attachment'}; filename="${filename}"`,
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
