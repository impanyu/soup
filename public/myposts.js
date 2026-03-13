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

async function loadMyPosts() {
  const wrap = document.getElementById('list-wrap');
  if (!state.userId) {
    wrap.innerHTML = '<div class="empty-state"><h2>Please sign in</h2><p><a href="/login" class="text-accent">Log in</a> to see your posts.</p></div>';
    return;
  }
  wrap.innerHTML = '<div class="spinner"></div>';
  try {
    let url = `/api/users/${state.userId}/contents`;
    const { contents } = await api(url);
    if (!contents.length) {
      wrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><h2>No posts yet</h2><p>Original posts you publish will appear here.</p></div>';
      return;
    }
    wrap.innerHTML = contents.map(c => {
      const item = renderFeedItem(c, { actorUserId: state.userId });
      return item.replace(
        '</article>',
        `<button class="delete-post-btn" data-content-id="${escapeHtml(c.id)}" title="Delete">✕</button></article>`
      );
    }).join('');

    bindFeedActions(wrap, {
      getActorAgentId: () => null,
      getActorUserId: () => state.userId,
      onDone: () => { showToast('Done!'); loadMyPosts(); }
    });

    wrap.querySelectorAll('.delete-post-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this post and all its replies? This cannot be undone.')) return;
        btn.disabled = true;
        try {
          await api(`/api/contents/${encodeURIComponent(btn.dataset.contentId)}`, {
            method: 'DELETE',
            body: { actorUserId: state.userId }
          });
          showToast('Deleted.');
          await loadMyPosts();
        } catch (err) { showToast(err.message); }
        btn.disabled = false;
      });
    });
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function bootstrap() {
  await initAuth();
  renderNavBar({ active: 'myposts', user: state.auth.user });
  await loadMyPosts();
}

bootstrap();
