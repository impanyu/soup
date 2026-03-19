import { escapeHtml } from '/shared.js';

let _adminToken = localStorage.getItem('soup_admin_token') || '';

async function adminApi(path) {
  const res = await fetch(path, { headers: { 'X-Admin-Token': _adminToken } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function showToast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatWeekDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function cr(n) { return Number(n || 0).toFixed(2); }
function usd(credits) { return '$' + (credits / 100).toFixed(2); }

// ── Auth ──

async function checkAuth() {
  if (!_adminToken) return false;
  try {
    await adminApi('/api/admin/verify');
    return true;
  } catch { return false; }
}

function showLogin() {
  document.getElementById('admin-login').style.display = '';
  document.getElementById('admin-app').style.display = 'none';
}

function showApp() {
  document.getElementById('admin-login').style.display = 'none';
  document.getElementById('admin-app').style.display = '';
}

// ── Chart ──

const _chartVis = { income: true, expense: true, net: true };

function renderWeeklyChart(weeks) {
  if (!weeks.length) return '';
  const n = weeks.length;
  const W = 720, H = 220, pad = { top: 20, right: 16, bottom: 40, left: 60 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  let yMax = 1, yMin = 0;
  for (const w of weeks) {
    if (_chartVis.income) yMax = Math.max(yMax, w.income);
    if (_chartVis.expense) yMax = Math.max(yMax, w.expense);
    if (_chartVis.net) { yMax = Math.max(yMax, w.net); yMin = Math.min(yMin, w.net); }
  }
  const range = yMax - yMin || 1;
  yMax += range * 0.05;
  if (yMin < 0) yMin -= range * 0.05;

  const xPos = (i) => pad.left + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const yPos = (val) => pad.top + plotH - ((val - yMin) / (yMax - yMin)) * plotH;

  const gridSteps = 4;
  let gridLines = '';
  for (let i = 0; i <= gridSteps; i++) {
    const gy = pad.top + (plotH / gridSteps) * i;
    const label = Math.round(yMax - ((yMax - yMin) / gridSteps) * i);
    gridLines += `<line x1="${pad.left}" y1="${gy}" x2="${W - pad.right}" y2="${gy}" stroke="var(--border)" stroke-dasharray="3,3" />`;
    gridLines += `<text x="${pad.left - 6}" y="${gy + 4}" text-anchor="end" fill="var(--text-muted)" font-size="10">${label}</text>`;
  }
  if (yMin < 0) {
    const zeroY = yPos(0);
    gridLines += `<line x1="${pad.left}" y1="${zeroY}" x2="${W - pad.right}" y2="${zeroY}" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="4,2" />`;
  }

  let labels = '';
  weeks.forEach((w, i) => {
    labels += `<text x="${xPos(i)}" y="${H - pad.bottom + 16}" text-anchor="middle" fill="var(--text-muted)" font-size="10">${escapeHtml(formatWeekDate(w.weekStart))}</text>`;
  });

  let lines = '', dots = '';
  if (_chartVis.income) {
    const pts = weeks.map((w, i) => `${xPos(i)},${yPos(w.income)}`).join(' ');
    lines += `<polyline points="${pts}" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`;
    weeks.forEach((w, i) => { dots += `<circle cx="${xPos(i)}" cy="${yPos(w.income)}" r="3.5" fill="#4ade80" stroke="var(--bg-input)" stroke-width="1.5" />`; });
  }
  if (_chartVis.expense) {
    const pts = weeks.map((w, i) => `${xPos(i)},${yPos(w.expense)}`).join(' ');
    lines += `<polyline points="${pts}" fill="none" stroke="var(--accent,#6366f1)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`;
    weeks.forEach((w, i) => { dots += `<circle cx="${xPos(i)}" cy="${yPos(w.expense)}" r="3.5" fill="var(--accent,#6366f1)" stroke="var(--bg-input)" stroke-width="1.5" />`; });
  }
  if (_chartVis.net) {
    for (let i = 0; i < weeks.length - 1; i++) {
      const c = weeks[i].net >= 0 ? '#4ade80' : '#ef4444';
      lines += `<line x1="${xPos(i)}" y1="${yPos(weeks[i].net)}" x2="${xPos(i+1)}" y2="${yPos(weeks[i+1].net)}" stroke="${c}" stroke-width="2" stroke-dasharray="6,3" stroke-linecap="round" />`;
    }
    weeks.forEach((w, i) => {
      const c = w.net >= 0 ? '#4ade80' : '#ef4444';
      dots += `<circle cx="${xPos(i)}" cy="${yPos(w.net)}" r="3" fill="${c}" stroke="var(--bg-input)" stroke-width="1.5" />`;
    });
  }

  return `
    <div style="margin-bottom:16px;padding:12px 16px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);overflow-x:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px;">
        <span class="text-xs muted">Weekly overview (last ${n} weeks, cr)</span>
        <div style="display:flex;gap:6px;" id="chart-toggles">
          <button class="btn btn-xs ${_chartVis.income ? '' : 'btn-outline'}" data-series="income" style="font-size:11px;padding:2px 8px;${_chartVis.income ? 'background:#4ade80;color:#000;border-color:#4ade80;' : ''}">Income</button>
          <button class="btn btn-xs ${_chartVis.expense ? '' : 'btn-outline'}" data-series="expense" style="font-size:11px;padding:2px 8px;${_chartVis.expense ? 'background:var(--accent,#6366f1);color:#fff;border-color:var(--accent,#6366f1);' : ''}">Expense</button>
          <button class="btn btn-xs ${_chartVis.net ? '' : 'btn-outline'}" data-series="net" style="font-size:11px;padding:2px 8px;${_chartVis.net ? 'background:#f59e0b;color:#000;border-color:#f59e0b;' : ''}">Net Profit</button>
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

// ── Main ──

let _page = 1;
let _weekIdx = 0;
let _weeklyStats = [];
const PER_PAGE = 30;

async function loadFinance() {
  const el = document.getElementById('admin-content');
  el.innerHTML = '<div class="spinner"></div>';

  try {
    const data = await adminApi(`/api/admin/finance?page=${_page}&perPage=${PER_PAGE}`);

    _weeklyStats = data.weeklyStats || [];
    _weekIdx = 0;

    const netColor = data.netProfit >= 0 ? 'color:#4ade80;' : 'color:#ef4444;';
    const netSign = data.netProfit >= 0 ? '+' : '';

    const summaryHtml = `
      <div style="margin-bottom:16px;padding:12px 16px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);display:flex;gap:24px;flex-wrap:wrap;">
        <div>
          <span class="text-xs muted">Total Income (top-ups)</span>
          <div style="font-size:18px;font-weight:700;color:#4ade80;">${usd(data.totalIncome)} <span class="muted text-sm">(${cr(data.totalIncome)} cr)</span></div>
        </div>
        <div>
          <span class="text-xs muted">Total Run Expense</span>
          <div style="font-size:18px;font-weight:700;">${usd(data.totalExpense)} <span class="muted text-sm">(${cr(data.totalExpense)} cr)</span></div>
        </div>
        <div>
          <span class="text-xs muted">Net Profit</span>
          <div style="font-size:18px;font-weight:700;${netColor}">${netSign}${usd(Math.abs(data.netProfit))} <span class="muted text-sm">(${netSign}${cr(data.netProfit)} cr)</span></div>
        </div>
        <div>
          <span class="text-xs muted">Total Users</span>
          <div style="font-size:18px;font-weight:700;">${data.totalUsers}</div>
        </div>
        <div>
          <span class="text-xs muted">Total Agents</span>
          <div style="font-size:18px;font-weight:700;">${data.totalAgents}</div>
        </div>
        <div>
          <span class="text-xs muted">Total Runs</span>
          <div style="font-size:18px;font-weight:700;">${data.totalRuns}</div>
        </div>
      </div>
    `;

    const chartWeeks = _weeklyStats.slice(0, 12).reverse();
    const chartHtml = `<div id="weekly-chart">${renderWeeklyChart(chartWeeks)}</div>`;

    // Weekly summary navigator
    const weekSummaryHtml = _weeklyStats.length ? renderWeekSummary() : '';

    // Itemized table
    const rowsHtml = data.entries.map(e => {
      const isIncome = e.category === 'income';
      const rowBg = isIncome ? 'background:rgba(74,222,128,0.05);' : 'background:rgba(99,102,241,0.05);';
      return `
        <tr style="border-bottom:1px solid var(--border);${rowBg}">
          <td style="padding:8px 12px;white-space:nowrap;">${formatTime(e.createdAt)}</td>
          <td style="padding:8px 12px;">
            <span class="badge" style="font-size:11px;${isIncome ? 'color:#4ade80;border-color:#4ade80;' : ''}">${escapeHtml(e.typeLabel)}</span>
          </td>
          <td style="padding:8px 12px;" class="text-sm muted">${escapeHtml(e.detail)}</td>
          <td style="padding:8px 12px;text-align:right;font-weight:600;${isIncome ? 'color:#4ade80;' : ''}">${isIncome ? '+' : '-'}${cr(e.amount)} cr</td>
          <td style="padding:8px 12px;text-align:right;" class="text-sm muted">${usd(e.amount)}</td>
        </tr>`;
    }).join('');

    const paginationHtml = data.totalPages > 1 ? `
      <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-top:16px;">
        <button class="btn btn-outline btn-xs" id="page-prev" ${_page <= 1 ? 'disabled' : ''}>Previous</button>
        <span class="text-sm muted">Page ${data.page} of ${data.totalPages} (${data.totalEntries} entries)</span>
        <button class="btn btn-outline btn-xs" id="page-next" ${_page >= data.totalPages ? 'disabled' : ''}>Next</button>
      </div>
    ` : `<div class="text-xs muted" style="text-align:center;margin-top:8px;">${data.totalEntries} entries total</div>`;

    el.innerHTML = `
      ${summaryHtml}
      ${chartHtml}
      <div id="week-summary">${weekSummaryHtml}</div>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:2px solid var(--border);text-align:left;">
            <th class="text-sm" style="padding:8px 12px;">Time</th>
            <th class="text-sm" style="padding:8px 12px;">Type</th>
            <th class="text-sm" style="padding:8px 12px;">Details</th>
            <th class="text-sm" style="padding:8px 12px;text-align:right;">Amount (cr)</th>
            <th class="text-sm" style="padding:8px 12px;text-align:right;">USD</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      ${paginationHtml}
    `;

    // Bind events
    document.getElementById('chart-toggles')?.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        _chartVis[btn.dataset.series] = !_chartVis[btn.dataset.series];
        document.getElementById('weekly-chart').innerHTML = renderWeeklyChart(chartWeeks);
        // Re-bind toggles
        document.getElementById('chart-toggles')?.querySelectorAll('button').forEach(b => {
          b.addEventListener('click', () => { _chartVis[b.dataset.series] = !_chartVis[b.dataset.series]; loadFinance(); });
        });
      });
    });
    bindWeekNav();
    document.getElementById('page-prev')?.addEventListener('click', () => { _page--; loadFinance(); });
    document.getElementById('page-next')?.addEventListener('click', () => { _page++; loadFinance(); });

  } catch (err) {
    el.innerHTML = `<p class="text-danger">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
}

function renderWeekSummary() {
  if (!_weeklyStats.length) return '';
  const w = _weeklyStats[_weekIdx];
  const netColor = w.net >= 0 ? 'color:#4ade80;' : 'color:#ef4444;';
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
          <span class="text-xs muted">Income</span>
          <div style="font-size:16px;font-weight:700;color:#4ade80;">+${usd(w.income)} <span class="muted text-xs">(${cr(w.income)} cr)</span></div>
        </div>
        <div>
          <span class="text-xs muted">Expense</span>
          <div style="font-size:16px;font-weight:700;">${usd(w.expense)} <span class="muted text-xs">(${cr(w.expense)} cr)</span></div>
        </div>
        <div>
          <span class="text-xs muted">Net Profit</span>
          <div style="font-size:16px;font-weight:700;${netColor}">${netSign}${usd(Math.abs(w.net))} <span class="muted text-xs">(${netSign}${cr(w.net)} cr)</span></div>
        </div>
        <div>
          <span class="text-xs muted">Runs</span>
          <div style="font-size:16px;font-weight:700;">${w.runs || 0}</div>
        </div>
        <div>
          <span class="text-xs muted">Top-ups</span>
          <div style="font-size:16px;font-weight:700;">${w.topups || 0}</div>
        </div>
      </div>
    </div>
  `;
}

function bindWeekNav() {
  document.getElementById('week-prev')?.addEventListener('click', () => {
    _weekIdx++;
    document.getElementById('week-summary').innerHTML = renderWeekSummary();
    bindWeekNav();
  });
  document.getElementById('week-next')?.addEventListener('click', () => {
    _weekIdx--;
    document.getElementById('week-summary').innerHTML = renderWeekSummary();
    bindWeekNav();
  });
}

// ── Bootstrap ──

async function bootstrap() {
  const authed = await checkAuth();
  if (authed) {
    showApp();
    loadFinance();
  } else {
    showLogin();
  }

  // Login handler
  document.getElementById('admin-login-btn').addEventListener('click', async () => {
    const pw = document.getElementById('admin-password').value.trim();
    if (!pw) return;
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      });
      const data = await res.json();
      if (!res.ok) {
        document.getElementById('admin-login-error').textContent = data.error || 'Invalid password';
        return;
      }
      _adminToken = data.token;
      localStorage.setItem('soup_admin_token', _adminToken);
      showApp();
      loadFinance();
    } catch (err) {
      document.getElementById('admin-login-error').textContent = err.message;
    }
  });

  document.getElementById('admin-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('admin-login-btn').click();
  });

  // Logout
  document.getElementById('admin-logout-btn').addEventListener('click', () => {
    _adminToken = '';
    localStorage.removeItem('soup_admin_token');
    showLogin();
    document.getElementById('admin-password').value = '';
    document.getElementById('admin-login-error').textContent = '';
  });
}

document.addEventListener('DOMContentLoaded', bootstrap);
