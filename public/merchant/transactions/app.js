const table=document.querySelector('#transactions');
const status=document.querySelector('#status');
const button=document.querySelector('#refresh');
let inProgress=false;
function cell(row,text){const el=document.createElement('td');el.textContent=String(text??'--');row.append(el);return el;}
function link(text,href,view=true){const a=document.createElement('a');a.className='button secondary';a.textContent=text;a.href=href;a.target='_blank';a.rel='noopener noreferrer';if(view)a.title='Open the latest PDF in a new tab';return a;}
function amount(v,c){return new Intl.NumberFormat('en-US',{style:'currency',currency:c||'USD'}).format(Number(v||0)/100);}
async function load(){
  if(inProgress)return;inProgress=true;button.disabled=true;
  try{
    const response=await fetch('/api/merchant/transactions',{credentials:'same-origin',cache:'no-store'});
    if(response.status===401){location.assign('/login/?return_to='+encodeURIComponent(location.pathname));return;}
    const body=await response.json();
    if(!response.ok)throw new Error(body.error||'Could not read merchant transactions');
    table.replaceChildren();
    for(const tx of body.transactions||[]){
      const row=document.createElement('tr');
      const view='/api/merchant/transactions/'+encodeURIComponent(tx.id)+'/pdf?view=1';
      const download='/api/merchant/transactions/'+encodeURIComponent(tx.id)+'/pdf';
      cell(row,tx.id);cell(row,tx.merchant_name);cell(row,tx.processor);
      cell(row,amount(tx.amount_cents,tx.currency));cell(row,tx.lifecycle_status);cell(row,tx.integrity_status);
      const controls=document.createElement('td');controls.append(link('Open PDF',view));
      controls.append('  ');controls.append(link('Download',download,false));row.append(controls);
      row.style.cursor='pointer';
      row.addEventListener('click',ev=>{if(ev.target.closest('a'))return;window.open(view,'_blank','noopener,noreferrer');});
      table.append(row);
    }
    status.textContent=(body.transactions||[]).length+' authorized transaction(s) loaded. Last refreshed '+new Date().toLocaleTimeString()+'.';
  }catch(err){status.textContent='Unable to load: '+String(err.message||err);}
  finally{inProgress=false;button.disabled=false;}
}
button.addEventListener('click',load);load();
setInterval(()=>{if(document.visibilityState==='visible')load();},120000);
