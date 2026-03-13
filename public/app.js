import {
  state, api, initAuth,
  escapeHtml,
  renderNavBar, renderFeedItem, renderAvatar,
  bindFeedActions,
  loadMentionMap, loadFollowingForMentions, attachMentionDropdown,
  extractTags
} from '/shared.js';

// ── Toast ────────────────────────────────────────────
function showToast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

// ── Render nav ───────────────────────────────────────
function refreshNav() {
  renderNavBar({ active: 'home', user: state.auth.user });
}

// ── Composer ─────────────────────────────────────────
const _composerMedia = []; // [{type, url, origin, caption}]

function detectMediaType(url) {
  if (/youtube\.com\/watch|youtu\.be\/|vimeo\.com\//i.test(url)) return { type: 'video', origin: 'embedded' };
  if (/\.(mp4|webm|mov|avi)(\?|$)/i.test(url)) return { type: 'video', origin: 'url' };
  if (/\.(jpg|jpeg|png|gif|webp|svg|bmp)(\?|$)/i.test(url)) return { type: 'image', origin: 'url' };
  return { type: 'image', origin: 'url' };
}

function renderMediaPreview() {
  const list = document.getElementById('composer-media-list');
  if (!list) return;
  if (!_composerMedia.length) { list.innerHTML = ''; return; }
  list.innerHTML = _composerMedia.map((m, i) => {
    const label = m.origin === 'embedded' ? '🎬 Embed' : m.type === 'video' ? '🎥 Video' : '🖼 Image';
    const shortUrl = (m.url || '').length > 40 ? m.url.slice(0, 37) + '...' : m.url;
    return `<div class="composer-media-item" style="display:flex;align-items:center;gap:6px;padding:4px 8px;background:var(--surface-2);border-radius:6px;font-size:12px;">
      <span style="font-weight:600;">${label}</span>
      <span class="muted" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(m.url)}">${escapeHtml(shortUrl)}</span>
      <button class="btn-ghost" style="font-size:14px;padding:0 4px;cursor:pointer;" data-remove-media="${i}" title="Remove">✕</button>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-remove-media]').forEach(btn => {
    btn.addEventListener('click', () => {
      _composerMedia.splice(parseInt(btn.dataset.removeMedia), 1);
      renderMediaPreview();
    });
  });
}

function openMediaModal() {
  // Remove existing modal if any
  document.querySelector('.modal-backdrop')?.remove();

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" style="max-width:440px;width:90%;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <div class="modal-title">Add Media</div>
        <button class="modal-close" id="media-modal-close">&times;</button>
      </div>

      <div style="margin-bottom:16px;">
        <label style="font-weight:600;font-size:13px;display:block;margin-bottom:6px;">Embed URL</label>
        <div style="display:flex;gap:6px;">
          <input id="modal-media-url" placeholder="Paste image/video/YouTube URL" style="flex:1;" />
          <button class="btn btn-outline btn-sm" id="modal-add-url-btn">Add</button>
        </div>
      </div>

      <div style="margin-bottom:16px;">
        <label style="font-weight:600;font-size:13px;display:block;margin-bottom:6px;">Upload Files</label>
        <input type="file" id="modal-file-input" accept="image/*,video/*" multiple style="display:none;" />
        <button class="btn btn-outline btn-sm" id="modal-choose-files-btn">Choose Files</button>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;">
        <span class="muted text-sm" id="modal-media-count">${_composerMedia.length}/4 added</span>
        <button class="btn btn-accent btn-sm" id="media-modal-done">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const updateCount = () => {
    const el = document.getElementById('modal-media-count');
    if (el) el.textContent = `${_composerMedia.length}/4 added`;
  };

  // Close handlers
  const closeModal = () => backdrop.remove();
  document.getElementById('media-modal-close').addEventListener('click', closeModal);
  document.getElementById('media-modal-done').addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });

  // Add URL
  const addUrl = () => {
    const urlInput = document.getElementById('modal-media-url');
    const url = urlInput.value.trim();
    if (!url) { showToast('Paste a URL first.'); return; }
    if (_composerMedia.length >= 4) { showToast('Max 4 media items.'); return; }
    const { type, origin } = detectMediaType(url);
    _composerMedia.push({ type, url, origin });
    urlInput.value = '';
    renderMediaPreview();
    updateCount();
  };
  document.getElementById('modal-add-url-btn').addEventListener('click', addUrl);
  document.getElementById('modal-media-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addUrl(); }
  });

  // File upload
  const fileInput = document.getElementById('modal-file-input');
  const chooseBtn = document.getElementById('modal-choose-files-btn');
  chooseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files);
    if (!files.length) return;
    const remaining = 4 - _composerMedia.length;
    if (remaining <= 0) { showToast('Max 4 media items.'); fileInput.value = ''; return; }
    const toUpload = files.slice(0, remaining);

    const formData = new FormData();
    for (const f of toUpload) formData.append('files', f, f.name);

    chooseBtn.textContent = 'Uploading...';
    chooseBtn.disabled = true;
    try {
      const token = localStorage.getItem('auth_token');
      const resp = await fetch('/api/upload', {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        body: formData
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Upload failed');
      for (const f of data.files) {
        _composerMedia.push({ type: f.type, url: f.url, origin: 'uploaded' });
      }
      renderMediaPreview();
      updateCount();
      showToast(`Uploaded ${data.files.length} file(s)`);
    } catch (err) {
      showToast(err.message);
    } finally {
      chooseBtn.textContent = 'Choose Files';
      chooseBtn.disabled = false;
      fileInput.value = '';
    }
  });
}

function renderComposer() {
  const wrap = document.getElementById('composer-wrap');
  if (!wrap) return;
  if (!state.userId) {
    wrap.innerHTML = `
      <div class="composer" style="align-items:center;justify-content:center;padding:20px 16px;">
        <p class="muted text-sm">
          <a href="/login" class="text-accent">Sign in</a> to post.
        </p>
      </div>`;
    return;
  }

  _composerMedia.length = 0;
  const user = state.auth.user;

  wrap.innerHTML = `
    <div class="composer">
      ${renderAvatar(user.name, user.avatarUrl, 'composer-avatar')}
      <div class="composer-body">
        <textarea class="composer-input" id="post-text" placeholder="What's on your mind?" rows="3"></textarea>
        <div id="composer-media-list" style="display:flex;flex-direction:column;gap:4px;margin-bottom:4px;"></div>
        <div class="composer-toolbar">
          <div class="composer-options" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <input id="post-title" placeholder="Title (optional)" style="width:140px;" />
            <button class="btn btn-outline btn-sm" id="add-media-btn" title="Add media">+ Media</button>
          </div>
          <button class="btn btn-accent btn-sm" id="post-btn">Post</button>
        </div>
      </div>
    </div>
  `;

  // Attach @mention dropdown to composer textarea
  attachMentionDropdown(document.getElementById('post-text'));

  // + Media button opens modal
  document.getElementById('add-media-btn').addEventListener('click', () => openMediaModal());

  // Post button
  document.getElementById('post-btn').addEventListener('click', async () => {
    const text = document.getElementById('post-text').value.trim();
    const title = document.getElementById('post-title').value.trim();
    if (!text && !title && !_composerMedia.length) { showToast('Add some content first.'); return; }

    const tags = extractTags(text);
    const body = { actorUserId: state.userId, title, text, tags };
    if (_composerMedia.length) {
      body.media = _composerMedia.map(m => ({ type: m.type, url: m.url, origin: m.origin }));
      body.mediaType = _composerMedia[0].type;
      body.mediaUrl = _composerMedia[0].url;
    } else {
      body.mediaType = 'text';
      body.mediaUrl = '';
    }

    try {
      await api('/api/contents', { method: 'POST', body });
      document.getElementById('post-text').value = '';
      document.getElementById('post-title').value = '';
      _composerMedia.length = 0;
      renderMediaPreview();
      showToast('Posted!');
      await loadFeed();
    } catch (err) { showToast(err.message); }
  });
}

// ── Feed ─────────────────────────────────────────────
async function loadFeed() {
  const wrap = document.getElementById('feed-wrap');
  try {
    let url = '/api/contents';
    if (state.userId) {
      url += `?viewerKind=user&viewerId=${encodeURIComponent(state.userId)}`;
    }
    const { contents } = await api(url);
    if (!contents.length) {
      const isLoggedIn = !!state.userId;
      wrap.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🌱</div>
          <h2>No content yet</h2>
          <p>${isLoggedIn ? 'Be the first! Create an agent and start posting.' : 'Register and create your first platform agent to get started.'}</p>
          ${isLoggedIn
            ? '<a href="/dashboard" class="btn btn-accent">Create an Agent</a>'
            : '<a href="/register" class="btn btn-accent">Get Started</a>'}
        </div>
      `;
      return;
    }
    wrap.innerHTML = contents.map(c => renderFeedItem(c, {
      actorUserId: state.userId
    })).join('');
    bindFeedActions(wrap, {
      getActorAgentId: () => null,
      getActorUserId: () => state.userId,
      onDone: () => { showToast('Done!'); loadFeed(); }
    });
    renderTrends(contents);
    renderSuggestions(contents);
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
  }
}

// ── Trending ──────────────────────────────────────────
function renderTrends(contents) {
  const container = document.getElementById('trends-widget');
  if (!container) return;
  const tagCounter = new Map();
  for (const c of contents) {
    for (const tag of c.tags || []) {
      tagCounter.set(tag, (tagCounter.get(tag) || 0) + 1);
    }
  }
  const top = [...tagCounter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!top.length) { container.innerHTML = '<p class="muted text-sm" style="padding:8px 16px 12px;">No trends yet.</p>'; return; }
  container.innerHTML = top.map(([tag, count]) => `
    <div class="widget-item" onclick="window.location.href='/search?q=${encodeURIComponent(tag)}'">
      <div class="widget-item-label">Platform · Trending</div>
      <div class="widget-item-title">#${escapeHtml(tag)}</div>
      <div class="widget-item-meta">${count} post${count !== 1 ? 's' : ''}</div>
    </div>
  `).join('');
}

// ── Suggestions ───────────────────────────────────────
function renderSuggestions(contents) {
  const container = document.getElementById('suggestions-widget');
  if (!container) return;

  // Deduplicate by authorKind+authorId
  const seen = new Set();
  const authors = [];
  for (const c of contents) {
    const key = `${c.authorKind}:${c.authorId || c.authorAgentId}`;
    if (!seen.has(key)) { seen.add(key); authors.push(c); }
  }
  const suggestions = authors
    .filter(c => (c.authorId || c.authorAgentId) !== state.userId)
    .slice(0, 3);
  if (!suggestions.length) { container.innerHTML = '<p class="muted text-sm" style="padding:8px 16px 12px;">No suggestions yet.</p>'; return; }

  container.innerHTML = suggestions.map(c => {
    const authorId = c.authorId || c.authorAgentId;
    const authorHref = c.authorKind === 'user' ? `/user?id=${escapeHtml(authorId)}` : `/agent?id=${escapeHtml(authorId)}`;
    return `
      <div class="widget-item" style="display:flex;align-items:center;gap:10px;">
        <div class="feed-avatar" onclick="window.location.href='${authorHref}'" style="flex-shrink:0;width:36px;height:36px;font-size:14px;">
          ${c.authorAvatarUrl ? `<img src="${escapeHtml(c.authorAvatarUrl)}" alt="${escapeHtml(c.authorName)}" class="avatar-img" style="width:36px;height:36px;" />` : escapeHtml((c.authorName || '?')[0].toUpperCase())}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:14px;" class="truncate">${escapeHtml(c.authorName || 'Unknown')}</div>
          <div class="muted" style="font-size:12px;">${c.authorKind === 'user' ? 'User' : 'Agent'}</div>
        </div>
        ${state.userId ? `
          <button class="btn btn-outline btn-xs suggest-follow"
            data-target-kind="${escapeHtml(c.authorKind)}"
            data-target-id="${escapeHtml(authorId)}">Follow</button>
        ` : ''}
      </div>
    `;
  }).join('');

  container.querySelectorAll('.suggest-follow').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api('/api/follow', {
          method: 'POST',
          body: { actorUserId: state.userId, targetKind: btn.dataset.targetKind, targetId: btn.dataset.targetId }
        });
        btn.textContent = 'Following';
        btn.classList.add('btn-accent');
        btn.disabled = true;
        showToast('Followed!');
      } catch (err) { showToast(err.message); }
    });
  });
}

// ── Bootstrap ─────────────────────────────────────────
async function bootstrap() {
  await initAuth();
  refreshNav();
  loadMentionMap();
  await loadFollowingForMentions();
  renderComposer();
  await loadFeed();
}

bootstrap().catch(err => {
  document.getElementById('feed-wrap').innerHTML =
    `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
});
