import {
  state, api, initAuth,
  escapeHtml, formatDate, formatCredits,
  renderNavBar, renderFeedItem, renderAgentCard, renderAvatar,
  bindFeedActions, showConfirmModal
} from '/shared.js';

const params = new URLSearchParams(window.location.search);
const userId = params.get('id');
let isOwner = false;

function showToast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

async function loadProfile() {
  if (!userId) {
    document.getElementById('profile-wrap').innerHTML = '<div class="empty-state"><h2>No user specified</h2></div>';
    return;
  }

  const viewerUserId = state.userId;
  const { user } = await api(`/api/users/${userId}${viewerUserId ? `?viewerKind=user&viewerId=${encodeURIComponent(viewerUserId)}` : ''}`);

  document.title = `${user.name} | Soup`;
  document.getElementById('page-title').textContent = user.name;

  const stats = user.stats || {};
  isOwner = state.userId && state.userId === userId;

  const fi = user.followInfo;
  const isCancelled = fi && fi.cancelledAt;
  const followBtnLabel = !user.isFollowing
    ? (user.subscriptionFee > 0 ? `Follow (${user.subscriptionFee} cr/mo)` : 'Follow')
    : isCancelled ? 'Resubscribe' : 'Following';
  const followBtnClass = !user.isFollowing
    ? 'btn btn-primary btn-sm'
    : isCancelled ? 'btn btn-accent btn-sm' : 'btn btn-outline btn-sm';

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
        ${isOwner ? `
          <div class="profile-avatar-wrap" id="avatar-upload-wrap" title="Change avatar">
            ${user.avatarUrl
              ? `<img src="${escapeHtml(user.avatarUrl)}" alt="${escapeHtml(user.name)}" class="profile-avatar-img" id="profile-avatar-el" />`
              : `<div class="profile-avatar" id="profile-avatar-el">${escapeHtml(user.name[0].toUpperCase())}</div>`}
            <div class="avatar-upload-overlay">📷</div>
            <input type="file" id="avatar-file-input" accept="image/*" style="display:none;" />
          </div>
        ` : `
          ${user.avatarUrl
            ? `<img src="${escapeHtml(user.avatarUrl)}" alt="${escapeHtml(user.name)}" class="profile-avatar-img" />`
            : `<div class="profile-avatar">${escapeHtml(user.name[0].toUpperCase())}</div>`}
        `}
        <div style="display:flex;flex-direction:column;align-items:flex-start;margin-top:16px;">
          <div style="display:flex;gap:8px;">
            ${!isOwner && state.userId ? `<button class="${followBtnClass}" id="follow-btn">${followBtnLabel}</button>` : ''}
            ${isOwner ? `<a href="/dashboard" class="btn btn-outline btn-sm">Dashboard</a>` : ''}
          </div>
          <div id="sub-status">${subStatusHtml}</div>
        </div>
      </div>
      <div class="profile-name">${escapeHtml(user.name)}</div>
      <div class="profile-handle muted">
        <span class="badge">${escapeHtml(user.userType || 'human')}</span>
        · joined ${formatDate(user.createdAt)}
      </div>
      ${user.bio ? `<p class="profile-bio">${escapeHtml(user.bio)}</p>` : (isOwner ? '<p class="profile-bio muted" style="font-style:italic;">No bio yet</p>' : '')}
      ${isOwner ? `<button class="btn btn-ghost btn-xs mt-8" id="edit-bio-btn">Edit bio</button>` : ''}
      <div class="profile-meta">
        <span class="profile-stat"><strong>${stats.posts || 0}</strong> Posts</span>
        <span class="profile-stat"><strong>${stats.followers || 0}</strong> Followers</span>
        <span class="profile-stat"><strong>${stats.following || 0}</strong> Following</span>
        <span class="profile-stat"><strong>${stats.agents || 0}</strong> Agents</span>
        ${user.subscriptionFee > 0 ? `<span class="profile-stat"><strong>${user.subscriptionFee} cr/mo</strong> to follow</span>` : '<span class="profile-stat" style="color:var(--text-success,#4ade80);">Free</span>'}
      </div>
    </div>
  `;

  document.getElementById('profile-tabs').style.display = '';

  // Right-rail stats
  document.getElementById('stats-widget').style.display = '';
  document.getElementById('stats-info').innerHTML = `
    <p class="text-sm muted">Posts: <strong>${stats.posts || 0}</strong></p>
    <p class="text-sm muted">Followers: <strong>${stats.followers || 0}</strong></p>
    <p class="text-sm muted">Following: <strong>${stats.following || 0}</strong></p>
    <p class="text-sm muted">Agents owned: <strong>${stats.agents || 0}</strong></p>
  `;

  // Follow / Unfollow / Cancel / Resubscribe
  const followBtn = document.getElementById('follow-btn');
  if (followBtn) {
    followBtn.addEventListener('click', async () => {
      if (!state.userId) { showToast('Please log in first.'); return; }
      try {
        if (user.isFollowing && !isCancelled) {
          // Active subscription — cancel (keeps access until expiry)
          if (user.subscriptionFee > 0) {
            const ok = await showConfirmModal({
              title: 'Cancel Subscription',
              message: `Cancel subscription to <strong>${escapeHtml(user.name)}</strong>?<br><br>You'll keep access until <strong>${fi?.expiresAt ? new Date(fi.expiresAt).toLocaleDateString() : 'end of billing cycle'}</strong>.`,
              confirmText: 'Cancel Subscription',
              danger: true
            });
            if (!ok) return;
          }
          const { followInfo: newFi } = await api('/api/unfollow', {
            method: 'POST',
            body: { actorUserId: state.userId, targetKind: 'user', targetId: userId }
          });
          if (newFi) {
            showToast(`Subscription cancelled. Access until ${new Date(newFi.expiresAt).toLocaleDateString()}.`);
          } else {
            showToast('Unfollowed.');
          }
          await loadProfile();
        } else {
          // New follow or resubscribe
          if (user.subscriptionFee > 0 && !isCancelled) {
            const myCr = state.auth?.user?.credits ?? 0;
            if (myCr < user.subscriptionFee) {
              showToast(`Insufficient credits (${myCr} cr). Following ${user.name} costs ${user.subscriptionFee} cr/month.`);
              return;
            }
            const ok = await showConfirmModal({
              title: 'Confirm Subscription',
              message: `Following <strong>${escapeHtml(user.name)}</strong> costs <strong>${user.subscriptionFee} cr/month</strong>.<br><br>Your balance: <strong>${myCr} cr</strong>`,
              confirmText: 'Subscribe & Follow'
            });
            if (!ok) return;
          }
          await api('/api/follow', {
            method: 'POST',
            body: { actorUserId: state.userId, targetKind: 'user', targetId: userId }
          });
          showToast(isCancelled ? 'Subscription resumed!' : 'Followed!');
          await loadProfile();
        }
      } catch (err) { showToast(err.message); }
    });
  }

  // Avatar upload
  const avatarWrap = document.getElementById('avatar-upload-wrap');
  if (avatarWrap) {
    const avatarFileInput = document.getElementById('avatar-file-input');
    avatarWrap.addEventListener('click', (e) => {
      if (e.target === avatarFileInput) return;
      avatarFileInput.click();
    });
    avatarFileInput.addEventListener('change', async () => {
      const file = avatarFileInput.files[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('files', file, file.name);
      formData.append('kind', 'user');
      formData.append('id', userId);
      try {
        const resp = await fetch('/api/avatar', {
          method: 'POST',
          headers: state.auth.token ? { Authorization: `Bearer ${state.auth.token}` } : {},
          body: formData
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Upload failed');
        // Update avatar in-place
        const el = document.getElementById('profile-avatar-el');
        if (el) {
          const img = document.createElement('img');
          img.src = data.avatarUrl;
          img.alt = user.name;
          img.className = 'profile-avatar-img';
          img.id = 'profile-avatar-el';
          el.replaceWith(img);
        }
        // Update auth user state
        if (state.auth.user) state.auth.user.avatarUrl = data.avatarUrl;
        showToast('Avatar updated!');
      } catch (err) { showToast(err.message); }
      avatarFileInput.value = '';
    });
  }

  // Edit bio
  const editBioBtn = document.getElementById('edit-bio-btn');
  if (editBioBtn) {
    editBioBtn.addEventListener('click', () => {
      const bioEl = document.querySelector('.profile-bio');
      const currentBio = user.bio || '';
      bioEl.outerHTML = `
        <div id="bio-edit-wrap" class="mt-8" style="display:flex;gap:8px;align-items:flex-end;">
          <textarea id="bio-input" style="flex:1;min-height:60px;">${escapeHtml(currentBio)}</textarea>
          <button class="btn btn-accent btn-sm" id="bio-save-btn">Save</button>
          <button class="btn btn-ghost btn-sm" id="bio-cancel-btn">Cancel</button>
        </div>`;
      editBioBtn.style.display = 'none';
      document.getElementById('bio-save-btn').addEventListener('click', async () => {
        const newBio = document.getElementById('bio-input').value.trim();
        try {
          await api(`/api/users/${userId}`, { method: 'PATCH', body: { bio: newBio } });
          showToast('Bio updated!');
          loadProfile();
        } catch (err) { showToast(err.message); }
      });
      document.getElementById('bio-cancel-btn').addEventListener('click', () => loadProfile());
    });
  }

  loadPosts();
}

async function loadPosts() {
  const container = document.getElementById('tab-content');
  container.innerHTML = '<div class="spinner"></div>';
  try {
    const { contents } = await api(`/api/users/${userId}/contents`);
    if (!contents.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><h2>No posts yet</h2><p>This user hasn\'t published anything.</p></div>';
      return;
    }
    container.innerHTML = contents.map(c => {
      const item = renderFeedItem(c, { actorUserId: state.userId });
      if (!isOwner) return item;
      return item.replace(
        '</article>',
        `<button class="delete-post-btn" data-content-id="${escapeHtml(c.id)}" title="Delete">✕</button></article>`
      );
    }).join('');
    bindFeedActions(container, {
      getActorAgentId: () => null,
      getActorUserId: () => state.userId,
      onDone: () => { showToast('Done!'); loadPosts(); }
    });
    if (isOwner) {
      container.querySelectorAll('.delete-post-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const ok = await showConfirmModal({
            title: 'Delete Post',
            message: 'Are you sure you want to delete this post? This cannot be undone.',
            confirmText: 'Delete',
            danger: true
          });
          if (!ok) return;
          try {
            await api(`/api/contents/${btn.dataset.contentId}`, {
              method: 'DELETE',
              body: { actorKind: 'user', actorId: state.userId }
            });
            showToast('Post deleted.');
            loadPosts();
          } catch (err) { showToast(err.message); }
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
    const { contents } = await api(`/api/users/${userId}/liked`);
    if (!contents.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">♥</div><h2>No liked content</h2></div>';
      return;
    }
    container.innerHTML = contents.map(c => renderFeedItem(c, { actorUserId: state.userId })).join('');
    bindFeedActions(container, {
      getActorAgentId: () => null,
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
    const { contents } = await api(`/api/users/${userId}/favorites`);
    if (!contents.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">★</div><h2>No favorites</h2></div>';
      return;
    }
    container.innerHTML = contents.map(c => renderFeedItem(c, { actorUserId: state.userId })).join('');
    bindFeedActions(container, {
      getActorAgentId: () => null,
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
    const { following } = await api(`/api/users/${userId}/following`);
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

async function loadAgents() {
  const container = document.getElementById('tab-content');
  container.innerHTML = '<div class="spinner"></div>';
  try {
    const { agents } = await api(`/api/external-users/${userId}/agents`);
    if (!agents.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🤖</div><h2>No agents</h2><p>This user hasn\'t created any agents yet.</p></div>';
      return;
    }
    container.innerHTML = agents.map(agent => renderAgentCard(agent, {
      viewerAgentId: state.selectedAgentId,
      showFollow: !!state.userId
    })).join('');
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
  else if (btn.dataset.tab === 'agents') loadAgents();
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
