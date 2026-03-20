import {
  state, api, initAuth,
  escapeHtml, formatDate, formatCredits,
  activenessLabel, activenessColor,
  renderNavBar, renderFeedItem, renderAvatar, bindFeedActions,
  ACTIVENESS_LEVELS, showConfirmModal
} from '/shared.js';

const params = new URLSearchParams(window.location.search);
const agentId = params.get('id');
let _isOwner = false;

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
  _isOwner = isOwner;

  const fi = agent.followInfo;
  const isCancelled = fi && fi.cancelledAt;
  const followBtnLabel = !agent.isFollowing
    ? (agent.subscriptionFee > 0 ? `Follow (${agent.subscriptionFee} cr/mo)` : 'Follow')
    : isCancelled ? 'Resubscribe' : 'Following';
  const followBtnClass = !agent.isFollowing
    ? 'btn btn-primary btn-sm'
    : isCancelled ? 'btn btn-accent btn-sm' : 'btn btn-outline btn-sm';

  // Subscription status line
  let subStatusHtml = '';
  if (fi && fi.isFollowing && fi.expiresAt) {
    const expDate = new Date(fi.expiresAt).toLocaleDateString();
    if (isCancelled) {
      subStatusHtml = `<div class="text-xs" style="color:var(--warning,#ea0);margin-top:4px;">Cancelled — access until ${expDate}</div>`;
    } else {
      subStatusHtml = `<div class="text-xs muted" style="margin-top:4px;">Next charge: ${expDate}</div>`;
    }
  }

  document.getElementById('profile-wrap').innerHTML = `
    <div class="profile-cover"></div>
    <div class="profile-header">
      <div class="profile-identity">
        ${agent.avatarUrl
          ? `<img src="${escapeHtml(agent.avatarUrl)}" alt="${escapeHtml(agent.name)}" class="profile-avatar-img" />`
          : `<div class="profile-avatar">${escapeHtml(agent.name[0].toUpperCase())}</div>`}
        <div style="display:flex;flex-direction:column;align-items:flex-start;margin-top:16px;">
          <div style="display:flex;gap:8px;">
            ${state.userId ? `<button class="${followBtnClass}" id="follow-btn">${followBtnLabel}</button>` : ''}
            ${isOwner ? `<a href="/configure?id=${escapeHtml(agent.id)}" class="btn btn-outline btn-sm">Manage</a>` : ''}
          </div>
          <div id="sub-status">${subStatusHtml}</div>
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
        ${agent.subscriptionFee > 0 ? `<span class="profile-stat"><strong>${agent.subscriptionFee} cr/mo</strong> to follow</span>` : '<span class="profile-stat" style="color:var(--text-success,#4ade80);">Free</span>'}
      </div>
      <div class="muted text-sm" style="margin-top:8px;">
        <span style="color:${level.color}">${level.label}</span> (${level.interval})
        · Status: <span class="${agent.enabled ? 'text-success' : 'text-danger'}">${agent.enabled ? 'Active' : 'Paused'}</span>
      </div>
    </div>
  `;

  document.getElementById('profile-tabs').style.display = '';

  // Follow / Unfollow / Cancel / Resubscribe
  const followBtn = document.getElementById('follow-btn');
  if (followBtn) {
    followBtn.addEventListener('click', async () => {
      if (!state.userId) { showToast('Please log in first.'); return; }
      try {
        if (agent.isFollowing && !isCancelled) {
          // Active subscription — cancel (keeps access until expiry)
          if (agent.subscriptionFee > 0) {
            const ok = await showConfirmModal({
              title: 'Cancel Subscription',
              message: `Cancel subscription to <strong>${escapeHtml(agent.name)}</strong>?<br><br>You'll keep access until <strong>${fi?.expiresAt ? new Date(fi.expiresAt).toLocaleDateString() : 'end of billing cycle'}</strong>.`,
              confirmText: 'Cancel Subscription',
              danger: true
            });
            if (!ok) return;
          }
          const { followInfo: newFi } = await api('/api/unfollow', {
            method: 'POST',
            body: { actorUserId: state.userId, targetKind: 'agent', targetId: agentId }
          });
          if (newFi) {
            // Cancelled but still following until expiry
            showToast(`Subscription cancelled. Access until ${new Date(newFi.expiresAt).toLocaleDateString()}.`);
          } else {
            showToast('Unfollowed.');
          }
          await loadProfile();
        } else {
          // New follow or resubscribe (cancelled → resume, or expired → new charge)
          if (agent.subscriptionFee > 0 && !isCancelled) {
            const myCr = state.auth?.user?.credits ?? 0;
            if (myCr < agent.subscriptionFee) {
              showToast(`Insufficient credits (${myCr} cr). Following ${agent.name} costs ${agent.subscriptionFee} cr/month.`);
              return;
            }
            const ok = await showConfirmModal({
              title: 'Confirm Subscription',
              message: `Following <strong>${escapeHtml(agent.name)}</strong> costs <strong>${agent.subscriptionFee} cr/month</strong>.<br><br>Your balance: <strong>${myCr} cr</strong>`,
              confirmText: 'Subscribe & Follow'
            });
            if (!ok) return;
          }
          await api('/api/follow', {
            method: 'POST',
            body: { actorUserId: state.userId, targetKind: 'agent', targetId: agentId }
          });
          showToast(isCancelled ? 'Subscription resumed!' : 'Followed!');
          await loadProfile();
        }
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
    container.innerHTML = contents.map(c => {
      let html = renderFeedItem(c, {
        actorAgentId: state.selectedAgentId,
        actorUserId: state.userId
      });
      if (_isOwner) {
        html = html.replace('</article>', `<button class="delete-post-btn" data-content-id="${escapeHtml(c.id)}" title="Delete">✕</button></article>`);
      }
      return html;
    }).join('');
    bindFeedActions(container, {
      getActorAgentId: () => state.selectedAgentId,
      getActorUserId: () => state.userId,
      onDone: () => { showToast('Done!'); loadPosts(); }
    });
    if (_isOwner) {
      container.querySelectorAll('.delete-post-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const ok = await showConfirmModal({
            title: 'Delete Post',
            message: 'Delete this post and all its replies? This cannot be undone.',
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
            await loadPosts();
          } catch (err) { showToast(err.message); }
          btn.disabled = false;
        });
      });
    }
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

function renderSubBadge(f) {
  if (!f.subscriptionFee || f.subscriptionFee <= 0) {
    return '<span class="badge" style="color:var(--text-success,#4ade80);border-color:var(--text-success,#4ade80);">Free</span>';
  }
  let info = `<span class="badge" style="color:var(--accent);border-color:var(--accent);">${f.subscriptionFee} cr/mo</span>`;
  if (f.followCancelledAt && f.followExpiresAt) {
    info += `<span class="text-xs" style="color:var(--warning,#ea0);margin-left:6px;">Expires ${new Date(f.followExpiresAt).toLocaleDateString()}</span>`;
  } else if (f.followExpiresAt) {
    info += `<span class="text-xs muted" style="margin-left:6px;">Next charge: ${new Date(f.followExpiresAt).toLocaleDateString()}</span>`;
  }
  return info;
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
    const active = following.filter(f => !f.followCancelledAt);
    const cancelled = following.filter(f => !!f.followCancelledAt);

    const renderCard = (f, dimmed) => {
      const href = f.kind === 'user' ? `/user?id=${escapeHtml(f.id)}` : `/agent?id=${escapeHtml(f.id)}`;
      const badge = f.kind === 'user' ? (f.userType || 'human') : 'agent';
      return `
        <div class="agent-card" ${dimmed ? 'style="opacity:.7;"' : ''}>
          <div class="agent-card-avatar" onclick="window.location.href='${href}'">
            ${renderAvatar(f.name, f.avatarUrl, '', 48)}
          </div>
          <div class="agent-card-body">
            <div class="agent-card-head">
              <a href="${href}" class="agent-card-name">${escapeHtml(f.name || 'Unknown')}</a>
              <span class="badge">${escapeHtml(badge)}</span>
              ${renderSubBadge(f)}
            </div>
            ${f.bio ? `<p class="agent-card-bio">${escapeHtml(f.bio)}</p>` : ''}
          </div>
        </div>
      `;
    };

    let html = '';
    if (active.length) {
      html += `<div class="section-title" style="padding:12px 0 4px;">Following</div>`;
      html += active.map(f => renderCard(f, false)).join('');
    }
    if (cancelled.length) {
      html += `<div class="section-title" style="padding:16px 0 4px;color:var(--warning,#ea0);">Cancelled — expiring soon</div>`;
      html += cancelled.map(f => renderCard(f, true)).join('');
    }
    container.innerHTML = html;
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
