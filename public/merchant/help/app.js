const $=id=>document.querySelector(id);
const status=$('#result'),merchant=$('#merchant'),form=$('#helpForm'),button=$('#submit');
function option(sel,v,title){const x=document.createElement('option');x.value=v;x.textContent=title;sel.append(x);}
async function api(path,payload){
 const response=await fetch(path,{method:payload?'POST':'GET',
  credentials:'same-origin',cache:'no-store',
  headers:payload?{'content-type':'application/json'}:{},
  body:payload?JSON.stringify(payload):undefined});
 if(response.status===401){location.href='/login/?return_to='+encodeURIComponent(location.pathname);throw Error('Sign in required');}
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(data.error||'Unable to complete request');
 return data;
}
async function loadHistory(){
 if(!merchant.value)return;
 const target=$('#history');target.replaceChildren();
 try{
  const result=await api('/api/merchant/help/requests?merchant_id='+encodeURIComponent(merchant.value));
  for(const ticket of result.requests||[]){
   const li=document.createElement('li');
   const label=document.createElement('strong');label.textContent=ticket.id+' · '+ticket.status;
   const details=document.createElement('span');
   details.textContent=' — '+ticket.request_type+' / '+ticket.service_name+
     ' · '+ticket.created_at+(ticket.email_status==='SENT'?' · Support inbox notified':' · Saved to account');
   li.append(label,details);target.append(li);
  }
  if(!result.requests?.length){const li=document.createElement('li');li.textContent='No requests yet.';target.append(li);}
 }catch(e){const li=document.createElement('li');li.textContent=e.message;target.append(li);}
}
async function start(){
 try{
  const data=await api('/api/merchant/custom/merchants');
  merchant.replaceChildren();
  for(const m of data.merchants||[])option(merchant,m.id,m.name+' ('+m.id+')');
  if(!merchant.value){option(merchant,'','No owner-authorized business available');throw Error('Only authorized merchant owners can request new integrations.');}
  status.textContent='Ready to submit. Most connections can be configured on your own.';
  await loadHistory();
 }catch(e){status.textContent=e.message;button.disabled=true;}
}
merchant.addEventListener('change',loadHistory);
form.addEventListener('submit',async event=>{
 event.preventDefault();if(!merchant.value)return;
 button.disabled=true;status.textContent='Saving request…';
 try{
  const result=await api('/api/merchant/help/submit',{
   merchant_id:merchant.value,request_type:$('#type').value,
   service_name:$('#service').value,desired_fields:$('#fields').value,
   details:$('#details').value});
  status.textContent='Request saved as '+result.id+'. Your request is available in your account.'+
    ' Email delivery to Builtegrity is pending configuration or scheduled processing. No API keys are needed.';
  $('#details').value='';$('#fields').value='';await loadHistory();
 }catch(e){status.textContent='Unable to save request: '+e.message;}
 finally{button.disabled=false;}
});
start();
