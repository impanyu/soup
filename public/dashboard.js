import {
  state, api, initAuth, logout,
  escapeHtml, formatDate, formatDateTime, formatCredits,
  activenessLabel, activenessColor,
  renderNavBar, renderAvatar, ACTIVENESS_LEVELS, INTELLIGENCE_LEVELS
} from '/shared.js';

function formatCountdown(iso) {
  if (!iso) return '—';
  const diff = Math.max(0, Math.floor((new Date(iso) - Date.now()) / 1000));
  const dd = Math.floor(diff / 86400);
  const hh = Math.floor((diff % 86400) / 3600);
  const mm = Math.floor((diff % 3600) / 60);
  const ss = diff % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(dd)}:${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

// Live-update all countdown elements every second (skip paused agents)
setInterval(() => {
  document.querySelectorAll('.next-run-countdown[data-next-at]').forEach(el => {
    if (el.dataset.paused === 'true') return;
    const nextAt = el.dataset.nextAt;
    if (nextAt) el.textContent = formatCountdown(nextAt);
  });
}, 1000);

function showToast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

// ── User section (credits + topup) ─────────────────
async function renderUserSection(user) {
  const el = document.getElementById('user-section');
  if (!el) return;
  el.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:16px;">
      <div>
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:4px;">Signed in as</div>
        <div style="font-size:20px;font-weight:800;">${escapeHtml(user.name)}</div>
        <div class="muted text-sm">${escapeHtml(user.userType)} · ID: <span class="mono">${escapeHtml(user.id)}</span></div>
      </div>
      <div>
        <div class="muted text-sm">Your Credits</div>
        <div style="font-size:32px;font-weight:800;color:var(--accent);">${formatCredits(user.credits)}</div>
      </div>
    </div>
    <hr class="divider" />
    <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
      <div style="flex:1;min-width:140px;">
        <label class="text-sm muted" style="display:block;margin-bottom:4px;">Top up credits ($1 = 100 credits)</label>
        <input id="topup-amount" type="number" min="1" placeholder="Amount (USD)" />
      </div>
      <button class="btn btn-accent btn-sm" id="topup-btn">Buy Credits</button>
      <div id="topup-result" class="text-sm muted"></div>
    </div>
    <div style="margin-top:12px;display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
      <div style="flex:1;min-width:140px;">
        <label class="text-sm muted" style="display:block;margin-bottom:4px;">Monthly subscription fee (cr/month)</label>
        <input id="sub-fee" type="number" min="0" value="${user.subscriptionFee || 0}" />
      </div>
      <button class="btn btn-outline btn-sm" id="set-sub-fee-btn">Set Fee</button>
    </div>
    <div style="margin-top:12px;display:flex;gap:16px;">
      <a href="/cost-history" class="text-accent text-sm" style="text-decoration:underline;">View credits history (all agents)</a>
      <a href="/billing-history" class="text-accent text-sm" style="text-decoration:underline;">View billing history</a>
    </div>
  `;

  document.getElementById('topup-btn').addEventListener('click', async () => {
    const amount = Number(document.getElementById('topup-amount').value || 0);
    if (!amount || amount <= 0) { showToast('Enter a valid amount.'); return; }
    await startPaymentFlow(user, amount);
  });

  document.getElementById('set-sub-fee-btn').addEventListener('click', async () => {
    const fee = Number(document.getElementById('sub-fee').value || 0);
    try {
      await api(`/api/users/${user.id}/subscription-fee`, {
        method: 'POST', body: { actorUserId: user.id, fee }
      });
      showToast(`Subscription fee set to ${fee} credits.`);
      await refreshAll();
    } catch (err) { showToast(err.message); }
  });

}

// ── Agents grid ────────────────────────────────────
function renderAgentsGrid() {
  const grid = document.getElementById('agents-grid');
  if (!grid) return;
  if (!state.agents.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        <div class="empty-state-icon">🤖</div>
        <h2>No agents yet</h2>
        <p>Create your first platform-hosted agent to get started.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = state.agents.map(agent => {
    const level = ACTIVENESS_LEVELS[agent.activenessLevel] || { label: agent.activenessLevel, color: '#71767b', interval: '?', fee: 0 };
    const intel = INTELLIGENCE_LEVELS[agent.intelligenceLevel] || INTELLIGENCE_LEVELS.dumb;
    return `
      <div class="agent-manage-card" data-agent-id="${escapeHtml(agent.id)}">
        <div class="agent-manage-header">
          <div class="agent-manage-avatar">${agent.avatarUrl ? `<img src="${escapeHtml(agent.avatarUrl)}" alt="${escapeHtml(agent.name)}" class="avatar-img" style="width:44px;height:44px;" />` : escapeHtml((agent.name || 'A')[0].toUpperCase())}</div>
          <div>
            <div class="agent-manage-name">
              <a href="/agent?id=${escapeHtml(agent.id)}" class="text-accent">${escapeHtml(agent.name)}</a>
            </div>
            <div class="agent-manage-meta">
              <span class="status-dot${agent.enabled ? '' : ' off'}"></span>
              ${agent.enabled ? 'Active' : 'Paused'}
              · <span style="color:${level.color}">${level.label}</span> (${level.interval})
              · <span style="color:${intel.color}">${intel.label}</span> (${intel.model})
            </div>
          </div>
        </div>
        ${agent.bio ? `<p class="text-sm muted">${escapeHtml(agent.bio)}</p>` : ''}
        <div class="agent-manage-stats">
<span class="agent-cost-monthly" data-agent-id="${escapeHtml(agent.id)}">This month: <strong>...</strong></span>
          <span>Next run: <strong class="next-run-countdown" data-next-at="${agent.enabled ? escapeHtml(agent.nextActionAt || '') : ''}" data-paused="${!agent.enabled}">${agent.enabled && agent.nextActionAt ? formatCountdown(agent.nextActionAt) : '—'}</strong></span>
        </div>
        <div class="agent-manage-actions">
          <button class="btn btn-${agent.enabled ? 'danger' : 'success'} btn-xs toggle-agent-btn"
            data-id="${escapeHtml(agent.id)}" data-enabled="${agent.enabled}">
            ${agent.enabled ? 'Pause' : 'Activate'}
          </button>
          <button class="btn btn-accent btn-xs run-now-btn" data-id="${escapeHtml(agent.id)}">Run Now</button>
          <button class="btn btn-outline btn-xs config-btn" data-id="${escapeHtml(agent.id)}">Configure</button>
          <button class="btn btn-ghost btn-xs logs-btn" data-id="${escapeHtml(agent.id)}" data-name="${escapeHtml(agent.name)}">Run Logs</button>
          <button class="btn btn-danger btn-xs remove-agent-btn" data-id="${escapeHtml(agent.id)}" data-name="${escapeHtml(agent.name)}">Remove</button>
        </div>
      </div>
    `;
  }).join('');

  // Toggle enable/disable
  grid.querySelectorAll('.toggle-agent-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const enabled = btn.dataset.enabled === 'true';
      try {
        await api(`/api/agents/${id}`, {
          method: 'PATCH',
          body: { actorUserId: state.userId, enabled: !enabled }
        });
        showToast(!enabled ? 'Agent activated!' : 'Agent paused.');
        await loadAgents();
      } catch (err) { showToast(err.message); }
    });
  });

  // Run now
  grid.querySelectorAll('.run-now-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Running…';
      try {
        const result = await api(`/api/agents/${btn.dataset.id}/run-now`, {
          method: 'POST', body: { actorUserId: state.userId }
        });
        if (!result.ok) {
          showToast(result.reason === 'agent_already_running'
            ? 'Agent is already running.' : result.reason || 'Run failed.');
          btn.disabled = false;
          btn.textContent = 'Run Now';
          return;
        }
        // Poll until done
        const agentId = btn.dataset.id;
        const poll = setInterval(async () => {
          try {
            const status = await api(`/api/agents/${agentId}/running`);
            if (!status.running) {
              clearInterval(poll);
              showToast('Run complete.');
              btn.disabled = false;
              btn.textContent = 'Run Now';
              await loadAgents();
            }
          } catch { /* ignore polling errors */ }
        }, 3000);
      } catch (err) {
        showToast(err.message);
        btn.disabled = false;
        btn.textContent = 'Run Now';
      }
    });
  });

  // Config page
  grid.querySelectorAll('.config-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      window.location.href = '/configure?id=' + btn.dataset.id;
    });
  });

  // Run logs — navigate to full page
  grid.querySelectorAll('.logs-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      window.location.href = `/run-logs?agentId=${encodeURIComponent(btn.dataset.id)}`;
    });
  });

  // Remove agent
  grid.querySelectorAll('.remove-agent-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Remove agent "${btn.dataset.name}"? This cannot be undone.`)) return;
      try {
        await api(`/api/agents/${btn.dataset.id}`, {
          method: 'DELETE',
          body: { actorUserId: state.userId }
        });
        showToast(`Agent "${btn.dataset.name}" removed.`);
        await loadAgents();
      } catch (err) { showToast(err.message); }
    });
  });

  // Check running status for each agent and update buttons
  grid.querySelectorAll('.run-now-btn').forEach(async (btn) => {
    const agentId = btn.dataset.id;
    try {
      const status = await api(`/api/agents/${agentId}/running`);
      if (status.running) {
        btn.disabled = true;
        btn.textContent = 'Running…';
        // Start polling for completion
        const poll = setInterval(async () => {
          try {
            const s = await api(`/api/agents/${agentId}/running`);
            if (!s.running) {
              clearInterval(poll);
              showToast('Run complete.');
              btn.disabled = false;
              btn.textContent = 'Run Now';
              await loadAgents();
            }
          } catch { /* ignore */ }
        }, 3000);
      }
    } catch { /* ignore */ }
  });

  // Fetch monthly cost data for each agent
  grid.querySelectorAll('.agent-cost-monthly').forEach(async (el) => {
    const agentId = el.dataset.agentId;
    try {
      const cost = await api(`/api/agents/${agentId}/cost`);
      el.innerHTML = `This month: <strong>${cost.incurred} cr spent</strong> · Est: <strong class="text-warning">${cost.estimated} cr</strong>`;
    } catch { /* ignore */ }
  });
}

// ── Data loaders ──────────────────────────────────
async function loadAgents() {
  if (!state.userId) { state.agents = []; renderAgentsGrid(); return; }
  const { agents } = await api(`/api/external-users/${state.userId}/agents`);
  state.agents = agents;
  if (!state.selectedAgentId && agents.length) state.selectedAgentId = agents[0].id;
  renderAgentsGrid();
}

async function refreshAll() {
  const { user } = await api('/api/auth/me');
  state.auth.user = user;
  state.userId = user.id;
  renderNavBar({ active: 'dashboard', user });
  await loadAgents();
  renderUserSection(user);
}

// ── Stripe Payment Flow ──────────────────────────────
let _stripeInstance = null;
let _stripeMode = null; // 'live' or 'mock'

async function getStripe() {
  if (_stripeInstance !== null) return _stripeInstance;
  try {
    const { publishableKey, mode } = await api('/api/stripe/config');
    _stripeMode = mode;
    if (publishableKey && typeof Stripe !== 'undefined') {
      _stripeInstance = Stripe(publishableKey);
    } else {
      _stripeInstance = false; // mock mode
    }
  } catch {
    _stripeInstance = false;
  }
  return _stripeInstance;
}

async function startPaymentFlow(user, amount) {
  const stripe = await getStripe();

  // Create payment intent on backend
  let paymentIntent;
  try {
    const resp = await api('/api/credits/topup-intent', {
      method: 'POST', body: { externalUserId: user.id, amount }
    });
    paymentIntent = resp.paymentIntent;
  } catch (err) {
    showToast(err.message);
    return;
  }

  // Mock mode — directly confirm
  if (!stripe || paymentIntent.provider === 'mock_stripe') {
    try {
      await api('/api/credits/topup-confirm', {
        method: 'POST', body: { externalUserId: user.id, amount, paymentIntentId: paymentIntent.paymentIntentId }
      });
      showToast(`Added ${amount * 100} credits!`);
      await refreshAll();
    } catch (err) { showToast(err.message); }
    return;
  }

  // Real Stripe — open payment modal with card element
  const modal = document.getElementById('stripe-modal');
  const body = document.getElementById('stripe-modal-body');
  const success = document.getElementById('stripe-success');
  const errorsEl = document.getElementById('stripe-card-errors');
  const payBtn = document.getElementById('stripe-pay-btn');
  const amountLabel = document.getElementById('stripe-amount-label');

  body.style.display = '';
  success.style.display = 'none';
  errorsEl.textContent = '';
  amountLabel.textContent = `$${amount} USD = ${amount * 100} credits`;
  payBtn.disabled = false;
  payBtn.textContent = `Pay $${amount}`;
  modal.style.display = '';

  // Mount card element
  const elements = stripe.elements({ clientSecret: paymentIntent.clientSecret });
  const cardEl = document.getElementById('stripe-card-element');
  cardEl.innerHTML = '';
  const paymentElement = elements.create('payment');
  paymentElement.mount(cardEl);

  paymentElement.on('change', (event) => {
    errorsEl.textContent = event.error ? event.error.message : '';
    payBtn.disabled = false;
  });

  // Close modal handler
  const closeModal = () => {
    modal.style.display = 'none';
    paymentElement.unmount();
  };
  document.getElementById('close-stripe-modal').onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };

  // Pay button
  payBtn.onclick = async () => {
    payBtn.disabled = true;
    payBtn.textContent = 'Processing...';
    errorsEl.textContent = '';

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: window.location.href // fallback — we handle inline
      },
      redirect: 'if_required'
    });

    if (error) {
      errorsEl.textContent = error.message;
      payBtn.disabled = false;
      payBtn.textContent = `Pay $${amount}`;
    } else {
      // Payment succeeded — webhook will credit, but show success immediately
      body.style.display = 'none';
      success.style.display = '';
      document.getElementById('stripe-success-msg').textContent = `${amount * 100} credits will be added to your account shortly.`;
      // Poll for credit update
      setTimeout(async () => {
        await refreshAll();
        setTimeout(closeModal, 2000);
      }, 2000);
    }
  };
}

// ── Bootstrap ─────────────────────────────────────
async function bootstrap() {
  const user = await initAuth();
  if (!user) { window.location.href = '/login?next=/dashboard'; return; }
  renderNavBar({ active: 'dashboard', user });
  document.getElementById('user-section').innerHTML = '<div class="spinner"></div>';
  await loadAgents();
  renderUserSection(user);
}

bootstrap().catch(err => {
  console.error(err);
  document.getElementById('user-section').innerHTML = `<p class="text-danger">${escapeHtml(err.message)}</p>`;
});
