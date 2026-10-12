const box = document.querySelector('#status');
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
      box.innerHTML = `<strong>Stripe payment confirmed.</strong><br>The transaction record is now ${escapeHtml(payment.lifecycle_status)}. Payout tracking continues automatically in the background.`;
      return;
    }

    box.innerHTML = `<strong>Payment confirmation is still pending.</strong><br>Current processor status: ${escapeHtml(payment.payment_status || 'waiting for Stripe')}. You do not need to resubmit payment.`;
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
