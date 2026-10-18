const business=document.querySelector('#merchantSelect');
const status=document.querySelector('#profileStatus');
const summary=document.querySelector('#profileSummary');
const themeSelect=document.querySelector('#themeSelect');
const themeStatus=document.querySelector('#themeStatus');
const saveTheme=document.querySelector('#saveTheme');
const allowedThemes=new Set(['builtegrity','slate','ocean','forest','sand','plum']);
let activeMerchant=null,activeRole='VIEWER';
function previewTheme(value){document.body.dataset.merchantTheme=allowedThemes.has(value)?value:'builtegrity';}
themeSelect.addEventListener('change',()=>{previewTheme(themeSelect.value);themeStatus.textContent='Preview only — save to apply for everyone on this business.';});
saveTheme.addEventListener('click',async()=>{
 if(!activeMerchant||!['OWNER','ADMIN'].includes(activeRole))return;
 saveTheme.disabled=true;themeStatus.textContent='Saving business template…';
 try{
  const result=await fetch('/api/merchant/appearance',{method:'PUT',credentials:'same-origin',
   headers:{'content-type':'application/json'},body:JSON.stringify({merchant_id:activeMerchant,template:themeSelect.value})});
  const data=await result.json();
  if(!result.ok)throw Error(data.error||'Unable to save theme');
  const item=merchantList.find(m=>m.id===activeMerchant);if(item)item.template=data.template;
  themeStatus.textContent='Saved. This business theme is shared across authorized merchant profiles.';
 }catch(e){themeStatus.textContent=e.message||'Unable to save appearance';}
 finally{saveTheme.disabled=false;}
});
let merchantList=[];
async function load(){
 try{
  const response=await fetch('/api/merchant/home',{credentials:'same-origin',cache:'no-store'});
  if(response.status===401){location.assign('/login/?return_to=%2Fmerchant%2F');return;}
  const body=await response.json();
  if(!response.ok)throw Error(body.error||'Unable to load your merchant profile');
  const list=body.merchants||[];
  merchantList=list;
  business.replaceChildren();
  if(!list.length){status.textContent='No active merchant membership found. Your business owner must grant you access.';return;}
  for(const item of list){const option=document.createElement('option');option.value=item.id;option.textContent=item.name;business.append(option);}
  const vanity=location.pathname.match(/^\/dashboard\/([a-z0-9-]{5,75})\/?$/);
  if(vanity){
    const selected=list.find(item=>item.dashboard_url==='/dashboard/'+vanity[1]+'/');
    if(selected)business.value=selected.id;
  }
  business.addEventListener('change',display);
  function display(){
   const x=list.find(item=>item.id===business.value);
   if(!x)return;
   activeMerchant=x.id;activeRole=x.role;
   themeSelect.value=allowedThemes.has(x.template)?x.template:'builtegrity';
   previewTheme(themeSelect.value);
   const canEdit=['OWNER','ADMIN'].includes(x.role);
   themeSelect.disabled=!canEdit;saveTheme.hidden=!canEdit;
   themeStatus.textContent=canEdit?'Select a template to preview and save it.':'Only business owners and admins can change the shared theme.';
   status.textContent=x.name+' · '+x.role+' access';
   const vanity=document.querySelector('#dashboardLink');
   if(vanity)vanity.href=x.dashboard_url||'/merchant/';
   const link=document.querySelector('#merchantDashboardLink');
   if(link){
     link.href=x.dashboard_url||'/merchant/';
     link.textContent=location.origin+(x.dashboard_url||'/merchant/');
   }
   summary.replaceChildren();
   for(const [count,description] of [[x.transaction_count,'transactions'],[x.custom_field_count,'custom fields']]){
    const el=document.createElement('span');el.textContent=String(count)+' '+description;summary.append(el);
   }
  }
  display();
 }catch(error){status.textContent='Unable to load: '+error.message;}
}
load();
