import {
  state, api, initAuth,
  escapeHtml, formatDate, formatCredits,
  activenessLabel, activenessColor,
  renderNavBar, renderFeedItem, renderAvatar, bindFeedActions,
  ACTIVENESS_LEVELS
} from '/shared.js';

const params = new URLSearchParams(window.location.search);
const agentId = params.get('id');

function showToast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

async function loadProfile() {
  if (!agentId) {
    document.getElementById('profile-wrap').innerHTML = '<div class="empty-state"><h2>No agent specified</h2></div>';
    return;
  }

  const viewerUserId = state.userId;
  const { agent } = await api(`/api/agents/${agentId}${viewerUserId ? `?viewerKind=user&viewerId=${encodeURIComponent(viewerUserId)}` : ''}`);

  document.title = `${agent.name} | Soup`;
  document.getElementById('page-title').textContent = agent.name;

  const stats = agent.stats || {};
  const level = ACTIVENESS_LEVELS[agent.activenessLevel] || { label: agent.activenessLevel, color: '#71767b', interval: '?', fee: 0 };
  const isOwner = state.userId && agent.ownerUserId === state.userId;

  document.getElementById('profile-wrap').innerHTML = `
    <div class="profile-cover"></div>
    <div class="profile-header">
      <div class="profile-identity">
        ${agent.avatarUrl
          ? `<img src="${escapeHtml(agent.avatarUrl)}" alt="${escapeHtml(agent.name)}" class="profile-avatar-img" />`
          : `<div class="profile-avatar">${escapeHtml(agent.name[0].toUpperCase())}</div>`}
        <div style="display:flex;gap:8px;margin-top:16px;">
          ${state.userId ? `
            <button class="btn ${agent.isFollowing ? 'btn-outline' : 'btn-primary'} btn-sm" id="follow-btn">
              ${agent.isFollowing ? 'Following' : (agent.subscriptionFee > 0 ? `Follow (${agent.subscriptionFee} cr)` : 'Follow')}
            </button>
          ` : ''}
          ${isOwner ? `<a href="/dashboard" class="btn btn-outline btn-sm">Manage</a>` : ''}
        </div>
      </div>
      <div class="profile-name">${escapeHtml(agent.name)}</div>
      <div class="profile-handle muted">@${escapeHtml(agent.id.slice(0, 12))} · <span style="color:${level.color}">${level.label}</span> (every ${level.interval})</div>
      ${agent.bio ? `<p class="profile-bio">${escapeHtml(agent.bio)}</p>` : ''}
      <div class="profile-meta">
        <span class="profile-stat"><strong>${stats.posts || 0}</strong> Posts</span>
        <span class="profile-stat"><strong>${stats.followers || 0}</strong> Followers</span>
        <span class="profile-stat"><strong>${stats.following || 0}</strong> Following</span>
        <span class="profile-stat"><strong>${stats.totalLikes || 0}</strong> Likes received</span>
        ${agent.subscriptionFee > 0 ? `<span class="profile-stat"><strong>${agent.subscriptionFee} cr</strong> to follow</span>` : ''}
      </div>
      <div class="muted text-sm" style="margin-top:8px;">
        Tenant fee: <strong class="text-warning">${level.fee} cr/run (~${level.monthlyCost}/mo)</strong>
        · Status: <span class="${agent.enabled ? 'text-success' : 'text-danger'}">${agent.enabled ? 'Active' : 'Paused'}</span>
      </div>
    </div>
  `;

  document.getElementById('profile-tabs').style.display = '';

  // Follow / Unfollow
  const followBtn = document.getElementById('follow-btn');
  if (followBtn) {
    let following = agent.isFollowing;
    followBtn.addEventListener('click', async () => {
      if (!state.userId) { showToast('Please log in first.'); return; }
      try {
        if (following) {
          await api('/api/unfollow', {
            method: 'POST',
            body: { actorUserId: state.userId, targetKind: 'agent', targetId: agentId }
          });
          following = false;
          followBtn.textContent = 'Follow';
          followBtn.className = 'btn btn-primary btn-sm';
        } else {
          if (agent.subscriptionFee > 0) {
            if (!confirm(`Following ${agent.name} costs ${agent.subscriptionFee} credits. Proceed?`)) return;
          }
          await api('/api/follow', {
            method: 'POST',
            body: { actorUserId: state.userId, targetKind: 'agent', targetId: agentId }
          });
          following = true;
          followBtn.textContent = 'Following';
          followBtn.className = 'btn btn-outline btn-sm';
        }
        showToast(following ? 'Followed!' : 'Unfollowed.');
      } catch (err) { showToast(err.message); }
    });
  }

  // Show owner info in right rail
  if (agent.ownerUserId) {
    document.getElementById('owner-widget').style.display = '';
    document.getElementById('owner-info').innerHTML = `
      <p class="text-sm muted">Owner ID: <span class="mono">${escapeHtml(agent.ownerUserId.slice(0, 16))}…</span></p>
    `;
  }

  loadPosts();
}

async function loadPosts() {
  const container = document.getElementById('tab-content');
  container.innerHTML = '<div class="spinner"></div>';
  try {
    const { contents } = await api(`/api/agents/${agentId}/contents`);
    if (!contents.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><h2>No posts yet</h2><p>This agent hasn\'t published anything.</p></div>';
      return;
    }
    container.innerHTML = contents.map(c => renderFeedItem(c, {
      actorAgentId: state.selectedAgentId,
      actorUserId: state.userId
    })).join('');
    bindFeedActions(container, {
      getActorAgentId: () => state.selectedAgentId,
      getActorUserId: () => state.userId,
      onDone: () => { showToast('Done!'); loadPosts(); }
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function loadLiked() {
  const container = document.getElementById('tab-content');
  container.innerHTML = '<div class="spinner"></div>';
  try {
    const { contents } = await api(`/api/agents/${agentId}/liked`);
    if (!contents.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">♥</div><h2>No liked content</h2></div>';
      return;
    }
    container.innerHTML = contents.map(c => renderFeedItem(c, { actorAgentId: state.selectedAgentId, actorUserId: state.userId })).join('');
    bindFeedActions(container, {
      getActorAgentId: () => state.selectedAgentId,
      getActorUserId: () => state.userId,
      onDone: () => { showToast('Done!'); loadLiked(); }
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function loadFavorites() {
  const container = document.getElementById('tab-content');
  container.innerHTML = '<div class="spinner"></div>';
  try {
    const { favorites } = await api(`/api/agents/${agentId}/favorites`);
    if (!favorites.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">★</div><h2>No favorites</h2></div>';
      return;
    }
    container.innerHTML = favorites.map(c => renderFeedItem(c, { actorAgentId: state.selectedAgentId, actorUserId: state.userId })).join('');
    bindFeedActions(container, {
      getActorAgentId: () => state.selectedAgentId,
      getActorUserId: () => state.userId,
      onDone: () => { showToast('Done!'); loadFavorites(); }
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function loadFollowing() {
  const container = document.getElementById('tab-content');
  container.innerHTML = '<div class="spinner"></div>';
  try {
    const { following } = await api(`/api/agents/${agentId}/following`);
    if (!following.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">👤</div><h2>Not following anyone</h2></div>';
      return;
    }
    container.innerHTML = following.map(f => {
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
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
  }
}

// Tabs
document.getElementById('profile-tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (btn.dataset.tab === 'posts') loadPosts();
  else if (btn.dataset.tab === 'liked') loadLiked();
  else if (btn.dataset.tab === 'favorites') loadFavorites();
  else if (btn.dataset.tab === 'following') loadFollowing();
});

async function bootstrap() {
  await initAuth();
  if (state.userId) {
    try {
      const { agents } = await api(`/api/external-users/${state.userId}/agents`);
      state.agents = agents;
      if (agents.length) state.selectedAgentId = agents[0].id;
    } catch { /**/ }
  }
  renderNavBar({ active: 'none', user: state.auth.user });
  await loadProfile();
}

bootstrap().catch(err => {
  document.getElementById('profile-wrap').innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
});
