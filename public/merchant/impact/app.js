const $ = (selector) => document.querySelector(selector);
const merchantSelect = $('#merchantSelect');
const status = $('#status');
const form = $('#impactForm');
const fields = ['enabled','cause','mode','rate'];
let merchants = [];
let currentRole = 'VIEWER';
const money = (cents) => (Number(cents || 0) / 100).toLocaleString('en-US', { style:'currency',currency:'USD' });
function notify(message) { status.textContent = message; }
function selectedMerchant() { return merchantSelect.value; }
async function api(path, options = {}) {
  const response = await fetch(path, { credentials:'same-origin',cache:'no-store',...options });
  if (response.status === 401) { location.assign('/login/?return_to=%2Fmerchant%2Fimpact%2F'); throw Error('Sign-in required'); }
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Request failed');
  return data;
}
function updateRate() {
  const flat = $('#mode').value === 'FLAT_CENTS';
  const field = $('#rate');
  field.min = flat ? '0.01' : '0.01';
  field.max = flat ? '1000' : '10';
  field.step = '0.01';
  $('#rateHelp').textContent = flat ? 'US dollars per transaction (max $1,000)' : 'Percent per paid transaction (max 10%)';
}
$('#mode').addEventListener('change', updateRate);
function readPolicy(policy) {
  $('#enabled').value = policy && Number(policy.enabled) ? 'true' : 'false';
  $('#cause').value = policy?.cause_code || 'REFORESTATION';
  $('#mode').value = policy?.contribution_mode || 'BPS';
  $('#rate').value = (Number(policy?.contribution_value ?? 25) / (policy?.contribution_mode === 'FLAT_CENTS' ? 100 : 100)).toFixed(2);
  updateRate();
}
function tableRows(entries) {
  const tbody = $('#entries');
  tbody.replaceChildren();
  if (!entries.length) {
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = 5; td.textContent = 'No eligible transactions yet.'; tr.append(td); tbody.append(tr); return;
  }
  for (const entry of entries) {
    const tr = document.createElement('tr');
    const values = [
      entry.transaction_id,
      entry.payment_at,
      entry.cause_code.replaceAll('_',' '),
      money(entry.cumulative_refunded_cents),
      money(entry.commitment_cents),
    ];
    for (const value of values) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
    tbody.append(tr);
  }
}
async function refresh() {
  if (!selectedMerchant()) return;
  notify('Loading Impact…');
  try {
    const mid = encodeURIComponent(selectedMerchant());
    const [profile, ledger] = await Promise.all([
      api('/api/merchant/impact?merchant_id=' + mid),
      api('/api/merchant/impact/ledger?merchant_id=' + mid),
    ]);
    readPolicy(profile.policy);
    $('#transactions').textContent = String(profile.summary.transactions);
    $('#committed').textContent = money(profile.summary.tracked_commitment_cents);
    $('#funded').textContent = money(profile.summary.verified_funded_cents);
    $('#tracking').textContent = profile.tracking_active ?
      'Transaction calculations are enabled. Contributions remain unfunded until a provider is authorized.' :
      'Transaction calculations are not yet activated by Builtegrity. Preferences can be saved, but tracking is pending deployment configuration.';
    tableRows(ledger.entries || []);
    const canEdit = ['OWNER','ADMIN'].includes(currentRole);
    for (const id of fields) $('#'+id).disabled = !canEdit;
    $('#save').hidden = !canEdit;
    notify(canEdit ? 'Preferences are optional. Your existing Builtegrity fees are unchanged.' :
      'View only. Contact your business owner or admin to change participation.');
  } catch (error) { notify(error.message); }
}
merchantSelect.addEventListener('change', () => {
  currentRole = merchants.find((m) => m.id === selectedMerchant())?.role || 'VIEWER';
  refresh();
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!['OWNER','ADMIN'].includes(currentRole)) return;
  const num = Number($('#rate').value);
  const amount = Math.round(num * 100);
  if (!Number.isFinite(num) || num <= 0 || Math.abs(amount / 100 - num) > 0.000001) {
    notify('Enter a positive amount with at most two decimal places.'); return;
  }
  $('#save').disabled = true; notify('Saving preferences…');
  try {
    const data = await api('/api/merchant/impact', {
      method:'PUT',headers:{'content-type':'application/json'},
      body: JSON.stringify({
        merchant_id:selectedMerchant(),enabled:$('#enabled').value === 'true',
        cause_code:$('#cause').value,contribution_mode:$('#mode').value,
        contribution_value:amount,
      }),
    });
    await refresh();
    notify(data.changed ? 'Impact preferences saved. Only future eligible payments use this version.' :
      'Your Impact preferences are unchanged.');
  } catch (error) { notify(error.message); }
  finally { $('#save').disabled = false; }
});
async function init() {
  try {
    const data = await api('/api/merchant/impact/merchants');
    merchants = data.merchants || [];
    merchantSelect.replaceChildren();
    if (!merchants.length) { notify('No authorized merchant businesses found.'); return; }
    for (const merchant of merchants) {
      const option = document.createElement('option');
      option.value = merchant.id; option.textContent = merchant.name; merchantSelect.append(option);
    }
    const requested = new URL(location.href).searchParams.get('merchant_id');
    if (merchants.some((m) => m.id === requested)) merchantSelect.value = requested;
    currentRole = merchants.find((m) => m.id === selectedMerchant())?.role || 'VIEWER';
    await refresh();
  } catch (error) { notify(error.message); }
}
init();
