const $=id=>document.querySelector(id);
const result=$('#helpResult'),requests=$('#helpRequests'),merchant=$('#helpMerchant');
async function api(path,body){
 const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',
  headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
 if(response.status===401){location.assign('/login/?return_to='+encodeURIComponent(location.pathname));throw Error('Sign-in required');}
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(data.error||'Help service temporarily unavailable');
 return data;
}
async function loadMerchants(){
 try{
  const data=await api('/api/merchant/home');
  merchant.replaceChildren();
  for(const m of data.merchants||[]){const opt=document.createElement('option');opt.value=m.id;opt.textContent=m.name;merchant.append(opt);}
  if(!merchant.value)throw Error('Your account has no active merchant membership.');
  await loadRequests();
 }catch(e){result.textContent=e.message;}
}
async function loadRequests(){
 if(!merchant.value)return;
 try{
  const data=await api('/api/merchant/help?merchant_id='+encodeURIComponent(merchant.value));
  requests.replaceChildren();
  for(const row of data.requests||[]){
   const wrap=document.createElement('div');wrap.className='help-history';
   const strong=document.createElement('strong');strong.textContent=row.subject;
   const sub=document.createElement('small');
   sub.textContent=row.id+' · '+row.request_status+' · Email notice: '+
     (row.delivery_state==='SENT'?'Sent':row.delivery_state==='QUEUED'?'Queued':row.delivery_state);
   wrap.append(strong,sub);requests.append(wrap);
  }
  if(!(data.requests||[]).length)requests.textContent='You have no submitted help requests.';
 }catch(e){requests.textContent='Unable to load request history: '+e.message;}
}
$('#helpForm').addEventListener('submit',async event=>{
 event.preventDefault();const button=$('#helpSubmit');button.disabled=true;
 result.textContent='Saving your request…';
 try{
  const data=await api('/api/merchant/help',{
   merchant_id:merchant.value,topic:$('#helpTopic').value,
   source_system:$('#helpSystem').value,example_reference:$('#helpReference').value,
   subject:$('#helpSubject').value,desired_outcome:$('#helpDesired').value,
   description:$('#helpDescription').value
  });
  result.textContent='Request '+data.id+' saved. Email notification will be sent automatically once delivery is configured. You can review it below.';
  $('#helpSubject').value='';$('#helpDesired').value='';$('#helpDescription').value='';
  await loadRequests();
 }catch(e){result.textContent=e.message;}
 finally{button.disabled=false;}
});
merchant.addEventListener('change',loadRequests);
$('#refreshRequests').addEventListener('click',loadRequests);
loadMerchants();
