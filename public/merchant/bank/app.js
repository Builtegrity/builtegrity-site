const merchants=document.querySelector('#merchant'),status=document.querySelector('#bankStatus');
const connect=document.querySelector('#connect'),refresh=document.querySelector('#refresh'),accounts=document.querySelector('#accounts');
let selectedMerchant=null,eligible=false;
async function api(path,data=null){
 const r=await fetch('/api/merchant/bank/'+path,{
  method:data?'POST':'GET',credentials:'same-origin',cache:'no-store',
  headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});
 if(r.status===401){location.href='/login/?return_to='+encodeURIComponent(location.pathname);throw Error('Sign-in required');}
 const result=await r.json().catch(()=>({}));if(!r.ok)throw Error(result.error||'Bank connection unavailable');
 return result;
}
async function loadMerchants(){
 try{
  const data=await api('merchants');
  eligible=Boolean(data.bank_link_available);
  merchants.replaceChildren();
  for(const m of data.merchants||[]){
   const op=document.createElement('option');op.value=m.id;op.textContent=m.name+' ('+m.id+')';merchants.append(op);
  }
  selectedMerchant=merchants.value||null;
  if(!selectedMerchant){status.textContent='No authorized merchant OWNER account available.';return;}
  await loadStatus();
 }catch(e){status.textContent=e.message;}
}
function bankAccountCard(a){
 const box=document.createElement('div');box.className='bank-item';
 const name=document.createElement('strong');name.textContent=a.account_name+' ••••'+(a.mask||'');
 box.append(name);
 const p=document.createElement('p');p.className='bank-note';
 p.textContent='Connection: '+a.status+(a.is_payout_target?' · Selected payout account':' · Not selected');
 box.append(p);
 if(!a.is_payout_target&&a.account_id){
  const btn=document.createElement('button');btn.className='secondary';btn.textContent='Use as payout account';
  btn.addEventListener('click',async()=>{
   try{await api('select',{merchant_id:selectedMerchant,connection_id:a.connection_id,account_id:a.account_id});await loadStatus();}
   catch(e){status.textContent=e.message;}
  });box.append(btn);
 }
 const disconnect=document.createElement('button');
 disconnect.className='secondary';disconnect.textContent='Disconnect this bank';
 disconnect.style.marginLeft='8px';
 disconnect.addEventListener('click',async()=>{
   if(!confirm('Disconnect this bank? Bank confirmations will no longer appear in current PDFs, and bank-provider permission will be revoked.'))return;
   try{await api('disconnect',{merchant_id:selectedMerchant,connection_id:a.connection_id});
     await loadStatus();}
   catch(e){status.textContent=e.message;}
 });
 box.append(disconnect);
 return box;
}
async function loadStatus(){
 if(!selectedMerchant)return;
 try{
  const data=await api('status?merchant_id='+encodeURIComponent(selectedMerchant));
  connect.disabled=!data.enabled;refresh.disabled=false;
  const rows=data.connections||[];accounts.replaceChildren();
  if(!rows.length)accounts.textContent='No linked bank. Bank-status details will not appear in PDFs.';
  const extra=new Set(rows.map(x=>x.connection_id));
  if(extra.size>1)status.textContent='Multiple bank authorizations exist. Disconnect older unused banks to prevent continued provider subscription charges.';
  else for(const a of rows)accounts.append(bankAccountCard(a));
  status.textContent=data.enabled
    ? rows.length?'Bank data connected. Payout matching runs automatically; changes may lag bank reporting.':
      'No bank connected. Connect an account to enable automatic deposit evidence.'
    : 'Optional bank integration is not enabled in this environment. Existing PDF processing remains available.';
 }catch(e){status.textContent=e.message;}
}
async function plaidLoader(){
 if(window.Plaid)return;
 await new Promise((resolve,reject)=>{
  const tag=document.createElement('script');tag.src='https://cdn.plaid.com/link/v2/stable/link-initialize.js';
  tag.onload=resolve;tag.onerror=()=>reject(Error('Unable to load secure bank connection'));document.head.append(tag);
 });
}
async function link(){
 if(!selectedMerchant||!eligible)return;
 connect.disabled=true;status.textContent='Opening secure bank connection…';
 try{
  await plaidLoader();
  const input={merchant_id:selectedMerchant};
  const data=await api('link-token',input);
  if(!window.Plaid)throw Error('Bank link unavailable');
  const handler=window.Plaid.create({
   token:data.link_token,
   onSuccess:async(public_token,metadata)=>{
    try{
     const picked=metadata?.accounts?.length===1?metadata.accounts[0].id:null;
     const done=await api('complete',{merchant_id:selectedMerchant,public_token,
       ...(picked?{selected_account_id:picked}:{})});
     status.textContent=done.action_required?'Bank connected. Select the account where Stripe/Square deposits land.':
       'Bank connected. Future supported deposit records will sync automatically.';
     await loadStatus();
    }catch(e){status.textContent=e.message;}
   },
   onExit:(error)=>{if(error)status.textContent='Connection not completed: '+String(error.display_message||error.error_code||'Authorization required');}
  });
  handler.open();
 }catch(e){status.textContent=e.message;}finally{connect.disabled=!eligible;}
}
connect.addEventListener('click',link);
refresh.addEventListener('click',loadStatus);
merchants.addEventListener('change',()=>{selectedMerchant=merchants.value;loadStatus();});
loadMerchants();
