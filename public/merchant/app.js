const business=document.querySelector('#merchantSelect');
const status=document.querySelector('#profileStatus');
const summary=document.querySelector('#profileSummary');
async function load(){
 try{
  const response=await fetch('/api/merchant/home',{credentials:'same-origin',cache:'no-store'});
  if(response.status===401){location.assign('/login/?return_to=%2Fmerchant%2F');return;}
  const body=await response.json();
  if(!response.ok)throw Error(body.error||'Unable to load your merchant profile');
  const list=body.merchants||[];
  business.replaceChildren();
  if(!list.length){status.textContent='No active merchant membership found. Your business owner must grant you access.';return;}
  for(const item of list){const option=document.createElement('option');option.value=item.id;option.textContent=item.name;business.append(option);}
  business.addEventListener('change',display);
  function display(){
   const x=list.find(item=>item.id===business.value);
   if(!x)return;
   status.textContent=x.name+' · '+x.role+' access';
   summary.replaceChildren();
   for(const [count,description] of [[x.transaction_count,'transactions'],[x.custom_field_count,'custom fields']]){
    const el=document.createElement('span');el.textContent=String(count)+' '+description;summary.append(el);
   }
  }
  display();
 }catch(error){status.textContent='Unable to load: '+error.message;}
}
load();
