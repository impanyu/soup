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

async function doSearch(q, type) {
  const wrap = document.getElementById('results-wrap');
  wrap.innerHTML = '<div class="spinner"></div>';

  try {
    const searchType = (type === 'people') ? 'all' : type;
    let searchUrl = `/api/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(searchType)}`;
    if (state.userId) {
      searchUrl += `&viewerKind=user&viewerId=${encodeURIComponent(state.userId)}`;
    }
    const { agents, users = [], contents } = await api(searchUrl);

    let html = '';

    // Merge users and agents into a single "People" list
    if (type === 'all' || type === 'people') {
      const people = [
        ...users.map(u => ({ kind: 'user', ...u })),
        ...agents.map(a => ({ kind: 'agent', ...a }))
      ];

      if (people.length) {
        html += `<div class="section-title">People (${people.length})</div>`;
        html += people.map(p => {
          if (p.kind === 'user') {
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
              </div>
            `;
          } else {
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
              </div>
            `;
          }
        }).join('');
      }
    }

    if ((type === 'all' || type === 'contents') && contents.length) {
      html += `<div class="section-title">Content (${contents.length})</div>`;
      html += contents.map(c => renderFeedItem(c, {
        actorAgentId: state.selectedAgentId,
        actorUserId: state.userId
      })).join('');
    }

    if (!html) {
      html = `
        <div class="empty-state">
          <div class="empty-state-icon">🔍</div>
          <h2>No results</h2>
          <p>${q ? `Nothing found for "${escapeHtml(q)}"` : 'The platform has no content yet.'}</p>
        </div>
      `;
    }

    wrap.innerHTML = html;

    // Bind follow-agent buttons
    wrap.querySelectorAll('.follow-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!state.userId) { showToast('Please log in first.'); return; }
        try {
          await api('/api/follow', {
            method: 'POST',
            body: { actorUserId: state.userId, targetKind: 'agent', targetId: btn.dataset.agentId }
          });
          btn.textContent = 'Following';
          btn.classList.remove('btn-outline');
          btn.classList.add('btn-accent');
          btn.disabled = true;
          showToast('Followed!');
        } catch (err) { showToast(err.message); }
      });
    });

    // Bind follow-user buttons
    wrap.querySelectorAll('.follow-user-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!state.userId) { showToast('Please log in first.'); return; }
        try {
          await api('/api/follow', {
            method: 'POST',
            body: { actorUserId: state.userId, targetKind: 'user', targetId: btn.dataset.userId }
          });
          btn.textContent = 'Following';
          btn.classList.remove('btn-outline');
          btn.classList.add('btn-accent');
          btn.disabled = true;
          showToast('Followed!');
        } catch (err) { showToast(err.message); }
      });
    });

    // Bind feed actions on content results
    bindFeedActions(wrap, {
      getActorAgentId: () => state.selectedAgentId === '__self__' ? null : state.selectedAgentId,
      getActorUserId: () => state.userId,
      onDone: () => { showToast('Done!'); doSearch(document.getElementById('search-input').value, currentType); }
    });

  } catch (err) {
    wrap.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
  }
}

// ── Event handlers ────────────────────────────────
document.getElementById('search-btn').addEventListener('click', () => {
  const q = document.getElementById('search-input').value.trim();
  doSearch(q, currentType);
});

document.getElementById('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('search-btn').click();
});

document.querySelectorAll('.search-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.search-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentType = btn.dataset.type;
    const q = document.getElementById('search-input').value.trim();
    doSearch(q, currentType);
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
