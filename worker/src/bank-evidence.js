// Bank connectivity is optional and opt-in. Plaid bank data is not a processor payout
// confirmation and never changes the canonical Builtegrity integrity classification.
const encoder=new TextEncoder();
const b64=v=>btoa(String.fromCharCode(...new Uint8Array(v)));
const from64=v=>Uint8Array.from(atob(v),c=>c.charCodeAt(0));
function error(message,status=409){const e=new Error(message);e.status=status;return e;}
function plaidBase(env){
 const which=String(env.PLAID_ENV||'sandbox').toLowerCase();
 if(!['sandbox','production'].includes(which))throw error('Invalid Plaid environment',503);
 return 'https://'+which+'.plaid.com';
}
export async function plaidCall(env,path,body={}){
 if(env.BANK_SYNC_ENABLED!=='true')throw error('Bank sync not configured',503);
 if(!env.PLAID_CLIENT_ID||!env.PLAID_SECRET)throw error('Plaid credentials not configured',503);
 const response=await fetch(plaidBase(env)+path,{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({client_id:env.PLAID_CLIENT_ID,secret:env.PLAID_SECRET,...body})
 });
 const payload=await response.json().catch(()=>({}));
 if(!response.ok)throw error('Bank data provider error: '+String(payload.error_code||response.status),502);
 return payload;
}
async function bankKey(env){
 if(!env.BANK_TOKEN_ENCRYPTION_KEY_B64)throw error('Bank token encryption key missing',503);
 const bytes=from64(env.BANK_TOKEN_ENCRYPTION_KEY_B64);
 if(bytes.length!==32)throw error('Bank token key must be 32 bytes',503);
 return crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);
}
export async function encryptBankToken(env,token){
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv},await bankKey(env),encoder.encode(token));
 return {ciphertext:b64(bytes),iv:b64(iv)};
}
export async function decryptBankToken(env,row){
 const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(row.access_token_iv)},
   await bankKey(env),from64(row.access_token_ciphertext));
 return new TextDecoder().decode(bytes);
}
const newid=prefix=>prefix+'-'+crypto.randomUUID();
export async function makeBankLinkToken(env,merchantId,userId,existing=null){
 const p={user:{client_user_id:merchantId+'-'+userId},
   client_name:'Builtegrity',products:existing?[]:['transactions'],
   country_codes:['US'],language:'en',
   webhook:env.PLAID_WEBHOOK_URL,
   ...(env.PLAID_REDIRECT_URI?{redirect_uri:env.PLAID_REDIRECT_URI}:{})};
 if(existing){
   p.access_token=await decryptBankToken(env,existing);
 }else p.transactions={days_requested:30};
 if(!p.webhook)throw error('Plaid webhook URL is required',503);
 const data=await plaidCall(env,'/link/token/create',p);
 return {link_token:data.link_token,expiration:data.expiration};
}
export async function connectBank(env,merchantId,userId,publicToken,selectedAccountId){
 if(!publicToken||typeof publicToken!=='string'||publicToken.length>500)throw error('Invalid temporary bank link token',400);
 const exchange=await plaidCall(env,'/item/public_token/exchange',{public_token:publicToken});
 if(!exchange.item_id||!exchange.access_token)throw error('Bank connection exchange returned no credentials',502);
 const accounts=await plaidCall(env,'/accounts/get',{access_token:exchange.access_token});
 const eligible=(accounts.accounts||[]).filter(a=>a.type==='depository'&&['checking','savings'].includes(a.subtype));
 if(!eligible.length){
   await plaidCall(env,'/item/remove',{access_token:exchange.access_token}).catch(()=>{});
   throw error('Bank connection must include a checking or savings account',409);
 }
 const selected=selectedAccountId
   ?eligible.find(a=>a.account_id===selectedAccountId)
   :eligible.length===1?eligible[0]:null;
 if(selectedAccountId&&!selected)throw error('Selected account was not returned by bank',400);
 const connId=newid('BANK');
 const secured=await encryptBankToken(env,exchange.access_token);
 const tasks=[];
 tasks.push(env.DB.prepare(`
   INSERT INTO merchant_bank_connections
   (id,merchant_id,item_id,access_token_ciphertext,access_token_iv,linked_by)
   VALUES(?,?,?,?,?,?)
 `).bind(connId,merchantId,exchange.item_id,secured.ciphertext,secured.iv,userId));
 for(const a of eligible){
   tasks.push(env.DB.prepare(`
    INSERT INTO merchant_bank_accounts
    (merchant_id,connection_id,provider_account_id,account_name,institution_name,mask,
      account_type,account_subtype,is_payout_target)
    VALUES(?,?,?,?,?,?,?,?,?)
   `).bind(merchantId,connId,a.account_id,String(a.official_name||a.name||'Bank account').slice(0,150),
    String(accounts.item?.institution_id||'Connected bank'),String(a.mask||'').slice(-4),a.type,a.subtype,
    0));
 }
 await env.DB.batch(tasks);
 // Don't terminate earlier permissions until new connection is saved and the merchant
 // explicitly selects its correct processor payout destination.
 await syncBankConnection(env,connId);
 if(selected)await selectPayoutBank(env,merchantId,connId,selected.account_id);
 return {connection_id:connId,accounts:eligible.map(a=>({id:a.account_id,name:a.name,mask:a.mask})),
   selected_account_id:selected?.account_id||null,action_required:!selected};
}
export async function bankConnectionsForMerchant(env,merchantId){
 const data=await env.DB.prepare(`
  SELECT c.id AS connection_id,c.status,c.last_sync_at,c.last_error,
   a.provider_account_id,a.account_name,a.mask,a.account_subtype,a.is_payout_target
  FROM merchant_bank_connections c LEFT JOIN merchant_bank_accounts a ON a.connection_id=c.id
  WHERE c.merchant_id=? AND c.status NOT IN ('REPLACED','DISCONNECTED')
  ORDER BY c.created_at DESC LIMIT 30
 `).bind(merchantId).all();
 return (data.results||[]).map(({provider_account_id,...x})=>({...x,
   account_id:provider_account_id}));
}
export async function selectPayoutBank(env,merchantId,connectionId,accountId){
 const matched=await env.DB.prepare(`
  SELECT a.provider_account_id FROM merchant_bank_accounts a
  JOIN merchant_bank_connections c ON c.id=a.connection_id
  WHERE a.connection_id=? AND a.provider_account_id=? AND a.merchant_id=?
   AND c.merchant_id=? AND c.status='CONNECTED' AND a.status='AVAILABLE'
 `).bind(connectionId,accountId,merchantId,merchantId).first();
 if(!matched)throw error('Bank account not connected to this merchant',404);
 // Unique merchant payout bank target enforced by D1.
 await env.DB.batch([
   env.DB.prepare('UPDATE merchant_bank_accounts SET is_payout_target=0 WHERE merchant_id=?')
     .bind(merchantId),
   env.DB.prepare(`UPDATE merchant_bank_accounts SET is_payout_target=1
      WHERE merchant_id=? AND connection_id=? AND provider_account_id=?`)
     .bind(merchantId,connectionId,accountId)
 ]);
 return {selected:true};
}
export async function disconnectMerchantBank(env,merchantId,connectionId){
 const row=await env.DB.prepare(`
  SELECT * FROM merchant_bank_connections WHERE merchant_id=? AND id=?
    AND status IN('CONNECTED','REAUTH_REQUIRED','ERROR')
 `).bind(merchantId,connectionId).first();
 if(!row)throw error('Bank connection not found',404);
 // Do not expose old bank matches after consent revoked; keep narrowly necessary
 // business evidence in the ledger subject to retention/privacy policies.
 const token=await decryptBankToken(env,row);
 await plaidCall(env,'/item/remove',{access_token:token});
 await env.DB.batch([
   env.DB.prepare(`UPDATE merchant_bank_connections SET status='DISCONNECTED',
    access_token_ciphertext='DISCONNECTED',access_token_iv='DISCONNECTED',
    updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(connectionId),
   env.DB.prepare(`UPDATE merchant_bank_accounts SET status='REVOKED',
      is_payout_target=0 WHERE connection_id=?`).bind(connectionId)
 ]);
 return {disconnected:true};
}
export function observedPlaidCredit(tx){
 if(!tx||!tx.account_id||!tx.transaction_id)return null;
 const amount=Number(tx.amount);
 const credit=Math.round(-amount*100);
 if(!Number.isSafeInteger(credit)||credit<=0)return null; // Plaid uses negative for deposits
 const currency=String(tx.iso_currency_code||'').toUpperCase();
 if(currency!=='USD')return null;
 const pending=tx.pending===true;
 return {id:tx.transaction_id,account:tx.account_id,credit,currency,
   name:String(tx.merchant_name||tx.name||'').slice(0,180),
   pending,date:tx.date||null,
   postedAt:!pending?(tx.date||null):null};
}
export async function syncBankConnection(env,id) {
 const row=await env.DB.prepare(`SELECT * FROM merchant_bank_connections
   WHERE id=? AND status='CONNECTED'`).bind(id).first();
 if(!row)return {synced:false,reason:'not_connected'};
 const token=await decryptBankToken(env,row);
 let cursor=row.cursor||null,pages=0;
 const added=new Map(),removed=new Set();
 try{
  while(true){
   const page=await plaidCall(env,'/transactions/sync',
     {access_token:token,cursor,count:100});
   pages++;
   for(const x of [...(page.added||[]),...(page.modified||[])]){
     const observed=observedPlaidCredit(x);
     if(observed)added.set(observed.id,observed);
   }
   for(const x of page.removed||[])if(x.transaction_id)removed.add(x.transaction_id);
   cursor=page.next_cursor;
   if(!page.has_more)break;
   if(pages>=50)throw error('Bank sync pagination cap exceeded',503);
  }
  const queries=[];
  for(const x of added.values())queries.push(env.DB.prepare(`
   INSERT INTO merchant_bank_deposit_observations
    (provider_transaction_id,connection_id,merchant_id,provider_account_id,credit_cents,
     currency,display_name,pending,bank_transaction_date,bank_posted_at,removed)
   VALUES(?,?,?,?,?,?,?,?,?,?,0)
   ON CONFLICT(provider_transaction_id) DO UPDATE SET
     credit_cents=excluded.credit_cents,display_name=excluded.display_name,
     pending=excluded.pending,bank_transaction_date=excluded.bank_transaction_date,
     bank_posted_at=excluded.bank_posted_at,removed=0,updated_at=CURRENT_TIMESTAMP
   WHERE merchant_id=excluded.merchant_id AND connection_id=excluded.connection_id
  `).bind(x.id,row.id,row.merchant_id,x.account,x.credit,x.currency,x.name,
     x.pending?1:0,x.date,x.postedAt));
  for(const id of removed)queries.push(env.DB.prepare(`
    UPDATE merchant_bank_deposit_observations SET removed=1,updated_at=CURRENT_TIMESTAMP
    WHERE provider_transaction_id=? AND connection_id=?
  `).bind(id,row.id));
  queries.push(env.DB.prepare(`
   UPDATE merchant_bank_connections SET cursor=?,last_sync_at=CURRENT_TIMESTAMP,
    last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND cursor IS ?
  `).bind(cursor,row.id,row.cursor));
  await env.DB.batch(queries);
  await reconcileMerchantBankPayouts(env,row.merchant_id);
  return {synced:true,added:added.size,removed:removed.size,pages};
 }catch(e){
  await env.DB.prepare(`UPDATE merchant_bank_connections
   SET status=CASE WHEN ? THEN 'REAUTH_REQUIRED' ELSE status END,
       last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(/ITEM_LOGIN_REQUIRED|INVALID_ACCESS_TOKEN/.test(String(e.message))?1:0,
      String(e.message).slice(0,250),row.id).run().catch(()=>{});
  throw e;
 }
}
// A bank transaction can only support a payout with exact amount, processor-identifying
// narration, selected bank account, provider PAID status and unique match. These safeguards
// intentionally prefer "not verified" to speculative assignment.
export async function reconcileMerchantBankPayouts(env,merchantId) {
 const payouts=await env.DB.prepare(`
  SELECT processor,COALESCE(processor_payout_id,stripe_payout_id) payout_id,
    MAX(payout_batch_total_cents) amount_cents,
    MAX(expected_payout_arrival) expected_date
  FROM transactions WHERE merchant_id=? AND payout_accounted=1
   AND LOWER(COALESCE(processor_payout_status,''))='paid'
   AND COALESCE(processor_payout_id,stripe_payout_id) IS NOT NULL
  GROUP BY processor,COALESCE(processor_payout_id,stripe_payout_id)
 `).bind(merchantId).all();
 let verified=0,ambiguous=0;
 for(const payout of payouts.results||[]){
  if(!Number.isSafeInteger(Number(payout.amount_cents))||Number(payout.amount_cents)<=0)continue;
  const brand=payout.processor==='STRIPE'?'stripe':'square';
  const candidates=await env.DB.prepare(`
   SELECT b.provider_transaction_id,b.pending,b.bank_posted_at,b.credit_cents
   FROM merchant_bank_deposit_observations b
   JOIN merchant_bank_accounts a ON a.connection_id=b.connection_id
      AND a.provider_account_id=b.provider_account_id
   JOIN merchant_bank_connections c ON c.id=b.connection_id AND c.status='CONNECTED'
   WHERE b.merchant_id=? AND a.merchant_id=? AND a.is_payout_target=1
     AND a.status='AVAILABLE' AND b.removed=0 AND b.credit_cents=?
     AND b.currency='USD' AND LOWER(b.display_name) LIKE ?
     AND b.bank_transaction_date IS NOT NULL
     AND (
       (? IS NOT NULL AND date(b.bank_transaction_date)
          BETWEEN date(?,'-7 days') AND date(?,'+7 days'))
       OR (? IS NULL AND date(b.bank_transaction_date)>=date('now','-10 days'))
     )
   LIMIT 3
  `).bind(merchantId,merchantId,payout.amount_cents,'%'+brand+'%',
 payout.expected_date,payout.expected_date,payout.expected_date,payout.expected_date).all();
  const available=candidates.results||[];
  if(available.length!==1){if(available.length>1)ambiguous++;continue;}
  const one=available[0];
  const existing=await env.DB.prepare(`
   SELECT merchant_id,processor,payout_id FROM processor_bank_payout_matches
   WHERE bank_transaction_id=?`).bind(one.provider_transaction_id).first();
  if(existing&&
    (existing.merchant_id!==merchantId||existing.payout_id!==payout.payout_id||
      existing.processor!==payout.processor)){ambiguous++;continue;}
  await env.DB.prepare(`
   INSERT INTO processor_bank_payout_matches
    (merchant_id,processor,payout_id,bank_transaction_id,matched_amount_cents,status,bank_posted_at)
   VALUES(?,?,?,?,?,?,?)
   ON CONFLICT(merchant_id,processor,payout_id) DO UPDATE SET
     bank_transaction_id=excluded.bank_transaction_id,
     status=excluded.status,bank_posted_at=excluded.bank_posted_at,
     updated_at=CURRENT_TIMESTAMP
   WHERE processor_bank_payout_matches.bank_transaction_id=excluded.bank_transaction_id
      OR EXISTS (SELECT 1 FROM merchant_bank_deposit_observations previous
        WHERE previous.provider_transaction_id=processor_bank_payout_matches.bank_transaction_id
          AND previous.removed=1)
  `).bind(merchantId,payout.processor,payout.payout_id,one.provider_transaction_id,
     payout.amount_cents,one.pending?'BANK_PENDING':'BANK_POSTED',one.bank_posted_at).run();
  verified++;
 }
 return {verified,ambiguous};
}
export async function payoutBankEvidence(env,tx){
 if(!tx?.merchant_id)return null;
 const payout=tx.processor==='SQUARE'?tx.processor_payout_id:tx.stripe_payout_id;
 const active=await env.DB.prepare(`
   SELECT 1 FROM merchant_bank_accounts a
    JOIN merchant_bank_connections c ON c.id=a.connection_id
    WHERE a.merchant_id=? AND a.is_payout_target=1 AND a.status='AVAILABLE'
       AND c.status='CONNECTED' LIMIT 1`).bind(tx.merchant_id).first();
 if(!active)return null; // Bank section must not appear when no authorized connection.
 if(!payout)return {status:'AWAITING_PROCESSOR_PAYOUT',verified:false};
 const row=await env.DB.prepare(`
  SELECT m.status,m.bank_posted_at,m.matched_amount_cents,
    b.bank_transaction_date,b.pending,b.removed,b.display_name
  FROM processor_bank_payout_matches m
  JOIN merchant_bank_deposit_observations b ON b.provider_transaction_id=m.bank_transaction_id
  JOIN merchant_bank_accounts a ON a.connection_id=b.connection_id
    AND a.provider_account_id=b.provider_account_id
    AND a.is_payout_target=1 AND a.status='AVAILABLE'
  JOIN merchant_bank_connections c ON c.id=a.connection_id AND c.status='CONNECTED'
  WHERE m.merchant_id=? AND m.processor=? AND m.payout_id=?
  AND b.removed=0 AND b.merchant_id=?
 `).bind(tx.merchant_id,tx.processor,payout,tx.merchant_id).first();
 if(!row)return {status:'AWAITING_BANK_EVIDENCE',verified:false};
 return {status:row.pending?'BANK_PENDING':'BANK_POSTED',verified:!row.pending,
   bank_transaction_date:row.bank_transaction_date,bank_posted_at:row.bank_posted_at,
   matched_payout_amount_cents:row.matched_amount_cents,
   evidence_source:'PLAID_TRANSACTIONS'};
}
export async function runBankSyncRecovery(env,{limit=5}={}){
 if(env.BANK_SYNC_ENABLED!=='true')return {enabled:false};
 const rows=await env.DB.prepare(`
  SELECT id FROM merchant_bank_connections WHERE status='CONNECTED'
   AND (last_sync_at IS NULL OR datetime(last_sync_at)<=datetime('now','-30 minutes'))
  ORDER BY COALESCE(last_sync_at,'') ASC LIMIT ?
 `).bind(limit).all();
 let checked=0,failed=0;
 for(const row of rows.results||[]){
  try{await syncBankConnection(env,row.id);checked++;}
  catch(e){failed++;console.error('Bank sync failed for connection',row.id,String(e.message));}
 }
 return {enabled:true,checked,failed};
}
