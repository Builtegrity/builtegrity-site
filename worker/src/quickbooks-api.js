import { getQuickBooksAccessToken } from './quickbooks-oauth.js';

const API_BASE = 'https://quickbooks.api.intuit.com';

export async function quickBooksCompanyInfo(env) {
  const { connection } = await getQuickBooksAccessToken(env);
  return quickBooksGet(env, `/v3/company/${encodeURIComponent(connection.realm_id)}/companyinfo/${encodeURIComponent(connection.realm_id)}`);
}

export async function quickBooksAccounts(env) {
  const { connection } = await getQuickBooksAccessToken(env);
  const query = encodeURIComponent('select * from Account maxresults 1000');
  const payload = await quickBooksGet(env, `/v3/company/${encodeURIComponent(connection.realm_id)}/query?query=${query}`);
  return payload?.QueryResponse?.Account || [];
}

export async function quickBooksProfitAndLoss(env, startDate, endDateInclusive, accountingMethod='Cash') {
  const { connection } = await getQuickBooksAccessToken(env);
  const params = new URLSearchParams({ start_date:startDate, end_date:endDateInclusive, accounting_method:accountingMethod });
  return quickBooksGet(env, `/v3/company/${encodeURIComponent(connection.realm_id)}/reports/ProfitAndLoss?${params}`);
}

export async function quickBooksBalanceSheet(env, reportDate, accountingMethod='Cash') {
  const { connection } = await getQuickBooksAccessToken(env);
  const params = new URLSearchParams({ report_date:reportDate, accounting_method:accountingMethod });
  return quickBooksGet(env, `/v3/company/${encodeURIComponent(connection.realm_id)}/reports/BalanceSheet?${params}`);
}

export function summarizeProfitAndLoss(report, mapping={}) {
  const rows = flattenReportRows(report?.Rows?.Row || []);
  return {
    total_income_micros: findAmount(rows,['Total Income','Income']),
    cost_of_goods_sold_micros: findAmount(rows,['Total Cost of Goods Sold','Cost of Goods Sold']),
    total_expenses_micros: findAmount(rows,['Total Expenses','Expenses']),
    other_income_micros: findAmount(rows,['Total Other Income','Other Income']),
    other_expenses_micros: findAmount(rows,['Total Other Expenses','Other Expenses']),
    net_income_micros: findAmount(rows,['Net Income']),
    mapped_fee_income_micros: mappedAmount(rows,mapping.fee_income_account_ref,mapping.fee_income_account_name),
    row_count: rows.length,
  };
}

export function summarizeBalanceSheet(report) {
  const rows = flattenReportRows(report?.Rows?.Row || []);
  return {
    total_assets_micros: findAmount(rows,['Total Assets']),
    total_liabilities_micros: findAmount(rows,['Total Liabilities']),
    total_equity_micros: findAmount(rows,['Total Equity']),
    cash_micros: firstPresent(rows,['Total Bank Accounts','Bank Accounts','Total Cash and cash equivalents']),
    accounts_receivable_micros: firstPresent(rows,['Accounts Receivable (A/R)','Accounts Receivable','Total Accounts Receivable']),
    accounts_payable_micros: firstPresent(rows,['Accounts Payable (A/P)','Accounts Payable','Total Accounts Payable']),
    row_count: rows.length,
  };
}

export function normalizeQuickBooksAccount(account) {
  return {
    provider_account_ref: String(account?.Id || ''),
    name: String(account?.Name || ''),
    fully_qualified_name: account?.FullyQualifiedName || null,
    account_type: account?.AccountType || null,
    account_subtype: account?.AccountSubType || null,
    classification: account?.Classification || null,
    active: account?.Active == null ? null : (account.Active ? 1 : 0),
    current_balance_micros: toMicros(account?.CurrentBalance),
    source_updated_at: account?.MetaData?.LastUpdatedTime || null,
  };
}

export function flattenReportRows(input) {
  const output=[];
  const visit=(row)=>{
    if(!row || typeof row!=='object') return;
    const candidates=[row.Header?.ColData,row.ColData,row.Summary?.ColData].filter(Array.isArray);
    for(const cols of candidates){
      const first=cols[0]||{};
      const last=cols[cols.length-1]||{};
      const label=String(first.value||'').trim();
      if(label){
        output.push({
          label,
          id:first.id ? String(first.id) : null,
          amount_micros:toMicros(last.value),
          raw:cols,
        });
      }
    }
    for(const child of row.Rows?.Row||[]) visit(child);
  };
  for(const row of input||[]) visit(row);
  return output;
}

async function quickBooksGet(env,path){
  const { token }=await getQuickBooksAccessToken(env);
  const response=await fetch(`${API_BASE}${path}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok){
    const message=payload?.Fault?.Error?.[0]?.Message || payload?.Fault?.Error?.[0]?.Detail || `QuickBooks API error ${response.status}`;
    const error=new Error(message);error.status=response.status;throw error;
  }
  return payload;
}
function mappedAmount(rows,ref,name){
  if(!ref && !name) return null;
  const normalizedName=String(name||'').trim().toLowerCase();
  const matches=rows.filter((row)=>(ref && row.id===String(ref)) || (normalizedName && row.label.toLowerCase()===normalizedName));
  const values=matches.map((x)=>x.amount_micros).filter((x)=>x!=null);
  return values.length ? values.reduce((a,b)=>a+b,0) : null;
}
function findAmount(rows,labels){
  for(const label of labels){
    const row=[...rows].reverse().find((x)=>x.label.toLowerCase()===label.toLowerCase() && x.amount_micros!=null);
    if(row) return row.amount_micros;
  }
  return null;
}
function firstPresent(rows,labels){return findAmount(rows,labels);}
function toMicros(value){
  if(value==null || value==='') return null;
  const normalized=String(value).replace(/[$,]/g,'').trim();
  const number=Number(normalized);
  return Number.isFinite(number) ? Math.round(number*1000000) : null;
}
