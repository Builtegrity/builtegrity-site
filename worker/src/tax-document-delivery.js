export async function prepareTaxDocumentDeliveries(env, limit = 200) {
  const rows=await env.DB.prepare(`
    SELECT e.id AS export_id,e.document_kind,e.source_id,e.merchant_id,e.period_label,
           COALESCE(m.statement_email,m.email) AS recipient_email,m.name AS merchant_name
      FROM tax_document_exports e JOIN merchants m ON m.id=e.merchant_id
     WHERE NOT EXISTS(SELECT 1 FROM tax_document_deliveries d WHERE d.export_id=e.id)
     ORDER BY e.generated_at LIMIT ?
  `).bind(limit).all();
  let created=0,missingRecipient=0;
  for(const row of rows.results||[]){
    const email=normalizeEmail(row.recipient_email);
    if(!email){missingRecipient+=1;continue;}
    const id=`TDD-${row.export_id}-${await sha256Short(email)}`;
    const inserted=await env.DB.prepare(`INSERT OR IGNORE INTO tax_document_deliveries(id,export_id,recipient_email,status,next_attempt_at) VALUES(?,?,?,'PENDING',CURRENT_TIMESTAMP)`).bind(id,row.export_id,email).run();
    created+=Number(inserted.meta?.changes||0);
  }
  return { created, missing_recipient:missingRecipient };
}

export async function deliverDueTaxDocuments(env, limit = 20) {
  const due=await env.DB.prepare(`
    SELECT d.*,e.document_kind,e.source_id,e.merchant_id,e.period_label,e.object_key,e.pdf_sha256,
           m.name AS merchant_name
      FROM tax_document_deliveries d
      JOIN tax_document_exports e ON e.id=d.export_id
      JOIN merchants m ON m.id=e.merchant_id
     WHERE d.status IN ('PENDING','RETRY')
       AND (d.next_attempt_at IS NULL OR datetime(d.next_attempt_at)<=datetime('now'))
     ORDER BY d.created_at LIMIT ?
  `).bind(Math.max(1,Math.min(Number(limit||20),100))).all();
  let delivered=0,failed=0;
  for(const row of due.results||[]){
    const claimed=await env.DB.prepare(`UPDATE tax_document_deliveries SET status='SENDING',attempts=attempts+1,last_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('PENDING','RETRY')`).bind(row.id).run();
    if(!Number(claimed.meta?.changes||0))continue;
    try{
      const providerId=await send(env,row);
      await env.DB.prepare(`UPDATE tax_document_deliveries SET status='DELIVERED',provider_message_id=?,delivered_at=CURRENT_TIMESTAMP,next_attempt_at=NULL,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(providerId,row.id).run();
      delivered+=1;
    }catch(error){
      failed+=1;
      const attempt=Number(row.attempts||0)+1;
      const minutes=Math.min(1440,Math.max(5,5*(2**Math.min(attempt,8))));
      await env.DB.prepare(`UPDATE tax_document_deliveries SET status='RETRY',next_attempt_at=datetime('now',?),last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(`+${minutes} minutes`,String(error?.message||error).slice(0,1000),row.id).run();
    }
  }
  return { delivered, failed };
}

export async function listTaxDocumentDeliveries(env, limit=100){const result=await env.DB.prepare(`SELECT d.*,e.document_kind,e.merchant_id,e.period_label FROM tax_document_deliveries d JOIN tax_document_exports e ON e.id=d.export_id ORDER BY d.created_at DESC LIMIT ?`).bind(Math.max(1,Math.min(Number(limit||100),500))).all();return result.results||[];}

async function send(env,row){
  if(!env.RESEND_API_KEY)throw new Error('RESEND_API_KEY is not configured');
  const from=String(env.STATEMENT_EMAIL_FROM||'').trim();if(!from)throw new Error('STATEMENT_EMAIL_FROM is not configured');
  if(!env.TRANSACTION_RECORDS)throw new Error('TRANSACTION_RECORDS binding is not configured');
  const object=await env.TRANSACTION_RECORDS.get(row.object_key);if(!object)throw new Error(`Tax document PDF missing: ${row.object_key}`);
  const bytes=new Uint8Array(await object.arrayBuffer());const hash=await sha256Hex(bytes);if(hash!==row.pdf_sha256)throw new Error(`Tax document PDF hash mismatch: ${row.export_id}`);
  const annual=row.document_kind==='YEAR_END_PAYMENT_ACTIVITY';
  const label=annual?'year-end':'quarterly';
  const subject=`Builtegrity ${label} payment activity — ${row.period_label}`;
  const body={from,to:[row.recipient_email],subject,text:[`${row.merchant_name||row.merchant_id},`,'',`Attached is your Builtegrity ${label} payment activity summary for ${row.period_label}.`,'','It is designed to support bookkeeping, reconciliation and tax preparation. It is not a tax return, estimated-tax voucher, payroll filing, 1099, or determination of taxable income.','',annual?'Use it alongside your processor tax forms and complete business books.':'Use it to reconcile the period and support any estimated-tax calculation your business or owners may be required to make.','','Every payment accounted for.'].join('\n'),attachments:[{filename:`builtegrity-${label}-${row.period_label}-${row.merchant_id}.pdf`,content:bytesToBase64(bytes),content_type:'application/pdf'}],tags:[{name:'type',value:`${label}-tax-support`},{name:'period',value:String(row.period_label).replace(/[^A-Za-z0-9_-]/g,'-')}]};
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:`Bearer ${env.RESEND_API_KEY}`,'content-type':'application/json','Idempotency-Key':`tax-document/${row.id}`.slice(0,256)},body:JSON.stringify(body)});
  const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`Resend HTTP ${response.status}: ${JSON.stringify(payload).slice(0,800)}`);return payload.id||payload.data?.id||null;
}
function normalizeEmail(value){const email=String(value||'').trim().toLowerCase();return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)?email:null;}
function bytesToBase64(bytes){let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(binary);}
async function sha256Hex(bytes){const digest=await crypto.subtle.digest('SHA-256',bytes);return[...new Uint8Array(digest)].map((b)=>b.toString(16).padStart(2,'0')).join('');}
async function sha256Short(value){const bytes=new TextEncoder().encode(value);return (await sha256Hex(bytes)).slice(0,16);}
