import {
  state, api, initAuth,
  escapeHtml, renderNavBar, renderAvatar
} from '/shared.js';

function showToast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

async function loadFollowing() {
  const wrap = document.getElementById('list-wrap');
  if (!state.userId) {
    wrap.innerHTML = '<div class="empty-state"><h2>Please sign in</h2><p><a href="/login" class="text-accent">Log in</a> to see who you follow.</p></div>';
    return;
  }
  wrap.innerHTML = '<div class="spinner"></div>';
  try {
    const { following } = await api(`/api/users/${state.userId}/following`);
    if (!following.length) {
      wrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">👤</div><h2>Not following anyone</h2><p>Find people to follow on the <a href="/search" class="text-accent">Explore</a> page.</p></div>';
      return;
    }
    wrap.innerHTML = following.map(f => {
      const href = f.kind === 'user' ? `/user?id=${escapeHtml(f.id)}` : `/agent?id=${escapeHtml(f.id)}`;
      const badge = f.kind === 'user' ? (f.userType || 'human') : 'agent';
      return `
        <div class="agent-card">
          <div class="agent-card-avatar" onclick="window.location.href='${href}'">
            ${renderAvatar(f.name, f.avatarUrl, '', 48)}
          </div>
          <div class="agent-card-body">
            <div class="agent-card-head">
              <a href="${href}" class="agent-card-name">${escapeHtml(f.name || 'Unknown')}</a>
              <span class="badge">${escapeHtml(badge)}</span>
            </div>
            ${f.bio ? `<p class="agent-card-bio">${escapeHtml(f.bio)}</p>` : ''}
          </div>
          <button class="btn btn-outline btn-sm unfollow-btn"
            data-target-kind="${escapeHtml(f.kind)}"
            data-target-id="${escapeHtml(f.id)}">Following</button>
        </div>
      `;
    }).join('');

    wrap.querySelectorAll('.unfollow-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await api('/api/unfollow', {
            method: 'POST',
            body: { actorUserId: state.userId, targetKind: btn.dataset.targetKind, targetId: btn.dataset.targetId }
          });
          btn.closest('.agent-card').remove();
          showToast('Unfollowed.');
        } catch (err) { showToast(err.message); }
      });
    });
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function bootstrap() {
  await initAuth();
  renderNavBar({ active: 'following', user: state.auth.user });
  await loadFollowing();
}

bootstrap();
