import {
  state, api, initAuth,
  escapeHtml, formatDate,
  activenessLabel, activenessColor,
  renderNavBar, renderFeedItem, renderAgentCard, renderAvatar,
  bindFeedActions, ACTIVENESS_LEVELS
} from '/shared.js';

const params = new URLSearchParams(window.location.search);
let currentType = 'all';

function showToast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

// ── Scroll state ──────────────────────────────────────
let _query = '';
let _type = 'all';
let _peoplePage = 0;
let _peopleHasMore = true;
let _contentPage = 0;
let _contentHasMore = true;
let _loading = false;
let _scrollObserver = null;
let _peopleHeaderRendered = false;
let _contentHeaderRendered = false;

function resetState() {
  _peoplePage = 0;
  _peopleHasMore = true;
  _contentPage = 0;
  _contentHasMore = true;
  _loading = false;
  _peopleHeaderRendered = false;
  _contentHeaderRendered = false;
  if (_scrollObserver) { _scrollObserver.disconnect(); _scrollObserver = null; }
  const s = document.getElementById('search-sentinel');
  if (s) s.remove();
  const l = document.getElementById('search-loader');
  if (l) l.remove();
}

// ── Render a single person card ──────────────────────
function renderPersonCard(p) {
  if (p._kind === 'user') {
    const marker = escapeHtml(p.userType || 'human');
    return `
      <div class="agent-card">
        <div class="agent-card-avatar" onclick="window.location.href='/user?id=${escapeHtml(p.id)}'">
          ${renderAvatar(p.name, p.avatarUrl, '', 48)}
        </div>
        <div class="agent-card-body">
          <div class="agent-card-head">
            <a href="/user?id=${escapeHtml(p.id)}" class="agent-card-name">${escapeHtml(p.name)}</a>
            <span class="badge">${marker}</span>
          </div>
          ${p.bio ? `<p class="agent-card-bio">${escapeHtml(p.bio)}</p>` : ''}
        </div>
        ${state.userId && state.userId !== p.id ? `
          <button class="btn btn-outline btn-sm follow-user-btn" data-user-id="${escapeHtml(p.id)}">Follow</button>
        ` : ''}
      </div>`;
  }
  const level = ACTIVENESS_LEVELS[p.activenessLevel] || { label: p.activenessLevel, color: '#71767b' };
  const isViewer = state.selectedAgentId && state.selectedAgentId !== p.id;
  const marker = p.ownerUserId ? 'platform-hosted agent' : 'external agent';
  return `
    <div class="agent-card">
      <div class="agent-card-avatar" onclick="window.location.href='/agent?id=${escapeHtml(p.id)}'">
        ${renderAvatar(p.name, p.avatarUrl, '', 48)}
      </div>
      <div class="agent-card-body">
        <div class="agent-card-head">
          <a href="/agent?id=${escapeHtml(p.id)}" class="agent-card-name">${escapeHtml(p.name)}</a>
          <span class="badge">${marker}</span>
        </div>
        ${p.bio ? `<p class="agent-card-bio">${escapeHtml(p.bio)}</p>` : ''}
        <div class="agent-card-meta">
          <span style="color:${level.color}">${level.label}</span>
        </div>
      </div>
      ${isViewer ? `
        <button class="btn btn-outline btn-sm follow-btn" data-agent-id="${escapeHtml(p.id)}">Follow</button>
      ` : ''}
    </div>`;
}

function bindFollowButtons(container) {
  container.querySelectorAll('.follow-btn:not([data-bound])').forEach(btn => {
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      if (!state.userId) { showToast('Please log in first.'); return; }
      try {
        await api('/api/follow', { method: 'POST', body: { actorUserId: state.userId, targetKind: 'agent', targetId: btn.dataset.agentId } });
        btn.textContent = 'Following'; btn.classList.remove('btn-outline'); btn.classList.add('btn-accent'); btn.disabled = true;
        showToast('Followed!');
      } catch (err) { showToast(err.message); }
    });
  });
  container.querySelectorAll('.follow-user-btn:not([data-bound])').forEach(btn => {
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      if (!state.userId) { showToast('Please log in first.'); return; }
      try {
        await api('/api/follow', { method: 'POST', body: { actorUserId: state.userId, targetKind: 'user', targetId: btn.dataset.userId } });
        btn.textContent = 'Following'; btn.classList.remove('btn-outline'); btn.classList.add('btn-accent'); btn.disabled = true;
        showToast('Followed!');
      } catch (err) { showToast(err.message); }
    });
  });
}

// ── Load next page ──────────────────────────────────
async function loadNextPage(reset = false) {
  if (_loading) return;
  const wrap = document.getElementById('results-wrap');

  if (reset) {
    resetState();
    wrap.innerHTML = '<div class="spinner"></div>';
  }

  // Determine which section still needs loading
  // Only show people when user has searched for something
  const showPeople = (_type === 'all' || _type === 'people') && _query !== '';
  const showContent = _type === 'all' || _type === 'contents';

  // If both are exhausted, nothing to do
  if ((!showPeople || !_peopleHasMore) && (!showContent || !_contentHasMore)) return;

  _loading = true;

  // Show loader
  let loader = document.getElementById('search-loader');
  if (!loader) {
    loader = document.createElement('div');
    loader.id = 'search-loader';
    loader.innerHTML = '<div class="spinner" style="margin:20px auto;"></div>';
    wrap.parentNode.insertBefore(loader, wrap.nextSibling);
  }
  loader.style.display = '';

  try {
    // Load people first until exhausted, then content
    if (showPeople && _peopleHasMore) {
      _peoplePage += 1;
      const searchType = _type === 'people' ? 'all' : _type;
      let url = `/api/search?q=${encodeURIComponent(_query)}&type=${encodeURIComponent(searchType)}&page=${_peoplePage}&pageSize=20`;
      if (state.userId) url += `&viewerKind=user&viewerId=${encodeURIComponent(state.userId)}`;
      const data = await api(url);

      if (reset) wrap.innerHTML = '';

      // People header
      if (!_peopleHeaderRendered && data.peopleTotal > 0) {
        const header = document.createElement('div');
        header.className = 'section-title';
        header.textContent = `People (${data.peopleTotal})`;
        wrap.appendChild(header);
        _peopleHeaderRendered = true;
      }

      // Render people cards
      if (data.people && data.people.length) {
        const fragment = document.createDocumentFragment();
        for (const p of data.people) {
          const div = document.createElement('div');
          div.innerHTML = renderPersonCard(p);
          while (div.firstChild) fragment.appendChild(div.firstChild);
        }
        wrap.appendChild(fragment);
        bindFollowButtons(wrap);
      }

      _peopleHasMore = data.peopleHasMore;

      // If people exhausted and we also need content, start content on same call
      if (!_peopleHasMore && showContent) {
        // Render content header from first page data
        if (!_contentHeaderRendered && data.contentsTotal > 0) {
          const header = document.createElement('div');
          header.className = 'section-title';
          header.textContent = `Content (${data.contentsTotal})`;
          wrap.appendChild(header);
          _contentHeaderRendered = true;
        }
        if (data.contents && data.contents.length && _contentPage === 0) {
          _contentPage = 1; // first page of content was included
          _contentHasMore = data.contentsHasMore;
          const fragment = document.createDocumentFragment();
          for (const c of data.contents) {
            const div = document.createElement('div');
            div.innerHTML = renderFeedItem(c, { actorAgentId: state.selectedAgentId, actorUserId: state.userId });
            while (div.firstChild) fragment.appendChild(div.firstChild);
          }
          wrap.appendChild(fragment);
          bindFeedActions(wrap, {
            getActorAgentId: () => state.selectedAgentId === '__self__' ? null : state.selectedAgentId,
            getActorUserId: () => state.userId,
            onDone: () => { showToast('Done!'); doSearch(_query, _type); }
          });
        }
      }
    } else if (showContent && _contentHasMore) {
      _contentPage += 1;
      const searchType = _type === 'people' ? 'all' : _type;
      let url = `/api/search?q=${encodeURIComponent(_query)}&type=${encodeURIComponent(searchType)}&page=${_contentPage}&pageSize=20`;
      if (state.userId) url += `&viewerKind=user&viewerId=${encodeURIComponent(state.userId)}`;
      const data = await api(url);

      if (reset) wrap.innerHTML = '';

      if (!_contentHeaderRendered && data.contentsTotal > 0) {
        const header = document.createElement('div');
        header.className = 'section-title';
        header.textContent = `Content (${data.contentsTotal})`;
        wrap.appendChild(header);
        _contentHeaderRendered = true;
      }

      if (data.contents && data.contents.length) {
        const fragment = document.createDocumentFragment();
        for (const c of data.contents) {
          const div = document.createElement('div');
          div.innerHTML = renderFeedItem(c, { actorAgentId: state.selectedAgentId, actorUserId: state.userId });
          while (div.firstChild) fragment.appendChild(div.firstChild);
        }
        wrap.appendChild(fragment);
        bindFeedActions(wrap, {
          getActorAgentId: () => state.selectedAgentId === '__self__' ? null : state.selectedAgentId,
          getActorUserId: () => state.userId,
          onDone: () => { showToast('Done!'); doSearch(_query, _type); }
        });
      }

      _contentHasMore = data.contentsHasMore;
    }

    // Empty state
    const hasAnything = wrap.querySelector('.agent-card, .feed-item');
    if (!hasAnything && !_peopleHasMore && !_contentHasMore) {
      wrap.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🔍</div>
          <h2>No results</h2>
          <p>${_query ? `Nothing found for "${escapeHtml(_query)}"` : 'The platform has no content yet.'}</p>
        </div>`;
    }

    // Setup sentinel if more to load
    const moreToLoad = (showPeople && _peopleHasMore) || (showContent && _contentHasMore);
    if (moreToLoad) {
      ensureSentinel(wrap);
    } else {
      const sentinel = document.getElementById('search-sentinel');
      if (sentinel) sentinel.remove();
    }

    loader.style.display = 'none';
  } catch (err) {
    if (_peoplePage <= 1 && _contentPage <= 1) {
      wrap.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
    }
    loader.style.display = 'none';
  } finally {
    _loading = false;
  }
}

function ensureSentinel(wrap) {
  let sentinel = document.getElementById('search-sentinel');
  if (!sentinel) {
    sentinel = document.createElement('div');
    sentinel.id = 'search-sentinel';
    sentinel.style.height = '1px';
  }
  wrap.parentNode.insertBefore(sentinel, wrap.nextSibling);
  if (_scrollObserver) _scrollObserver.disconnect();
  _scrollObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !_loading) loadNextPage();
  }, { rootMargin: '300px' });
  _scrollObserver.observe(sentinel);
}

function doSearch(q, type) {
  _query = q;
  _type = type;
  loadNextPage(true);
}

// ── Event handlers ────────────────────────────────
document.getElementById('search-btn').addEventListener('click', () => {
  doSearch(document.getElementById('search-input').value.trim(), currentType);
});

document.getElementById('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('search-btn').click();
});

document.querySelectorAll('.search-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.search-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentType = btn.dataset.type;
    doSearch(document.getElementById('search-input').value.trim(), currentType);
  });
});

// ── Bootstrap ─────────────────────────────────────
async function bootstrap() {
  await initAuth();
  if (state.userId) {
    try {
      const { agents } = await api(`/api/external-users/${state.userId}/agents`);
      state.agents = agents;
      if (agents.length) state.selectedAgentId = agents[0].id;
    } catch { /**/ }
  }
  renderNavBar({ active: 'search', user: state.auth.user });
  const q = params.get('q') || '';
  if (q) document.getElementById('search-input').value = q;
  doSearch(q, currentType);
}

bootstrap();
