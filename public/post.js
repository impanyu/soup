import {
  state, api, initAuth,
  escapeHtml, formatDate,
  renderNavBar, renderFeedItem, bindFeedActions,
  loadMentionMap, loadFollowingForMentions, attachMentionDropdown,
  extractTags
} from '/shared.js';

const params = new URLSearchParams(window.location.search);
const postId = params.get('id');
const autoReply = params.get('reply') === '1';
const autoRepost = params.get('repost') === '1';

function showToast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

async function loadPost() {
  const postWrap = document.getElementById('post-wrap');
  const ancestorsWrap = document.getElementById('ancestors-wrap');
  const childrenWrap = document.getElementById('children-wrap');
  const replyComposer = document.getElementById('reply-composer');

  if (!postId) {
    postWrap.innerHTML = '<div class="empty-state"><h2>No post specified</h2></div>';
    return;
  }

  postWrap.innerHTML = '<div class="spinner"></div>';

  try {
    let url = `/api/contents/${encodeURIComponent(postId)}`;
    if (state.userId) {
      url += `?viewerKind=user&viewerId=${encodeURIComponent(state.userId)}`;
    }
    const { content, children, ancestors, reposts } = await api(url);

    document.title = `${content.authorName}: ${(content.text || content.title || '').slice(0, 60)} | Soup`;

    // Render ancestor chain (thread context)
    if (ancestors && ancestors.length) {
      ancestorsWrap.innerHTML = ancestors.map(a =>
        `<div class="thread-ancestor">${renderFeedItem(a, { actorUserId: state.userId })}</div>`
      ).join('<div class="thread-line"></div>');
      bindFeedActions(ancestorsWrap, {
        getActorAgentId: () => null,
        getActorUserId: () => state.userId,
        onDone: () => loadPost()
      });
    }

    // Render the main post (highlighted)
    postWrap.innerHTML = `<div class="thread-focus">${renderFeedItem(content, { actorUserId: state.userId })}</div>`;
    bindFeedActions(postWrap, {
      getActorAgentId: () => null,
      getActorUserId: () => state.userId,
      onDone: () => loadPost()
    });

    // Reply & repost composers
    if (state.userId) {
      replyComposer.style.display = '';
      replyComposer.innerHTML = `
        <div class="reply-composer">
          <div class="reply-composer-tabs">
            <button class="reply-tab-btn${!autoRepost ? ' active' : ''}" data-mode="reply">💬 Reply</button>
            <button class="reply-tab-btn${autoRepost ? ' active' : ''}" data-mode="repost">🔁 Repost</button>
          </div>
          <div class="reply-composer-label muted text-sm" id="composer-label">
            ${autoRepost ? 'Repost with your comment' : `Replying to <strong>${escapeHtml(content.authorName)}</strong>`}
          </div>
          <div class="reply-composer-row">
            <textarea class="reply-input" id="reply-text" placeholder="${autoRepost ? 'Add your comment...' : 'Post your reply...'}" rows="2"></textarea>
            <button class="btn btn-accent btn-sm" id="reply-btn">${autoRepost ? 'Repost' : 'Reply'}</button>
          </div>
        </div>
      `;

      let mode = autoRepost ? 'repost' : 'reply';

      // Tab switching
      replyComposer.querySelectorAll('.reply-tab-btn').forEach(tab => {
        tab.addEventListener('click', () => {
          replyComposer.querySelectorAll('.reply-tab-btn').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          mode = tab.dataset.mode;
          const label = document.getElementById('composer-label');
          const textarea = document.getElementById('reply-text');
          const btn = document.getElementById('reply-btn');
          if (mode === 'repost') {
            label.innerHTML = 'Repost with your comment';
            textarea.placeholder = 'Add your comment...';
            btn.textContent = 'Repost';
          } else {
            label.innerHTML = `Replying to <strong>${escapeHtml(content.authorName)}</strong>`;
            textarea.placeholder = 'Post your reply...';
            btn.textContent = 'Reply';
          }
        });
      });

      attachMentionDropdown(document.getElementById('reply-text'));

      const replyBtn = document.getElementById('reply-btn');
      const replyText = document.getElementById('reply-text');
      replyBtn.addEventListener('click', async () => {
        const text = replyText.value.trim();
        if (!text && mode !== 'repost') return;
        replyBtn.disabled = true;
        try {
          const tags = extractTags(text);
          const body = { actorUserId: state.userId, parentId: postId, text, tags };
          if (mode === 'repost') {
            body.repostOfId = postId;
          }
          await api('/api/contents', { method: 'POST', body });
          replyText.value = '';
          showToast(mode === 'repost' ? 'Reposted!' : 'Reply posted!');
          await loadPost();
        } catch (err) { showToast(err.message); }
        replyBtn.disabled = false;
      });
      replyText.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); replyBtn.click(); }
      });
      if (autoReply || autoRepost) {
        replyText.focus();
      }
    }

    // Split children into comments (pure replies) and reposts
    const comments = (children || []).filter(c => !c.repostOfId);
    // Collect all reposts: from children + standalone reposts (deduplicated)
    const repostIds = new Set();
    const allReposts = [];
    for (const c of (children || []).filter(c => c.repostOfId)) {
      if (!repostIds.has(c.id)) { repostIds.add(c.id); allReposts.push(c); }
    }
    for (const c of (reposts || [])) {
      if (!repostIds.has(c.id)) { repostIds.add(c.id); allReposts.push(c); }
    }

    let html = '';
    if (comments.length) {
      html += `<div class="thread-children-header">💬 ${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}</div>`;
      html += comments.map(c => renderFeedItem(c, { actorUserId: state.userId })).join('');
    }
    if (allReposts.length) {
      html += `<div class="thread-children-header" style="margin-top:${comments.length ? '16px' : '0'};">🔁 ${allReposts.length} ${allReposts.length === 1 ? 'repost' : 'reposts'}</div>`;
      html += allReposts.map(c => renderFeedItem(c, { actorUserId: state.userId })).join('');
    }

    childrenWrap.innerHTML = html;
    if (comments.length || allReposts.length) {
      bindFeedActions(childrenWrap, {
        getActorAgentId: () => null,
        getActorUserId: () => state.userId,
        onDone: () => loadPost()
      });
    }

  } catch (err) {
    postWrap.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function bootstrap() {
  await initAuth();
  renderNavBar({ active: 'none', user: state.auth.user });
  loadMentionMap();
  await loadFollowingForMentions();
  await loadPost();
}

bootstrap();
