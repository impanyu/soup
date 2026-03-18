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

function formatWeekDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function reasonLabel(reason) {
  const map = {
    scheduled_action: 'Scheduled',
    manual_run: 'Manual',
    autonomous_action: 'Scheduled',
    subscription: 'Sub. Paid',
    subscription_renewal: 'Sub. Renewal Paid',
    sub_earned: 'Sub. Earned',
    sub_earned_renewal: 'Sub. Renewal Earned',
    topup: 'Top-up'
  };
  return map[reason] || reason;
}

let _mode = 'user';
let _id = '';
let _page = 1;
let _weekIdx = 0;
let _weeklyStats = [];
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

/* ── Weekly chart (pure SVG) ─────────────────────── */

const _chartVis = { spent: true, earned: true, net: true };

function renderWeeklyChart(stats) {
  if (!stats.length) return '';

  const weeks = stats.slice(0, 12).reverse();
  const n = weeks.length;
  const W = 720, H = 220, pad = { top: 20, right: 16, bottom: 40, left: 52 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  // Compute Y range across visible series (net can be negative)
  let yMax = 1, yMin = 0;
  for (const w of weeks) {
    if (_chartVis.spent) yMax = Math.max(yMax, w.spent);
    if (_chartVis.earned) yMax = Math.max(yMax, w.earned);
    if (_chartVis.net) { yMax = Math.max(yMax, w.net); yMin = Math.min(yMin, w.net); }
  }
  // Add a small pad so lines don't touch edges
  const range = yMax - yMin || 1;
  yMax += range * 0.05;
  if (yMin < 0) yMin -= range * 0.05;

  const xPos = (i) => pad.left + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const yPos = (val) => pad.top + plotH - ((val - yMin) / (yMax - yMin)) * plotH;

  const spentPts = weeks.map((w, i) => [xPos(i), yPos(w.spent)]);
  const earnedPts = weeks.map((w, i) => [xPos(i), yPos(w.earned)]);
  const netPts = weeks.map((w, i) => [xPos(i), yPos(w.net)]);

  // Grid lines
  const gridSteps = 4;
  let gridLines = '';
  for (let i = 0; i <= gridSteps; i++) {
    const gy = pad.top + (plotH / gridSteps) * i;
    const label = Math.round(yMax - ((yMax - yMin) / gridSteps) * i);
    gridLines += `<line x1="${pad.left}" y1="${gy}" x2="${W - pad.right}" y2="${gy}" stroke="var(--border)" stroke-dasharray="3,3" />`;
    gridLines += `<text x="${pad.left - 6}" y="${gy + 4}" text-anchor="end" fill="var(--text-muted)" font-size="10">${label}</text>`;
  }
  // Zero line when range includes negatives
  if (yMin < 0) {
    const zeroY = yPos(0);
    gridLines += `<line x1="${pad.left}" y1="${zeroY}" x2="${W - pad.right}" y2="${zeroY}" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="4,2" />`;
    gridLines += `<text x="${pad.left - 6}" y="${zeroY + 4}" text-anchor="end" fill="var(--text-muted)" font-size="10" font-weight="600">0</text>`;
  }

  // X-axis labels
  let labels = '';
  weeks.forEach((w, i) => {
    labels += `<text x="${xPos(i)}" y="${H - pad.bottom + 16}" text-anchor="middle" fill="var(--text-muted)" font-size="10">${escapeHtml(formatWeekDate(w.weekStart))}</text>`;
  });

  // Lines + dots for each visible series
  let lines = '';
  let dots = '';

  if (_chartVis.spent) {
    lines += `<polyline points="${spentPts.map(p => p.join(',')).join(' ')}" fill="none" stroke="var(--accent, #6366f1)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`;
    spentPts.forEach(([px, py]) => {
      dots += `<circle cx="${px}" cy="${py}" r="3.5" fill="var(--accent, #6366f1)" stroke="var(--bg-input)" stroke-width="1.5" />`;
    });
  }
  if (_chartVis.earned) {
    lines += `<polyline points="${earnedPts.map(p => p.join(',')).join(' ')}" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`;
    earnedPts.forEach(([px, py]) => {
      dots += `<circle cx="${px}" cy="${py}" r="3.5" fill="#4ade80" stroke="var(--bg-input)" stroke-width="1.5" />`;
    });
  }
  if (_chartVis.net) {
    // Net line — dashed, green if starting point >= 0, red if < 0
    for (let i = 0; i < netPts.length - 1; i++) {
      const color = weeks[i].net >= 0 ? '#4ade80' : '#ef4444';
      lines += `<line x1="${netPts[i][0]}" y1="${netPts[i][1]}" x2="${netPts[i + 1][0]}" y2="${netPts[i + 1][1]}" stroke="${color}" stroke-width="2" stroke-dasharray="6,3" stroke-linecap="round" />`;
    }
    netPts.forEach(([px, py], i) => {
      const c = weeks[i].net >= 0 ? '#4ade80' : '#ef4444';
      dots += `<circle cx="${px}" cy="${py}" r="3" fill="${c}" stroke="var(--bg-input)" stroke-width="1.5" />`;
    });
  }

  return `
    <div style="margin-bottom:16px;padding:12px 16px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);overflow-x:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px;">
        <span class="text-xs muted">Weekly overview (last ${weeks.length} weeks, cr)</span>
        <div style="display:flex;gap:6px;" id="chart-toggles">
          <button class="btn btn-xs ${_chartVis.spent ? '' : 'btn-outline'}" data-series="spent" style="font-size:11px;padding:2px 8px;${_chartVis.spent ? 'background:var(--accent,#6366f1);color:#fff;border-color:var(--accent,#6366f1);' : ''}">Spent</button>
          <button class="btn btn-xs ${_chartVis.earned ? '' : 'btn-outline'}" data-series="earned" style="font-size:11px;padding:2px 8px;${_chartVis.earned ? 'background:#4ade80;color:#000;border-color:#4ade80;' : ''}">Earned</button>
          <button class="btn btn-xs ${_chartVis.net ? '' : 'btn-outline'}" data-series="net" style="font-size:11px;padding:2px 8px;${_chartVis.net ? 'background:#f59e0b;color:#000;border-color:#f59e0b;' : ''}">Net</button>
        </div>
      </div>
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block;">
        ${gridLines}
        <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${W - pad.right}" y2="${pad.top + plotH}" stroke="var(--border)" />
        ${labels}
        ${lines}
        ${dots}
      </svg>
    </div>
  `;
}

function bindChartToggles() {
  const wrap = document.getElementById('chart-toggles');
  if (!wrap) return;
  wrap.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = btn.dataset.series;
      _chartVis[s] = !_chartVis[s];
      const el = document.getElementById('weekly-chart');
      if (el) { el.innerHTML = renderWeeklyChart(_weeklyStats); bindChartToggles(); }
    });
  });
}

/* ── Weekly summary navigator ────────────────────── */

function renderWeeklySummary() {
  if (!_weeklyStats.length) return '';
  const w = _weeklyStats[_weekIdx];
  const netColor = w.net >= 0 ? 'color:var(--text-success,#4ade80);' : 'color:var(--danger,#ef4444);';
  const netSign = w.net >= 0 ? '+' : '';
  return `
    <div style="margin-bottom:16px;padding:12px 16px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <button class="btn btn-outline btn-xs" id="week-prev" ${_weekIdx >= _weeklyStats.length - 1 ? 'disabled' : ''}>&larr;</button>
        <span class="text-sm" style="font-weight:600;">${formatWeekDate(w.weekStart)} — ${formatWeekDate(w.weekEnd)}</span>
        <button class="btn btn-outline btn-xs" id="week-next" ${_weekIdx <= 0 ? 'disabled' : ''}>&rarr;</button>
      </div>
      <div style="display:flex;gap:24px;flex-wrap:wrap;">
        <div>
          <span class="text-xs muted">Spent</span>
          <div style="font-size:16px;font-weight:700;">${w.spent} cr</div>
        </div>
        <div>
          <span class="text-xs muted">Earned</span>
          <div style="font-size:16px;font-weight:700;color:var(--text-success,#4ade80);">+${w.earned} cr</div>
        </div>
        <div>
          <span class="text-xs muted">Net</span>
          <div style="font-size:16px;font-weight:700;${netColor}">${netSign}${w.net} cr</div>
        </div>
      </div>
    </div>
  `;
}

function bindWeekNav() {
  const prev = document.getElementById('week-prev');
  const next = document.getElementById('week-next');
  if (prev) prev.addEventListener('click', () => { _weekIdx++; refreshWeekly(); });
  if (next) next.addEventListener('click', () => { _weekIdx--; refreshWeekly(); });
}

function refreshWeekly() {
  const el = document.getElementById('weekly-summary');
  if (el) { el.innerHTML = renderWeeklySummary(); bindWeekNav(); }
}

/* ── Main page loader ────────────────────────────── */

async function loadPage() {
  const content = document.getElementById('cost-content');
  content.innerHTML = '<div class="spinner"></div>';

  try {
    const endpoint = _mode === 'agent'
      ? `/api/agents/${_id}/cost-history?page=${_page}&perPage=${PER_PAGE}`
      : `/api/users/${_id}/cost-history?page=${_page}&perPage=${PER_PAGE}`;

    const data = await api(endpoint);

    const title = _mode === 'agent'
      ? `Bill History — ${data.agentName}`
      : 'Bill History — All Agents';
    document.getElementById('page-title').textContent = title;

    if (!data.runs.length && _page === 1) {
      content.innerHTML = '<p class="muted">No bill history yet.</p>';
      return;
    }

    _weeklyStats = data.weeklyStats || [];
    _weekIdx = 0;

    const totalEarned = data.totalEarned || 0;
    const totalNet = totalEarned - data.totalCost;
    const netColor = totalNet >= 0 ? 'color:var(--text-success,#4ade80);' : 'color:var(--danger,#ef4444);';
    const netSign = totalNet >= 0 ? '+' : '';

    const summaryHtml = `
      <div style="margin-bottom:16px;padding:12px 16px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);display:flex;gap:24px;flex-wrap:wrap;">
        <div>
          <span class="text-xs muted">Total spent</span>
          <div style="font-size:18px;font-weight:700;">${data.totalCost} cr <span class="muted text-sm">($${(data.totalCost / 100).toFixed(2)})</span></div>
        </div>
        <div>
          <span class="text-xs muted">Total earned</span>
          <div style="font-size:18px;font-weight:700;color:var(--text-success,#4ade80);">+${totalEarned} cr <span class="muted text-sm">($${(totalEarned / 100).toFixed(2)})</span></div>
        </div>
        <div>
          <span class="text-xs muted">Net</span>
          <div style="font-size:18px;font-weight:700;${netColor}">${netSign}${totalNet} cr <span class="muted text-sm">($${(Math.abs(totalNet) / 100).toFixed(2)})</span></div>
        </div>
        <div>
          <span class="text-xs muted">Total entries</span>
          <div style="font-size:18px;font-weight:700;">${data.total}</div>
        </div>
      </div>
    `;

    const chartHtml = renderWeeklyChart(_weeklyStats);

    const showAgent = _mode === 'user';
    const headerCols = `
      <th class="text-sm" style="padding:8px 12px;">Time</th>
      ${showAgent ? '<th class="text-sm" style="padding:8px 12px;">Agent</th>' : ''}
      <th class="text-sm" style="padding:8px 12px;">Type</th>
      <th class="text-sm" style="padding:8px 12px;text-align:right;">Steps</th>
      <th class="text-sm" style="padding:8px 12px;text-align:right;">Duration</th>
      <th class="text-sm" style="padding:8px 12px;text-align:right;">Spent (cr)</th>
      <th class="text-sm" style="padding:8px 12px;text-align:right;">Earned (cr)</th>
    `;

    const rowsHtml = data.runs.map(run => {
      const isEarned = run.type === 'subscription_earned';
      const isTopup = run.type === 'topup';
      const isSub = run.type === 'subscription' || isEarned;
      const isNonRun = isSub || isTopup;
      const isRun = run.type === 'run';
      const rowStyle = isTopup
        ? 'background:rgba(99,102,241,0.05);'
        : isEarned ? 'background:rgba(74,222,128,0.05);'
        : isSub ? 'opacity:0.85;' : '';
      const clickStyle = isRun ? 'cursor:pointer;' : '';
      const runLogHref = isRun
        ? `/run-log?id=${encodeURIComponent(run.id)}&from=${_mode}&agentId=${encodeURIComponent(run.agentId)}`
        : '';
      const onClick = isRun ? `onclick="window.location.href='${runLogHref}'"` : '';
      const detailText = isTopup ? run.detail : (isSub && run.detail ? ` <span class="muted text-xs">${escapeHtml(run.detail)}</span>` : '');
      return `
      <tr style="border-bottom:1px solid var(--border);${rowStyle}${clickStyle}" ${onClick} ${isRun ? 'class="hoverable-row"' : ''}>
        <td style="padding:8px 12px;white-space:nowrap;">${formatTime(run.startedAt)}</td>
        ${showAgent ? `<td style="padding:8px 12px;">${escapeHtml(run.agentName || (isTopup ? '—' : ''))}</td>` : ''}
        <td style="padding:8px 12px;"><span class="badge" style="font-size:11px;${isTopup ? 'color:var(--accent);border-color:var(--accent);' : ''}">${reasonLabel(run.reason)}</span>${isTopup ? ` <span class="muted text-xs">${escapeHtml(run.detail || '')}</span>` : (isSub && run.detail ? ` <span class="muted text-xs">${escapeHtml(run.detail)}</span>` : '')}</td>
        <td style="padding:8px 12px;text-align:right;">${isNonRun ? '—' : run.stepsExecuted}</td>
        <td style="padding:8px 12px;text-align:right;">${isNonRun ? '—' : formatDuration(run.durationMs)}</td>
        <td style="padding:8px 12px;text-align:right;font-weight:600;">${run.cost || '—'}</td>
        <td style="padding:8px 12px;text-align:right;font-weight:600;color:var(--text-success,#4ade80);">${run.amount ? '+' + run.amount : '—'}</td>
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
      <div style="max-width:960px;margin:0 24px;">
        ${summaryHtml}
        <div id="weekly-chart">${chartHtml}</div>
        <div id="weekly-summary">${renderWeeklySummary()}</div>
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

    bindWeekNav();
    bindChartToggles();

    const prevBtn = document.getElementById('cost-prev');
    const nextBtn = document.getElementById('cost-next');
    if (prevBtn) prevBtn.addEventListener('click', () => { _page--; loadPage(); });
    if (nextBtn) nextBtn.addEventListener('click', () => { _page++; loadPage(); });

  } catch (err) {
    content.innerHTML = `<p class="text-danger">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
}

document.addEventListener('DOMContentLoaded', bootstrap);
