const input=document.querySelector('#solutionSearch'),results=document.querySelector('#solutionList');
const audience=document.body.dataset.helpAudience||'MERCHANT';
function el(tag,text){const node=document.createElement(tag);node.textContent=String(text||'');return node;}
async function search(){
 if(!results)return;
 const q=input?.value||'';
 try{
  const response=await fetch('/api/help/solutions?'+new URLSearchParams({audience,q}),
    {credentials:'omit',cache:'no-store'});
  const data=await response.json();
  results.replaceChildren();
  for(const guide of data.solutions||[]){
   const details=el('details');details.className='help-detail';
   const summary=el('summary',guide.title);details.append(summary);
   details.append(el('p',guide.symptom));
   const list=el('ol');
   for(const step of guide.steps||[])list.append(el('li',step));
   details.append(list);
   const action=el('a','Open the matching setting →');
   action.href=guide.action_url;details.append(action);
   if(!guide.self_service)details.append(el('p',
    'This issue may require provider evidence or a support request after the self-service checks.'));
   results.append(details);
  }
  if(!data.solutions?.length)results.append(el('p','No matching guide yet. Use Submit a Request if you have a merchant account, or contact your referring partner.'));
 }catch{
  results.textContent='Unable to load solution guides. Existing merchant settings remain available.';
 }
}
input?.addEventListener('input',search);
search();
