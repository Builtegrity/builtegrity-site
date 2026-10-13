import { generateDueMerchantTaxDocuments, ensureMissingExports } from './tax-document-generation.js';
import { prepareTaxDocumentDeliveries, deliverDueTaxDocuments, listTaxDocumentDeliveries } from './tax-document-delivery.js';

export async function runTaxDocumentPipeline(env, options = {}) {
  const generated=await generateDueMerchantTaxDocuments(env,options);
  const recovered=await ensureMissingExports(env,100);
  const prepared=await prepareTaxDocumentDeliveries(env,200);
  const delivered=await deliverDueTaxDocuments(env,options.deliveryBatchSize||20);
  return { generated, recovered_exports:recovered, prepared, delivered };
}

export async function getTaxDocumentStatus(env, options = {}) {
  const limit=Math.max(1,Math.min(Number(options.limit||100),500));
  const documents=await env.DB.prepare(`
    SELECT cadence,document_id,merchant_id,period_label,status,generated_at
      FROM merchant_tax_document_registry
     ORDER BY generated_at DESC LIMIT ?
  `).bind(limit).all();
  const exports=await env.DB.prepare(`
    SELECT id,document_kind,source_id,merchant_id,period_label,object_key,pdf_sha256,pdf_byte_length,generated_at
      FROM tax_document_exports ORDER BY generated_at DESC LIMIT ?
  `).bind(limit).all();
  return { documents:documents.results||[], exports:exports.results||[], deliveries:await listTaxDocumentDeliveries(env,limit) };
}
