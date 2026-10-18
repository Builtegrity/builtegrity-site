const transactions=document.querySelector('#transactions');
const refunds=document.querySelector('#refunds');
const status=document.querySelector('#status');
const refresh=document.querySelector('#refresh');
const tabs={transactions:document.querySelector('#tab-transactions'),refunds:document.querySelector('#tab-refunds')};
const panels={transactions:document.querySelector('#panel-transactions'),refunds:document.querySelector('#panel-refunds')};
const loaded={transactions:false,refunds:false};
let active=new URLSearchParams(location.search).get('tab')==='refunds'?'refunds':'transactions';
let inflight=false;

function money(cents,currency){
  const amount=Number(cents);
  if(!Number.isFinite(amount))return 'Not recorded';
  try{return new Intl.NumberFormat('en-US',{style:'currency',currency:currency||'USD'}).format(amount/100);}
  catch{return (amount/100).toFixed(2)+' '+String(currency||'USD');}
}
function td(row,value){const el=document.createElement('td');el.textContent=String(value??'—');row.append(el);return el;}
function pdfPath(id,inline=false){return '/api/merchant/transactions/'+encodeURIComponent(id)+'/pdf'+(inline?'?view=1':'');}
function pdfLinks(row,id){
  const cell=document.createElement('td');cell.className='record-action';
  for(const [label,inline] of [['PDF',true],['Download',false]]){
    if(cell.childNodes.length)cell.append(' · ');
    const a=document.createElement('a');a.textContent=label;a.href=pdfPath(id,inline);
    a.rel='noopener noreferrer';if(inline)a.target='_blank';cell.append(a);
  }
  row.append(cell);
}
async function request(url){
  const response=await fetch(url,{credentials:'same-origin',cache:'no-store'});
  if(response.status===401){
    location.assign('/login/?return_to='+encodeURIComponent(location.pathname+location.search));
    throw Error('Please sign in');
  }
  const json=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(json.error||'Unable to load merchant history');
  return json;
}
function drawTransactions(items){
  transactions.replaceChildren();
  for(const tx of items){
    const row=document.createElement('tr');row.dataset.pdf=pdfPath(tx.id,true);
    td(row,tx.id);td(row,tx.merchant_name);td(row,tx.processor);
    td(row,money(tx.amount_cents,tx.currency));td(row,tx.lifecycle_status);td(row,tx.integrity_status);
    td(row,tx.integrity_verified_at||'Pending');pdfLinks(row,tx.id);transactions.append(row);
    row.addEventListener('click',ev=>{
      if(ev.target.closest('a'))return;
      window.open(row.dataset.pdf,'_blank','noopener,noreferrer');
    });
  }
  if(!items.length){const row=document.createElement('tr');const el=td(row,'No transactions yet.');el.colSpan=8;transactions.append(row);}
}
function drawRefunds(items){
  refunds.replaceChildren();
  for(const refund of items){
    const row=document.createElement('tr');
    td(row,refund.refund_id);td(row,refund.transaction_id);
    td(row,refund.processor);td(row,money(refund.amount_cents,refund.currency));
    td(row,refund.status);td(row,refund.occurred_at);
    pdfLinks(row,refund.transaction_id);refunds.append(row);
  }
  if(!items.length){const row=document.createElement('tr');const el=td(row,'No recorded refunds yet.');el.colSpan=7;refunds.append(row);}
}
async function reload(){
  if(inflight)return;
  inflight=true;refresh.disabled=true;
  const requestedTab=active;
  status.textContent='Refreshing '+requestedTab+' history…';
  try{
    const source=requestedTab==='refunds'?'/api/merchant/refunds':'/api/merchant/transactions';
    const result=await request(source);
    const records=requestedTab==='refunds'?result.refunds||[]:result.transactions||[];
    if(requestedTab==='refunds')drawRefunds(records);else drawTransactions(records);
    loaded[requestedTab]=true;
    if(requestedTab===active)status.textContent=records.length+' '+requestedTab+' record(s) · Updated '+new Date().toLocaleTimeString();
  }catch(e){status.textContent=String(e.message||e);}
  finally{inflight=false;refresh.disabled=false;if(requestedTab!==active)reload();}
}
function activate(tab,updateHistory=true){
  active=tab==='refunds'?'refunds':'transactions';
  for(const name of Object.keys(tabs)){
    const selected=name===active;
    tabs[name].setAttribute('aria-selected',String(selected));
    tabs[name].tabIndex=selected?0:-1;panels[name].hidden=!selected;
  }
  if(updateHistory){
    const url=new URL(location.href);url.searchParams.set('tab',active);
    history.replaceState(null,'',url);
  }
  reload();
}
tabs.transactions.addEventListener('click',()=>activate('transactions'));
tabs.refunds.addEventListener('click',()=>activate('refunds'));
refresh.addEventListener('click',reload);
// A lightweight browser refresh keeps the visible screen current; payment ingestion is webhook-driven.
setInterval(()=>{if(document.visibilityState==='visible')reload();},30000);
activate(active,false);
