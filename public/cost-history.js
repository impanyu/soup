import { state, api, initAuth, escapeHtml, renderNavBar } from '/shared.js';

function formatDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function reasonLabel(reason) {
  const map = {
    scheduled_action: 'Scheduled',
    manual_run: 'Manual',
    autonomous_action: 'Scheduled',
    subscription: 'Subscription',
    subscription_renewal: 'Sub. Renewal'
  };
  return map[reason] || reason;
}

let _mode = 'user'; // 'user' or 'agent'
let _id = '';
let _page = 1;
const PER_PAGE = 20;

async function bootstrap() {
  const user = await initAuth();
  if (!user) { window.location.href = '/login?next=/cost-history'; return; }
  renderNavBar({ active: 'dashboard', user });

  const params = new URLSearchParams(window.location.search);
  const agentId = params.get('agentId');

  if (agentId) {
    _mode = 'agent';
    _id = agentId;
  } else {
    _mode = 'user';
    _id = user.id;
  }

  await loadPage();
}

async function loadPage() {
  const content = document.getElementById('cost-content');
  content.innerHTML = '<div class="spinner"></div>';

  try {
    const endpoint = _mode === 'agent'
      ? `/api/agents/${_id}/cost-history?page=${_page}&perPage=${PER_PAGE}`
      : `/api/users/${_id}/cost-history?page=${_page}&perPage=${PER_PAGE}`;

    const data = await api(endpoint);

    const title = _mode === 'agent'
      ? `Cost History — ${data.agentName}`
      : 'Cost History — All Agents';
    document.getElementById('page-title').textContent = title;

    if (!data.runs.length && _page === 1) {
      content.innerHTML = '<p class="muted">No run history yet.</p>';
      return;
    }

    const summaryHtml = `
      <div style="margin-bottom:16px;padding:12px 16px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);display:flex;gap:24px;flex-wrap:wrap;">
        <div>
          <span class="text-xs muted">Total cost</span>
          <div style="font-size:18px;font-weight:700;">${data.totalCost} cr <span class="muted text-sm">($${(data.totalCost / 100).toFixed(2)})</span></div>
        </div>
        <div>
          <span class="text-xs muted">Total entries</span>
          <div style="font-size:18px;font-weight:700;">${data.total}</div>
        </div>
      </div>
    `;

    const showAgent = _mode === 'user';
    const headerCols = `
      <th class="text-sm" style="padding:8px 12px;">Time</th>
      ${showAgent ? '<th class="text-sm" style="padding:8px 12px;">Agent</th>' : ''}
      <th class="text-sm" style="padding:8px 12px;">Trigger</th>
      <th class="text-sm" style="padding:8px 12px;text-align:right;">Steps</th>
      <th class="text-sm" style="padding:8px 12px;text-align:right;">Duration</th>
      <th class="text-sm" style="padding:8px 12px;text-align:right;">Cost (cr)</th>
      <th class="text-sm" style="padding:8px 12px;text-align:right;">Cost ($)</th>
    `;

    const rowsHtml = data.runs.map(run => {
      const isSub = run.type === 'subscription';
      return `
      <tr style="border-bottom:1px solid var(--border);${isSub ? 'opacity:0.85;' : ''}">
        <td style="padding:8px 12px;white-space:nowrap;">${formatTime(run.startedAt)}</td>
        ${showAgent ? `<td style="padding:8px 12px;">${escapeHtml(run.agentName || '')}</td>` : ''}
        <td style="padding:8px 12px;"><span class="badge" style="font-size:11px;">${reasonLabel(run.reason)}</span>${isSub && run.detail ? ` <span class="muted text-xs">${escapeHtml(run.detail)}</span>` : ''}</td>
        <td style="padding:8px 12px;text-align:right;">${isSub ? '—' : run.stepsExecuted}</td>
        <td style="padding:8px 12px;text-align:right;">${isSub ? '—' : formatDuration(run.durationMs)}</td>
        <td style="padding:8px 12px;text-align:right;font-weight:600;">${run.cost}</td>
        <td style="padding:8px 12px;text-align:right;color:var(--accent);">$${(run.cost / 100).toFixed(2)}</td>
      </tr>`;
    }).join('');

    const paginationHtml = data.totalPages > 1 ? `
      <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-top:16px;">
        <button class="btn btn-outline btn-xs" id="cost-prev" ${_page <= 1 ? 'disabled' : ''}>Previous</button>
        <span class="text-sm muted">Page ${data.page} of ${data.totalPages} (${data.total} entries)</span>
        <button class="btn btn-outline btn-xs" id="cost-next" ${_page >= data.totalPages ? 'disabled' : ''}>Next</button>
      </div>
    ` : `<div class="text-xs muted" style="text-align:center;margin-top:8px;">${data.total} entr${data.total !== 1 ? 'ies' : 'y'} total</div>`;

    const backLink = _mode === 'agent'
      ? `<a href="/configure?id=${escapeHtml(_id)}" class="text-accent text-sm">&larr; Back to configuration</a>`
      : `<a href="/dashboard" class="text-accent text-sm">&larr; Back to dashboard</a>`;

    content.innerHTML = `
      <div style="max-width:900px;margin:0 24px;">
        ${summaryHtml}
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="border-bottom:2px solid var(--border);text-align:left;">
              ${headerCols}
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        ${paginationHtml}
        <div style="margin-top:16px;">${backLink}</div>
      </div>
    `;

    const prevBtn = document.getElementById('cost-prev');
    const nextBtn = document.getElementById('cost-next');
    if (prevBtn) prevBtn.addEventListener('click', () => { _page--; loadPage(); });
    if (nextBtn) nextBtn.addEventListener('click', () => { _page++; loadPage(); });

  } catch (err) {
    content.innerHTML = `<p class="text-danger">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
}

document.addEventListener('DOMContentLoaded', bootstrap);
