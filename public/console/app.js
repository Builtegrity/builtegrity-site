const rows = document.querySelector('#transactionRows');
const detail = document.querySelector('#detail');
const stats = document.querySelector('#stats');
const empty = document.querySelector('#empty');
const refreshButton = document.querySelector('#refresh');
const signOutButton = document.querySelector('#signOut');
const sessionLabel = document.querySelector('#sessionLabel');

refreshButton.addEventListener('click', loadTransactions);
signOutButton?.addEventListener('click', async () => {
  signOutButton.disabled = true;
  try {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    location.assign('/login/');
  }
});

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  if (response.status === 401) {
    const returnTo = encodeURIComponent(`${location.pathname}${location.search}`);
    location.assign(`/login/?return_to=${returnTo}`);
    throw new Error('Authentication required');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function loadSession() {
  try {
    const session = await api('/auth/session');
    if (sessionLabel && session.principal) {
      sessionLabel.textContent = `${session.principal.role || 'Operator'} · ${session.principal.provider || 'session'}`;
    }
  } catch {
    // api() handles redirect for unauthenticated sessions.
  }
}

async function loadTransactions() {
  rows.innerHTML = '<tr><td colspan="7" class="muted">Loading…</td></tr>';
  try {
    const data = await api('/api/transactions?limit=200');
    renderStats(data.transactions);
    renderRows(data.transactions);
    const requested = new URLSearchParams(location.search).get('tx');
    if (requested) await loadDetail(requested);
  } catch (error) {
    rows.innerHTML = `<tr><td colspan="7" class="error">${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderStats(items) {
  const total = items.length;
  const accounted = items.filter((t) => t.integrity_status === 'ACCOUNTED').length;
  const attention = items.filter((t) => t.integrity_status === 'NEEDS_ATTENTION').length;
  const volume = items.reduce((sum, t) => sum + Number(t.amount_cents || 0), 0);
  stats.innerHTML = [
    ['Transactions', total],
    ['Accounted', accounted],
    ['Needs attention', attention],
    ['Recorded volume', money(volume, 'USD')],
  ].map(([label, value]) => `<div class="panel stat"><span class="muted">${label}</span><strong>${escapeHtml(String(value))}</strong></div>`).join('');
}

function renderRows(items) {
  empty.hidden = items.length > 0;
  rows.innerHTML = items.map((t) => `
    <tr data-id="${escapeHtml(t.transaction_id)}">
      <td><strong>${escapeHtml(t.transaction_id)}</strong></td>
      <td>${escapeHtml(t.merchant_name || '')}</td>
      <td>${escapeHtml(t.customer_name || '')}</td>
      <td>${escapeHtml(t.merchant_reference || t.purchase_id || '')}</td>
      <td>${money(t.amount_cents, t.currency)}</td>
      <td>${badge(t.lifecycle_status)}</td>
      <td>${badge(t.integrity_status)}</td>
    </tr>
  `).join('');

  for (const row of rows.querySelectorAll('tr[data-id]')) {
    row.addEventListener('click', () => loadDetail(row.dataset.id));
  }
}

async function loadDetail(txId) {
  detail.hidden = false;
  detail.innerHTML = '<div class="panel muted">Loading transaction…</div>';
  try {
    const tx = await api(`/api/transactions/${encodeURIComponent(txId)}`);
    history.replaceState(null, '', `/console/?tx=${encodeURIComponent(txId)}`);
    renderDetail(tx);
  } catch (error) {
    detail.innerHTML = `<div class="panel error">${escapeHtml(error.message)}</div>`;
  }
}

function renderDetail(tx) {
  const publicPath = tx.payment_access_token ? `/pay/?token=${encodeURIComponent(tx.payment_access_token)}` : null;
  detail.innerHTML = `
    <div class="toolbar"><h2>${escapeHtml(tx.id)}</h2><div>${badge(tx.lifecycle_status)} ${badge(tx.integrity_status)}</div></div>
    <div class="detail">
      <div class="panel">
        <h3>Transaction record</h3>
        <dl class="kv">
          <dt>Partner</dt><dd>${escapeHtml(`${tx.partner_id} · ${tx.partner_name}`)}</dd>
          <dt>Merchant</dt><dd>${escapeHtml(`${tx.merchant_id} · ${tx.merchant_name}`)}</dd>
          <dt>Customer</dt><dd>${escapeHtml(`${tx.customer_id} · ${tx.customer_name}`)}</dd>
          <dt>Purchase</dt><dd>${escapeHtml(`${tx.purchase_id} · ${tx.merchant_reference || ''}`)}</dd>
          <dt>Description</dt><dd>${escapeHtml(tx.description)}</dd>
          <dt>Amount</dt><dd>${money(tx.amount_cents, tx.currency)}</dd>
          <dt>Consent</dt><dd>${Number(tx.consent_accepted) ? 'Accepted' : 'Not accepted'}</dd>
          <dt>Terms hash</dt><dd><code>${escapeHtml(tx.terms_snapshot_sha256 || '—')}</code></dd>
          <dt>PaymentIntent</dt><dd><code>${escapeHtml(tx.stripe_payment_intent_id || '—')}</code></dd>
          <dt>Charge</dt><dd><code>${escapeHtml(tx.stripe_charge_id || '—')}</code></dd>
          <dt>Balance transaction</dt><dd><code>${escapeHtml(tx.stripe_balance_transaction_id || '—')}</code></dd>
          <dt>Application fee</dt><dd><code>${escapeHtml(tx.stripe_application_fee_id || '—')}</code></dd>
          <dt>Payout</dt><dd><code>${escapeHtml(tx.stripe_payout_id || '—')}</code></dd>
          <dt>Fee earned</dt><dd>${money(tx.integrity_fee_earned_cents, tx.currency)} via ${escapeHtml(tx.fee_collection_method || '—')}</dd>
          <dt>Fee collected</dt><dd>${money(tx.integrity_fee_collected_cents, tx.currency)}</dd>
        </dl>
        <div class="actions">
          ${publicPath ? `<a class="button secondary" target="_blank" rel="noreferrer" href="${publicPath}">Open customer payment page</a>` : ''}
        </div>
      </div>

      <div class="panel">
        <h3>Development controls</h3>
        <p class="muted">These buttons only work when <code>DEV_MODE=true</code>. They exercise the same database state model without moving money.</p>
        <div class="actions" id="simButtons">
          ${['CONSENT','CHECKOUT','PAYMENT','PAYOUT','FAIL_PAYMENT','OPEN_DISPUTE','RESOLVE_DISPUTE','PAYOUT_FAILED'].map((action) => `<button class="secondary" data-action="${action}">${action.replaceAll('_',' ')}</button>`).join('')}
        </div>
        <h3 style="margin-top:18px">Exceptions</h3>
        <ul class="timeline">
          ${(tx.exceptions || []).length ? tx.exceptions.map((ex) => `<li><strong>${escapeHtml(ex.exception_type)}</strong> ${badge(ex.status)}<div class="muted">${escapeHtml(ex.summary || '')}</div><time>${escapeHtml(ex.opened_at || '')}</time></li>`).join('') : '<li><span class="muted">No exceptions.</span></li>'}
        </ul>
      </div>
    </div>

    <div class="panel" style="margin-top:16px">
      <h3>Immutable event history</h3>
      <ul class="timeline">
        ${(tx.events || []).map((event) => `<li><strong>${escapeHtml(event.event_type)}</strong> <span class="muted">· ${escapeHtml(event.source)}</span><time>${escapeHtml(event.event_at || event.created_at || '')}</time></li>`).join('')}
      </ul>
    </div>
  `;

  for (const button of detail.querySelectorAll('[data-action]')) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const updated = await api(`/api/dev/transactions/${encodeURIComponent(tx.id)}/simulate`, {
          method: 'POST',
          body: JSON.stringify({ action: button.dataset.action }),
        });
        renderDetail(updated);
        loadTransactions();
      } catch (error) {
        alert(error.message);
      } finally {
        button.disabled = false;
      }
    });
  }
}

function badge(value) {
  const text = String(value || '—');
  const upper = text.toUpperCase();
  const cls = upper === 'ACCOUNTED' || upper === 'COMPLETE' || upper === 'RESOLVED' ? 'ok'
    : upper.includes('ATTENTION') || upper === 'OPEN' || upper.includes('FAILED') ? 'bad'
      : 'warn';
  return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
}

function money(cents, currency = 'USD') {
  const value = Number(cents || 0) / 100;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: String(currency || 'USD').toUpperCase() }).format(value); }
  catch { return `$${value.toFixed(2)}`; }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

await loadSession();
await loadTransactions();