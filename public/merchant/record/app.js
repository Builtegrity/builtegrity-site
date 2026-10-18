const status=document.querySelector('#status'),token=location.hash.slice(1),facts=document.querySelector('#facts');
if(token)history.replaceState(null,'',location.pathname);
const fields=[['Transaction ID','transaction_id'],['Merchant reference','merchant_reference'],
 ['Invoice / receipt reference','merchant_payment_reference'],['Processor','processor'],
 ['Amount','amount_cents'],['Lifecycle','lifecycle_status'],['Integrity','integrity_status'],
 ['Payment status','payment_status'],['Processor payout status','processor_payout_status'],
 ['Payment confirmed','payment_at'],['Expected payout arrival','expected_payout_arrival'],
 ['Record updated','last_updated_at']];
async function api(action){
 const response=await fetch('/api/merchant/record-link/'+action,{method:'POST',
  headers:{'content-type':'application/json'},body:JSON.stringify({token}),
  credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer'});
 if(action==='pdf'&&response.ok)return response.blob();
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(data.error||'Private link unavailable');
 return data;
}
async function load(){
 if(!/^[a-f0-9]{64}$/.test(token)){status.textContent='The private link is missing or invalid. Please use your original email.';return;}
 try{
  const data=await api('read');facts.replaceChildren();
  document.querySelector('#merchant').textContent=data.record.merchant_name||'Merchant record';
  for(const [name,key] of fields){
   const dt=document.createElement('dt'),dd=document.createElement('dd');
   dt.textContent=name;
   const v=data.record[key];
   dd.textContent=key==='amount_cents'?new Intl.NumberFormat('en-US',
    {style:'currency',currency:data.record.currency||'USD'}).format(Number(v||0)/100):
    String(v??'Not yet recorded');facts.append(dt,dd);
  }
  document.querySelector('#record').hidden=false;
  status.textContent='Read-only merchant transaction. Link expires '+data.expires_at+'.';
 }catch(e){status.textContent=e.message;}
}
document.querySelector('#download').addEventListener('click',async()=>{
 try{
  const blob=await api('pdf');const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='builtegrity-transaction.pdf';
  document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(e){status.textContent=e.message;}
});
document.querySelector('#claim').addEventListener('click',async()=>{
 try{
  const d=await api('claim');status.textContent='Business linked. Opening your profile…';
  location.assign(d.account_url||'/merchant/');
 }catch(e){
  status.textContent=e.message+
   ' If you have not registered yet, choose Create my merchant profile, sign in and reopen this email link.';
 }
});
load();