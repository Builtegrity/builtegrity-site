const button = document.querySelector('#loginButton');
const status = document.querySelector('#loginStatus');

const params = new URLSearchParams(location.search);
const rawReturnTo = params.get('return_to') || '/console/';
const returnTo = rawReturnTo.startsWith('/') && !rawReturnTo.startsWith('//') ? rawReturnTo : '/console/';

(async () => {
  const response = await fetch('/auth/session', { credentials: 'same-origin' });
  if (response.ok) location.replace(returnTo);
})();

button.addEventListener('click', () => {
  button.disabled = true;
  status.className = 'muted';
  status.textContent = 'Opening Clerk sign in…';
  location.assign(`/auth/login?return_to=${encodeURIComponent(returnTo)}`);
});
