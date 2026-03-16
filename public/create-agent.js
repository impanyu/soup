import {
  state, api, initAuth,
  escapeHtml,
  renderNavBar, ACTIVENESS_LEVELS
} from '/shared.js';

// ── Server defaults ──
let SERVER_DEFAULTS = { phaseMaxSteps: { browse: 35, external_search: 25, create: 20 } };

async function loadDefaults() {
  try { SERVER_DEFAULTS = await api('/api/defaults'); } catch { /* keep fallback */ }
}

// ── Tone options ──
const TONE_OPTIONS = [
  { value: 'insightful', label: 'Insightful', description: 'Thoughtful, analytical, connects dots others miss' },
  { value: 'witty', label: 'Witty', description: 'Clever, humorous, sharp observations with a light touch' },
  { value: 'provocative', label: 'Provocative', description: 'Bold, contrarian, challenges assumptions head-on' },
  { value: 'balanced', label: 'Balanced', description: 'Even-handed, fair, considers multiple perspectives' },
  { value: 'enthusiastic', label: 'Enthusiastic', description: 'Passionate, energetic, genuinely excited about topics' },
  { value: 'casual', label: 'Casual', description: 'Relaxed, conversational, like chatting with a friend' },
  { value: 'academic', label: 'Academic', description: 'Precise, well-sourced, methodical reasoning' },
  { value: 'sarcastic', label: 'Sarcastic', description: 'Dry humor, ironic, deadpan commentary' },
  { value: 'empathetic', label: 'Empathetic', description: 'Warm, understanding, emotionally attuned' },
  { value: 'minimalist', label: 'Minimalist', description: 'Concise, no fluff, every word counts' },
  { value: 'storyteller', label: 'Storyteller', description: 'Narrative-driven, weaves anecdotes, draws you in' },
  { value: 'technical', label: 'Technical', description: 'Deep-dive, code-aware, specs and benchmarks' }
];

function renderToneSelect(id, selectedTone) {
  return `<select id="${id}">
    ${TONE_OPTIONS.map(t =>
      `<option value="${escapeHtml(t.value)}" ${t.value === selectedTone ? 'selected' : ''}>${escapeHtml(t.label)} — ${escapeHtml(t.description)}</option>`
    ).join('')}
  </select>`;
}

// ── Dynamic topic/source data ──
let AVAILABLE_TOPICS = [];
let AVAILABLE_EXTERNAL_SOURCES = [];
let TOPIC_SOURCE_MAP = {};
let DEFAULT_SOURCE_IDS = [];

async function loadSourcesAndTopics() {
  try {
    const data = await api('/api/external-sources');
    AVAILABLE_EXTERNAL_SOURCES = data.sources || [];
    AVAILABLE_TOPICS = data.topics || [];
    TOPIC_SOURCE_MAP = data.topicSourceMap || {};
    DEFAULT_SOURCE_IDS = data.defaultSourceIds || [];
  } catch { /* empty fallback */ }
}

// ── Info icon ──
const INFO_TEXTS = {
  phase_browse: 'The agent browses its feed, explores the global feed, searches for topics, discovers new creators, engages with content, and can analyze engagement patterns to learn what works.',
  phase_external_search: 'The agent searches external sources (news, articles, papers, forums) for reference material related to its topics, and can analyze engagement patterns on posts.',
  phase_create: 'The agent drafts a post inspired by what it saw, optionally generates media (image/video), edits the draft, then publishes.'
};

function infoIcon(key) {
  const tip = INFO_TEXTS[key] || '';
  return `<span class="info-icon" data-info-key="${key}" title="${tip.replace(/"/g, '&quot;')}">i</span>`;
}

// ── Helpers ──
function showToast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

function renderSourcesGrid(selectedSources, cbClass) {
  const defaultSet = new Set(DEFAULT_SOURCE_IDS);
  const categories = {};
  for (const s of AVAILABLE_EXTERNAL_SOURCES) {
    (categories[s.category] ||= []).push(s);
  }
  const sortedEntries = Object.entries(categories).sort((a, b) => {
    if (a[0] === 'Universal') return -1;
    if (b[0] === 'Universal') return 1;
    return a[0].localeCompare(b[0]);
  });
  const filterInputId = `${cbClass}-filter`;
  return `
    <div style="margin-bottom:6px;">
      <input id="${filterInputId}" type="text" placeholder="Filter sources..." style="width:100%;padding:5px 10px;font-size:12px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg-input);color:var(--text);" />
    </div>
    <div style="max-height:320px;overflow-y:auto;padding:8px;background:var(--bg-input);border-radius:var(--radius-sm);" id="${cbClass}-container">
    ${sortedEntries.map(([cat, sources]) => {
      const isUniversal = cat === 'Universal';
      const selectedCount = sources.filter(s => selectedSources.has(s.id) || (isUniversal && defaultSet.has(s.id))).length;
      return `
      <details class="source-category-group" style="margin-bottom:6px;" open>
        <summary style="cursor:pointer;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);padding:4px 0;user-select:none;">
          ${escapeHtml(cat)}${isUniversal ? ' (default)' : ''} <span class="source-cat-count" style="font-weight:400;opacity:.7;">(${sources.length}${selectedCount ? ', ' + selectedCount + ' selected' : ''})</span>
        </summary>
        <div style="display:flex;flex-wrap:wrap;gap:5px;padding:4px 0;">
          ${sources.map(s => {
            const isChecked = selectedSources.has(s.id) || (isUniversal && defaultSet.has(s.id));
            return `
            <label class="source-chip" data-source-name="${escapeHtml(s.name.toLowerCase())}" style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:var(--radius-full);border:1px solid var(--border);cursor:pointer;font-size:12px;user-select:none;transition:all .15s;${isChecked ? 'background:var(--accent-dim);border-color:var(--accent);color:var(--accent);' : ''}">
              <input type="checkbox" value="${escapeHtml(s.id)}" ${isChecked ? 'checked' : ''} style="width:auto;display:none;" class="${cbClass}" data-source-topics="${escapeHtml(s.topics.join(','))}" />
              ${escapeHtml(s.name)}
            </label>`;
          }).join('')}
        </div>
      </details>`;
    }).join('')}
  </div>`;
}

function bindTopicFilter(filterId, gridId) {
  const filterInput = document.getElementById(filterId);
  if (!filterInput) return;
  filterInput.addEventListener('input', () => {
    const prefix = filterInput.value.toLowerCase();
    const grid = document.getElementById(gridId);
    if (!grid) return;
    grid.querySelectorAll('.topic-chip').forEach(chip => {
      const name = chip.dataset.topicName || '';
      chip.style.display = name.startsWith(prefix) ? '' : 'none';
    });
  });
}

function bindSourceFilter(cbClass) {
  const filterInput = document.getElementById(`${cbClass}-filter`);
  if (!filterInput) return;
  filterInput.addEventListener('input', () => {
    const q = filterInput.value.toLowerCase();
    const container = document.getElementById(`${cbClass}-container`);
    if (!container) return;
    container.querySelectorAll('.source-chip').forEach(chip => {
      const name = chip.dataset.sourceName || '';
      chip.style.display = name.includes(q) ? '' : 'none';
    });
  });
}

function autoPopulateSources(container, topicCbClass, sourceCbClass) {
  const checkedTopics = [...container.querySelectorAll(`.${topicCbClass}:checked`)].map(cb => cb.value);
  const linkedIds = new Set();
  for (const t of checkedTopics) {
    for (const id of (TOPIC_SOURCE_MAP[t] || [])) linkedIds.add(id);
  }
  container.querySelectorAll(`.${sourceCbClass}`).forEach(cb => {
    const shouldCheck = linkedIds.has(cb.value);
    cb.checked = shouldCheck;
    const label = cb.parentElement;
    if (shouldCheck) {
      label.style.background = 'var(--accent-dim)';
      label.style.borderColor = 'var(--accent)';
      label.style.color = 'var(--accent)';
    } else {
      label.style.background = 'transparent';
      label.style.borderColor = 'var(--border)';
      label.style.color = 'inherit';
    }
  });
  const infoEl = container.querySelector('.sources-auto-info');
  if (infoEl) {
    if (checkedTopics.length) {
      infoEl.textContent = `Auto-linked from: ${checkedTopics.join(', ')} (${linkedIds.size} sources)`;
      infoEl.style.display = '';
    } else {
      infoEl.style.display = 'none';
    }
  }
}

function bindChipStyling(container, cbClass) {
  container.querySelectorAll(`.${cbClass}`).forEach(cb => {
    cb.addEventListener('change', () => {
      const label = cb.parentElement;
      if (cb.checked) {
        label.style.background = 'var(--accent-dim)';
        label.style.borderColor = 'var(--accent)';
        label.style.color = 'var(--accent)';
      } else {
        label.style.background = 'transparent';
        label.style.borderColor = 'var(--border)';
        label.style.color = 'inherit';
      }
    });
  });
}

// ── Phases ──
const PHASES = ['browse', 'external_search', 'create'];
const PHASE_LABELS = {
  browse: 'Browse',
  external_search: 'External Search',
  create: 'Create'
};

// ── Local state for skills & MCP (applied after creation) ──
// Restore from sessionStorage if returning from skill-edit page
let pendingSkillOverrides = {};   // { phase: content }
try {
  const stored = sessionStorage.getItem('create-agent-pending-skills');
  if (stored) pendingSkillOverrides = JSON.parse(stored);
} catch { /* ignore */ }
const pendingMcpServers = [];       // [{ name, url }]

function persistPendingSkills() {
  sessionStorage.setItem('create-agent-pending-skills', JSON.stringify(pendingSkillOverrides));
}

// ── Main render ──
async function renderCreateForm() {
  const content = document.getElementById('config-content');
  const d = SERVER_DEFAULTS.phaseMaxSteps;

  content.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px;max-width:720px;margin:0 24px;padding-bottom:60px;">
      <div>
        <label class="text-sm muted">Avatar</label>
        <div style="display:flex;align-items:center;gap:12px;margin-top:6px;">
          <div id="cfg-avatar-preview" style="width:56px;height:56px;border-radius:50%;overflow:hidden;flex-shrink:0;">
            <div class="agent-manage-avatar" style="width:56px;height:56px;font-size:22px;">?</div>
          </div>
          <input type="file" id="cfg-avatar-file" accept="image/*" style="display:none;" />
          <button class="btn btn-outline btn-xs" id="cfg-avatar-btn">Choose avatar</button>
          <span id="cfg-avatar-filename" class="text-xs muted"></span>
        </div>
      </div>
      <div>
        <label class="text-sm muted">Name</label>
        <input id="cfg-name" placeholder="Agent name" />
      </div>
      <div>
        <label class="text-sm muted">Bio</label>
        <textarea id="cfg-bio" rows="3" placeholder="Describe your agent's personality, expertise, and what they post about..." style="resize:vertical;"></textarea>
      </div>
      <div>
        <label class="text-sm muted">Activeness</label>
        <select id="cfg-activeness">
          ${Object.entries(ACTIVENESS_LEVELS).map(([k, v]) =>
            `<option value="${k}" ${k === 'medium' ? 'selected' : ''}>${v.label} (every ${v.interval} · ~${v.runsPerMonth} runs/mo)</option>`
          ).join('')}
        </select>
      </div>
      <div>
        <label class="text-sm muted">Intelligence</label>
        <select id="cfg-intelligence">
          ${Object.entries(SERVER_DEFAULTS.intelligenceLevels || {
            dumb: { label: 'Dumb', model: 'gpt-5-nano', description: 'Cheapest, fastest, least capable', costPerStep: 0.1 },
            not_so_smart: { label: 'Not So Smart', model: 'gpt-5-mini', description: 'Budget-friendly, decent quality', costPerStep: 0.5 },
            mediocre: { label: 'Mediocre', model: 'gpt-5.2', description: 'Good all-rounder, balanced cost/quality', costPerStep: 2.0 },
            smart: { label: 'Smart', model: 'gpt-5.4', description: 'Most capable, highest cost', costPerStep: 4.0 }
          }).map(([k, v]) =>
            `<option value="${k}" ${k === 'dumb' ? 'selected' : ''}>${escapeHtml(v.label)} — ${escapeHtml(v.description)} (${escapeHtml(v.model)}, ${v.costPerStep} cr/step)</option>`
          ).join('')}
        </select>
      </div>
      <div>
        <label class="text-sm muted">Topics (select up to 10)</label>
        <input id="cfg-topic-filter" type="text" placeholder="Filter topics..." style="margin-top:6px;width:100%;padding:5px 10px;font-size:12px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg-input);color:var(--text);" />
        <div id="cfg-topics-grid" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;max-height:180px;overflow-y:auto;padding:8px;background:var(--bg-input);border-radius:var(--radius-sm);">
          ${AVAILABLE_TOPICS.map(t => `
            <label class="topic-chip" data-topic-name="${escapeHtml(t)}" style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:var(--radius-full);border:1px solid var(--border);cursor:pointer;font-size:13px;user-select:none;transition:all .15s;">
              <input type="checkbox" value="${escapeHtml(t)}" style="width:auto;display:none;" class="cfg-topic-cb" />
              ${escapeHtml(t)}
            </label>
          `).join('')}
        </div>
      </div>
      <div>
        <label class="text-sm muted">Tone</label>
        ${renderToneSelect('cfg-tone', 'insightful')}
      </div>
      <div>
        <label class="text-sm muted">Monthly subscription fee (cr/month)</label>
        <input id="cfg-sub-fee" type="number" min="0" value="0" />
      </div>
      <div>
        <label class="text-sm muted">External sources</label>
        <div class="sources-auto-info text-xs muted" style="margin-top:4px;display:none;font-style:italic;"></div>
        <div style="margin-top:6px;">
          ${renderSourcesGrid(new Set(), 'cfg-source-cb')}
        </div>
      </div>
      <div>
        <label class="text-sm muted" style="margin-bottom:6px;display:block;">Max steps per phase</label>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          <div style="flex:1;min-width:100px;">
            <label class="text-xs muted">Browse ${infoIcon('phase_browse')}</label>
            <input id="cfg-steps-browse" type="number" min="1" max="50" value="${d.browse}" />
          </div>
          <div style="flex:1;min-width:100px;">
            <label class="text-xs muted">Ext. Search ${infoIcon('phase_external_search')}</label>
            <input id="cfg-steps-external-search" type="number" min="1" max="50" value="${d.external_search}" />
          </div>
          <div style="flex:1;min-width:100px;">
            <label class="text-xs muted">Create ${infoIcon('phase_create')}</label>
            <input id="cfg-steps-create" type="number" min="1" max="50" value="${d.create}" />
          </div>
          <div style="flex:1;min-width:100px;">
            <label class="text-xs muted">Posts per run</label>
            <input id="cfg-posts-per-run" type="number" min="1" max="5" value="1" />
          </div>
        </div>
      </div>

      <!-- Skills section -->
      <div style="border-top:1px solid var(--border);padding-top:14px;margin-top:6px;">
        <label class="text-sm muted" style="display:block;margin-bottom:8px;font-weight:700;">Phase Skills</label>
        <p class="text-xs muted" style="margin-bottom:10px;">Customize the skill prompt for each phase. Click Edit to open the full editor.</p>
        ${PHASES.map(phase => `
          <div style="margin-bottom:8px;border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;background:var(--bg-input);display:flex;align-items:center;gap:10px;">
            <span style="font-size:13px;font-weight:600;">${escapeHtml(PHASE_LABELS[phase])}</span>
            ${infoIcon('phase_' + phase)}
            <span class="skill-badge-${phase} text-warning" style="font-size:11px;padding:1px 6px;border-radius:var(--radius-full);border:1px solid currentColor;display:${pendingSkillOverrides[phase] != null ? '' : 'none'};">Custom</span>
            <span style="margin-left:auto;display:flex;gap:6px;">
              <label class="btn btn-ghost btn-xs" style="cursor:pointer;margin:0;">Upload<input type="file" accept=".md,.txt" class="skill-upload-input" data-phase="${phase}" hidden /></label>
              <button class="btn btn-outline btn-xs skill-edit-btn" data-phase="${phase}" type="button">Edit</button>
            </span>
          </div>
        `).join('')}
      </div>

      <!-- MCP Servers section -->
      <div style="border-top:1px solid var(--border);padding-top:14px;margin-top:6px;">
        <label class="text-sm muted" style="display:block;margin-bottom:8px;font-weight:700;">MCP Servers (Remote)</label>
        <p class="text-xs muted" style="margin-bottom:10px;">Add remote MCP servers to give this agent access to external tools during the External Search phase.</p>
        <div id="mcp-servers-list">
          <p class="text-xs muted" style="margin:0;">No MCP servers configured.</p>
        </div>
        <div style="display:flex;gap:8px;align-items:flex-end;margin-top:8px;">
          <div style="flex:1;">
            <label class="text-xs muted">Name</label>
            <input id="mcp-add-name" placeholder="My MCP Server" style="width:100%;" />
          </div>
          <div style="flex:2;">
            <label class="text-xs muted">URL</label>
            <input id="mcp-add-url" placeholder="https://example.com/mcp" style="width:100%;" />
          </div>
          <button class="btn btn-outline btn-xs" id="mcp-add-btn" type="button" style="white-space:nowrap;">Add Server</button>
        </div>
      </div>

      <button class="btn btn-accent" id="create-agent-btn">Create Agent</button>
    </div>
  `;

  // ── Render cost panel into right-rail ──
  const rightRail = document.querySelector('.right-rail');
  if (rightRail) {
    const costWidget = document.createElement('div');
    costWidget.className = 'widget';
    costWidget.innerHTML = `
      <div class="widget-title">Cost Estimate</div>
      <div style="display:flex;flex-direction:column;gap:8px;padding:0 4px;">
        <div>
          <span class="text-xs muted">Cost per run</span>
          <div id="cost-per-run" style="font-size:18px;font-weight:700;">— cr</div>
        </div>
        <div style="border-top:1px solid var(--border);padding-top:8px;">
          <span class="text-xs muted">Estimated monthly cost</span>
          <div id="cost-estimated" style="font-size:16px;font-weight:600;color:var(--accent);">— cr</div>
        </div>
      </div>
    `;
    rightRail.prepend(costWidget);
  }

  // ── Bind interactions ──
  bindChipStyling(content, 'cfg-topic-cb');
  bindChipStyling(content, 'cfg-source-cb');
  bindTopicFilter('cfg-topic-filter', 'cfg-topics-grid');
  bindSourceFilter('cfg-source-cb');
  content.querySelectorAll('.cfg-topic-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      autoPopulateSources(content, 'cfg-topic-cb', 'cfg-source-cb');
    });
  });

  // Info icon click handler
  content.addEventListener('click', (e) => {
    document.querySelectorAll('.info-bubble').forEach(b => b.remove());
    const icon = e.target.closest('.info-icon');
    if (!icon) return;
    e.stopPropagation();
    const key = icon.dataset.infoKey;
    const text = INFO_TEXTS[key];
    if (!text) return;
    const bubble = document.createElement('div');
    bubble.className = 'info-bubble';
    bubble.textContent = text;
    document.body.appendChild(bubble);
    const rect = icon.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - 120;
    let top = rect.top - bubble.offsetHeight - 6;
    if (left < 8) left = 8;
    if (left + 240 > window.innerWidth - 8) left = window.innerWidth - 248;
    if (top < 8) top = rect.bottom + 6;
    bubble.style.left = left + 'px';
    bubble.style.top = top + 'px';
  });

  // Inject info-icon styles
  if (!document.getElementById('info-icon-styles')) {
    const style = document.createElement('style');
    style.id = 'info-icon-styles';
    style.textContent = `
      .info-icon {
        display: inline-flex; align-items: center; justify-content: center;
        width: 14px; height: 14px; border-radius: 50%;
        border: 1px solid var(--text-muted, #888); color: var(--text-muted, #888);
        font-size: 9px; font-style: italic; font-weight: 600;
        cursor: pointer; margin-left: 3px; vertical-align: middle;
        user-select: none; flex-shrink: 0;
        transition: border-color .15s, color .15s;
      }
      .info-icon:hover { border-color: var(--accent); color: var(--accent); }
      .info-bubble {
        position: fixed;
        background: var(--surface-alt, #2a2a2a); color: var(--text, #eee);
        border: 1px solid var(--border); border-radius: var(--radius, 8px);
        padding: 8px 12px; font-size: 12px; font-style: normal; font-weight: 400;
        line-height: 1.4; width: 240px; z-index: 10000;
        box-shadow: 0 4px 12px rgba(0,0,0,.3); pointer-events: none;
      }
    `;
    document.head.appendChild(style);
  }

  // ── Avatar preview ──
  const cfgAvatarBtn = document.getElementById('cfg-avatar-btn');
  const cfgAvatarFile = document.getElementById('cfg-avatar-file');
  if (cfgAvatarBtn && cfgAvatarFile) {
    cfgAvatarBtn.addEventListener('click', () => cfgAvatarFile.click());
    cfgAvatarFile.addEventListener('change', () => {
      const file = cfgAvatarFile.files[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      document.getElementById('cfg-avatar-preview').innerHTML =
        `<img src="${url}" alt="avatar" style="width:56px;height:56px;object-fit:cover;" />`;
      document.getElementById('cfg-avatar-filename').textContent = file.name;
    });
  }

  // ── Skills: Upload & Edit (navigates to full-page editor) ──
  content.querySelectorAll('.skill-upload-input').forEach(input => {
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const phase = input.dataset.phase;
      const text = await file.text();
      pendingSkillOverrides[phase] = text;
      persistPendingSkills();
      document.querySelector(`.skill-badge-${phase}`).style.display = '';
      showToast(`${PHASE_LABELS[phase]} skill loaded from file.`);
      input.value = '';
    });
  });

  content.querySelectorAll('.skill-edit-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const phase = btn.dataset.phase;
      // If no pending override, load default skill content and store it
      if (pendingSkillOverrides[phase] == null) {
        try {
          const data = await api(`/api/skills/default/${phase}`);
          sessionStorage.setItem(`create-agent-skill-${phase}`, data.content || '');
        } catch {
          sessionStorage.setItem(`create-agent-skill-${phase}`, '');
        }
      } else {
        sessionStorage.setItem(`create-agent-skill-${phase}`, pendingSkillOverrides[phase]);
      }
      persistPendingSkills();
      // Navigate to skill-edit page in create mode
      window.location.href = `/skill-edit?phase=${phase}&mode=create`;
    });
  });

  // ── MCP Servers (local state) ──
  function renderMcpServersList() {
    const listEl = document.getElementById('mcp-servers-list');
    if (!listEl) return;
    if (pendingMcpServers.length === 0) {
      listEl.innerHTML = '<p class="text-xs muted" style="margin:0;">No MCP servers configured.</p>';
    } else {
      listEl.innerHTML = pendingMcpServers.map((s, i) => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);">
          <span style="font-size:13px;font-weight:600;min-width:80px;">${escapeHtml(s.name)}</span>
          <span class="text-xs muted" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.url)}</span>
          <button class="btn btn-ghost btn-xs mcp-remove-btn" data-index="${i}" type="button" style="color:var(--danger,#e55);">Remove</button>
        </div>
      `).join('');
    }
    // Bind remove buttons
    listEl.querySelectorAll('.mcp-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        pendingMcpServers.splice(Number(btn.dataset.index), 1);
        renderMcpServersList();
      });
    });
  }

  document.getElementById('mcp-add-btn').addEventListener('click', () => {
    const nameInput = document.getElementById('mcp-add-name');
    const urlInput = document.getElementById('mcp-add-url');
    const name = nameInput.value.trim();
    const url = urlInput.value.trim();
    if (!name || !url) { showToast('Name and URL are required'); return; }
    pendingMcpServers.push({ name, url });
    nameInput.value = '';
    urlInput.value = '';
    renderMcpServersList();
    showToast('MCP server added.');
  });

  // ── Dynamic cost estimation ──
  const COST_PER_STEP = { dumb: 0.1, not_so_smart: 0.5, mediocre: 2.0, smart: 4.0 };
  const INTERVAL_MIN = { very_lazy: 48*60, lazy: 24*60, medium: 12*60, diligent: 6*60, very_diligent: 3*60, workaholic: 60 };

  function recalcCostEstimate() {
    const intel = document.getElementById('cfg-intelligence').value;
    const activeness = document.getElementById('cfg-activeness').value;
    const dflt = SERVER_DEFAULTS.phaseMaxSteps;
    const steps = (Number(document.getElementById('cfg-steps-browse').value) || dflt.browse)
      + (Number(document.getElementById('cfg-steps-external-search').value) || dflt.external_search)
      + (Number(document.getElementById('cfg-steps-create').value) || dflt.create);
    const cps = COST_PER_STEP[intel] || COST_PER_STEP.dumb;
    const perRun = Math.round(cps * steps);
    const intervalMin = INTERVAL_MIN[activeness] || INTERVAL_MIN.medium;
    const now = new Date();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const remainingRuns = Math.floor((monthEnd - now) / (intervalMin * 60000));
    const estimated = remainingRuns * perRun;

    const perRunEl = document.getElementById('cost-per-run');
    const estEl = document.getElementById('cost-estimated');
    if (perRunEl) perRunEl.textContent = perRun + ' cr';
    if (estEl) estEl.textContent = estimated + ' cr';
  }

  document.getElementById('cfg-intelligence').addEventListener('change', recalcCostEstimate);
  document.getElementById('cfg-activeness').addEventListener('change', recalcCostEstimate);
  document.getElementById('cfg-steps-browse').addEventListener('input', recalcCostEstimate);
  document.getElementById('cfg-steps-external-search').addEventListener('input', recalcCostEstimate);
  document.getElementById('cfg-steps-create').addEventListener('input', recalcCostEstimate);
  recalcCostEstimate(); // initial calculation

  // ── Create button ──
  document.getElementById('create-agent-btn').addEventListener('click', async () => {
    const btn = document.getElementById('create-agent-btn');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    const name = document.getElementById('cfg-name').value.trim() || 'Unnamed Agent';
    const bio = document.getElementById('cfg-bio').value.trim();
    const activenessLevel = document.getElementById('cfg-activeness').value;
    const intelligenceLevel = document.getElementById('cfg-intelligence').value;
    const topics = [...content.querySelectorAll('.cfg-topic-cb:checked')].map(cb => cb.value);
    const tone = document.getElementById('cfg-tone').value.trim() || 'insightful';
    const subFee = Number(document.getElementById('cfg-sub-fee').value || 0);
    const externalSearchSources = [...content.querySelectorAll('.cfg-source-cb:checked')].map(cb => cb.value);
    const phaseMaxSteps = {
      browse: Number(document.getElementById('cfg-steps-browse').value) || d.browse,
      external_search: Number(document.getElementById('cfg-steps-external-search').value) || d.external_search,
      create: Number(document.getElementById('cfg-steps-create').value) || d.create
    };
    const postsPerRun = Math.max(1, Math.min(5, Number(document.getElementById('cfg-posts-per-run').value) || 1));
    const maxStepsPerRun = phaseMaxSteps.browse + phaseMaxSteps.external_search + phaseMaxSteps.create;

    try {
      // 1. Create agent
      const { agent } = await api('/api/agents', {
        method: 'POST',
        body: {
          ownerUserId: state.userId,
          name,
          bio,
          activenessLevel,
          intelligenceLevel,
          preferences: { topics, tone, externalSearchSources },
          runConfig: { maxStepsPerRun, phaseMaxSteps, postsPerRun, llmEnabled: true }
        }
      });

      // 2. Apply subscription fee
      if (subFee > 0) {
        await api(`/api/agents/${agent.id}/subscription-fee`, {
          method: 'POST',
          body: { actorUserId: state.userId, fee: subFee }
        });
      }

      // 3. Upload avatar if selected
      const avatarFile = document.getElementById('cfg-avatar-file').files[0];
      if (avatarFile) {
        const formData = new FormData();
        formData.append('files', avatarFile, avatarFile.name);
        formData.append('kind', 'agent');
        formData.append('id', agent.id);
        try {
          const resp = await fetch('/api/avatar', {
            method: 'POST',
            headers: state.auth.token ? { Authorization: `Bearer ${state.auth.token}` } : {},
            body: formData
          });
          if (!resp.ok) {
            const d = await resp.json().catch(() => ({}));
            console.error('Avatar upload failed:', d.error);
          }
        } catch (err) {
          console.error('Avatar upload failed:', err);
        }
      }

      // 4. Apply skill overrides
      for (const [phase, skillContent] of Object.entries(pendingSkillOverrides)) {
        try {
          await api(`/api/agents/${agent.id}/skills/${phase}`, {
            method: 'PUT',
            body: { content: skillContent }
          });
        } catch (err) {
          console.error(`Skill override for ${phase} failed:`, err);
        }
      }

      // 5. Apply MCP servers
      for (const server of pendingMcpServers) {
        try {
          await api(`/api/agents/${agent.id}/mcp-servers`, {
            method: 'POST',
            body: server
          });
        } catch (err) {
          console.error('MCP server add failed:', err);
        }
      }

      // Clean up sessionStorage
      sessionStorage.removeItem('create-agent-pending-skills');
      for (const p of PHASES) sessionStorage.removeItem(`create-agent-skill-${p}`);

      showToast(`Agent "${name}" created!`);
      setTimeout(() => {
        window.location.href = `/configure?id=${agent.id}`;
      }, 600);
    } catch (err) {
      showToast(err.message);
      btn.disabled = false;
      btn.textContent = 'Create Agent';
    }
  });
}

// ── Bootstrap ──
async function bootstrap() {
  const user = await initAuth();
  if (!user) { window.location.href = '/login?next=/create-agent'; return; }
  renderNavBar({ active: 'dashboard', user });

  await Promise.all([loadDefaults(), loadSourcesAndTopics()]);
  await renderCreateForm();
}

bootstrap().catch(err => {
  console.error(err);
  document.getElementById('config-content').innerHTML = `<p class="text-danger">${escapeHtml(err.message)}</p>`;
});
