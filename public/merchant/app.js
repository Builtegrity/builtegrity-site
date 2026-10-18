const $=id=>document.querySelector(id);
const merchant=$('#merchant');
let businesses=[];
function show(){
 const found=businesses.find(x=>x.id===merchant.value);
 if(!found)return;
 $('#txCount').textContent=Number(found.total_transactions||0).toLocaleString();
 $('#attentionCount').textContent=Number(found.attention_transactions||0).toLocaleString();
 $('#fieldCount').textContent=Number(found.custom_fields||0).toLocaleString();
 $('#access').textContent=found.name+' · '+found.role+
  ' access · '+Number(found.data_sources||0)+' active data sources.';
 // Every linked destination uses authenticated server-side membership checks.
 // Do not leak a merchant ID into a public URL or assume role access.
}
async function start(){
 try{
  const response=await fetch('/api/merchant/home',{credentials:'same-origin',cache:'no-store'});
  if(response.status===401){location.assign('/login/?return_to=%2Fmerchant%2F');return;}
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||'Unable to access merchant account');
  businesses=data.merchants||[];
  merchant.replaceChildren();
  if(!businesses.length)throw Error('No authorized merchant account is connected to this sign-in yet.');
  for(const m of businesses){
   const option=document.createElement('option');option.value=m.id;option.textContent=m.name;
   merchant.append(option);
  }
  merchant.addEventListener('change',show);show();
 }catch(e){
  merchant.replaceChildren();
  const option=document.createElement('option');option.textContent='Account not available';merchant.append(option);
  $('#access').textContent=e.message;
 }
}
start();
