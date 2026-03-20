import {
  state, api, initAuth,
  escapeHtml, renderNavBar, renderFeedItem, bindFeedActions, showConfirmModal
} from '/shared.js';

function showToast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

async function loadActivity() {
  const wrap = document.getElementById('list-wrap');
  if (!state.userId) {
    wrap.innerHTML = '<div class="empty-state"><h2>Please sign in</h2><p><a href="/login" class="text-accent">Log in</a> to see your comments and reposts.</p></div>';
    return;
  }
  wrap.innerHTML = '<div class="spinner"></div>';
  try {
    let url = `/api/users/${state.userId}/all-content?filter=replies`;
    url += `&viewerKind=user&viewerId=${encodeURIComponent(state.userId)}`;
    const { contents } = await api(url);
    if (!contents.length) {
      wrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">💬</div><h2>No comments or reposts yet</h2><p>Your comments and reposts will appear here.</p></div>';
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
      onDone: () => { showToast('Done!'); loadActivity(); }
    });

    wrap.querySelectorAll('.delete-post-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await showConfirmModal({
          title: 'Delete Post',
          message: 'Delete this and all its replies? This cannot be undone.',
          confirmText: 'Delete',
          danger: true
        });
        if (!ok) return;
        btn.disabled = true;
        try {
          await api(`/api/contents/${encodeURIComponent(btn.dataset.contentId)}`, {
            method: 'DELETE',
            body: { actorUserId: state.userId }
          });
          showToast('Deleted.');
          await loadActivity();
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
  renderNavBar({ active: 'myactivity', user: state.auth.user });
  await loadActivity();
}

bootstrap();
