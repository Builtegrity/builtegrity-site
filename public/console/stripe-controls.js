const consoleRoot = document.querySelector('main.shell');

if (consoleRoot) {
  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.style.marginTop = '16px';
  panel.innerHTML = `
    <div class="toolbar" style="margin:0 0 12px">
      <div>
        <p class="eyebrow">Stripe connection</p>
        <h2>Merchant onboarding</h2>
      </div>
    </div>
    <div class="grid" style="grid-template-columns:2fr 1fr 1fr">
      <div><input id="stripeMerchantId" value="MER-0001" aria-label="Merchant ID"></div>
      <div><button id="stripeConnect" style="width:100%">Connect Stripe</button></div>
      <div><button id="stripeVerify" class="secondary" style="width:100%">Verify account</button></div>
    </div>
    <p id="stripeStatus" class="muted" style="margin-bottom:0"></p>
  `;

  const tablePanel = document.querySelector('.table-wrap');
  tablePanel?.parentNode?.insertBefore(panel, tablePanel);

  const merchantInput = panel.querySelector('#stripeMerchantId');
  const connectButton = panel.querySelector('#stripeConnect');
  const verifyButton = panel.querySelector('#stripeVerify');
  const status = panel.querySelector('#stripeStatus');

  const oauth = new URLSearchParams(location.search);
  if (oauth.get('stripe') === 'connected') {
    status.textContent = `Stripe connected for ${oauth.get('merchant') || 'merchant'}. Run Verify account next.`;
  } else if (oauth.get('stripe') === 'denied') {
    status.textContent = `Stripe connection was not completed${oauth.get('reason') ? `: ${oauth.get('reason')}` : '.'}`;
    status.className = 'error';
  }

  connectButton.addEventListener('click', async () => {
    connectButton.disabled = true;
    status.className = 'muted';
    status.textContent = 'Creating a secure Stripe authorization link…';
    try {
      const merchantId = merchantInput.value.trim();
      const result = await internalApi(`/api/merchants/${encodeURIComponent(merchantId)}/stripe/connect-url`, { method: 'POST' });
      location.assign(result.authorize_url);
    } catch (error) {
      status.className = 'error';
      status.textContent = error.message;
      connectButton.disabled = false;
    }
  });

  verifyButton.addEventListener('click', async () => {
    verifyButton.disabled = true;
    status.className = 'muted';
    status.textContent = 'Checking Stripe account capabilities and payout schedule…';
    try {
      const merchantId = merchantInput.value.trim();
      const result = await internalApi(`/api/merchants/${encodeURIComponent(merchantId)}/stripe/verify`, { method: 'POST' });
      status.textContent = result.compatible
        ? `Compatible: charges enabled, payouts enabled, payout interval ${result.payout_interval || 'unknown'}.`
        : `Not V1-compatible yet. charges_enabled=${result.charges_enabled}, payouts_enabled=${result.payouts_enabled}, automatic_payouts=${result.automatic_payouts}.`;
      status.className = result.compatible ? 'muted' : 'error';
    } catch (error) {
      status.className = 'error';
      status.textContent = error.message;
    } finally {
      verifyButton.disabled = false;
    }
  });
}

async function internalApi(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = sessionStorage.getItem('builtegrity_admin_token');
  if (token) headers.set('X-Builtegrity-Admin', token);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
