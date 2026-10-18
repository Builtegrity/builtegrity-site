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
   item.append(node('strong',source.title),
    node('div',source.source_kind+' · '+source.status+' · Sync: '+(source.sync_health||'Awaiting verification')),
    node('div','Last successful update: '+(source.last_success_at||'Not yet received')));
   if(source.sync_health==='LATE'||source.sync_health==='NEEDS_ATTENTION'){
     const note=node('p','This source may be delayed. Check the sender or rotate its connection key in settings. Transaction payments remain unaffected.');
     note.className='setup-help';item.append(note);
   }
   if(source.source_kind==='FILE'&&source.status==='ACTIVE')option(fileList,source.id,source.title);
   if(source.source_kind!=='FILE'&&source.status==='ACTIVE'){
     const endpoint=node('code','POST '+location.origin+'/api/sync/merchant-fields/'+source.id);
     endpoint.className='setup-secret';item.append(endpoint);
     const rotate=node('button','Rotate key');rotate.type='button';rotate.className='secondary';
     rotate.addEventListener('click',async()=>{
       if(!confirm('Rotate this key? Existing key will stop working immediately.'))return;
       try{
         const result=await request('source/rotate',{merchant_id:merchantId,source_id:source.id});
         oneTimeSecret(result.token_once,source.id);
         message('New private source key generated; update your integration once.');
       }catch(e){message(e.message);}
     });item.append(rotate);
   }
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
  const interval=$('#sourceInterval').value;
  const result=await request('source/create',{merchant_id:merchantId,title:$('#sourceTitle').value,
    source_kind,...(interval?{expected_interval_minutes:Number(interval)}:{})});
  if(result.source.token_once)oneTimeSecret(result.source.token_once,result.source.id);
  await refresh();message('Source created. Configure an outgoing feed or upload a structured file.');
 }catch(e){message(e.message);}
});
async function importRows(rows){
 if(!Array.isArray(rows)||!rows.length||rows.length>2000)throw Error('Use 1–2000 rows per file.');
 const source_id=$('#fileSource').value;if(!source_id)throw Error('Create a file source first.');
 let applied=0;
 const chunks=[];
 for(const row of rows){
  const entries=Object.entries(row.fields||{});
  if(!entries.length)throw Error('A row did not contain any custom fields.');
  for(let i=0;i<entries.length;i+=4){
   chunks.push({scope:row.scope,external_reference:row.external_reference,
     fields:Object.fromEntries(entries.slice(i,i+4))});
  }
 }
 for(let i=0;i<chunks.length;i+=6){
  const result=await request('import',{merchant_id:merchantId,source_id,
   delivery_id:'file-'+crypto.randomUUID(),records:chunks.slice(i,i+6)});
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
function parseCsv(text){
 const rows=[];let cells=[],value='',quoted=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(c==='"'){
   if(quoted&&text[i+1]==='"'){value+='"';i++;}
   else quoted=!quoted;
  }else if(c===','&&!quoted){cells.push(value);value='';}
  else if((c==='\r'||c==='\n')&&!quoted){
   if(c==='\r'&&text[i+1]==='\n')i++;
   cells.push(value);if(cells.some(v=>v.trim()))rows.push(cells);
   cells=[];value='';
  }else value+=c;
 }
 if(quoted)throw Error('CSV has an unclosed quoted value');
 cells.push(value);if(cells.some(v=>v.trim()))rows.push(cells);
 if(rows.length<2)throw Error('CSV requires headers and data');
 const headers=rows.shift().map(x=>x.trim());
 if(!headers.includes('scope')||!headers.includes('external_reference'))
  throw Error('CSV requires scope and external_reference columns');
 return rows.map((values,i)=>{
  const record={scope:'',external_reference:'',fields:{}};
  for(let k=0;k<headers.length;k++){
   if(headers[k]==='scope'||headers[k]==='external_reference')
     record[headers[k]]=(values[k]||'').trim();
   else if(values[k]?.trim())record.fields[headers[k]]=values[k].trim();
  }
  if(!Object.keys(record.fields).length)throw Error('No values in CSV row '+(i+2));
  return record;
 });
}
$('#importFile').addEventListener('click',async()=>{
 const f=$('#fileUpload').files?.[0];
 if(!f){$('#importResult').textContent='Choose a file.';return;}
 if(f.size>250000){$('#importResult').textContent='File too large: split the CSV/JSON into files below 250 KB.';return;}
 try{
  const txt=await f.text();let records;
  if(f.name.toLowerCase().endsWith('.csv'))records=parseCsv(txt);
  else if(f.name.toLowerCase().endsWith('.json')){
   const data=JSON.parse(txt);records=Array.isArray(data)?data:data.records;
  }else throw Error('Only CSV and JSON are supported');
  const count=await importRows(records);
  $('#importResult').textContent='Imported '+count+' values. The latest revision appears in the timeline and merchant PDF.';
 }catch(e){$('#importResult').textContent='Stopped: '+e.message+
  '. Previously accepted batches remain stored. Correct unmatched references before retrying.';}
});
$('#exampleFile').addEventListener('click',()=>{
 const content='scope,external_reference,hoa_community\r\nCUSTOMER,EXAMPLE-HOA-001,West Bay Community\r\n';
 const file=new Blob([content],{type:'text/csv'});
 const a=document.createElement('a');a.href=URL.createObjectURL(file);
 a.download='builtegrity-example.csv';a.click();
 setTimeout(()=>URL.revokeObjectURL(a.href),1000);
 message('Template downloaded. Create the hoa_community field first and use your real customer reference.');
});
$('#loadGroups').addEventListener('click',async()=>{
 try{
  const field=$('#groupField').value;
  if(!field)throw Error('Choose a customer field');
  const grouped=await request(query('groups?field_key='+encodeURIComponent(field)));
  const parent=$('#groupList');parent.replaceChildren();
  $('#groupHistory').replaceChildren();
  for(const item of grouped.groups||[]){
   const outer=node('div');outer.className='setup-item';
   const button=node('button',item.group_value+' · '+item.customer_count+' customers · '+
     item.transaction_count+' transactions');
   button.className='secondary';button.type='button';
   button.addEventListener('click',async()=>{
    try{
     const history=await request(query('group-history?field_key='+
       encodeURIComponent(field)+'&value='+encodeURIComponent(item.group_value)));
     const table=node('table'),head=node('thead'),row=node('tr');
     for(const title of ['Customer','Customer reference','Payment reference','Amount','Integrity','PDF'])
       row.append(node('th',title));
     head.append(row);table.append(head);
     const body=node('tbody');
     for(const item of history.records||[]){
      const line=node('tr');
      for(const value of [item.name,item.merchant_customer_reference,
       item.merchant_payment_reference||item.transaction_id,
       item.transaction_id?(Number(item.amount_cents)/100).toFixed(2)+' '+item.currency:'—',
       item.integrity_status||'—'])line.append(node('td',value??'—'));
      const cell=node('td');
      if(item.transaction_id){
       const pdf=node('a','Open PDF');
       pdf.href='/api/merchant/transactions/'+encodeURIComponent(item.transaction_id)+'/pdf?view=1';
       pdf.target='_blank';pdf.rel='noopener noreferrer';cell.append(pdf);
      }
      line.append(cell);body.append(line);
     }
     table.append(body);
     const target=$('#groupHistory');target.replaceChildren();target.append(table);
    }catch(e){message(e.message);}
   });outer.append(button);parent.append(outer);
  }
  if(!grouped.groups?.length)parent.append(node('p','No customers have a value for this grouping yet.'));
 }catch(e){message(e.message);}
});
setup();
