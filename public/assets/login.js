'use strict';

const form = document.getElementById('form');
const statusEl = document.getElementById('status');
const submit = document.getElementById('submit');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusEl.textContent = '';
  statusEl.classList.remove('error');
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  if (!username || !password) {
    statusEl.textContent = 'Enter your user ID and password.';
    statusEl.classList.add('error');
    return;
  }
  submit.disabled = true;
  submit.textContent = 'Signing in…';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      window.location.href = '/';
      return;
    }
    statusEl.textContent = data.error || 'Could not sign in. Try again.';
    statusEl.classList.add('error');
  } catch (_) {
    statusEl.textContent = 'Could not reach the server. Check your connection and try again.';
    statusEl.classList.add('error');
  }
  submit.disabled = false;
  submit.textContent = 'Sign in';
});
