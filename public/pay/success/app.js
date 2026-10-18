const box = document.querySelector('#status');
const actions = document.querySelector('#record-actions');
const pdfLink = document.querySelector('#pdf-link');
const token = new URLSearchParams(location.search).get('token');

async function check() {
  if (!token) {
    box.textContent = 'The payment access token is missing from this return URL.';
    return;
  }

  try {
    const response = await fetch(`/api/payments/${encodeURIComponent(token)}`, { cache: 'no-store' });
    const payment = await response.json();
    if (!response.ok) throw new Error(payment.error || 'Unable to read transaction status');

    if (payment.payment_status === 'succeeded' || ['PAID','PAYOUT_PENDING','COMPLETE'].includes(payment.lifecycle_status)) {
      box.innerHTML = `<strong>Payment confirmed by processor.</strong><br>The transaction record is now ${escapeHtml(payment.lifecycle_status)}. Payout tracking continues automatically in the background.`;
      pdfLink.href = `/api/records/${encodeURIComponent(token)}/pdf`;
      actions.hidden = false;
      return;
    }

    box.innerHTML = `<strong>Payment confirmation is still pending.</strong><br>Current processor status: ${escapeHtml(payment.payment_status || 'awaiting processor confirmation')}. You do not need to resubmit payment.`;
  } catch (error) {
    box.textContent = error.message;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

check();
setTimeout(check, 2500);
setTimeout(check, 6000);
