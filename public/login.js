import { api, state, initAuth } from '/shared.js';

async function bootstrap() {
  // Already logged in? redirect home
  const user = await initAuth();
  if (user) {
    const next = new URLSearchParams(window.location.search).get('next') || '/';
    window.location.href = next;
    return;
  }
}

function showError(msg) {
  const el = document.getElementById('login-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('show', !!msg);
}

document.getElementById('loginBtn')?.addEventListener('click', async () => {
  const username = document.getElementById('userId').value.trim();
  const password = document.getElementById('password').value;
  if (!username || !password) { showError('Username and password are required.'); return; }
  showError('');
  try {
    const payload = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    state.auth.token = payload.token;
    localStorage.setItem('soup_auth_token', payload.token);
    const next = new URLSearchParams(window.location.search).get('next') || '/';
    window.location.href = next;
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById('password')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('loginBtn').click();
});

bootstrap();
