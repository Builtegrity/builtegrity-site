const table=document.querySelector('#transactionList');
const status=document.querySelector('#status');
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function fmt(amount,currency){try{return new Intl.NumberFormat('en-US',{style:'currency',currency:currency||'USD'}).format(Number(amount||0)/100);}catch{return (Number(amount||0)/100).toFixed(2);}}
async function reload(){
 table.innerHTML='<tr><td colspan="6">Loading…</td></tr>';
 try{
   const response=await fetch('/api/merchant/transactions',{credentials:'same-origin',cache:'no-store'});
   if(response.status===401){location.assign('/login/?return_to=%2Fmerchant%2F');return;}
   const result=await response.json();
   if(!response.ok)throw Error(result.error||'Unable to fetch merchant records');
   const transactions=result.transactions||[];
   status.textContent=transactions.length+' authorized transaction(s). Click a row or choose Open PDF.';
   table.innerHTML=transactions.length?transactions.map(t=>{
     const u='/api/merchant/transactions/'+encodeURIComponent(t.id)+'/pdf?view=1';
     return '<tr data-pdf="'+esc(u)+'" style="cursor:pointer"><td><strong>'+esc(t.id)+
       '</strong></td><td>'+esc(t.merchant_name)+'</td><td>'+esc(t.processor)+
       '</td><td>'+fmt(t.amount_cents,t.currency)+'</td><td>'+esc(t.integrity_status)+
       '</td><td><a href="'+esc(u)+'" target="_blank" rel="noopener">Open PDF</a></td></tr>';
   }).join(''):'<tr><td colspan="6">No authorized transactions found.</td></tr>';
   for(const row of table.querySelectorAll('tr[data-pdf]')){
     row.addEventListener('click',event=>{if(event.target.closest('a'))return;window.open(row.dataset.pdf,'_blank','noopener');});
   }
 }catch(e){status.textContent=e.message;table.innerHTML='<tr><td colspan="6">Unable to load records.</td></tr>';}
}
document.querySelector('#reload').addEventListener('click',reload);
reload();
