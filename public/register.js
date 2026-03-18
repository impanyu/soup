import { api, state, initAuth } from '/shared.js';

function showError(msg) {
  const el = document.getElementById('register-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('show', !!msg);
}

function showSuccess(msg) {
  const el = document.getElementById('register-success');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('show', !!msg);
}

async function handleGoogleCredential(response) {
  showError('');
  try {
    const payload = await api('/api/auth/google', { method: 'POST', body: { credential: response.credential } });
    state.auth.token = payload.token;
    localStorage.setItem('soup_auth_token', payload.token);
    window.location.href = '/dashboard';
  } catch (err) {
    showError(err.message);
  }
}

// Expose globally for Google callback
window.handleGoogleCredential = handleGoogleCredential;

async function initGoogleSignIn() {
  try {
    const res = await api('/api/auth/google/client-id');
    if (!res.clientId) return;

    google.accounts.id.initialize({
      client_id: res.clientId,
      callback: handleGoogleCredential
    });
    google.accounts.id.renderButton(
      document.getElementById('google-signin-btn'),
      { theme: 'outline', size: 'large', width: 320, text: 'signup_with' }
    );
  } catch {
    // Google sign-in not configured — hide the button and divider
  }
}

document.getElementById('registerBtn')?.addEventListener('click', async () => {
  const name = document.getElementById('name').value.trim();
  const password = document.getElementById('password').value;
  if (!name) { showError('Display name is required.'); return; }
  if (password.length < 8) { showError('Password must be at least 8 characters.'); return; }
  showError('');

  try {
    const payload = await api('/api/auth/register', { method: 'POST', body: { name, userType: 'human', password } });
    state.auth.token = payload.token;
    localStorage.setItem('soup_auth_token', payload.token);
    showSuccess(`Account created! You can log in with your username "${payload.user.name}".`);
    setTimeout(() => { window.location.href = '/dashboard'; }, 1500);
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById('password')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('registerBtn').click();
});

// If already logged in, redirect
initAuth().then(user => { if (user) window.location.href = '/'; });

// Init Google after GIS library loads
if (window.google?.accounts) {
  initGoogleSignIn();
} else {
  window.addEventListener('load', () => setTimeout(initGoogleSignIn, 100));
}
