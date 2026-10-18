const $=s=>document.querySelector(s);
let merchantId='',definitions=[],sources=[],syncEnabled=false;
function node(tag,text){const x=document.createElement(tag);if(text!==undefined)x.textContent=String(text);return x;}
function option(sel,value,text){const o=node('option',text);o.value=value;sel.append(o);}
function message(text){$('#syncStatus').textContent=String(text);}
async function request(path,body){
 const response=await fetch('/api/merchant/custom/'+path,{
  method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',
  headers:body?{'content-type':'application/json'}:{},
  body:body?JSON.stringify(body):undefined
 });
 if(response.status===401){location.href='/login/?return_to='+encodeURIComponent(location.pathname);throw Error('Merchant sign-in required');}
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(data.error||'Integration request failed');
 return data;
}
function query(endpoint){return endpoint+(endpoint.includes('?')?'&':'?')+'merchant_id='+encodeURIComponent(merchantId);}
async function setup(){
 try{
  const info=await request('merchants');
  syncEnabled=Boolean(info.automatic_push_enabled);
  const sel=$('#merchantSelect');sel.replaceChildren();
  for(const m of info.merchants||[])option(sel,m.id,m.name);
  merchantId=sel.value;
  if(!merchantId)throw Error('No authorized merchant owner membership.');
  await refresh();
 }catch(e){message(e.message);}
}
async function refresh(){
 if(!merchantId)return;
 try{
  const [a,b]=await Promise.all([request(query('schema')),request(query('sources'))]);
  definitions=a.definitions||[];sources=b.sources||[];
  syncEnabled=Boolean(b.live_sync_enabled);
  const fields=$('#fieldList');fields.replaceChildren();
  for(const d of definitions){
   const item=node('div');item.className='setup-item';
   item.append(node('strong',d.label),node('span',' · '+d.field_key+' · '+d.record_scope+' · '+d.group_title));
   if(d.active){
    const btn=node('button','Disable');btn.className='secondary';btn.type='button';
    btn.addEventListener('click',async()=>{
     if(!confirm('Hide this custom field but preserve its history?'))return;
     try{await request('deactivate',{merchant_id:merchantId,field_key:d.field_key});await refresh();}
     catch(e){message(e.message);}
    });item.append(btn);
   }fields.append(item);
  }
  const sourceList=$('#sourceList'),fileList=$('#fileSource');
  sourceList.replaceChildren();fileList.replaceChildren();
  for(const source of sources){
   const item=node('div');item.className='setup-item';
   item.append(node('strong',source.title),node('div',source.source_kind+' · '+source.status+
     ' · '+(source.last_success_at||'No data received yet')));
   if(source.source_kind==='FILE'&&source.status==='ACTIVE')option(fileList,source.id,source.title);
   if(source.status==='ACTIVE'){
    const revoke=node('button','Revoke source');revoke.type='button';revoke.className='secondary';
    revoke.addEventListener('click',async()=>{
     if(!confirm('Revoke this source and stop updates?'))return;
     try{await request('source/revoke',{merchant_id:merchantId,source_id:source.id});await refresh();}
     catch(e){message(e.message);}
    });item.append(revoke);
   }
   sourceList.append(item);
  }
  if(!fileList.options.length)option(fileList,'','Create a file source first');
  for(const [selector,filter] of [['#groupField',d=>d.record_scope==='CUSTOMER'],
    ['#manualField',d=>d.record_scope===$('#manualScope').value]]){
   const sel=$(selector);sel.replaceChildren();
   for(const d of definitions.filter(d=>d.active&&filter(d)))option(sel,d.field_key,d.label);
   if(!sel.options.length)option(sel,'','Define matching fields first');
  }
  message('Merchant setup loaded. Financial transaction evidence remains independent of imported fields.');
 }catch(e){message(e.message);}
}
$('#merchantSelect').addEventListener('change',e=>{merchantId=e.target.value;refresh();});
$('#manualScope').addEventListener('change',refresh);
$('#defineForm').addEventListener('submit',async event=>{
 event.preventDefault();
 try{await request('define',{merchant_id:merchantId,field_key:$('#fieldKey').value,
 label:$('#fieldLabel').value,group_title:$('#groupTitle').value,
 record_scope:$('#recordScope').value,value_type:$('#valueType').value,
 visible_in_pdf:$('#pdfVisible').value==='yes'});
 $('#fieldKey').value='';$('#fieldLabel').value='';await refresh();
 message('Field ready. Use its key in your structured imports or external feed.');}
 catch(e){message(e.message);}
});
function oneTimeSecret(token,sourceId){
 const target=$('#oneTimeToken');target.replaceChildren();target.hidden=false;
 target.append(node('strong','Copy this private connection key now. It will not be shown again.'));
 const text=node('code',token);text.className='setup-secret';target.append(text);
 target.append(node('p','Endpoint: '+location.origin+'/api/sync/merchant-fields/'+sourceId));
 target.append(node('p','Send HTTPS JSON with a unique delivery_id and records. Use this key as a Bearer authorization header. Keep it only in your private application or automation server.'));
 const copy=node('button','Copy key');copy.type='button';copy.addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText(token);message('Key copied. Store it privately.');}
  catch{message('Select and copy the key into your private integration system.');}
 });target.append(copy);
}
$('#createSource').addEventListener('click',async()=>{
 try{
  const source_kind=$('#sourceKind').value;
  if(source_kind!=='FILE'&&!syncEnabled)throw Error('Automatic source feed has not yet been activated.');
  const result=await request('source/create',{merchant_id:merchantId,title:$('#sourceTitle').value,source_kind});
  if(result.source.token_once)oneTimeSecret(result.source.token_once,result.source.id);
  await refresh();message('Source created. Configure an outgoing feed or upload a structured file.');
 }catch(e){message(e.message);}
});
async function importRows(rows){
 if(!Array.isArray(rows)||!rows.length||rows.length>2000)throw Error('Use 1–2000 rows per file.');
 const source_id=$('#fileSource').value;if(!source_id)throw Error('Create a file source first.');
 let applied=0;
 for(let i=0;i<rows.length;i+=25){
  const result=await request('import',{merchant_id:merchantId,source_id,
   delivery_id:'file-'+crypto.randomUUID(),records:rows.slice(i,i+25)});
  applied+=Number(result.applied||0);
  $('#importResult').textContent='Imported '+applied+' field observations so far.';
 }
 await refresh();return applied;
}
$('#saveManual').addEventListener('click',async()=>{
 try{
  const result=await importRows([{scope:$('#manualScope').value,
   external_reference:$('#manualReference').value,
   fields:{[$('#manualField').value]:$('#manualValue').value}}]);
  message('Saved '+result+' custom field observation(s).');
 }catch(e){message(e.message);}
});
