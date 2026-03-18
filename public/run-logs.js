import { state, api, initAuth, escapeHtml, formatDateTime, renderNavBar } from '/shared.js';

function formatDuration(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return '—';
  const ms = new Date(finishedAt) - new Date(startedAt);
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}

const params = new URLSearchParams(window.location.search);
const agentId = params.get('agentId');

let _page = 1;
const PER_PAGE = 10;

async function bootstrap() {
  const user = await initAuth();
  if (!user) { window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname + window.location.search); return; }
  renderNavBar({ active: 'dashboard', user });

  if (!agentId) {
    document.getElementById('run-logs-content').innerHTML = '<div class="empty-state"><h2>No agent specified</h2></div>';
    return;
  }

  await loadPage();
}

async function loadPage() {
  const content = document.getElementById('run-logs-content');
  content.innerHTML = '<div class="spinner"></div>';

  try {
    const { logs, page, total, totalPages, agentName: name } = await api(
      `/api/agents/${encodeURIComponent(agentId)}/run-logs?actorUserId=${encodeURIComponent(state.userId)}&page=${_page}&perPage=${PER_PAGE}`
    );

    const agentName = name || agentId;
    document.getElementById('page-title').textContent = `Run Logs — ${agentName}`;
    document.title = `Run Logs — ${agentName} | Soup`;

    if (!logs.length && page === 1) {
      content.innerHTML = `
        <div style="max-width:960px;margin:0 24px;">
          <p class="muted">No run logs yet.</p>
          <div style="margin-top:16px;">
            <a href="/configure?id=${escapeHtml(agentId)}" class="text-accent text-sm">&larr; Back to configuration</a>
          </div>
        </div>`;
      return;
    }

    const phaseLabels = { browse: 'Browse', external_search: 'Ext. Search', create: 'Create' };

    const logsHtml = logs.map((log, idx) => {
      const steps = log.steps || [];
      const phaseGroups = [];
      let currentPhase = null;
      for (const step of steps) {
        if (step.phase !== currentPhase) {
          currentPhase = step.phase;
          phaseGroups.push({ phase: currentPhase, steps: [] });
        }
        phaseGroups[phaseGroups.length - 1].steps.push(step);
      }
      const collapsed = idx > 0 ? ' collapsed' : '';
      const duration = formatDuration(log.startedAt, log.finishedAt);
      const runLabel = `Run ${formatDateTime(log.startedAt)} · ${log.stepsExecuted} steps · ${duration}`;
      return `
        <div class="run-log-panel${collapsed}">
          <div class="run-log-panel-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="run-log-panel-toggle">▶</span>
            <span class="run-log-panel-title">${runLabel}</span>
            <span class="run-log-id">${escapeHtml(log.id)}</span>
          </div>
          <div class="run-log-panel-body">
            ${phaseGroups.map(group => `
              <div class="run-phase-group">
                <div class="run-phase-header">${escapeHtml(phaseLabels[group.phase] || group.phase)} <span class="muted text-xs">(${group.steps.length} steps)</span></div>
                ${group.steps.map(step => `
                  <div class="run-step">
                    <span class="run-step-action">${escapeHtml(step.action)}</span>
                    <div class="run-step-result">${escapeHtml(step.result?.summary || '')}</div>
                  </div>
                `).join('')}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }).join('');

    const paginationHtml = totalPages > 1 ? `
      <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-top:16px;">
        <button class="btn btn-outline btn-xs" id="logs-prev" ${page <= 1 ? 'disabled' : ''}>Previous</button>
        <span class="text-sm muted">Page ${page} of ${totalPages} (${total} runs)</span>
        <button class="btn btn-outline btn-xs" id="logs-next" ${page >= totalPages ? 'disabled' : ''}>Next</button>
      </div>
    ` : `<div class="text-xs muted" style="text-align:center;margin-top:8px;">${total} run${total !== 1 ? 's' : ''} total</div>`;

    content.innerHTML = `
      <div style="max-width:960px;margin:0 24px;">
        ${logsHtml}
        ${paginationHtml}
        <div style="margin-top:16px;">
          <a href="/configure?id=${escapeHtml(agentId)}" class="text-accent text-sm">&larr; Back to configuration</a>
        </div>
      </div>
    `;

    const prevBtn = document.getElementById('logs-prev');
    const nextBtn = document.getElementById('logs-next');
    if (prevBtn) prevBtn.addEventListener('click', () => { _page--; loadPage(); });
    if (nextBtn) nextBtn.addEventListener('click', () => { _page++; loadPage(); });
  } catch (err) {
    content.innerHTML = `<p class="text-danger" style="padding:24px;">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
}

document.addEventListener('DOMContentLoaded', bootstrap);
