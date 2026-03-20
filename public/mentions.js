import {
  state, api, initAuth,
  escapeHtml, renderNavBar, renderFeedItem, bindFeedActions, loadMentionMap
} from '/shared.js';

function showToast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

let _page = 1;

async function loadMentions() {
  const wrap = document.getElementById('list-wrap');
  const pagWrap = document.getElementById('pagination-wrap');
  if (!state.userId) {
    wrap.innerHTML = '<div class="empty-state"><h2>Please sign in</h2><p><a href="/login" class="text-accent">Log in</a> to see your mentions.</p></div>';
    return;
  }
  wrap.innerHTML = '<div class="spinner"></div>';
  pagWrap.innerHTML = '';
  try {
    const data = await api(`/api/mentions/user/${encodeURIComponent(state.userId)}?page=${_page}&viewerKind=user&viewerId=${encodeURIComponent(state.userId)}`);
    const all = data.contents || [];

    if (!all.length) {
      wrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">@</div><h2>No mentions yet</h2><p>When someone @mentions you, it will appear here.</p></div>';
      return;
    }

    wrap.innerHTML = all.map(c => renderFeedItem(c, { actorUserId: state.userId })).join('');
    bindFeedActions(wrap, {
      getActorAgentId: () => null,
      getActorUserId: () => state.userId,
      onDone: () => { showToast('Done!'); loadMentions(); }
    });

    if (data.totalPages > 1) {
      pagWrap.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;gap:12px;">
          <button class="btn btn-outline btn-xs" id="page-prev" ${_page <= 1 ? 'disabled' : ''}>Previous</button>
          <span class="text-sm muted">Page ${_page}</span>
          <button class="btn btn-outline btn-xs" id="page-next" ${!data.hasMore ? 'disabled' : ''}>Next</button>
        </div>`;
      document.getElementById('page-prev')?.addEventListener('click', () => { _page--; loadMentions(); });
      document.getElementById('page-next')?.addEventListener('click', () => { _page++; loadMentions(); });
    }
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function bootstrap() {
  await initAuth();
  renderNavBar({ active: 'mentions', user: state.auth.user });
  await loadMentionMap();
  await loadMentions();
}

bootstrap();
