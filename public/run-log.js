import { state, api, initAuth, escapeHtml, renderNavBar } from '/shared.js';

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

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function bootstrap() {
  const user = await initAuth();
  if (!user) { window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname + window.location.search); return; }
  renderNavBar({ active: 'dashboard', user });

  const params = new URLSearchParams(window.location.search);
  const runId = params.get('id');
  const from = params.get('from'); // 'agent' or 'user' — for the back link
  const agentId = params.get('agentId');

  const content = document.getElementById('run-log-content');

  if (!runId) {
    content.innerHTML = '<div class="empty-state"><h2>No run specified</h2></div>';
    return;
  }

  try {
    const { log, agentName } = await api(`/api/run-logs/${encodeURIComponent(runId)}?actorUserId=${encodeURIComponent(user.id)}`);
    document.getElementById('page-title').textContent = `Run Log — ${agentName}`;
    document.title = `Run Log — ${agentName} | Soup`;

    const duration = formatDuration(log.startedAt, log.finishedAt);
    const steps = log.steps || [];
    const phaseLabels = { browse: 'Browse', external_search: 'Ext. Search', create: 'Create' };

    const phaseGroups = [];
    let currentPhase = null;
    for (const step of steps) {
      if (step.phase !== currentPhase) {
        currentPhase = step.phase;
        phaseGroups.push({ phase: currentPhase, steps: [] });
      }
      phaseGroups[phaseGroups.length - 1].steps.push(step);
    }

    const summaryHtml = `
      <div style="margin-bottom:16px;padding:12px 16px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);display:flex;gap:24px;flex-wrap:wrap;">
        <div>
          <span class="text-xs muted">Agent</span>
          <div style="font-size:16px;font-weight:600;">${escapeHtml(agentName)}</div>
        </div>
        <div>
          <span class="text-xs muted">Started</span>
          <div style="font-size:14px;">${formatDateTime(log.startedAt)}</div>
        </div>
        <div>
          <span class="text-xs muted">Duration</span>
          <div style="font-size:14px;">${duration}</div>
        </div>
        <div>
          <span class="text-xs muted">Steps</span>
          <div style="font-size:14px;">${log.stepsExecuted || steps.length}</div>
        </div>
        <div>
          <span class="text-xs muted">Run ID</span>
          <div style="font-size:12px;font-family:monospace;color:var(--text-muted);">${escapeHtml(log.id)}</div>
        </div>
      </div>
    `;

    const phasesHtml = phaseGroups.map(group => `
      <div class="run-log-panel">
        <div class="run-log-panel-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="run-log-panel-toggle">▶</span>
          <span class="run-log-panel-title">${escapeHtml(phaseLabels[group.phase] || group.phase)} <span class="muted text-xs">(${group.steps.length} steps)</span></span>
        </div>
        <div class="run-log-panel-body">
          ${group.steps.map(step => `
            <div class="run-step">
              <span class="run-step-action">${escapeHtml(step.action)}</span>
              <div class="run-step-result">${escapeHtml(step.result?.summary || '')}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');

    const backHref = from === 'agent' && agentId
      ? `/cost-history?agentId=${escapeHtml(agentId)}`
      : '/cost-history';
    const backLabel = from === 'agent' ? '&larr; Back to agent bill history' : '&larr; Back to bill history';

    content.innerHTML = `
      <div style="max-width:960px;margin:0 24px;">
        ${summaryHtml}
        ${phasesHtml.length ? phasesHtml : '<p class="muted">No steps recorded for this run.</p>'}
        <div style="margin-top:16px;">
          <a href="${backHref}" class="text-accent text-sm">${backLabel}</a>
        </div>
      </div>
    `;
  } catch (err) {
    content.innerHTML = `<p class="text-danger" style="padding:24px;">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
}

document.addEventListener('DOMContentLoaded', bootstrap);
