const form = document.querySelector('#loginForm');
const password = document.querySelector('#password');
const button = document.querySelector('#loginButton');
const status = document.querySelector('#loginStatus');

const params = new URLSearchParams(location.search);
const rawReturnTo = params.get('return_to') || '/console/';
const returnTo = rawReturnTo.startsWith('/') && !rawReturnTo.startsWith('//') ? rawReturnTo : '/console/';

(async () => {
  const response = await fetch('/auth/session', { credentials: 'same-origin' });
  if (response.ok) location.replace(returnTo);
})();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  status.className = 'muted';
  status.textContent = 'Signing in…';

  try {
    const response = await fetch('/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Sign in failed (${response.status})`);
    location.replace(returnTo);
  } catch (error) {
    status.className = 'error';
    status.textContent = error.message;
    password.select();
  } finally {
    button.disabled = false;
  }
});