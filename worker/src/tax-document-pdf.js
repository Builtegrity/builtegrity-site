export function buildTaxDocumentPdf(document) {
  const s = document.snapshot || document;
  const lines = [];
  const annual = s.kind === 'YEAR_END_PAYMENT_ACTIVITY_SUMMARY';
  lines.push(annual ? 'BUILTEGRITY YEAR-END PAYMENT ACTIVITY SUMMARY' : 'BUILTEGRITY QUARTERLY PAYMENT ACTIVITY SUMMARY');
  lines.push('Every payment accounted for.');
  lines.push('');
  push(lines,'Merchant',s.merchant?.name || document.merchant_name || document.merchant_id);
  push(lines,'Merchant ID',s.merchant?.id || document.merchant_id);
  push(lines,'Period',annual ? String(s.tax_year || document.tax_year) : `${s.tax_year || document.tax_year} Q${s.quarter || document.quarter}`);
  push(lines,'Currency',s.currency || document.currency || 'USD');
  if (!annual) push(lines,'Purpose',s.purpose_code || document.purpose_code || 'Accounting and estimated-tax preparation support');
  push(lines,'Reconciliation status',s.reconciliation_status || document.status);
  lines.push('');
  lines.push('PAYMENT ACTIVITY');
  const money=s.money||{}; const counts=s.counts||{};
  push(lines,'Successful payments',counts.successful_charge_count ?? document.successful_charge_count ?? 0);
  push(lines,'Gross payment volume',moneyText(money.gross_payment_volume_cents ?? document.gross_payment_volume_cents,s.currency||document.currency));
  push(lines,'Customer refunds recorded',moneyText(money.customer_refunds_cents ?? document.customer_refunds_cents,s.currency||document.currency));
  push(lines,'Processor fees observed',moneyText(money.processor_fee_cents ?? document.processor_fee_cents,s.currency||document.currency));
  push(lines,'Builtegrity gross fees earned',moneyText(money.builtegrity_gross_fee_earned_cents ?? document.builtegrity_gross_fee_earned_cents,s.currency||document.currency));
  push(lines,'Builtegrity fee refunds',moneyText(money.builtegrity_fee_refunds_cents ?? document.builtegrity_fee_refunds_cents,s.currency||document.currency));
  push(lines,'Merchant net observed',moneyText(money.merchant_net_observed_cents ?? document.merchant_net_observed_cents,s.currency||document.currency));
  lines.push('');
  lines.push('TRANSACTION RECORD COVERAGE');
  push(lines,'Protected',counts.protected_count ?? document.protected_count ?? 0);
  push(lines,'Observed',counts.observed_count ?? document.observed_count ?? 0);
  push(lines,'Imported',counts.imported_count ?? document.imported_count ?? 0);
  push(lines,'Exceptions',counts.exception_count ?? document.exception_count ?? 0);
  push(lines,'Missing processor Available On',counts.missing_available_on_count ?? document.missing_available_on_count ?? 0);
  push(lines,'Unreconciled payouts',counts.unreconciled_payout_count ?? document.unreconciled_payout_count ?? 0);
  lines.push('');
  lines.push('IMPORTANT');
  lines.push('This document is an accounting and tax-preparation aid generated from Builtegrity transaction records.');
  lines.push('It is not a tax return, estimated-tax voucher, payroll return, Form 1099, determination of taxable income, or tax advice.');
  lines.push('Gross payment activity is presented separately from refunds, processor fees and Builtegrity fees.');
  lines.push('Tax authorities, processor tax forms, complete business books and the taxpayer filing record remain authoritative.');
  return simplePdf(lines);
}

function push(lines,label,value){lines.push(`${label}: ${clean(value)}`);}
function moneyText(cents,currency='USD'){const n=Number(cents||0)/100;try{return new Intl.NumberFormat('en-US',{style:'currency',currency:String(currency||'USD').toUpperCase()}).format(n);}catch{return `${currency} ${n.toFixed(2)}`;}}
function clean(v){return String(v??'').normalize('NFKD').replace(/[^\x20-\x7E]/g,'?');}
function wrap(value,width=92){const text=clean(value);if(text.length<=width)return[text];const words=text.split(/\s+/);const out=[];let cur='';for(const word of words){if(!cur)cur=word;else if(`${cur} ${word}`.length<=width)cur+=` ${word}`;else{out.push(cur);cur=word;}}if(cur)out.push(cur);return out;}
function escapePdf(v){return clean(v).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');}
function byteLength(v){return new TextEncoder().encode(v).byteLength;}
function pageStream(lines){const c=['BT','/F1 10 Tf','48 744 Td','13 TL'];lines.forEach((line,i)=>{if(i)c.push('T*');c.push(`(${escapePdf(line)}) Tj`);});c.push('ET');return c.join('\n');}
function simplePdf(lines){const wrapped=lines.flatMap((x)=>wrap(x));const pages=[];for(let i=0;i<wrapped.length;i+=46)pages.push(wrapped.slice(i,i+46));if(!pages.length)pages.push(['Builtegrity']);const objects=[];const reserve=()=>{objects.push('');return objects.length;};const set=(id,v)=>{objects[id-1]=v;};const catalog=reserve(),pagesId=reserve(),font=reserve();set(font,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');const pageIds=[];for(const page of pages){const content=reserve(),pageId=reserve();pageIds.push(pageId);const stream=pageStream(page);set(content,`<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`);set(pageId,`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);}set(pagesId,`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id)=>`${id} 0 R`).join(' ')}] >>`);set(catalog,`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);let pdf='%PDF-1.4\n% Builtegrity\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}const xref=byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;for(let i=1;i<offsets.length;i++)pdf+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;pdf+=`trailer\n<< /Size ${objects.length+1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;return new TextEncoder().encode(pdf);}
