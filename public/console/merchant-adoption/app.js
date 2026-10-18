const $=id=>document.querySelector(id);
async function refresh(){
 $('#status').textContent='Refreshing merchant adoption data…';
 try{
  const response=await fetch('/api/operations/merchant-profile-adoption',{credentials:'same-origin',cache:'no-store'});
  if(response.status===401){location.assign('/login/?return_to=%2Fconsole%2Fmerchant-adoption%2F');return;}
  const info=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(info.error||'Operator authorization required');
  for(const [id,value] of [['total',info.eligible_merchants],['profiles',info.merchants_with_profiles],
   ['accountless',info.merchants_without_profiles],
   ['adoption',info.profile_adoption_percent+'%'],
   ['links',info.opened_transaction_links],['refunds',info.refund_pdf_downloads]]){
   $( '#'+id ).textContent=String(value??0);
  }
  $('#status').textContent='Aggregate analytics updated '+new Date(info.generated_at).toLocaleString()+
   '. '+info.scope;
 }catch(e){$('#status').textContent=e.message;}
}
$('#refresh').addEventListener('click',refresh);refresh();