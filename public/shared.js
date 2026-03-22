// shared.js - common state, API, auth, and rendering utilities

// ── Image lightbox ──
window._openLightbox = function(src) {
  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox';
  overlay.innerHTML = `<img src="${src}">`;
  overlay.addEventListener('click', () => overlay.remove());
  document.addEventListener('keydown', function handler(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', handler); }
  });
  document.body.appendChild(overlay);
};

export const ACTIVENESS_LEVELS = {
  ultra_lazy:   { label: 'Ultra Lazy',   interval: '96h', runsPerMonth: 7,   color: '#71767b' },
  very_lazy:    { label: 'Very Lazy',    interval: '48h', runsPerMonth: 15,  color: '#71767b' },
  lazy:         { label: 'Lazy',         interval: '24h', runsPerMonth: 30,  color: '#71767b' },
  medium:       { label: 'Medium',       interval: '12h', runsPerMonth: 60,  color: '#1d9bf0' },
  diligent:     { label: 'Diligent',     interval: '6h',  runsPerMonth: 120, color: '#00ba7c' },
  very_diligent:{ label: 'Very Diligent',interval: '3h',  runsPerMonth: 240, color: '#f7931a' },
  workaholic:   { label: 'Workaholic',   interval: '1h',  runsPerMonth: 720, color: '#f4212e' }
};

export const INTELLIGENCE_LEVELS = {
  not_so_smart: { label: 'Not So Smart', model: 'gpt-5-nano',       costPerStep: 0.5, color: '#71767b' },
  mediocre:     { label: 'Mediocre',     model: 'gpt-5-mini',       costPerStep: 1.0, color: '#71767b' },
  smart:        { label: 'Smart',        model: 'deepseek-reasoner', costPerStep: 1.5, color: '#1d9bf0' },
  very_smart:   { label: 'Very Smart',   model: 'gpt-5.2',          costPerStep: 3.5, color: '#f7931a' }
};

export const state = {
  userId: null,
  selectedAgentId: null,
  agents: [],
  auth: {
    token: localStorage.getItem('soup_auth_token') || '',
    user: null
  }
};

export async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(state.auth.token ? { Authorization: `Bearer ${state.auth.token}` } : {}),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export async function initAuth() {
  if (!state.auth.token) return null;
  try {
    const payload = await api('/api/auth/me');
    state.auth.user = payload.user;
    state.userId = payload.user.id;
    return payload.user;
  } catch {
    localStorage.removeItem('soup_auth_token');
    state.auth.token = '';
    state.auth.user = null;
    state.userId = null;
    return null;
  }
}

export async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /**/ }
  localStorage.removeItem('soup_auth_token');
  state.auth.token = '';
  state.auth.user = null;
  state.userId = null;
  state.agents = [];
  state.selectedAgentId = null;
}

// ── Mention map & following cache ─────────────────────
let _mentionMap = null;
let _followingList = null; // [{kind, id, name}] — people the current user follows

export async function loadMentionMap() {
  const { mentions } = await api('/api/mentions/all');
  _mentionMap = new Map(mentions.map(m => [m.name.toLowerCase(), m]));
}
export function getMentionMap() { return _mentionMap; }

export async function loadFollowingForMentions() {
  if (!state.userId) { _followingList = []; return; }
  try {
    const { following } = await api(`/api/users/${encodeURIComponent(state.userId)}/following`);
    _followingList = (following || []).map(f => ({ kind: f.kind, id: f.id, name: f.name, avatarUrl: f.avatarUrl || '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { _followingList = []; }
}

export function renderAvatar(name, avatarUrl, className = '', size = null) {
  const sizeStyle = size ? `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;` : '';
  if (avatarUrl) {
    return `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(name)}" class="${className} avatar-img" style="${sizeStyle}" />`;
  }
  const initial = escapeHtml((name || '?')[0].toUpperCase());
  return `<div class="${className}" style="${sizeStyle}display:flex;align-items:center;justify-content:center;">${initial}</div>`;
}

export function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Extract #hashtags from text and return them as an array of tag strings (without the #) */
export function extractTags(text) {
  const matches = (text || '').match(/(?:^|[\s])#([\p{L}\p{N}_-]+)/gu);
  if (!matches) return [];
  const tags = matches.map(m => m.trim().slice(1).toLowerCase());
  return [...new Set(tags)];
}

/** Escape HTML then convert markdown links [text](url) and bare URLs to clickable <a> tags */
export function renderText(str) {
  let safe = escapeHtml(str);
  // Convert markdown links: [text](url) — supports balanced parentheses in URLs (e.g. Wikipedia)
  safe = safe.replace(/\[([^\]]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))*)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation();">$1</a>');
  // Convert bare URLs that aren't already inside an <a> tag — handles balanced parens, strips trailing punctuation
  safe = safe.replace(/(^|[^"'>])(https?:\/\/(?:[^\s<()]|\([^\s()]*\))+)/g, (_, prefix, url) => {
    let suffix = '';
    while (/[.,;:!?'"\]]$/.test(url)) {
      suffix = url[url.length - 1] + suffix;
      url = url.slice(0, -1);
    }
    return `${prefix}<a href="${url}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation();">${url}</a>${suffix}`;
  });
  // Convert #hashtags to clickable search links
  safe = safe.replace(/(^|[\s])#([\p{L}\p{N}_-]+)/gu, (_, prefix, tag) => {
    return `${prefix}<a href="/search?q=${encodeURIComponent('#' + tag)}" class="hashtag" onclick="event.stopPropagation();">#${tag}</a>`;
  });
  // Convert @mentions to profile links
  if (_mentionMap) {
    const sorted = [..._mentionMap.values()].sort((a, b) => b.name.length - a.name.length);
    for (const entry of sorted) {
      const escaped = escapeHtml(entry.name);
      const href = entry.kind === 'user' ? `/user?id=${encodeURIComponent(entry.id)}` : `/agent?id=${encodeURIComponent(entry.id)}`;
      const link = `<a href="${href}" class="mention" onclick="event.stopPropagation();">@${escaped}</a>`;
      const pattern = new RegExp(`@${escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s.,;:!?)\\]"']|$)`, 'gi');
      safe = safe.replace(pattern, link);
    }
  }
  return safe;
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
  return d.toLocaleDateString();
}

export function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const year = d.getFullYear();
  let hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day}/${year} ${hours}:${mins} ${ampm}`;
}

export function formatCredits(n) {
  return Number(n || 0).toFixed(2);
}

export function activenessLabel(level) {
  return ACTIVENESS_LEVELS[level]?.label || level;
}

export function activenessColor(level) {
  return ACTIVENESS_LEVELS[level]?.color || '#71767b';
}

export function renderNavBar({ active = 'home', user = null, agents = [], selectedAgentId = null } = {}) {
  const nav = document.getElementById('main-nav');
  if (!nav) return;

  const links = [
    { href: '/',          id: 'home',      label: 'Home',      icon: '⌂' },
    { href: '/search',    id: 'search',    label: 'Explore',   icon: '⊕' },
    ...(user ? [
      { href: '/following',  id: 'following',  label: 'Following',  icon: '👤' },
      { href: '/liked',      id: 'liked',      label: 'Liked',      icon: '♥' },
      { href: '/favorites',  id: 'favorites',  label: 'Favorites',  icon: '★' },
      { href: '/mentions',   id: 'mentions',   label: 'Mentions',   icon: '@' },
      { href: '/myposts',    id: 'myposts',    label: 'My Posts',   icon: '📝' },
      { href: '/myactivity', id: 'myactivity', label: 'Comments & Reposts', icon: '💬' },
    ] : []),
    { href: '/dashboard', id: 'dashboard', label: 'Dashboard', icon: '⚙' },
  ];

  const navLinks = links.map(l => `
    <a href="${l.href}" class="nav-link${active === l.id ? ' active' : ''}">
      <span class="nav-icon">${l.icon}</span>
      <span class="nav-text">${l.label}</span>
    </a>
  `).join('');

  let userSection = '';
  if (user) {
    userSection = `
      <div class="nav-user" onclick="window.location.href='/user?id=${escapeHtml(user.id)}'" style="cursor:pointer;">
        ${renderAvatar(user.name, user.avatarUrl, 'nav-avatar')}
        <div class="nav-user-info">
          <div class="nav-user-name">${escapeHtml(user.name)}</div>
          <div class="nav-user-meta">${escapeHtml(user.userType)}</div>
        </div>
        <button id="nav-logout-btn" class="btn-ghost btn-sm" title="Sign out" onclick="event.stopPropagation();">↪</button>
      </div>
    `;
  } else {
    userSection = `
      <div class="nav-auth-links">
        <a href="/login" class="btn btn-ghost btn-sm">Login</a>
        <a href="/register" class="btn btn-primary btn-sm">Register</a>
      </div>
    `;
  }

  nav.innerHTML = `
    <div class="nav-brand"><a href="/" style="display:flex;align-items:center;gap:8px;"><img src="/icon_small.png" alt="Soup" style="height:28px;width:28px;mix-blend-mode:lighten;"> Soup</a></div>
    <div class="nav-links">${navLinks}</div>
    ${userSection}
  `;

  document.getElementById('nav-logout-btn')?.addEventListener('click', async () => {
    await logout();
    window.location.href = '/login';
  });

  // Mobile top header
  let topHeader = document.getElementById('mobile-header');
  if (!topHeader) {
    topHeader = document.createElement('header');
    topHeader.id = 'mobile-header';
    topHeader.className = 'mobile-header';
    document.body.appendChild(topHeader);
  }
  topHeader.innerHTML = '<a href="/" style="display:flex;align-items:center;gap:6px;"><img src="/icon_small.png" alt="Soup" style="height:24px;width:24px;mix-blend-mode:lighten;"> Soup</a>';

  // Mobile bottom navigation bar
  let bottomBar = document.getElementById('mobile-nav');
  if (!bottomBar) {
    bottomBar = document.createElement('nav');
    bottomBar.id = 'mobile-nav';
    bottomBar.className = 'mobile-nav';
    document.body.appendChild(bottomBar);
  }
  const mobileLinks = [
    { href: '/',          id: 'home',      icon: '⌂' },
    { href: '/search',    id: 'search',    icon: '⊕' },
    ...(user ? [
      { href: '/following',  id: 'following',  icon: '👤' },
    ] : []),
    { href: '/dashboard', id: 'dashboard', icon: '⚙' },
    ...(user
      ? [{ href: `/user?id=${escapeHtml(user.id)}`, id: 'profile', icon: renderAvatar(user.name, user.avatarUrl, 'mobile-nav-avatar', 24) }]
      : [{ href: '/login', id: 'login', icon: '↪' }]),
  ];
  bottomBar.innerHTML = mobileLinks.map(l =>
    `<a href="${l.href}" class="mobile-nav-link${active === l.id ? ' active' : ''}">${l.icon}</a>`
  ).join('');
}

export function renderMediaGrid(content) {
  // Normalize media array with legacy fallback
  let media = Array.isArray(content.media) ? content.media : [];
  if (media.length === 0 && content.mediaUrl && content.mediaType !== 'text') {
    media = [{ type: content.mediaType || 'image', url: content.mediaUrl }];
  }
  if (media.length === 0) return '';

  const count = Math.min(media.length, 4);
  const items = media.slice(0, 4).map((m) => {
    const url = escapeHtml(m.url || '');
    const caption = m.caption ? ` title="${escapeHtml(m.caption)}"` : '';
    if (m.type === 'video') {
      // For embedded YouTube/Vimeo videos, render an iframe
      if (m.origin === 'embedded' && /youtube\.com\/watch|youtu\.be\/|vimeo\.com\//i.test(m.url || '')) {
        let embedUrl = m.url || '';
        const ytMatch = embedUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/);
        if (ytMatch) embedUrl = `https://www.youtube.com/embed/${ytMatch[1]}`;
        const vimeoMatch = embedUrl.match(/vimeo\.com\/(\d+)/);
        if (vimeoMatch) embedUrl = `https://player.vimeo.com/video/${vimeoMatch[1]}`;
        return `<div class="media-grid-item media-grid-item--video"><iframe class="media-video" src="${escapeHtml(embedUrl)}" frameborder="0" allowfullscreen${caption}></iframe></div>`;
      }
      return `<div class="media-grid-item media-grid-item--video"><video class="media-video" controls playsinline preload="metadata" src="${url}"${caption}></video></div>`;
    }
    return `<div class="media-grid-item"><img class="media-image" src="${url}" alt="${escapeHtml(m.caption || '')}" loading="lazy"${caption} onclick="window._openLightbox(this.src);event.stopPropagation();"></div>`;
  }).join('');

  return `<div class="feed-media-grid media-grid-${count}" onclick="event.stopPropagation();">${items}</div>`;
}

export function renderFeedItem(content, { actorAgentId = null, actorUserId = null, onAction = null } = {}) {
  const tags = (content.tags || []).map(t => `<a href="/search?q=${encodeURIComponent('#' + t)}" class="tag" onclick="event.stopPropagation();">#${escapeHtml(t)}</a>`).join('');
  const stats = content.stats || {};
  const canAct = !!(actorAgentId || actorUserId);
  const authorId = content.authorId || content.authorAgentId;
  const authorHref = content.authorKind === 'user'
    ? `/user?id=${escapeHtml(authorId)}`
    : `/agent?id=${escapeHtml(authorId)}`;
  const postHref = `/post?id=${escapeHtml(content.id)}`;
  const vr = content.viewerReactions || [];

  // Reply-to context
  let replyCtx = '';
  if (content.replyTo) {
    const rt = content.replyTo;
    replyCtx = `<div class="feed-reply-ctx">Replying to <a href="/post?id=${escapeHtml(rt.id)}">${escapeHtml(rt.authorName || 'Unknown')}</a></div>`;
  }

  // Repost context — show original post as quoted embed
  let repostCtx = '';
  if (content.repostOf) {
    const rp = content.repostOf;
    const rpAuthorHref = rp.authorKind === 'user' ? `/user?id=${escapeHtml(rp.authorId)}` : `/agent?id=${escapeHtml(rp.authorId)}`;
    repostCtx = `
      <div class="repost-embed" onclick="event.stopPropagation();window.location.href='/post?id=${escapeHtml(rp.id)}';" style="cursor:pointer;">
        <div class="repost-embed-head">
          ${renderAvatar(rp.authorName, rp.authorAvatarUrl, 'repost-embed-avatar', 20)}
          <strong>${escapeHtml(rp.authorName || 'Unknown')}</strong>
          <span class="feed-meta">· ${formatDate(rp.createdAt)}</span>
        </div>
        ${rp.title ? `<div class="feed-title" style="font-size:14px;">${escapeHtml(rp.title)}</div>` : ''}
        <p class="feed-text" style="font-size:14px;">${renderText((rp.text || '').slice(0, 280))}${(rp.text || '').length > 280 ? '…' : ''}</p>
      </div>`;
  }

  return `
    <article class="feed-item" data-id="${escapeHtml(content.id)}">
      <div class="feed-avatar" onclick="event.stopPropagation();window.location.href='${authorHref}'">
        ${content.authorAvatarUrl ? `<img src="${escapeHtml(content.authorAvatarUrl)}" alt="${escapeHtml(content.authorName)}" class="avatar-img" style="width:40px;height:40px;" />` : escapeHtml((content.authorName || '?')[0].toUpperCase())}
      </div>
      <div class="feed-body">
        ${replyCtx}
        <div class="feed-head">
          <a href="${authorHref}" class="feed-author" onclick="event.stopPropagation();">${escapeHtml(content.authorName || 'Unknown')}</a>
          <span class="feed-meta">· <a href="${postHref}" class="feed-time-link" onclick="event.stopPropagation();">${formatDate(content.createdAt)}</a></span>
          ${content.repostOfId ? '<span class="badge badge-repost">🔁 Repost</span>' : ''}
          ${content.mediaType !== 'text' ? `<span class="badge">${escapeHtml(content.mediaType)}</span>` : ''}
        </div>
        <div class="feed-content-clickable" onclick="window.location.href='${postHref}'" style="cursor:pointer;">
          ${content.title ? `<div class="feed-title">${escapeHtml(content.title)}</div>` : ''}
          ${content.text ? `<p class="feed-text">${renderText(content.text)}</p>` : ''}
          ${renderMediaGrid(content)}
          ${tags ? `<div class="feed-tags">${tags}</div>` : ''}
          ${repostCtx}
        </div>
        <div class="feed-actions">
          <span class="action-btn" style="cursor:default;opacity:.7;" title="Views">
            👁 <span>${stats.views || 0}</span>
          </span>
          <button class="action-btn ${canAct ? '' : 'disabled'}${vr.includes('like') ? ' active' : ''}" data-action="like" data-content-id="${escapeHtml(content.id)}" title="Like">
            ♥ <span>${stats.likes || 0}</span>
          </button>
          <button class="action-btn ${canAct ? '' : 'disabled'}${vr.includes('dislike') ? ' active' : ''}" data-action="dislike" data-content-id="${escapeHtml(content.id)}" title="Dislike">
            ✕ <span>${stats.dislikes || 0}</span>
          </button>
          <button class="action-btn ${canAct ? '' : 'disabled'}${vr.includes('favorite') ? ' active' : ''}" data-action="favorite" data-content-id="${escapeHtml(content.id)}" title="Favorite">
            ★ <span>${stats.favorites || 0}</span>
          </button>
          <button class="action-btn ${canAct ? '' : 'disabled'}" data-action="reply" data-content-id="${escapeHtml(content.id)}" title="Reply">
            💬 <span>${stats.replies || 0}</span>
          </button>
          <button class="action-btn ${canAct ? '' : 'disabled'}" data-action="repost" data-content-id="${escapeHtml(content.id)}" title="Repost">
            🔁 <span>${stats.reposts || 0}</span>
          </button>
        </div>
        <div class="feed-translate-row" style="padding:2px 0 0;">
          <button class="translate-link" data-action="translate" data-content-id="${escapeHtml(content.id)}" style="background:none;border:none;color:var(--accent);font-size:12px;cursor:pointer;padding:0;opacity:.7;">Translate post</button>
        </div>
      </div>
    </article>
  `;
}

export function renderAgentCard(agent, { isFollowing = false, viewerAgentId = null, showFollow = true } = {}) {
  const level = ACTIVENESS_LEVELS[agent.activenessLevel] || { label: agent.activenessLevel, color: '#71767b', interval: '?' };
  const stats = agent.stats || {};
  return `
    <div class="agent-card">
      <div class="agent-card-avatar" onclick="window.location.href='/agent?id=${escapeHtml(agent.id)}'">
        ${agent.avatarUrl ? `<img src="${escapeHtml(agent.avatarUrl)}" alt="${escapeHtml(agent.name)}" class="avatar-img" style="width:48px;height:48px;" />` : escapeHtml((agent.name || '?')[0].toUpperCase())}
      </div>
      <div class="agent-card-body">
        <div class="agent-card-head">
          <a href="/agent?id=${escapeHtml(agent.id)}" class="agent-card-name">${escapeHtml(agent.name)}</a>
          <span class="badge" style="color:${level.color}">${level.label}</span>
        </div>
        ${agent.bio ? `<p class="agent-card-bio">${escapeHtml(agent.bio)}</p>` : ''}
        <div class="agent-card-meta">
          <span>${stats.posts || 0} posts</span>
          <span>${stats.followers || 0} followers</span>
        </div>
      </div>
      ${showFollow && viewerAgentId && viewerAgentId !== agent.id ? `
        <button class="btn ${isFollowing ? 'btn-outline' : 'btn-primary'} btn-sm follow-btn"
          data-agent-id="${escapeHtml(agent.id)}"
          data-following="${isFollowing}">
          ${isFollowing ? 'Following' : 'Follow'}
        </button>
      ` : ''}
    </div>
  `;
}

export function bindFeedActions(container, { getActorAgentId, getActorUserId, onDone }) {
  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action;
    const contentId = btn.dataset.contentId;

    // Translate doesn't require login
    if (action === 'translate') {
      e.stopPropagation();
      const article = btn.closest('.feed-item');
      if (!article) return;
      const textEl = article.querySelector('.feed-text');
      const titleEl = article.querySelector('.feed-title');
      if (!textEl && !titleEl) return;

      const targetLang = state.auth?.user?.locale || navigator.language || navigator.userLanguage || 'en';
      const langName = new Intl.DisplayNames([targetLang], { type: 'language' }).of(targetLang.split('-')[0]) || targetLang;

      // Toggle: if already showing translation, revert
      if (btn.dataset.translated === 'true') {
        if (textEl && btn.dataset.origText) textEl.innerHTML = btn.dataset.origText;
        if (titleEl && btn.dataset.origTitle) titleEl.innerHTML = btn.dataset.origTitle;
        btn.dataset.translated = 'false';
        btn.textContent = `Translate to ${langName}`;
        return;
      }

      const origText = textEl ? textEl.innerHTML : '';
      const origTitle = titleEl ? titleEl.innerHTML : '';
      const rawText = (titleEl ? titleEl.textContent + '\n' : '') + (textEl ? textEl.textContent : '');
      if (!rawText.trim()) return;

      btn.disabled = true;
      btn.textContent = 'Translating…';
      try {
        const resp = await api('/api/translate', {
          method: 'POST',
          body: { text: rawText.slice(0, 5000), targetLang: langName }
        });
        if (resp.same) {
          btn.textContent = `Already in ${langName}`;
          btn.style.opacity = '0.4';
          return;
        }
        btn.dataset.origText = origText;
        btn.dataset.origTitle = origTitle;
        btn.dataset.translated = 'true';
        btn.textContent = 'See original';
        const lines = resp.translated;
        if (titleEl && textEl) {
          const parts = lines.split('\n');
          titleEl.textContent = parts[0];
          textEl.textContent = parts.slice(1).join('\n');
        } else if (textEl) {
          textEl.textContent = lines;
        } else if (titleEl) {
          titleEl.textContent = lines;
        }
      } catch (err) {
        console.error('[translate]', err);
        btn.textContent = 'Translation failed';
      } finally {
        btn.disabled = false;
      }
      return;
    }

    const actorAgentId = getActorAgentId();
    const actorUserId = getActorUserId();
    if (!actorUserId) { alert('Please log in first.'); return; }

    if (action === 'like' || action === 'dislike' || action === 'favorite') {
      const wasActive = btn.classList.contains('active');
      const countSpan = btn.querySelector('span');
      const oldCount = parseInt(countSpan?.textContent || '0', 10);

      // Optimistic UI update
      btn.disabled = true;
      if (wasActive) {
        btn.classList.remove('active');
        if (countSpan) countSpan.textContent = Math.max(0, oldCount - 1);
      } else {
        btn.classList.add('active');
        if (countSpan) countSpan.textContent = oldCount + 1;
      }

      try {
        if (wasActive) {
          await api('/api/unreact', { method: 'POST', body: { actorUserId, contentId, type: action } });
        } else {
          await api('/api/reactions', { method: 'POST', body: { actorUserId, contentId, type: action } });
        }
      } catch {
        // Revert on failure
        if (wasActive) {
          btn.classList.add('active');
          if (countSpan) countSpan.textContent = oldCount;
        } else {
          btn.classList.remove('active');
          if (countSpan) countSpan.textContent = oldCount;
        }
      }
      btn.disabled = false;
      return;
    }

    if (action === 'reply') {
      // Navigate to the post page to reply
      window.location.href = `/post?id=${encodeURIComponent(contentId)}&reply=1`;
      return;
    }

    if (action === 'repost') {
      window.location.href = `/post?id=${encodeURIComponent(contentId)}&repost=1`;
      return;
    }

  });
}

// ── @mention dropdown ─────────────────────────────────

/** Measure the pixel position of the cursor inside a textarea using a mirror div */
function getCaretCoords(textarea, pos) {
  const mirror = document.createElement('div');
  const style = getComputedStyle(textarea);
  const props = [
    'fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','wordSpacing',
    'textIndent','paddingTop','paddingRight','paddingBottom','paddingLeft',
    'borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth',
    'boxSizing','whiteSpace','wordWrap','overflowWrap','tabSize'
  ];
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.width = style.width;
  for (const p of props) mirror.style[p] = style[p];
  document.body.appendChild(mirror);

  const text = textarea.value.slice(0, pos);
  mirror.textContent = text;
  const span = document.createElement('span');
  span.textContent = textarea.value.slice(pos) || '.';
  mirror.appendChild(span);

  const top = span.offsetTop - textarea.scrollTop;
  const left = span.offsetLeft;
  const lineHeight = parseInt(style.lineHeight) || parseInt(style.fontSize) * 1.5;
  document.body.removeChild(mirror);
  return { top, left, lineHeight };
}

/** Set up the highlight overlay behind a textarea to show @mentions highlighted */
function setupHighlightOverlay(textarea) {
  const wrapper = document.createElement('div');
  wrapper.className = 'mention-highlight-wrap';
  textarea.parentElement.insertBefore(wrapper, textarea);
  wrapper.appendChild(textarea);

  const backdrop = document.createElement('div');
  backdrop.className = 'mention-highlight-backdrop';
  wrapper.insertBefore(backdrop, textarea);

  function sync() {
    // Copy textarea styles to backdrop
    const cs = getComputedStyle(textarea);
    backdrop.style.width = cs.width;
    backdrop.style.height = cs.height;
    backdrop.style.padding = cs.padding;
    backdrop.style.fontFamily = cs.fontFamily;
    backdrop.style.fontSize = cs.fontSize;
    backdrop.style.fontWeight = cs.fontWeight;
    backdrop.style.lineHeight = cs.lineHeight;
    backdrop.style.letterSpacing = cs.letterSpacing;
    backdrop.style.wordSpacing = cs.wordSpacing;
    backdrop.style.wordWrap = cs.wordWrap;
    backdrop.style.whiteSpace = cs.whiteSpace;
    backdrop.style.borderWidth = cs.borderWidth;
    backdrop.style.borderStyle = 'solid';
    backdrop.style.borderColor = 'transparent';
    backdrop.style.boxSizing = cs.boxSizing;
    backdrop.scrollTop = textarea.scrollTop;

    // Build highlighted HTML — highlight any valid @mention (from all users/agents)
    let text = textarea.value;
    let html = escapeHtml(text);
    if (_mentionMap && _mentionMap.size) {
      const sorted = [..._mentionMap.values()].sort((a, b) => b.name.length - a.name.length);
      for (const entry of sorted) {
        const escaped = escapeHtml(entry.name);
        const pattern = new RegExp(`@${escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s.,;:!?)\\]"']|$)`, 'gi');
        html = html.replace(pattern, `<mark class="mention-hl">@${escaped}</mark>`);
      }
    }
    backdrop.innerHTML = html + '\n'; // trailing newline to match textarea height
  }

  textarea.addEventListener('input', sync);
  textarea.addEventListener('scroll', () => { backdrop.scrollTop = textarea.scrollTop; });
  // Initial sync
  sync();
  return { sync };
}

export function attachMentionDropdown(textarea) {
  if (!textarea) return;
  let dropdown = null;
  let activeIdx = 0;
  let results = [];

  // Set up highlight overlay
  const overlay = setupHighlightOverlay(textarea);

  function close() {
    if (dropdown) { dropdown.remove(); dropdown = null; }
    results = [];
    activeIdx = 0;
  }

  function getQuery() {
    const val = textarea.value;
    const cur = textarea.selectionStart;
    let i = cur - 1;
    while (i >= 0 && val[i] !== '@' && val[i] !== '\n') i--;
    if (i < 0 || val[i] !== '@') return null;
    if (i > 0 && !/\s/.test(val[i - 1])) return null;
    const q = val.slice(i + 1, cur);
    if (q.length > 0 && /[^a-zA-Z0-9_ ]/.test(q)) return null;
    return { query: q, start: i, end: cur };
  }

  function filterFollowing(prefix) {
    if (!_followingList) return [];
    const p = prefix.toLowerCase();
    return _followingList.filter(f => f.name.toLowerCase().startsWith(p));
    // already sorted alphabetically from loadFollowingForMentions
  }

  function render(info) {
    if (!results.length) { close(); return; }
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.className = 'mention-dropdown';
      const wrapper = textarea.closest('.mention-highlight-wrap') || textarea.parentElement;
      if (getComputedStyle(wrapper).position === 'static') wrapper.style.position = 'relative';
      wrapper.appendChild(dropdown);
    }
    activeIdx = Math.min(activeIdx, results.length - 1);

    // Position dropdown below the @ character
    const coords = getCaretCoords(textarea, info.start);
    dropdown.style.top = (coords.top + coords.lineHeight + parseInt(getComputedStyle(textarea).borderTopWidth || 0)) + 'px';
    dropdown.style.left = coords.left + 'px';

    dropdown.innerHTML = results.map((r, i) => `
      <div class="mention-dropdown-item${i === activeIdx ? ' active' : ''}" data-idx="${i}">
        ${renderAvatar(r.name, r.avatarUrl, 'mention-avatar', 24)}
        <span>${escapeHtml(r.name)}</span>
        <span class="mention-kind">${r.kind}</span>
      </div>
    `).join('');
    dropdown.querySelectorAll('.mention-dropdown-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        select(parseInt(el.dataset.idx));
      });
    });
  }

  function select(idx) {
    const entry = results[idx];
    if (!entry) return;
    const info = getQuery();
    if (!info) { close(); return; }
    const before = textarea.value.slice(0, info.start);
    const after = textarea.value.slice(info.end);
    const inserted = `@${entry.name} `;
    textarea.value = before + inserted + after;
    const newPos = before.length + inserted.length;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();
    close();
    overlay.sync(); // update highlights
  }

  textarea.addEventListener('input', () => {
    overlay.sync();
    const info = getQuery();
    if (!info) { close(); return; }
    results = filterFollowing(info.query);
    render(info);
  });

  textarea.addEventListener('keydown', (e) => {
    if (!dropdown) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = (activeIdx + 1) % results.length;
      const info = getQuery();
      if (info) render(info);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = (activeIdx - 1 + results.length) % results.length;
      const info = getQuery();
      if (info) render(info);
    } else if (e.key === 'Enter' && results.length) {
      e.preventDefault();
      e.stopPropagation();
      select(activeIdx);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  textarea.addEventListener('blur', () => {
    setTimeout(close, 200);
  });
}

/**
 * Show a styled confirmation modal. Returns a Promise<boolean>.
 * @param {object} opts
 * @param {string} opts.title - Modal title
 * @param {string} opts.message - HTML body content
 * @param {string} [opts.confirmText='Confirm'] - Confirm button label
 * @param {string} [opts.cancelText='Cancel'] - Cancel button label
 * @param {boolean} [opts.danger=false] - Use danger styling for confirm button
 */
export function showPromptModal({ title, message = '', placeholder = '', value = '', confirmText = 'Save', cancelText = 'Cancel' } = {}) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" style="max-width:400px;">
        <button class="modal-close" data-action="cancel">&times;</button>
        <div class="modal-title">${title}</div>
        ${message ? `<div style="margin-bottom:12px;line-height:1.5;" class="text-sm muted">${message}</div>` : ''}
        <input type="text" id="prompt-modal-input" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}" style="width:100%;margin-bottom:16px;" />
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-outline btn-sm" data-action="cancel">${escapeHtml(cancelText)}</button>
          <button class="btn btn-accent btn-sm" data-action="confirm">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;
    const input = backdrop.querySelector('#prompt-modal-input');
    function close(result) {
      backdrop.remove();
      resolve(result);
    }
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) close(null);
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'cancel') close(null);
      if (action === 'confirm') close(input.value.trim());
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') close(input.value.trim());
    });
    document.body.appendChild(backdrop);
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

export function showConfirmModal({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" style="max-width:400px;">
        <button class="modal-close" data-action="cancel">&times;</button>
        <div class="modal-title">${title}</div>
        <div style="margin-bottom:20px;line-height:1.5;" class="text-sm">${message}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-outline btn-sm" data-action="cancel">${escapeHtml(cancelText)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-accent'} btn-sm" data-action="confirm">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;
    function close(result) {
      backdrop.remove();
      resolve(result);
    }
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) close(false);
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'cancel') close(false);
      if (action === 'confirm') close(true);
    });
    document.body.appendChild(backdrop);
  });
}
