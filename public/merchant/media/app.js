const $=q=>document.querySelector(q);
let merchantId='',defs=[],groups=[];
function say(s){$('#status').textContent=String(s);}
function opt(target,value,text){const o=document.createElement('option');o.value=value;o.textContent=text;target.append(o);}
async function getApi(endpoint){
 const response=await fetch(endpoint,{credentials:'same-origin',cache:'no-store'});
 if(response.status===401){location.href='/login/?return_to='+encodeURIComponent(location.pathname);throw Error('Sign in required');}
 const result=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(result.error||'Unable to open merchant record');
 return result;
}
async function postApi(endpoint,payload,form=false){
 const response=await fetch(endpoint,{method:'POST',credentials:'same-origin',
  headers:form?{}:{'content-type':'application/json'},
  body:form?payload:JSON.stringify(payload)});
 const result=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(result.error||'Unable to save');
 return result;
}
function q(base,extra={}){return base+'?'+new URLSearchParams({merchant_id:merchantId,...extra}).toString();}
async function loadAccount(){
 try{
  const data=await getApi('/api/merchant/custom/merchants');
  $('#merchant').replaceChildren();
  for(const m of data.merchants||[])opt($('#merchant'),m.id,m.name);
  merchantId=$('#merchant').value;
  if(!merchantId)throw Error('Only authorized merchant owners can manage private files');
  await loadGroupOptions();say('Ready. Select a customer, transaction, or group.');
 }catch(e){say(e.message);}
}
async function loadRecordChoices(){
 if(!merchantId)return;
 const select=$('#recordChoices');select.replaceChildren();
 const category=$('#scope').value;
 const result=await getApi(q('/api/merchant/media/choices',{target_type:category}));
 opt(select,'','Choose a record…');
 for(const row of result.records||[]){
   opt(select,row.id,String(row.title||row.id).slice(0,90)+
     (row.subtitle?' · '+String(row.subtitle).slice(0,90):'')+' ('+row.id+')');
 }
 select.value=$('#target').value||'';
 if(!select.value)select.value='';
}
async function loadGroupOptions(){
 const [schema,data]=await Promise.all([
  getApi(q('/api/merchant/custom/schema')),
  getApi(q('/api/merchant/media/groups'))]);
 defs=(schema.definitions||[]).filter(d=>d.record_scope==='CUSTOMER'&&d.active);
 groups=data.groups||[];
 const field=$('#groupField'),list=$('#groupList');field.replaceChildren();list.replaceChildren();
 for(const d of defs)opt(field,d.field_key,d.label);
 for(const g of groups)opt(list,g.id,g.title+' · '+g.group_value);
 if(!field.options.length)opt(field,'','Define a customer field first');
 if(!list.options.length)opt(list,'','No saved groups');
 await loadRecordChoices();
}
function selected(){return {merchant_id:merchantId,target_type:$('#scope').value,target_id:$('#target').value.trim()};}
async function openRecord(){
 const data=selected();
 if(!data.merchant_id||!data.target_id)throw Error('Choose a business and enter an existing record ID');
 const result=await getApi(q('/api/merchant/media/list',{
  target_type:data.target_type,target_id:data.target_id}));
 $('#displayTitle').value=result.display?.display_title||'';
 $('#displayNote').value=result.display?.display_note||'';
 const items=$('#items');items.replaceChildren();
 for(const row of result.media||[]){
  const line=document.createElement('div');line.className='studio-item';
  if(row.mime_type.startsWith('image/')){
   const image=document.createElement('img');image.className='studio-thumb';
   image.src='/api/merchant/media/file/'+encodeURIComponent(row.id);
   image.alt=row.caption||row.filename;image.loading='lazy';line.append(image);
  }
  const text=document.createElement('div');
  const label=document.createElement('strong');label.textContent=row.filename;
  const meta=document.createElement('p');meta.className='studio-info';
  meta.textContent=row.role+' · '+(row.caption||'No caption')+' · '+row.created_at;
  text.append(label,meta);
  const file=document.createElement('a');file.href='/api/merchant/media/file/'+encodeURIComponent(row.id);
  file.textContent='Open file';file.target='_blank';file.rel='noopener noreferrer';
  text.append(file);line.append(text);
  const del=document.createElement('button');del.textContent='Remove from view';
  del.className='secondary';del.type='button';
  del.addEventListener('click',async()=>{
   if(!confirm('Hide this attachment? The retention policy may retain audit records.'))return;
   try{await postApi('/api/merchant/media/delete',{merchant_id:merchantId,media_id:row.id});
    await openRecord();}catch(e){say(e.message);}
  });line.append(del);items.append(line);
 }
 if(!result.media?.length)items.textContent='No photos or files attached.';
 say('Private '+data.target_type.toLowerCase()+' record open. Changes are saved separately from financial evidence.');
}
$('#recordChoices').addEventListener('change',()=>{
 $('#target').value=$('#recordChoices').value;
 if($('#target').value)openRecord().catch(e=>say(e.message));
});
$('#scope').addEventListener('change',()=>loadRecordChoices().catch(e=>say(e.message)));
$('#load').addEventListener('click',()=>openRecord().catch(e=>say(e.message)));
$('#merchant').addEventListener('change',async()=>{
 merchantId=$('#merchant').value;try{await loadGroupOptions();}catch(e){say(e.message);}
});
$('#createGroup').addEventListener('click',async()=>{
 try{
  const r=await postApi('/api/merchant/media/group',{merchant_id:merchantId,
   field_key:$('#groupField').value,group_value:$('#groupValue').value,
   title:$('#groupName').value,description:$('#groupDescription').value});
  $('#scope').value='GROUP';$('#target').value=r.group_id;
  await loadGroupOptions();
  await openRecord();say('Group ready. You can now customize its title and upload a cover photo.');
 }catch(e){say(e.message);}
});
$('#selectGroup').addEventListener('click',async()=>{
 $('#scope').value='GROUP';$('#target').value=$('#groupList').value;
 await loadRecordChoices();
 try{await openRecord();}catch(e){say(e.message);}
});
$('#saveDisplay').addEventListener('click',async()=>{
 try{await postApi('/api/merchant/media/display',{...selected(),
 display_title:$('#displayTitle').value,display_note:$('#displayNote').value});
 say('Record display information saved. Payment facts were not modified.');
 }catch(e){say(e.message);}
});
$('#upload').addEventListener('click',async()=>{
 try{
  if(!$('#uploadFile').files?.length)throw Error('Choose a picture or document first');
  const form=new FormData(),data=selected();
  for(const [k,v] of Object.entries(data))form.set(k,v);
  form.set('role',$('#role').value);form.set('caption',$('#caption').value);
  form.set('file',$('#uploadFile').files[0]);
  await postApi('/api/merchant/media/upload',form,true);
  $('#uploadFile').value='';await openRecord();say('Private attachment uploaded. It is not accessible by an email-only transaction link.');
 }catch(e){say(e.message);}
});
const qparams=new URLSearchParams(location.search);
if(qparams.get('target_type'))$('#scope').value=qparams.get('target_type').toUpperCase();
if(qparams.get('target_id'))$('#target').value=qparams.get('target_id');
loadAccount().then(()=>{
 if($('#target').value)openRecord().catch(e=>say(e.message));
});