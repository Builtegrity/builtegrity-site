// Canonical, filtered PDF projection: the source tables remain authoritative.
// The customer-token rendition omits internal fees, exceptions, evidence objects and contact details.
const SAFE_EVENT_FIELDS=/token|secret|password|credential|authorization|card|cvv|cvc|ssn|bank_account|api_key|private_key|access_key|ip_address|user_agent|account_number|email|phone/i;
function safeJson(value,depth=0){
  if(depth>7)return '[nested data omitted]';
  if(Array.isArray(value))return value.map(v=>safeJson(v,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(
    Object.entries(value).map(([key,val])=>[key,SAFE_EVENT_FIELDS.test(key)?'[REDACTED]':safeJson(val,depth+1)]));
  return value;
}
function money(cents,currency='USD'){
  if(cents===null||cents===undefined)return 'not recorded';
  return (Number(cents)/100).toFixed(2)+' '+String(currency||'USD').toUpperCase();
}
export function transactionPdfLines(tx,{audience='merchant'}={}){
  const merchant=audience!=='customer';
  const lines=['BUILTEGRITY - TRANSACTION RECORD',merchant?'MERCHANT EVIDENCE COPY':'CUSTOMER SHAREABLE COPY',
    'Snapshot of the latest Builtegrity evidence, not a guarantee of settlement.'];
  const heading=name=>{lines.push('');lines.push(name.toUpperCase());};
  const label=(name,value)=>lines.push(name+': '+String(value??'not recorded'));
  const fields=(pairs)=>pairs.forEach(([name,key])=>label(name,tx[key]));
  heading('Transaction identity and statuses');
  fields([['Transaction ID','id'],['Merchant','merchant_name'],['Customer','customer_name'],
    ['Purchase reference','merchant_reference'],['Purchase ID','purchase_id'],
    ['Description','description'],['Type','transaction_type'],['Processor','processor'],
    ['Lifecycle status','lifecycle_status'],['Integrity status','integrity_status'],
    ['Record classification','record_classification'],['Exception status','exception_status'],
    ['Payment status','payment_status'],['Payout status','processor_payout_status'],
    ['Created','created_at'],['Last record change','updated_at']]);
  label('Gross payment',money(tx.amount_cents,tx.currency));
  label('Integrity locally verified at',tx.integrity_verified_at||'not yet checked');
  label('Verification source','Local canonical records; processor updates arrive separately');
  heading('Agreement and customer attestation');
  fields([['Terms version','terms_version'],['Consent accepted','consent_accepted'],
    ['Consent timestamp','consent_accepted_at'],['Consent method','consent_method'],
    ['Terms SHA-256','terms_snapshot_sha256'],
    ['Country attested','customer_attested_country_code'],
    ['State attested','customer_attested_state_code'],
    ['Attestation time','customer_attested_at'],['Checkout legal clearance','checkout_legal_gate_at'],
    ['Accepted terms snapshot','terms_snapshot'],
    ['Refund policy snapshot','refund_policy_snapshot'],
    ['Cancellation policy snapshot','cancellation_policy_snapshot']]);
  heading('Processor references and payout evidence');
  if(String(tx.processor).toUpperCase()==='SQUARE'){
    fields([['Square checkout','processor_checkout_id'],['Square order','processor_order_id'],
      ['Square payment','processor_payment_id'],['Square payout','processor_payout_id']]);
  }else{
    fields([['Stripe checkout','stripe_checkout_session_id'],
      ['PaymentIntent','stripe_payment_intent_id'],['Stripe charge','stripe_charge_id'],
      ['Balance transaction','stripe_balance_transaction_id'],
      ['Application fee ID','stripe_application_fee_id'],['Stripe payout','stripe_payout_id']]);
  }
  fields([['Payment confirmed at','payment_at'],['Expected payout date','expected_payout_arrival'],
    ['Payout accounted','payout_accounted'],['Last processor reconciliation','last_reconciled_at']]);
  if(merchant){
    heading('Merchant fees, refunds and financial evidence');
    for(const [name,key] of [
      ['Amount customer paid','customer_paid_cents'],
      ['Earned fee cents','integrity_fee_earned_cents'],
      ['Builtegrity recognized cents','bg_fee_earned_cents'],
      ['Collected Builtegrity fee cents','integrity_fee_collected_cents'],
      ['Gross confirmed app fee cents','application_fee_gross_confirmed_cents'],
      ['Square app fee requested cents','processor_app_fee_requested_cents'],
      ['Square app fee confirmed cents','processor_app_fee_confirmed_cents'],
      ['App fee refunded cents','application_fee_refunded_cents'],
      ['Customer refunded cents','refunded_cents'],
      ['Processor charge fee cents','processor_fee_cents'],
      ['Prior carry reserved cents','pricing_carry_reserved_cents'],
      ['Expected merchant net cents','expected_merchant_net_cents'],
      ['Actual merchant net cents','actual_merchant_net_cents'],
      ['Payout contribution cents','transaction_payout_contribution_cents'],
      ['Payout batch total cents','payout_batch_total_cents'],
      ['Fee method','fee_collection_method'],['Protection confirmed','protection_confirmed_at'],
      ['Protection failure','protection_failure_reason']])label(name,tx[key]);
    heading('Exceptions and resolutions');
    if(!(tx.exceptions||[]).length)lines.push('No exceptions recorded.');
    for(const ex of tx.exceptions||[]){
      fields.call(null,[]);
      label('Exception',[(ex.id||''),(ex.exception_type||''),(ex.status||'')].join(' | '));
      label('Opened',ex.opened_at);label('Summary',ex.summary);
      label('Resolution',ex.resolution);label('Resolved',ex.resolved_at);
    }
    heading('Economics ledger');
    const ledger=(tx.economics?.ledger||[]).filter(row=>!String(row.category||'').startsWith('PDF_'));
    if(!ledger.length)lines.push('No economics entries recorded.');
    for(const item of ledger){
      label('Ledger ID',item.id);label('Kind',item.entry_kind);
      label('Category',item.category);label('Micros',item.amount_micros);label('Basis',item.basis);
      if(item.details)label('Details',JSON.stringify(safeJson(item.details)));
    }
  }
  heading('Event history');
  if(!(tx.events||[]).length)lines.push('No events recorded.');
  for(const event of tx.events||[]){
    label('Event',[(event.id||''),(event.event_at||''),(event.event_type||''),(event.source||'')].join(' | '));
    if(merchant&&event.event_data)label('Event evidence',JSON.stringify(safeJson(event.event_data)));
  }
  heading('Status meanings');
  lines.push('INCOMPLETE: required recorded evidence has not all been reconciled.');
  lines.push('ACCOUNTED: the required processor payout and lifecycle facts match and no exception is open.');
  lines.push('NEEDS_ATTENTION: an unresolved exception requires investigation.');
  lines.push('PROTECTED is a separate record and fee classification, not payment insurance.');
  lines.push('The source database and append-only events are authoritative; this is a current copy.');
  lines.push('No card data, API secrets, access tokens, or original binary attachments are included.');
  return lines;
}
