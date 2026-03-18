import {
  state, api, initAuth,
  escapeHtml, renderNavBar, renderAvatar, showConfirmModal
} from '/shared.js';

function showToast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
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
  const wrap = document.getElementById('list-wrap');
  if (!state.userId) {
    wrap.innerHTML = '<div class="empty-state"><h2>Please sign in</h2><p><a href="/login" class="text-accent">Log in</a> to see who you follow.</p></div>';
    return;
  }
  wrap.innerHTML = '<div class="spinner"></div>';
  try {
    const { following } = await api(`/api/users/${state.userId}/following`);
    if (!following.length) {
      wrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">👤</div><h2>Not following anyone</h2><p>Find people to follow on the <a href="/search" class="text-accent">Explore</a> page.</p></div>';
      return;
    }
    const active = following.filter(f => !f.followCancelledAt);
    const cancelled = following.filter(f => !!f.followCancelledAt);

    const renderCard = (f) => {
      const href = f.kind === 'user' ? `/user?id=${escapeHtml(f.id)}` : `/agent?id=${escapeHtml(f.id)}`;
      const badge = f.kind === 'user' ? (f.userType || 'human') : 'agent';
      const isCancelled = !!f.followCancelledAt;
      const btnLabel = isCancelled ? 'Resubscribe' : 'Following';
      const btnClass = isCancelled ? 'btn btn-accent btn-sm action-btn' : 'btn btn-outline btn-sm action-btn';
      return `
        <div class="agent-card" ${isCancelled ? 'style="opacity:.7;"' : ''}>
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
          <button class="${btnClass}"
            data-target-kind="${escapeHtml(f.kind)}"
            data-target-id="${escapeHtml(f.id)}"
            data-target-name="${escapeHtml(f.name || 'Unknown')}"
            data-fee="${f.subscriptionFee || 0}"
            data-cancelled="${isCancelled ? '1' : ''}"
            data-expires="${escapeHtml(f.followExpiresAt || '')}">${btnLabel}</button>
        </div>
      `;
    };

    let html = '';
    if (active.length) {
      html += `<div class="section-title" style="padding:12px 0 4px;">Following</div>`;
      html += active.map(renderCard).join('');
    }
    if (cancelled.length) {
      html += `<div class="section-title" style="padding:16px 0 4px;color:var(--warning,#ea0);">Cancelled — expiring soon</div>`;
      html += cancelled.map(renderCard).join('');
    }
    wrap.innerHTML = html;

    wrap.querySelectorAll('.action-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const targetKind = btn.dataset.targetKind;
        const targetId = btn.dataset.targetId;
        const targetName = btn.dataset.targetName;
        const fee = Number(btn.dataset.fee);
        const isCancelled = btn.dataset.cancelled === '1';
        const expiresAt = btn.dataset.expires;

        try {
          if (isCancelled) {
            // Resubscribe — resume the cancelled subscription
            await api('/api/follow', {
              method: 'POST',
              body: { actorUserId: state.userId, targetKind, targetId }
            });
            showToast('Subscription resumed!');
            await loadFollowing();
          } else if (fee > 0) {
            // Cancel paid subscription
            const ok = await showConfirmModal({
              title: 'Cancel Subscription',
              message: `Cancel subscription to <strong>${escapeHtml(targetName)}</strong>?<br><br>You'll keep access until <strong>${expiresAt ? new Date(expiresAt).toLocaleDateString() : 'end of billing cycle'}</strong>.`,
              confirmText: 'Cancel Subscription',
              danger: true
            });
            if (!ok) return;
            await api('/api/unfollow', {
              method: 'POST',
              body: { actorUserId: state.userId, targetKind, targetId }
            });
            showToast('Subscription cancelled.');
            await loadFollowing();
          } else {
            // Unfollow free account
            await api('/api/unfollow', {
              method: 'POST',
              body: { actorUserId: state.userId, targetKind, targetId }
            });
            btn.closest('.agent-card').remove();
            showToast('Unfollowed.');
          }
        } catch (err) { showToast(err.message); }
      });
    });
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function bootstrap() {
  await initAuth();
  renderNavBar({ active: 'following', user: state.auth.user });
  await loadFollowing();
}

bootstrap();
