const $=q=>document.querySelector(q);
const merchant=$('#merchantSetup');
async function api(path){const response=await fetch(path,{credentials:'same-origin',cache:'no-store'});
 if(response.status===401){location.href='/login/?return_to='+encodeURIComponent(location.pathname);return{};}
 const data=await response.json().catch(()=>({}));if(!response.ok)throw Error(data.error||'Integration status unavailable');
 return data;
}
function note(text){$('#setupStatus').textContent=String(text);}
async function refresh(){
 if(!merchant.value)return;
 const id=encodeURIComponent(merchant.value);
 try{
  const [bank,notices,fields,sources]=await Promise.all([
   api('/api/merchant/bank/status?merchant_id='+id),
   api('/api/merchant/bank/notices?merchant_id='+id),
   api('/api/merchant/custom/schema?merchant_id='+id),
   api('/api/merchant/custom/sources?merchant_id='+id)]);
  const rows=bank.connections||[];
  $('#bankHelp').textContent=bank.enabled
    ?rows.length?rows.some(x=>x.status==='REAUTH_REQUIRED')?
      'Bank reconnect required. Follow the action below; Stripe/Square monitoring continues.':
      rows.some(x=>x.is_payout_target)?'Optional bank connection established. Bank updates are provider-dependent.':
      'Connection exists, but you must select the payout-receiving account.':
      'Bank linking is optional. No bank deposit confirmation will be shown without it.'
    :'Optional bank feed has not been activated for this Builtegrity environment.';
  const list=$('#bankNotices');list.replaceChildren();
  for(const n of notices.notices||[]){
   const li=document.createElement('li'),a=document.createElement('a');
   a.href=n.action_url;a.textContent=n.title;li.append(a);
   const text=document.createElement('span');text.textContent=' — '+n.description;
   li.append(text);list.append(li);
  }
  $('#customHelp').textContent=(fields.definitions||[]).filter(x=>x.active).length+
   ' custom fields defined · '+(sources.sources||[]).filter(x=>x.status==='ACTIVE').length+
   ' active data sources. '+(sources.live_sync_enabled?
   'Automatic inbound feed can be configured.':'Automated inbound feeds are not yet enabled.');
  note('Settings reviewed. All actions can be performed directly in the linked settings pages.');
 }catch(e){note('Could not check every integration setting: '+e.message);}
}
async function start(){
 try{
  const data=await api('/api/merchant/custom/merchants');
  merchant.replaceChildren();
  for(const m of data.merchants||[]){const o=document.createElement('option');o.value=m.id;o.textContent=m.name;merchant.append(o);}
  if(!merchant.value)throw Error('No authorized merchant owner account found.');
  await refresh();
 }catch(e){note(e.message);}
}
merchant.addEventListener('change',refresh);
start();
