const card = document.querySelector('#paymentCard');
const token = new URLSearchParams(location.search).get('token');

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

    ${accepted ? `
      <div class="notice" style="margin-top:18px">Terms acceptance has already been recorded for this transaction.</div>
      <div class="actions"><button id="payButton">Continue to secure Stripe payment</button></div>
    ` : `
      <label class="checkline">
        <input id="acceptTerms" type="checkbox">
        <span>I have reviewed and accept the terms shown above for this payment.</span>
      </label>
      <div class="actions"><button id="continueButton" disabled>Accept terms and continue to Stripe</button></div>
    `}
    <p id="status" class="muted"></p>
  `;

  if (accepted) {
    document.querySelector('#payButton').addEventListener('click', startCheckout);
  } else {
    const checkbox = document.querySelector('#acceptTerms');
    const button = document.querySelector('#continueButton');
    checkbox.addEventListener('change', () => { button.disabled = !checkbox.checked; });
    button.addEventListener('click', async () => {
      button.disabled = true;
      setStatus('Recording your acceptance…');
      try {
        await api(`/api/payments/${encodeURIComponent(token)}/consent`, {
          method: 'POST',
          body: JSON.stringify({ accepted: true }),
        });
        setStatus('Acceptance recorded. Opening Stripe…');
        await startCheckout();
      } catch (error) {
        setStatus(error.message, true);
        button.disabled = false;
      }
    });
  }
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
