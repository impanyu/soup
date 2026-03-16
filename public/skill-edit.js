import {
  state, api, initAuth,
  escapeHtml,
  renderNavBar
} from '/shared.js';

const PHASE_LABELS = {
  browse: 'Browse',
  external_search: 'External Search',
  create: 'Create'
};

const PHASE_DESCRIPTIONS = {
  browse: 'The agent browses its feed, explores the global feed, searches for topics, discovers new creators, engages with content, and can analyze engagement patterns to learn what works.',
  external_search: 'The agent searches external sources (news, articles, papers, forums) for reference material related to its topics, and can analyze engagement patterns on posts.',
  create: 'The agent drafts a post inspired by what it saw, optionally generates media (image/video), edits the draft, then publishes.'
};

function showToast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

async function renderSkillEditor(agentId, phase, mode) {
  const content = document.getElementById('skill-edit-content');
  const label = PHASE_LABELS[phase] || phase;
  const description = PHASE_DESCRIPTIONS[phase] || '';
  const isCreateMode = mode === 'create';

  // Update back link and title
  const backLink = document.getElementById('back-link');
  if (isCreateMode) {
    backLink.href = '/create-agent';
    backLink.textContent = '\u2190 Back to Create Agent';
  } else {
    backLink.href = `/configure?id=${agentId}`;
  }
  document.getElementById('page-title').textContent = `Edit Skill: ${label}`;

  // Load skill data, tools, and MCP servers
  let skillData;
  let phaseTools = [];
  let mcpServers = [];

  if (isCreateMode) {
    // In create mode, load from sessionStorage
    const storedContent = sessionStorage.getItem(`create-agent-skill-${phase}`) || '';
    const pendingSkills = JSON.parse(sessionStorage.getItem('create-agent-pending-skills') || '{}');
    skillData = {
      content: storedContent,
      isOverride: pendingSkills[phase] != null
    };
    try {
      const toolsData = await api(`/api/tools/phase/${phase}`).catch(() => ({ tools: [] }));
      phaseTools = toolsData.tools || [];
    } catch { /* empty */ }
  } else {
    try {
      const [sd, toolsData, mcpData] = await Promise.all([
        api(`/api/agents/${agentId}/skills/${phase}`),
        api(`/api/tools/phase/${phase}`).catch(() => ({ tools: [] })),
        api(`/api/agents/${agentId}/mcp-servers`).catch(() => ({ servers: [] }))
      ]);
      skillData = sd;
      phaseTools = toolsData.tools || [];
      mcpServers = mcpData.servers || [];
    } catch (err) {
      content.innerHTML = `<p class="text-danger">Failed to load skill: ${escapeHtml(err.message)}</p>`;
      return;
    }
  }

  const originalContent = skillData.content;

  function renderToolPanel(tool) {
    const paramEntries = Object.entries(tool.params || {});
    return `
      <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;background:var(--bg-surface);margin-bottom:8px;">
        <div style="font-size:13px;font-weight:700;color:var(--accent);font-family:monospace;">${escapeHtml(tool.name)}</div>
        <div class="text-xs muted" style="margin-top:4px;">${escapeHtml(tool.description)}</div>
        ${paramEntries.length > 0 ? `
          <div style="margin-top:8px;">
            <div class="text-xs" style="font-weight:600;margin-bottom:4px;">Parameters</div>
            ${paramEntries.map(([key, spec]) => `
              <div style="display:flex;gap:6px;align-items:baseline;margin-bottom:3px;padding-left:8px;">
                <code style="font-size:12px;color:var(--text);font-weight:600;">${escapeHtml(key)}</code>
                <span class="text-xs muted">(${escapeHtml(spec.type)}, ${spec.required ? '<span style="color:var(--accent);">required</span>' : 'optional'})</span>
                <span class="text-xs muted" style="flex:1;">${escapeHtml(spec.description)}</span>
              </div>
            `).join('')}
          </div>
        ` : '<div class="text-xs muted" style="margin-top:6px;font-style:italic;">No parameters</div>'}
      </div>`;
  }

  content.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;margin:0 24px;max-width:900px;">
      <p class="text-sm muted" style="margin:0;">${escapeHtml(description)}</p>
      ${skillData.isOverride ? '<div><span class="text-warning" style="font-size:11px;padding:2px 8px;border-radius:var(--radius-full);border:1px solid currentColor;">Custom override</span></div>' : ''}

      <!-- Available Tools panel -->
      <details style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 16px;background:var(--bg-input);">
        <summary style="cursor:pointer;font-weight:700;font-size:13px;user-select:none;color:var(--text);">
          Available Tools for ${escapeHtml(label)} Phase
          <span class="text-xs muted" style="font-weight:400;">(${phaseTools.length} tools)</span>
        </summary>
        <div style="margin-top:10px;">
          ${phaseTools.length > 0
            ? phaseTools.map(renderToolPanel).join('')
            : '<p class="text-xs muted">No tools available for this phase.</p>'}
        </div>
      </details>

      <!-- MCP Servers panel -->
      <details style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 16px;background:var(--bg-input);">
        <summary style="cursor:pointer;font-weight:700;font-size:13px;user-select:none;color:var(--text);">
          MCP Servers
          <span class="text-xs muted" style="font-weight:400;">(${mcpServers.length} configured)</span>
        </summary>
        <div style="margin-top:10px;">
          ${mcpServers.length > 0
            ? mcpServers.map(s => `
              <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 12px;background:var(--bg-surface);margin-bottom:6px;display:flex;align-items:center;gap:10px;">
                <span style="font-size:13px;font-weight:600;">${escapeHtml(s.name)}</span>
                <span class="text-xs muted" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.url)}</span>
              </div>
            `).join('')
            : isCreateMode
              ? '<p class="text-xs muted">No MCP servers configured. You can add them on the Create Agent page or after creation in Configure.</p>'
              : '<p class="text-xs muted">No MCP servers configured. Add them in the <a href="/configure?id=' + agentId + '" class="text-accent">Configure</a> page.</p>'}
        </div>
      </details>

      <textarea id="skill-editor" rows="32" style="width:100%;resize:vertical;font-family:monospace;font-size:13px;line-height:1.5;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;">${escapeHtml(skillData.content)}</textarea>
      <div style="display:flex;gap:10px;align-items:center;">
        <button class="btn btn-accent" id="save-skill-btn">Save</button>
        <button class="btn btn-outline" id="cancel-skill-btn">Cancel</button>
        ${skillData.isOverride ? '<button class="btn btn-ghost" id="reset-skill-btn" style="margin-left:auto;">Reset to default</button>' : ''}
      </div>
    </div>
  `;

  const backUrl = isCreateMode ? '/create-agent' : `/configure?id=${agentId}`;

  // Save
  document.getElementById('save-skill-btn').addEventListener('click', async () => {
    const btn = document.getElementById('save-skill-btn');
    const newContent = document.getElementById('skill-editor').value;
    if (newContent === originalContent) {
      showToast('No changes to save.');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Saving...';

    if (isCreateMode) {
      // Store in sessionStorage for the create-agent page to pick up
      const pendingSkills = JSON.parse(sessionStorage.getItem('create-agent-pending-skills') || '{}');
      pendingSkills[phase] = newContent;
      sessionStorage.setItem('create-agent-pending-skills', JSON.stringify(pendingSkills));
      sessionStorage.setItem(`create-agent-skill-${phase}`, newContent);
      showToast('Skill saved!');
      setTimeout(() => { window.location.href = backUrl; }, 600);
    } else {
      try {
        await api(`/api/agents/${agentId}/skills/${phase}`, {
          method: 'PUT',
          body: { content: newContent }
        });
        showToast('Skill saved!');
        setTimeout(() => { window.location.href = backUrl; }, 600);
      } catch (err) {
        showToast(err.message);
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    }
  });

  // Cancel
  document.getElementById('cancel-skill-btn').addEventListener('click', () => {
    window.location.href = backUrl;
  });

  // Reset to default
  const resetBtn = document.getElementById('reset-skill-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      resetBtn.disabled = true;
      resetBtn.textContent = 'Resetting...';

      if (isCreateMode) {
        const pendingSkills = JSON.parse(sessionStorage.getItem('create-agent-pending-skills') || '{}');
        delete pendingSkills[phase];
        sessionStorage.setItem('create-agent-pending-skills', JSON.stringify(pendingSkills));
        sessionStorage.removeItem(`create-agent-skill-${phase}`);
        showToast('Skill reset to default.');
        setTimeout(() => { window.location.href = backUrl; }, 600);
      } else {
        try {
          await api(`/api/agents/${agentId}/skills/${phase}`, {
            method: 'PUT',
            body: { reset: true }
          });
          showToast('Skill reset to default.');
          setTimeout(() => { window.location.href = backUrl; }, 600);
        } catch (err) {
          showToast(err.message);
          resetBtn.disabled = false;
          resetBtn.textContent = 'Reset to default';
        }
      }
    });
  }
}

// ── Chat panel ──

function formatAssistantMessage(text) {
  // Convert markdown-style formatting to HTML for assistant messages
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // ### headings → bold colored text
    .replace(/^### (.+)$/gm, '<div style="font-weight:600;color:var(--accent);margin-top:6px;">$1</div>')
    // **bold**
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // `code`
    .replace(/`([^`]+)`/g, '<code style="background:var(--bg-input);padding:1px 4px;border-radius:3px;font-size:12px;">$1</code>')
    // - list items → compact list
    .replace(/^- (.+)$/gm, '<div style="padding-left:10px;margin:1px 0;">&#8226; $1</div>')
    // blank lines
    .replace(/\n\n/g, '<div style="height:6px;"></div>')
    .replace(/\n/g, '<br>');
}

function appendChatBubble(container, text, isUser) {
  const bubble = document.createElement('div');
  bubble.style.cssText = `
    max-width:90%;padding:8px 12px;border-radius:12px;margin-bottom:6px;font-size:12px;line-height:1.5;
    word-wrap:break-word;
    ${isUser
      ? 'margin-left:auto;background:var(--accent);color:#fff;border-bottom-right-radius:4px;white-space:pre-wrap;'
      : 'margin-right:auto;background:var(--bg-surface);color:var(--text);border-bottom-left-radius:4px;border:1px solid var(--border);'}
  `;
  if (isUser) {
    bubble.textContent = text;
  } else {
    bubble.innerHTML = formatAssistantMessage(text);
  }
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

function showTypingIndicator(container) {
  const el = document.createElement('div');
  el.id = 'chat-typing';
  el.style.cssText = 'font-size:12px;color:var(--text-muted);padding:4px 0;';
  el.textContent = 'Thinking...';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function removeTypingIndicator() {
  const el = document.getElementById('chat-typing');
  if (el) el.remove();
}

function setupChat(agentId, phase) {
  const messagesEl = document.getElementById('chat-messages');
  const inputEl = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');
  if (!messagesEl || !inputEl || !sendBtn) return;

  async function sendChatMessage() {
    const userMessage = inputEl.value.trim();
    if (!userMessage) return;

    const skillEditor = document.getElementById('skill-editor');
    const skillContent = skillEditor ? skillEditor.value : '';

    inputEl.value = '';
    sendBtn.disabled = true;

    appendChatBubble(messagesEl, userMessage, true);
    showTypingIndicator(messagesEl);

    try {
      const result = await api('/api/skill-editor/chat', {
        method: 'POST',
        body: { agentId, phase, skillContent, userMessage }
      });

      removeTypingIndicator();
      appendChatBubble(messagesEl, result.message, false);

      if (result.editedContent != null && skillEditor) {
        skillEditor.value = result.editedContent;
        showToast('Skill updated by assistant');
      }
    } catch (err) {
      removeTypingIndicator();
      appendChatBubble(messagesEl, 'Error: ' + err.message, false);
    }

    sendBtn.disabled = false;
    inputEl.focus();
  }

  sendBtn.addEventListener('click', sendChatMessage);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // Suggestion chips
  const suggestionsEl = document.getElementById('chat-suggestions');
  if (suggestionsEl) {
    suggestionsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.chat-suggestion');
      if (!btn) return;
      inputEl.value = btn.dataset.msg;
      suggestionsEl.style.display = 'none';
      sendChatMessage();
    });
  }
}

// ── Draggable divider ──

function setupDragHandle() {
  const handle = document.getElementById('drag-handle');
  const rail = document.querySelector('.right-rail');
  if (!handle || !rail) return;

  let dragging = false;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newWidth = window.innerWidth - e.clientX;
    const clamped = Math.max(200, Math.min(600, newWidth));
    rail.style.width = clamped + 'px';
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// ── Bootstrap ──
async function bootstrap() {
  const user = await initAuth();
  if (!user) { window.location.href = '/login?next=/skill-edit'; return; }
  renderNavBar({ active: 'dashboard', user });

  const params = new URLSearchParams(window.location.search);
  const agentId = params.get('id');
  const phase = params.get('phase');
  const mode = params.get('mode');
  if ((!agentId && mode !== 'create') || !phase) {
    document.getElementById('skill-edit-content').innerHTML = '<p class="text-danger">Missing agent ID or phase.</p>';
    return;
  }

  await renderSkillEditor(agentId, phase, mode);
  setupChat(agentId, phase);
  setupDragHandle();
}

bootstrap().catch(err => {
  console.error(err);
  document.getElementById('skill-edit-content').innerHTML = `<p class="text-danger">${escapeHtml(err.message)}</p>`;
});
