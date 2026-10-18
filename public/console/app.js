const rows = document.querySelector('#transactionRows');
const detail = document.querySelector('#detail');
const stats = document.querySelector('#stats');
const empty = document.querySelector('#empty');
const caseRows = document.querySelector('#caseRows');
const caseDetail = document.querySelector('#caseDetail');
const caseEmpty = document.querySelector('#caseEmpty');
const opsStats = document.querySelector('#opsStats');
const refreshButton = document.querySelector('#refresh');
const signOutButton = document.querySelector('#signOut');
const sessionLabel = document.querySelector('#sessionLabel');
let caseOpenedAt = null;

refreshButton.addEventListener('click', loadEverything);
signOutButton?.addEventListener('click', async () => {
  signOutButton.disabled = true;
  try {
    const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    location.assign(data.redirect_url || '/login/');
  } catch {
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

async function loadEverything() {
  await Promise.all([loadCases(), loadTransactions()]);
}

async function loadCases() {
  caseRows.innerHTML = '<tr><td colspan="7" class="muted">Loading internal cases…</td></tr>';
  try {
    const [queue, metrics] = await Promise.all([
      api('/api/cases?limit=200'),
      api('/api/cases/metrics'),
    ]);
    renderOpsStats(queue.cases || [], metrics || {});
    renderCaseRows(queue.cases || []);
    const requested = new URLSearchParams(location.search).get('case');
    if (requested) await loadCaseDetail(requested);
  } catch (error) {
    caseRows.innerHTML = `<tr><td colspan="7" class="error">${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderOpsStats(items, metrics) {
  const critical = items.filter((item) => item.severity === 'CRITICAL').length;
  const touchRate = Number(metrics.human_touch_rate || 0) * 100;
  const minutesPerThousand = Number(metrics.human_minutes_per_1000_transactions || 0);
  opsStats.innerHTML = [
    ['Open internal cases', items.length],
    ['Critical', critical],
    ['Human touch rate', `${touchRate.toFixed(3)}%`],
    ['Human min / 1,000 TX', minutesPerThousand.toFixed(2)],
    ['Unknown exceptions', Number(metrics.unknown_exception_cases || 0)],
  ].map(([label, value]) => `<div class="panel stat"><span class="muted">${label}</span><strong>${escapeHtml(String(value))}</strong></div>`).join('');
}

function renderCaseRows(items) {
  caseEmpty.hidden = items.length > 0;
  caseRows.innerHTML = items.length ? items.map((item) => `
    <tr data-case-id="${escapeHtml(item.id)}">
      <td><strong>${escapeHtml(item.id)}</strong></td>
      <td>${escapeHtml(item.title || item.case_type_code)}</td>
      <td>${escapeHtml(`${item.subject_type || 'SYSTEM'} ${item.subject_id || ''}`.trim())}</td>
      <td>${badge(item.severity)}</td>
      <td>${escapeHtml(formatAge(item.age_minutes))}</td>
      <td>${badge(item.status)}</td>
      <td>${escapeHtml(item.recommended_action || 'Follow runbook')}</td>
    </tr>
  `).join('') : '<tr><td colspan="7" class="muted">No internal human cases. The machine is handling the queue.</td></tr>';

  for (const row of caseRows.querySelectorAll('tr[data-case-id]')) {
    row.addEventListener('click', () => loadCaseDetail(row.dataset.caseId));
  }
}

async function loadCaseDetail(caseId) {
  caseDetail.hidden = false;
  caseDetail.innerHTML = '<div class="panel muted">Loading case runbook…</div>';
  try {
    const item = await api(`/api/cases/${encodeURIComponent(caseId)}`);
    caseOpenedAt = Date.now();
    history.replaceState(null, '', `/console/?case=${encodeURIComponent(caseId)}`);
    renderCaseDetail(item);
  } catch (error) {
    caseDetail.innerHTML = `<div class="panel error">${escapeHtml(error.message)}</div>`;
  }
}

function renderCaseDetail(item) {
  const context = item.machine_context || {};
  const attempts = item.automation_attempts || {};
  const providerUrl = providerShortcut(item);
  caseDetail.innerHTML = `
    <div class="panel" style="margin-top:16px">
      <div class="toolbar">
        <div>
          <p class="eyebrow">${escapeHtml(item.case_type_code)}</p>
          <h2>${escapeHtml(item.id)} · ${escapeHtml(item.title || '')}</h2>
        </div>
        <div>${badge(item.severity)} ${badge(item.status)}</div>
      </div>

      <div class="detail">
        <div>
          <h3>What happened</h3>
          <p>${escapeHtml(item.summary)}</p>
          <h3>Operator rule</h3>
          <p>${escapeHtml(item.operator_summary || '')}</p>
          <dl class="kv">
            <dt>Subject</dt><dd>${escapeHtml(`${item.subject_type} ${item.subject_id || ''}`.trim())}</dd>
            <dt>Transaction</dt><dd>${escapeHtml(item.transaction_id || '—')}</dd>
            <dt>Merchant</dt><dd>${escapeHtml(item.merchant_id || '—')}</dd>
            <dt>Escalation target</dt><dd>${escapeHtml(item.escalation_target)}</dd>
            <dt>SLA</dt><dd>${escapeHtml(String(item.sla_minutes || '—'))} minutes</dd>
            <dt>Auto-verification</dt><dd>${escapeHtml(item.auto_verify_rule || 'Source condition must clear')}</dd>
          </dl>
        </div>
        <div>
          <h3>Machine already knows</h3>
          <pre style="white-space:pre-wrap">${escapeHtml(JSON.stringify(context, null, 2))}</pre>
          <h3>Automation attempts</h3>
          <pre style="white-space:pre-wrap">${escapeHtml(JSON.stringify(attempts, null, 2))}</pre>
        </div>
      </div>

      <h3 style="margin-top:18px">Allowed actions</h3>
      <p class="muted">This case type is hard-limited to three human actions. After every action, Builtegrity re-runs its watchdog and decides whether the problem is actually gone.</p>
      <div class="actions" id="caseActions">
        ${(item.actions || []).map((action) => `<button class="secondary" data-case-action="${escapeHtml(action.action_code)}" data-handler="${escapeHtml(action.action_handler)}">${escapeHtml(action.label)}</button>`).join('') || '<span class="muted">No operator action is currently allowed.</span>'}
        ${providerUrl ? `<a class="button secondary" target="_blank" rel="noreferrer" href="${providerUrl}">Open provider dashboard</a>` : ''}
      </div>

      <h3 style="margin-top:18px">Action history</h3>
      <ul class="timeline">
        ${(item.action_runs || []).length ? item.action_runs.map((run) => `<li><strong>${escapeHtml(run.action_code)}</strong> ${badge(run.status)}<div class="muted">${escapeHtml(run.actor_ref || run.actor_type || '')} · ${escapeHtml(String(run.human_seconds || 0))} human sec</div><time>${escapeHtml(run.finished_at || run.started_at || '')}</time></li>`).join('') : '<li><span class="muted">No human action taken.</span></li>'}
      </ul>
    </div>
  `;

  for (const button of caseDetail.querySelectorAll('[data-case-action]')) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const humanSeconds = caseOpenedAt ? Math.max(1, Math.round((Date.now() - caseOpenedAt) / 1000)) : 0;
        const handler = button.dataset.handler || '';
        let note = '';
        if (handler === 'EXTERNAL_CONFIRMATION' || handler.startsWith('ESCALATE_') || handler === 'MARK_RESOLVED') {
          note = window.prompt('Optional note for the audit trail:', '') || '';
        }
        const result = await api(`/api/cases/${encodeURIComponent(item.id)}/actions/${encodeURIComponent(button.dataset.caseAction)}`, {
          method: 'POST',
          body: JSON.stringify({ human_seconds: humanSeconds, note }),
        });
        caseOpenedAt = Date.now();
        renderCaseDetail(result.case || result.executed?.case || item);
        await loadCases();
      } catch (error) {
        alert(error.message);
      } finally {
        button.disabled = false;
      }
    });
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
      <td>${escapeHtml(t.merchant_name || '')} <small class="muted">· ${escapeHtml(t.processor || 'STRIPE')}</small></td>
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
          <dt>Processor</dt><dd>${escapeHtml(tx.processor || 'STRIPE')}</dd>
          ${tx.processor === 'SQUARE' ? `
          <dt>Square checkout</dt><dd><code>${escapeHtml(tx.processor_checkout_id || '—')}</code></dd>
          <dt>Square order</dt><dd><code>${escapeHtml(tx.processor_order_id || '—')}</code></dd>
          <dt>Square payment</dt><dd><code>${escapeHtml(tx.processor_payment_id || '—')}</code></dd>
          <dt>Square payout</dt><dd><code>${escapeHtml(tx.processor_payout_id || '—')}</code></dd>
          <dt>Application fee requested</dt><dd>${money(tx.processor_app_fee_requested_cents,tx.currency)}</dd>
          <dt>Application fee reported by Square</dt><dd>${money(tx.processor_app_fee_confirmed_cents,tx.currency)} (not recognized as Builtegrity revenue until settlement verified)</dd>
          ` : `
          <dt>PaymentIntent</dt><dd><code>${escapeHtml(tx.stripe_payment_intent_id || '—')}</code></dd>
          <dt>Charge</dt><dd><code>${escapeHtml(tx.stripe_charge_id || '—')}</code></dd>
          <dt>Balance transaction</dt><dd><code>${escapeHtml(tx.stripe_balance_transaction_id || '—')}</code></dd>
          <dt>Application fee</dt><dd><code>${escapeHtml(tx.stripe_application_fee_id || '—')}</code></dd>
          <dt>Payout</dt><dd><code>${escapeHtml(tx.stripe_payout_id || '—')}</code></dd>
          `}
          <dt>Fee quoted</dt><dd>${money(tx.integrity_fee_earned_cents, tx.currency)} via ${escapeHtml(tx.fee_collection_method || '—')}</dd>
          <dt>Recognized fee revenue</dt><dd>${money(tx.bg_fee_earned_cents || 0, tx.currency)} · ${escapeHtml(tx.record_classification || 'PENDING')}</dd>
          <dt>Application fee cash recognized</dt><dd>${money(tx.integrity_fee_collected_cents, tx.currency)}</dd>
        </dl>
        <div class="actions">
          ${publicPath ? `<a class="button secondary" target="_blank" rel="noreferrer" href="${publicPath}">Open customer payment page</a>` : ''}
          <a class="button" target="_blank" rel="noopener" href="/api/transactions/${encodeURIComponent(tx.id)}/pdf?view=1">Open current PDF</a>
          <a class="button secondary" href="/api/transactions/${encodeURIComponent(tx.id)}/pdf">Download current PDF</a>
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

function providerShortcut(item) {
  const key = `${item.source_ref || ''} ${item.summary || ''}`.toLowerCase();
  if (key.includes('stripe')) return 'https://dashboard.stripe.com/';
  if (key.includes('clerk')) return 'https://dashboard.clerk.com/';
  if (key.includes('cloudflare') || key.includes('public-health') || key.includes('config:')) return 'https://dash.cloudflare.com/';
  return '';
}

function formatAge(minutes) {
  const value = Math.max(0, Number(minutes || 0));
  if (value < 60) return `${Math.round(value)}m`;
  if (value < 1440) return `${(value / 60).toFixed(1)}h`;
  return `${(value / 1440).toFixed(1)}d`;
}

function badge(value) {
  const text = String(value || '—');
  const upper = text.toUpperCase();
  const cls = upper === 'ACCOUNTED' || upper === 'COMPLETE' || upper === 'RESOLVED' || upper === 'SUCCEEDED' ? 'ok'
    : upper.includes('ATTENTION') || upper === 'OPEN' || upper.includes('FAILED') || upper === 'CRITICAL' || upper === 'QUARANTINED' ? 'bad'
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
await loadEverything();