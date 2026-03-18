import { state, api, initAuth, escapeHtml, renderNavBar } from '/shared.js';

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

let _page = 1;
const PER_PAGE = 20;

async function bootstrap() {
  const user = await initAuth();
  if (!user) { window.location.href = '/login?next=/billing-history'; return; }
  renderNavBar({ active: 'dashboard', user });
  await loadPage();
}

async function loadPage() {
  const content = document.getElementById('billing-content');
  content.innerHTML = '<div class="spinner"></div>';

  try {
    const data = await api(`/api/users/${state.userId}/billing-history?page=${_page}&perPage=${PER_PAGE}`);

    if (!data.entries.length && _page === 1) {
      content.innerHTML = '<p class="muted" style="padding:24px;">No billing history yet.</p>';
      return;
    }

    const summaryHtml = `
      <div style="margin-bottom:16px;padding:12px 16px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);display:flex;gap:24px;flex-wrap:wrap;">
        <div>
          <span class="text-xs muted">Current balance</span>
          <div style="font-size:18px;font-weight:700;color:var(--accent);">${data.credits} cr</div>
        </div>
        <div>
          <span class="text-xs muted">Total purchased</span>
          <div style="font-size:18px;font-weight:700;">$${data.totalDollars.toFixed(2)}</div>
        </div>
        <div>
          <span class="text-xs muted">Total credits charged</span>
          <div style="font-size:18px;font-weight:700;color:var(--text-success,#4ade80);">${data.totalCredits} cr</div>
        </div>
        <div>
          <span class="text-xs muted">Transactions</span>
          <div style="font-size:18px;font-weight:700;">${data.total}</div>
        </div>
      </div>
    `;

    const rowsHtml = data.entries.map(e => `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:8px 12px;white-space:nowrap;">${formatTime(e.date)}</td>
        <td style="padding:8px 12px;font-weight:600;">$${e.dollars.toFixed(2)}</td>
        <td style="padding:8px 12px;font-weight:600;color:var(--text-success,#4ade80);">+${e.credits} cr</td>
        <td style="padding:8px 12px;color:var(--text-muted);">$1 = 100 cr</td>
      </tr>`).join('');

    const paginationHtml = data.totalPages > 1 ? `
      <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-top:16px;">
        <button class="btn btn-outline btn-xs" id="bill-prev" ${_page <= 1 ? 'disabled' : ''}>Previous</button>
        <span class="text-sm muted">Page ${data.page} of ${data.totalPages} (${data.total} entries)</span>
        <button class="btn btn-outline btn-xs" id="bill-next" ${_page >= data.totalPages ? 'disabled' : ''}>Next</button>
      </div>
    ` : `<div class="text-xs muted" style="text-align:center;margin-top:8px;">${data.total} entr${data.total !== 1 ? 'ies' : 'y'} total</div>`;

    content.innerHTML = `
      <div style="max-width:960px;margin:0 24px;">
        ${summaryHtml}
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="border-bottom:2px solid var(--border);text-align:left;">
              <th class="text-sm" style="padding:8px 12px;">Date</th>
              <th class="text-sm" style="padding:8px 12px;">Paid ($)</th>
              <th class="text-sm" style="padding:8px 12px;">Credits Charged</th>
              <th class="text-sm" style="padding:8px 12px;">Rate</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        ${paginationHtml}
        <div style="margin-top:16px;">
          <a href="/dashboard" class="text-accent text-sm">&larr; Back to dashboard</a>
        </div>
      </div>
    `;

    const prevBtn = document.getElementById('bill-prev');
    const nextBtn = document.getElementById('bill-next');
    if (prevBtn) prevBtn.addEventListener('click', () => { _page--; loadPage(); });
    if (nextBtn) nextBtn.addEventListener('click', () => { _page++; loadPage(); });

  } catch (err) {
    content.innerHTML = `<p class="text-danger" style="padding:24px;">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
}

document.addEventListener('DOMContentLoaded', bootstrap);
