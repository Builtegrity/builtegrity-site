const card = document.querySelector('#paymentCard');
const token = new URLSearchParams(location.search).get('token');

const US_STATES = [
  ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],['CO','Colorado'],
  ['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],
  ['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],
  ['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],['MS','Mississippi'],
  ['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],
  ['NM','New Mexico'],['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],
  ['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],['SD','South Dakota'],
  ['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],['VA','Virginia'],['WA','Washington'],
  ['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming'],
];

function money(cents, currency = 'USD') {
  const value = Number(cents || 0) / 100;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: String(currency || 'USD').toUpperCase() }).format(value); }
  catch { return `$${value.toFixed(2)}`; }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function stateOptions(selected = '') {
  return [
    '<option value="">Select billing state…</option>',
    ...US_STATES.map(([code, name]) => `<option value="${code}"${selected === code ? ' selected' : ''}>${escapeHtml(name)} (${code})</option>`),
  ].join('');
}

async function load() {
  if (!token) {
    card.innerHTML = '<h2>Invalid payment link</h2><p class="error">This payment URL is missing its access token.</p>';
    return;
  }

  try {
    const payment = await api(`/api/payments/${encodeURIComponent(token)}`);
    render(payment);
  } catch (error) {
    card.innerHTML = `<h2>Payment unavailable</h2><p class="error">${escapeHtml(error.message)}</p>`;
  }
}

function render(payment) {
  const accepted = Boolean(payment.consent_accepted);
  const jurisdictionAttested = Boolean(payment.customer_jurisdiction_attested);
  const readyForCheckout = accepted && jurisdictionAttested;
  const currentState = String(payment.customer_attested_state_code || '').toUpperCase();

  card.innerHTML = `
    <p class="eyebrow">${escapeHtml(payment.merchant_name)}</p>
    <h1 style="font-size:clamp(30px,7vw,48px)">${escapeHtml(payment.transaction_description)}</h1>
    <p class="lede" style="font-size:16px">${escapeHtml(payment.purchase_description || '')}</p>

    <dl class="kv">
      <dt>Reference</dt><dd>${escapeHtml(payment.purchase_reference || payment.transaction_id)}</dd>
      <dt>Payment amount</dt><dd><strong>${money(payment.amount_cents, payment.currency)}</strong></dd>
      <dt>Payment type</dt><dd>${escapeHtml(payment.transaction_type)}</dd>
    </dl>

    <h3 style="margin-top:24px">Terms for this payment</h3>
    <div class="terms" style="margin-top:10px">${escapeHtml(payment.terms_snapshot || 'No terms were provided.')}</div>
    ${payment.refund_policy ? `<p><strong>Refund policy:</strong> ${escapeHtml(payment.refund_policy)}</p>` : ''}
    ${payment.cancellation_policy ? `<p><strong>Cancellation policy:</strong> ${escapeHtml(payment.cancellation_policy)}</p>` : ''}

    ${accepted ? '<div class="notice" style="margin-top:18px">Terms acceptance has already been recorded for this transaction.</div>' : `
      <label class="checkline">
        <input id="acceptTerms" type="checkbox">
        <span>I have reviewed and accept the terms shown above for this payment.</span>
      </label>
    `}

    ${readyForCheckout ? `
      <div class="notice" style="margin-top:12px">U.S. billing jurisdiction confirmed: ${escapeHtml(currentState)}.</div>
      <div class="actions"><button id="payButton">Continue to secure Stripe payment</button></div>
    ` : `
      <div class="panel" style="margin-top:16px;padding:16px">
        <h3 style="margin-top:0">Billing jurisdiction</h3>
        <p class="muted">Builtegrity V1 supports U.S. customer payments only. Stripe will collect your full billing address securely; Builtegrity only records the country/state needed for legal and tax jurisdiction checks.</p>
        <label for="billingState"><strong>Billing state</strong></label>
        <select id="billingState" style="width:100%;margin-top:8px">${stateOptions(currentState)}</select>
        <label class="checkline" style="margin-top:14px">
          <input id="confirmJurisdiction" type="checkbox">
          <span>I confirm that my billing address for this payment is in the United States and in the state selected above.</span>
        </label>
      </div>
      <div class="actions"><button id="continueButton" disabled>${accepted ? 'Confirm jurisdiction and continue to Stripe' : 'Accept terms and continue to Stripe'}</button></div>
    `}
    <p id="status" class="muted"></p>
  `;

  if (readyForCheckout) {
    document.querySelector('#payButton').addEventListener('click', startCheckout);
    return;
  }

  const termsCheckbox = document.querySelector('#acceptTerms');
  const jurisdictionCheckbox = document.querySelector('#confirmJurisdiction');
  const stateSelect = document.querySelector('#billingState');
  const button = document.querySelector('#continueButton');

  const refreshEnabled = () => {
    const termsOk = accepted || Boolean(termsCheckbox?.checked);
    const jurisdictionOk = Boolean(jurisdictionCheckbox?.checked) && Boolean(stateSelect?.value);
    button.disabled = !(termsOk && jurisdictionOk);
  };
  termsCheckbox?.addEventListener('change', refreshEnabled);
  jurisdictionCheckbox?.addEventListener('change', refreshEnabled);
  stateSelect?.addEventListener('change', refreshEnabled);

  button.addEventListener('click', async () => {
    button.disabled = true;
    setStatus(accepted ? 'Recording your jurisdiction confirmation…' : 'Recording your acceptance and jurisdiction confirmation…');
    try {
      await api(`/api/payments/${encodeURIComponent(token)}/consent`, {
        method: 'POST',
        body: JSON.stringify({
          accepted: true,
          customer_country_code: 'US',
          customer_state_code: stateSelect.value,
        }),
      });
      setStatus('Confirmation recorded. Opening Stripe…');
      await startCheckout();
    } catch (error) {
      setStatus(error.message, true);
      refreshEnabled();
    }
  });
}

async function startCheckout() {
  const button = document.querySelector('#payButton') || document.querySelector('#continueButton');
  if (button) button.disabled = true;
  setStatus('Creating secure Stripe Checkout…');
  try {
    const checkout = await api(`/api/payments/${encodeURIComponent(token)}/checkout`, { method: 'POST' });
    location.assign(checkout.url);
  } catch (error) {
    setStatus(error.message, true);
    if (button) button.disabled = false;
  }
}

function setStatus(message, isError = false) {
  const status = document.querySelector('#status');
  if (!status) return;
  status.className = isError ? 'error' : 'muted';
  status.textContent = message;
}

load();