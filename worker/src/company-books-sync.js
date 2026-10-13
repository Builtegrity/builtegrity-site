import {
  quickBooksCompanyInfo,
  quickBooksAccounts,
  quickBooksProfitAndLoss,
  quickBooksBalanceSheet,
  summarizeProfitAndLoss,
  summarizeBalanceSheet,
  normalizeQuickBooksAccount,
} from './quickbooks-api.js';

const PRIMARY='BOOKS-PRIMARY';

export async function runCompanyBooksSync(env, options={}) {
  const force=Boolean(options.force);
  const connection=await env.DB.prepare(`SELECT * FROM accounting_connections WHERE id=?`).bind(PRIMARY).first();
  if(!connection || connection.status!=='ACTIVE') return evaluateCompanyBooksState(env);

  const settings=await env.DB.prepare(`SELECT * FROM company_books_settings WHERE id='GLOBAL'`).first();
  if(!force && isFresh(connection.last_sync_succeeded_at,6)) return evaluateCompanyBooksState(env);

  await env.DB.prepare(`UPDATE accounting_connections SET last_sync_started_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(PRIMARY).run();
  try{
    const company=await quickBooksCompanyInfo(env);
    const companyName=company?.CompanyInfo?.CompanyName || company?.CompanyInfo?.LegalName || null;
    if(companyName) await env.DB.prepare(`UPDATE accounting_connections SET company_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(companyName,PRIMARY).run();

    const accounts=await quickBooksAccounts(env);
    await syncAccounts(env,accounts);

    const now=options.now?new Date(options.now):new Date();
    const lagDays=Number(settings?.settlement_lag_days ?? 7);
    const settledDate=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-lagDays));
    const ytdStart=new Date(Date.UTC(settledDate.getUTCFullYear(),0,1));
    await syncPeriod(env,{kind:'YTD',start:ytdStart,endExclusive:addDays(settledDate,1)},settings);

    const completed=previousCompletedQuarter(now);
    if(now.getTime() >= addDays(completed.endExclusive,lagDays).getTime()) {
      await syncPeriod(env,{kind:'QUARTER',start:completed.start,endExclusive:completed.endExclusive},settings);
    }
    if(now.getUTCMonth()<=5){
      const year=now.getUTCFullYear()-1;
      await syncPeriod(env,{kind:'YEAR',start:new Date(Date.UTC(year,0,1)),endExclusive:new Date(Date.UTC(year+1,0,1))},settings);
    }

    await env.DB.prepare(`UPDATE accounting_connections SET last_sync_succeeded_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(PRIMARY).run();
  }catch(error){
    await env.DB.prepare(`UPDATE accounting_connections SET status=CASE WHEN ? IN (401,403) THEN 'REAUTH_REQUIRED' ELSE status END,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(Number(error?.status||0),String(error?.message||error).slice(0,1000),PRIMARY).run();
  }
  return evaluateCompanyBooksState(env);
}

export async function syncPeriod(env, period, settingsOverride=null) {
  const settings=settingsOverride || await env.DB.prepare(`SELECT * FROM company_books_settings WHERE id='GLOBAL'`).first();
  const connection=await env.DB.prepare(`SELECT * FROM accounting_connections WHERE id=?`).bind(PRIMARY).first();
  if(!connection || connection.status!=='ACTIVE') throw Object.assign(new Error('QuickBooks Online is not active'),{status:409});
  const method=String(settings.accounting_method||'CASH').toUpperCase();
  const qboMethod=method==='ACCRUAL'?'Accrual':'Cash';
  const startDate=dateOnly(period.start);
  const endDate=dateOnly(addDays(period.endExclusive,-1));
  const [pnlRaw,bsRaw]=await Promise.all([
    quickBooksProfitAndLoss(env,startDate,endDate,qboMethod),
    quickBooksBalanceSheet(env,endDate,qboMethod),
  ]);
  const mapping={fee_income_account_ref:settings.fee_income_account_ref,fee_income_account_name:settings.fee_income_account_name};
  const pnl=summarizeProfitAndLoss(pnlRaw,mapping);
  const bs=summarizeBalanceSheet(bsRaw);
  const pnlSnapshot=await storeReport(env,'PROFIT_AND_LOSS',period,method,pnl,pnlRaw,connection);
  const bsSnapshot=await storeReport(env,'BALANCE_SHEET',period,method,bs,bsRaw,connection);
  return reconcilePeriod(env,period,method,pnlSnapshot,bsSnapshot,settings);
}

export async function evaluateCompanyBooksState(env) {
  const connection=await env.DB.prepare(`SELECT * FROM accounting_connections WHERE id=?`).bind(PRIMARY).first();
  const settings=await env.DB.prepare(`SELECT * FROM company_books_settings WHERE id='GLOBAL'`).first();
  const latest=await env.DB.prepare(`SELECT * FROM accounting_reconciliation_runs ORDER BY created_at DESC LIMIT 1`).first();
  let state='INCOMPLETE'; const reasons=[];

  if(!connection || ['NOT_CONFIGURED','DISCONNECTED'].includes(connection.status)){state='NOT_CONNECTED';reasons.push('ACCOUNTING_NOT_CONNECTED');}
  else if(connection.status==='REAUTH_REQUIRED'){state='REAUTH_REQUIRED';reasons.push('ACCOUNTING_REAUTH_REQUIRED');}
  else if(connection.status!=='ACTIVE'){state='INCOMPLETE';reasons.push('ACCOUNTING_CONNECTION_NOT_ACTIVE');}
  else if(!isFresh(connection.last_sync_succeeded_at,Number(settings?.sync_freshness_hours||26))){state='STALE';reasons.push('ACCOUNTING_SYNC_STALE');}
  else if(settings?.all_business_financial_accounts_status!=='CONFIRMED'){state='INCOMPLETE';reasons.push('ALL_BUSINESS_ACCOUNTS_NOT_CONFIRMED');}
  else if(!settings?.fee_income_account_ref && !settings?.fee_income_account_name){state='MAPPING_REQUIRED';reasons.push('FEE_INCOME_ACCOUNT_MAPPING_REQUIRED');}
  else if(!latest){state='INCOMPLETE';reasons.push('RECONCILIATION_MISSING');}
  else if(latest.status==='MAPPING_REQUIRED'){state='MAPPING_REQUIRED';reasons.push('FEE_INCOME_ACCOUNT_MAPPING_REQUIRED');}
  else if(latest.status==='MISMATCH'){state='MISMATCH';reasons.push('TRANSACTION_REVENUE_BOOKS_MISMATCH');}
  else if(latest.status==='NO_BANK_ACCOUNT'){state='INCOMPLETE';reasons.push('NO_ACTIVE_BANK_ACCOUNT_IN_BOOKS');}
  else if(latest.status!=='PASS'){state='INCOMPLETE';reasons.push('BOOKS_RECONCILIATION_INCOMPLETE');}
  else {state='COMPLETE_VERIFIED';reasons.push('BOOKS_RECONCILED');}

  await env.DB.prepare(`UPDATE company_books_state SET state=?,connection_status=?,latest_reconciliation_id=?,reason_codes_json=?,evaluated_at=CURRENT_TIMESTAMP WHERE id='GLOBAL'`)
    .bind(state,connection?.status||'NOT_CONFIGURED',latest?.id||null,JSON.stringify(reasons)).run();
  await env.DB.prepare(`INSERT INTO company_books_state_events(state,connection_status,reconciliation_id,reason_codes_json) VALUES(?,?,?,?)`)
    .bind(state,connection?.status||'NOT_CONFIGURED',latest?.id||null,JSON.stringify(reasons)).run();
  if(state==='COMPLETE_VERIFIED'){
    await env.DB.prepare(`UPDATE builtegrity_tax_profile SET accounting_data_status='COMPLETE_VERIFIED',updated_at=CURRENT_TIMESTAMP WHERE id='GLOBAL'`).run();
  }
  return getCompanyBooksStatus(env);
}

export async function getCompanyBooksStatus(env){
  const [connection,settings,state,latest]=await Promise.all([
    env.DB.prepare(`SELECT id,provider,status,realm_id,company_name,scope,access_token_expires_at,refresh_token_expires_at,last_sync_started_at,last_sync_succeeded_at,last_error,updated_at FROM accounting_connections WHERE id=?`).bind(PRIMARY).first(),
    env.DB.prepare(`SELECT * FROM company_books_settings WHERE id='GLOBAL'`).first(),
    env.DB.prepare(`SELECT * FROM company_books_state WHERE id='GLOBAL'`).first(),
    env.DB.prepare(`SELECT * FROM accounting_reconciliation_runs ORDER BY created_at DESC LIMIT 1`).first(),
  ]);
  const accounts=await env.DB.prepare(`SELECT provider_account_ref,name,fully_qualified_name,account_type,account_subtype,classification,active,current_balance_micros,synced_at FROM accounting_provider_accounts WHERE connection_id=? ORDER BY account_type,name`).bind(PRIMARY).all();
  return {connection,settings,state:{...state,reason_codes:parse(state?.reason_codes_json)},latest_reconciliation:hydrateReconciliation(latest),accounts:accounts.results||[]};
}

export async function updateCompanyBooksSettings(env,input={},principal={}){
  const current=await env.DB.prepare(`SELECT * FROM company_books_settings WHERE id='GLOBAL'`).first();
  const method=String(input.accounting_method??current.accounting_method??'CASH').toUpperCase();
  if(!['CASH','ACCRUAL'].includes(method)) throw Object.assign(new Error('accounting_method must be CASH or ACCRUAL'),{status:400});
  const accountRef=nullable(input.fee_income_account_ref??current.fee_income_account_ref);
  const accountName=nullable(input.fee_income_account_name??current.fee_income_account_name);
  const allStatus=String(input.all_business_financial_accounts_status??current.all_business_financial_accounts_status??'UNKNOWN').toUpperCase();
  if(!['UNKNOWN','CONFIRMED'].includes(allStatus)) throw Object.assign(new Error('all_business_financial_accounts_status must be UNKNOWN or CONFIRMED'),{status:400});
  const actor=principal?.userId||principal?.ref||principal?.email||'OPERATOR';
  const confirmedAt=allStatus==='CONFIRMED'?(current.confirmed_at||new Date().toISOString()):null;
  await env.DB.prepare(`UPDATE company_books_settings SET accounting_method=?,fee_income_account_ref=?,fee_income_account_name=?,all_business_financial_accounts_status=?,confirmed_by=?,confirmed_at=?,updated_at=CURRENT_TIMESTAMP WHERE id='GLOBAL'`)
    .bind(method,accountRef,accountName,allStatus,allStatus==='CONFIRMED'?actor:null,confirmedAt).run();
  return evaluateCompanyBooksState(env);
}

async function syncAccounts(env,accounts){
  for(const raw of accounts){
    const a=normalizeQuickBooksAccount(raw); if(!a.provider_account_ref||!a.name) continue;
    await env.DB.prepare(`INSERT INTO accounting_provider_accounts(connection_id,provider_account_ref,name,fully_qualified_name,account_type,account_subtype,classification,active,current_balance_micros,source_updated_at,synced_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(connection_id,provider_account_ref) DO UPDATE SET name=excluded.name,fully_qualified_name=excluded.fully_qualified_name,account_type=excluded.account_type,account_subtype=excluded.account_subtype,classification=excluded.classification,active=excluded.active,current_balance_micros=excluded.current_balance_micros,source_updated_at=excluded.source_updated_at,synced_at=CURRENT_TIMESTAMP`)
      .bind(PRIMARY,a.provider_account_ref,a.name,a.fully_qualified_name,a.account_type,a.account_subtype,a.classification,a.active,a.current_balance_micros,a.source_updated_at).run();
  }
}

async function storeReport(env,type,period,method,summary,raw,connection){
  const json=JSON.stringify(raw); const bytes=new TextEncoder().encode(json); const hash=await sha256Hex(bytes);
  const id=`BOOK-${type==='PROFIT_AND_LOSS'?'PNL':'BS'}-${period.kind}-${dateOnly(period.start)}-${dateOnly(addDays(period.endExclusive,-1))}-${randomId()}`;
  let objectKey=null;
  if(env.TRANSACTION_RECORDS){objectKey=`accounting/quickbooks/${connection.realm_id}/${period.kind.toLowerCase()}/${id}.json`;await env.TRANSACTION_RECORDS.put(objectKey,bytes,{httpMetadata:{contentType:'application/json'},customMetadata:{sha256:hash,reportType:type,periodKind:period.kind}});}
  const common=[id,PRIMARY,type,period.kind,period.start.toISOString(),period.endExclusive.toISOString(),method,summary.row_count>0?'COMPLETE':'NEEDS_REVIEW','USD'];
  await env.DB.prepare(`INSERT INTO accounting_report_snapshots(id,connection_id,provider,report_type,period_kind,period_start,period_end_exclusive,accounting_method,status,currency,total_income_micros,cost_of_goods_sold_micros,total_expenses_micros,other_income_micros,other_expenses_micros,net_income_micros,total_assets_micros,total_liabilities_micros,total_equity_micros,cash_micros,accounts_receivable_micros,accounts_payable_micros,mapped_fee_income_micros,raw_object_key,raw_sha256,provider_report_time,snapshot_json)
    VALUES(?,?,'QUICKBOOKS_ONLINE',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(...common,summary.total_income_micros??null,summary.cost_of_goods_sold_micros??null,summary.total_expenses_micros??null,summary.other_income_micros??null,summary.other_expenses_micros??null,summary.net_income_micros??null,summary.total_assets_micros??null,summary.total_liabilities_micros??null,summary.total_equity_micros??null,summary.cash_micros??null,summary.accounts_receivable_micros??null,summary.accounts_payable_micros??null,summary.mapped_fee_income_micros??null,objectKey,hash,raw?.Header?.Time||null,JSON.stringify(summary)).run();
  return env.DB.prepare(`SELECT * FROM accounting_report_snapshots WHERE id=?`).bind(id).first();
}

async function reconcilePeriod(env,period,method,pnl,bs,settings){
  const internal=await env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN entry_kind='REVENUE' THEN amount_micros WHEN entry_kind='ADJUSTMENT' THEN amount_micros ELSE 0 END),0) AS amount FROM transaction_economics_ledger WHERE basis='ACTUAL' AND category IN ('INTEGRITY_FEE','INTEGRITY_FEE_ADJUSTMENT') AND datetime(created_at)>=datetime(?) AND datetime(created_at)<datetime(?)`)
    .bind(period.start.toISOString(),period.endExclusive.toISOString()).first();
  const internalMicros=Number(internal?.amount||0); const books=pnl?.mapped_fee_income_micros==null?null:Number(pnl.mapped_fee_income_micros);
  const diff=books==null?null:books-internalMicros; const tolerance=Number(settings.reconciliation_tolerance_micros||10000);
  const bank=await env.DB.prepare(`SELECT COUNT(*) AS count FROM accounting_provider_accounts WHERE connection_id=? AND lower(COALESCE(account_type,''))='bank' AND COALESCE(active,1)=1`).bind(PRIMARY).first();
  const bankCount=Number(bank?.count||0); const reasons=[]; let status='PASS';
  if(pnl?.status!=='COMPLETE'||bs?.status!=='COMPLETE'){status='INCOMPLETE_REPORTS';reasons.push('ACCOUNTING_REPORT_INCOMPLETE');}
  else if(bankCount<1){status='NO_BANK_ACCOUNT';reasons.push('NO_ACTIVE_BANK_ACCOUNT');}
  else if(!settings.fee_income_account_ref&&!settings.fee_income_account_name){status='MAPPING_REQUIRED';reasons.push('FEE_INCOME_ACCOUNT_MAPPING_REQUIRED');}
  else if(books==null){status='MAPPING_REQUIRED';reasons.push('MAPPED_FEE_INCOME_NOT_FOUND_IN_PNL');}
  else if(Math.abs(diff)>tolerance){status='MISMATCH';reasons.push('FEE_REVENUE_MISMATCH');}
  else reasons.push('RECONCILED');
  const id=`BOOK-REC-${period.kind}-${dateOnly(period.start)}-${randomId()}`;
  const evidence={internal_fee_revenue_micros:internalMicros,books_mapped_fee_income_micros:books,revenue_difference_micros:diff,tolerance_micros:tolerance,bank_account_count:bankCount};
  await env.DB.prepare(`INSERT INTO accounting_reconciliation_runs(id,period_kind,period_start,period_end_exclusive,accounting_method,profit_and_loss_snapshot_id,balance_sheet_snapshot_id,internal_fee_revenue_micros,books_mapped_fee_income_micros,revenue_difference_micros,tolerance_micros,bank_account_count,status,reason_codes_json,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id,period.kind,period.start.toISOString(),period.endExclusive.toISOString(),method,pnl.id,bs.id,internalMicros,books,diff,tolerance,bankCount,status,JSON.stringify(reasons),JSON.stringify(evidence)).run();
  return env.DB.prepare(`SELECT * FROM accounting_reconciliation_runs WHERE id=?`).bind(id).first();
}

function previousCompletedQuarter(now){const y=now.getUTCFullYear(),q=Math.floor(now.getUTCMonth()/3)+1;if(q===1)return{start:new Date(Date.UTC(y-1,9,1)),endExclusive:new Date(Date.UTC(y,0,1))};const sm=(q-2)*3;return{start:new Date(Date.UTC(y,sm,1)),endExclusive:new Date(Date.UTC(y,sm+3,1))};}
function isFresh(value,hours){const t=Date.parse(value||'');return Number.isFinite(t)&&(Date.now()-t)<=hours*3600000;}
function addDays(date,days){return new Date(date.getTime()+days*86400000);}
function dateOnly(date){return date.toISOString().slice(0,10);}
function randomId(){const b=crypto.getRandomValues(new Uint8Array(8));return[...b].map((x)=>x.toString(16).padStart(2,'0')).join('');}
async function sha256Hex(bytes){const d=await crypto.subtle.digest('SHA-256',bytes);return[...new Uint8Array(d)].map((b)=>b.toString(16).padStart(2,'0')).join('');}
function nullable(value){return value==null||String(value).trim()===''?null:String(value).trim().slice(0,200);}
function parse(value){if(!value)return[];try{return JSON.parse(value);}catch{return[];}}
function hydrateReconciliation(row){return row?{...row,reason_codes:parse(row.reason_codes_json),evidence:parseObject(row.evidence_json)}:null;}
function parseObject(value){if(!value)return null;try{return JSON.parse(value);}catch{return null;}}
