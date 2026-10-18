
const root = document.querySelector('main.shell');
if (root) {
  const section = document.createElement('section');
  section.className = 'panel';
  section.style.marginTop = '16px';
  section.innerHTML =
    '<div class="toolbar"><div><p class="eyebrow">Square connection</p><h2>Connect Square to a merchant</h2>' +
    '<p class="muted">This merchant can continue using Stripe too. Each transaction chooses one processor.</p></div></div>' +
    '<div class="grid" style="grid-template-columns:2fr 1fr 1fr">' +
    '<div><input id="squareMerchantId" value="MER-0001" aria-label="Builtegrity merchant ID"></div>' +
    '<div><button style="width:100%" id="squareConnect">Connect Square</button></div>' +
    '<div><button class="secondary" style="width:100%" id="squareVerify">Verify Square</button></div></div>' +
    '<p id="squareConnection" class="muted" role="status"></p>' +
    '<div class="actions"><button id="squareRefresh" class="secondary">Refresh processor connections</button>' +
    '<button id="squareDisconnect" class="secondary">Disconnect Square</button></div>' +
    '<p class="muted">Square live payments remain disabled until approval and sandbox verification.</p>';

  const stripePanel = document.querySelector('#stripeMerchantId')?.closest('section');
  if (stripePanel) stripePanel.insertAdjacentElement('afterend',section);
  else root.insertAdjacentElement('afterbegin',section);
  const input = section.querySelector('#squareMerchantId');
  const status = section.querySelector('#squareConnection');
  const query = new URLSearchParams(location.search);
  if (/^MER-[A-Za-z0-9-]+$/.test(query.get('merchant') || ''))
    input.value = query.get('merchant');

  function message(value,fail=false) {
    status.className=fail?'error':'muted';
    status.textContent=value;
  }
  async function internal(path,options={}) {
    const res=await fetch(path,{...options,credentials:'same-origin'});
    if (res.status===401) {location.assign('/login/');throw new Error('Sign in required');}
    const body=await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(body.error || 'Square request failed ('+res.status+')');
    return body;
  }
  function urlFor(action) {
    const id=input.value.trim();
    if (!/^MER-[A-Za-z0-9-]+$/.test(id)) throw new Error('Valid MER- merchant ID required');
    return '/api/merchants/'+encodeURIComponent(id)+'/square/'+action;
  }
  async function refresh() {
    try {
      const id=input.value.trim();
      if (!/^MER-[A-Za-z0-9-]+$/.test(id)) throw new Error('Valid MER- merchant ID required');
      const response=await internal('/api/merchants/'+encodeURIComponent(id)+'/processors');
      const square=(response.processors||[]).find(p=>p.processor==='SQUARE');
      const stripe=(response.processors||[]).find(p=>p.processor==='STRIPE');
      message('Square: '+(square?square.status+' (location '+(square.location_id||'not chosen')+')':'not connected')+
        '. Stripe: '+(stripe?stripe.status:response.legacy_stripe_connected?'connected':'not connected')+'.');
    } catch(error){message(error.message,true);}
  }
  async function action(buttonId,mode) {
    const btn=section.querySelector('#'+buttonId);
    btn.disabled=true;
    try {
      if(mode==='disconnect'&&!confirm('Revoke this merchant Square connection? Historical transactions are retained.'))return;
      message('Working on Square '+mode+'…');
      const actionName=mode==='connect'?'connect-url':mode;
      const response=await internal(urlFor(actionName),{method:'POST'});
      if(mode==='connect'){
        if(!response.authorize_url)throw new Error('Square authorization URL missing');
        location.assign(response.authorize_url);
        return;
      }
      if(mode==='verify'){
        message(response.compatible?'Square connection verified':('Square verification incomplete: '+(response.reason||(response.missing_scopes||[]).join(', ')||'requirements pending')),!response.compatible);
      }else message('Square authorization revoked.');
      await refresh();
    } catch(error){message(error.message,true);}
    finally{btn.disabled=false;}
  }
  section.querySelector('#squareConnect').addEventListener('click',()=>action('squareConnect','connect'));
  section.querySelector('#squareVerify').addEventListener('click',()=>action('squareVerify','verify'));
  section.querySelector('#squareDisconnect').addEventListener('click',()=>action('squareDisconnect','disconnect'));
  section.querySelector('#squareRefresh').addEventListener('click',refresh);
  input.addEventListener('change',refresh);
  if(query.get('square')==='connected')message('Square authorization completed. Verify this merchant next.');
  else if(query.get('square')==='denied')message('Square authorization was declined.',true);
  else refresh();
}
