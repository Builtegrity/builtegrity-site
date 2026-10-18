const transactions=document.querySelector('#transactions');
const refunds=document.querySelector('#refunds');
const status=document.querySelector('#status');
const refresh=document.querySelector('#refresh');
const tabs={transactions:document.querySelector('#tab-transactions'),refunds:document.querySelector('#tab-refunds')};
const panels={transactions:document.querySelector('#panel-transactions'),refunds:document.querySelector('#panel-refunds')};
const loaded={transactions:false,refunds:false};
let active=new URLSearchParams(location.search).get('tab')==='refunds'?'refunds':'transactions';
let inflight=false,lastIds='',latestId=null;
const journeys=new Map();
function money(cents,currency){
 const num=Number(cents);
 if(!Number.isFinite(num))return 'Not recorded';
 try{return new Intl.NumberFormat('en-US',{style:'currency',currency:currency||'USD'}).format(num/100);}
 catch{return (num/100).toFixed(2)+' '+String(currency||'USD');}
}
function td(row,value){const cell=document.createElement('td');cell.textContent=String(value??'—');row.append(cell);return cell;}
function pdfPath(id,inline=false){return '/api/merchant/transactions/'+encodeURIComponent(id)+'/pdf'+(inline?'?view=1':'');}
function pdfLinks(row,id){
 const cell=document.createElement('td');
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
  location.assign('/login/?return_to='+encodeURIComponent(location.pathname+location.search));throw Error('Sign in required');
 }
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(data.error||'Unable to load merchant history');
 return data;
}
function elem(tag,className,text){
 const result=document.createElement(tag);
 if(className)result.className=className;
 if(text!==undefined)result.textContent=String(text);
 return result;
}
function time(value){
 if(!value)return 'Awaiting evidence';
 const d=new Date(value);
 return Number.isNaN(d.getTime())?String(value):d.toLocaleString();
}
function pdfIcon(id){
 const a=elem('a','journey-pdf','▣  PDF');
 a.href=pdfPath(id,true);a.target='_blank';a.rel='noopener noreferrer';
 a.title='View latest PDF (print, download or share)';return a;
}
function createCard(tx,openInitially=false){
 const card=elem('details','journey-card');
 card.dataset.tx=tx.id;
 const isActive=tx.lifecycle_status!=='COMPLETE'||tx.exception_status!=='NONE';
 card.dataset.active=isActive?'true':'false';
 const summary=elem('summary');
 const main=elem('div','journey-main');
 const label=elem('div','journey-title');
 label.append(elem('span','',tx.merchant_payment_reference||tx.merchant_reference||tx.id));
 const chip=elem('span','journey-chip '+(tx.integrity_status==='ACCOUNTED'?'accounted':
    tx.integrity_status==='NEEDS_ATTENTION'?'attention':'running'),
    tx.integrity_status==='ACCOUNTED'?'Accounted for':
    tx.integrity_status==='NEEDS_ATTENTION'?'Needs attention':'Processing');
 label.append(chip);main.append(label);
 main.append(elem('div','journey-sub',tx.merchant_name+' · '+tx.processor+' · '+tx.id));
 main.append(elem('div','journey-sub','Verified: '+time(tx.integrity_verified_at)));
 const side=elem('div','journey-side');
 side.append(elem('div','journey-amount',money(tx.amount_cents,tx.currency)));
 side.append(elem('span','journey-open','⌄'));
 summary.append(main,side);card.append(summary);
 const expanded=elem('div','journey-expanded');
 expanded.append(elem('p','integrity-meta','Expand to see verified transaction events…'));
 card.append(expanded);
 card.addEventListener('toggle',()=>{if(card.open)refreshJourney(card);});
 if(openInitially)card.open=true;
 return card;
}
function progressStep(name,done,activeNow,at,detail,attention=false){
 const item=elem('li','journey-step '+(attention?'error':done?'done':activeNow?'waiting':''));
 item.append(elem('strong','',name));
 item.append(elem('small','',done?time(at):detail||'Awaiting verified processor evidence'));
 return item;
}
function buildJourney(card,data){
 const tx=data.transaction;
 const wrap=card.querySelector('.journey-expanded');
 wrap.replaceChildren();
 const header=elem('div','journey-header');
 const description=elem('div');
 description.append(elem('strong','',tx.customer_name||tx.merchant_name||'Merchant transaction'));
 description.append(elem('div','integrity-meta','Merchant reference: '+(tx.merchant_reference||'Not provided')+
    ' · Merchant payment ID: '+(tx.merchant_payment_reference||'Not supplied')+
    ' · Builtegrity: '+tx.id));
 header.append(description);
 const actions=elem('div');actions.append(pdfIcon(tx.id));
 const save=elem('a','journey-pdf','↓ Download');
 save.href=pdfPath(tx.id);save.title='Download the latest transaction PDF';
 actions.append('  ',save);header.append(actions);wrap.append(header);
 const steps=elem('ol','journey-track');
 const settled=String(tx.processor_payout_status||'').toLowerCase()==='paid';
 const payment=Boolean(tx.payment_at);
 const consent=Boolean(tx.consent_at);
 const checkout=Boolean(tx.checkout_at);
 const fee=tx.record_classification==='PROTECTED';
 const timeline=[
  ['Transaction created',Boolean(tx.created_at),tx.created_at,'Creating payment record'],
  ['Customer accepted terms',consent,tx.consent_at,'Waiting for customer agreement'],
  ['Secure processor checkout',checkout,tx.checkout_at,'Awaiting checkout creation'],
  ['Processor confirmed payment',payment,tx.payment_at,'Waiting for '+tx.processor+''],
  ['Application fee verified',fee,tx.fee_verified_at,
     'Matching the provider-reported application fee'],
  ['Processor payout reported paid',settled,tx.payout_reported_at,
     'Waiting for processor payout confirmation']
 ];
 let firstWaiting=timeline.findIndex(v=>!v[1]);
 timeline.forEach(([label,done,at,detail],i)=>steps.append(
   progressStep(label,done,i===firstWaiting,at,detail,tx.exception_status==='NEEDS_ATTENTION'&&i===firstWaiting)
 ));
 const bank=tx.bank_evidence;
 if(bank){
  const post=bank.status==='BANK_POSTED';
  const seen=post||bank.status==='BANK_PENDING';
  const firstBank=elem('li','journey-step '+(seen?'done':settled?'waiting':''));
  firstBank.append(elem('strong','','Bank deposit independently observed'));
  firstBank.append(elem('small','',seen?
    'Bank transaction: '+time(bank.bank_transaction_date):
    'Connected bank is waiting for a unique whole-payout match'));
  steps.append(firstBank);
  steps.append(progressStep('Bank deposit posted',post,
    bank.status==='BANK_PENDING',bank.bank_posted_at,
    'Bank provider has not reported a posted deposit.'));
 }
 const accounted=tx.integrity_status==='ACCOUNTED';
 steps.append(progressStep('Integrity accounted for',accounted,
   !accounted&&!tx.exception_status,tx.integrity_verified_at,
   tx.integrity_status==='NEEDS_ATTENTION'?'An unresolved exception needs attention':
     'Awaiting required recorded lifecycle and payout evidence',
   tx.integrity_status==='NEEDS_ATTENTION'));
 wrap.append(steps);
 const evidence=elem('section','journey-evidence');
 evidence.append(elem('strong','','Processor timestamps and evidence'));
 evidence.append(elem('div','','Processor: '+tx.processor+
   ' · Payout ref: '+(tx.payout_id||'Not yet issued')));
 evidence.append(elem('div','','Processor payment confirmed: '+time(tx.payment_at)));
 evidence.append(elem('div','','Processor payout marked paid: '+time(tx.payout_reported_at)));
 evidence.append(elem('div','','Builtegrity local verification: '+time(tx.integrity_verified_at)));
 if(bank){
  const section=elem('div','journey-bank');
  section.append(elem('strong','','Connected bank evidence'));
  section.append(elem('div','','Status: '+bank.status));
  section.append(elem('div','','Provider: '+(bank.evidence_source||'Read-only bank transaction feed')));
  section.append(elem('div','','Bank deposit date: '+time(bank.bank_transaction_date)));
  evidence.append(section);
 }
 wrap.append(evidence);
 if((data.deliveries||[]).length){
  const timings=elem('div','journey-evidence');
  timings.append(elem('strong','','Live processor notification timestamps'));
  for(const d of data.deliveries.slice(0,5)){
   const row=elem('div','journey-bank');
   row.append(elem('strong','',d.processor+' · '+d.event_type));
   row.append(elem('div','','Processor event created: '+time(d.provider_event_created_at)));
   row.append(elem('div','','Builtegrity received: '+time(d.received_at)));
   row.append(elem('div','','Builtegrity processed: '+time(d.processed_at)));
   row.append(elem('div','','Processing: '+d.outcome));
   timings.append(row);
  }
  wrap.append(timings);
 }
 const events=elem('div','journey-evidence');
 events.append(elem('strong','','Recent processing events'));
 for(const item of (data.events||[]).slice(-12).reverse()){
  const row=elem('div','journey-event');row.append(elem('span','',time(item.occurred_at)));
  row.append(elem('span','',item.type+' · '+item.source));events.append(row);
 }
 if(!(data.events||[]).length)events.append(elem('div','','No events recorded.'));
 wrap.append(events);
 if((data.exceptions||[]).some(e=>e.status==='OPEN')){
  const ex=elem('section','journey-evidence');
  ex.append(elem('strong','','Attention required'));
  for(const e of data.exceptions.filter(x=>x.status==='OPEN'))
    ex.append(elem('div','',e.type+': '+(e.summary||'Unresolved exception')));
  wrap.append(ex);
 }
}
async function refreshJourney(card){
 if(!card.open||card.dataset.loading==='yes')return;
 card.dataset.loading='yes';
 try{
  const data=await request('/api/merchant/transactions/'+encodeURIComponent(card.dataset.tx)+'/journey');
  if(card.open)buildJourney(card,data);
 }catch(e){card.querySelector('.journey-expanded').textContent='Unable to refresh timeline: '+e.message;}
 finally{card.dataset.loading='no';}
}
function drawTransactions(items){
 const open=new Set([...transactions.querySelectorAll('details[open]')].map(e=>e.dataset.tx));
 const sorted=[...items].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))||b.id.localeCompare(a.id));
 const newest=sorted[0];
 const previousNewest=latestId;
 latestId=newest?.id||null;
 if(newest&&newest.id!==previousNewest&&newest.lifecycle_status!=='COMPLETE')
   open.add(newest.id);
 transactions.replaceChildren();
 for(const tx of sorted){
  const card=createCard(tx,open.has(tx.id));transactions.append(card);
  if(card.open)refreshJourney(card);
 }
 if(!sorted.length)transactions.append(elem('p','muted','No authorized transaction records yet.'));
 lastIds=sorted.map(x=>x.id).join(',');
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
setInterval(()=>{if(document.visibilityState==='visible')reload();},15000);
activate(active,false);
