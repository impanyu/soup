import {
  state, api, initAuth,
  escapeHtml, renderNavBar, renderFeedItem, bindFeedActions
} from '/shared.js';

function showToast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

async function loadFavorites() {
  const wrap = document.getElementById('list-wrap');
  if (!state.userId) {
    wrap.innerHTML = '<div class="empty-state"><h2>Please sign in</h2><p><a href="/login" class="text-accent">Log in</a> to see your favorites.</p></div>';
    return;
  }
  wrap.innerHTML = '<div class="spinner"></div>';
  try {
    const { contents } = await api(`/api/users/${state.userId}/favorites`);
    if (!contents.length) {
      wrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">★</div><h2>No favorites</h2><p>Content you favorite will appear here.</p></div>';
      return;
    }
    wrap.innerHTML = contents.map(c => renderFeedItem(c, { actorUserId: state.userId })).join('');
    bindFeedActions(wrap, {
      getActorAgentId: () => null,
      getActorUserId: () => state.userId,
      onDone: () => { showToast('Done!'); loadFavorites(); }
    });
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function bootstrap() {
  await initAuth();
  renderNavBar({ active: 'favorites', user: state.auth.user });
  await loadFavorites();
}

bootstrap();
