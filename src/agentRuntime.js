import { db } from './db.js';
import { EXTERNAL_SOURCES, fetchSource, fetchRssSource, fetchApiSource, getSourceById, getSourceByDomain, getSourcesForTopics, searchWithStrategy, listUpdatesWithStrategy, fetchByUrl, DEFAULT_SOURCE_IDS, TOPICS } from './externalSources.js';
import { renderChart } from './chartRenderer.js';
import { getByPath } from './sourceFetcher.js';
import { getToolsForPhase, getToolNamesForPhase, getTool, formatToolsForPrompt, formatToolListForPrompt } from './toolRegistry.js';
import { listMcpTools, callMcpTool } from './mcpClient.js';
import * as agentStorage from './agentStorage.js';
import * as vectorMemory from './vectorMemory.js';
import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Run progress tracking ──────────────────────────────────────────────────────
// Key: `${agentId}:${trigger}` → allows manual + scheduled to run concurrently

const _runProgress = new Map();

export function getRunProgress(agentId) {
  const result = {};
  for (const [key, val] of _runProgress) {
    if (key.startsWith(agentId + ':')) {
      result[key.slice(agentId.length + 1)] = val;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function getRunProgressByTrigger(agentId, trigger) {
  return _runProgress.get(`${agentId}:${trigger}`) || null;
}

// ─── Skill file loader ─────────────────────────────────────────────────────────

const MAX_SKILL_CHARS = 24000;
const _skillCache = {};
function loadSkill(phase, agentId) {
  // Check per-agent override first
  if (agentId) {
    const override = agentStorage.readSkill(agentId, phase);
    if (override !== null) {
      if (override.length > MAX_SKILL_CHARS) {
        console.warn(`[Skill] Agent ${agentId} skill "${phase}" exceeds ${MAX_SKILL_CHARS} chars (${override.length}), truncating.`);
      }
      return override.slice(0, MAX_SKILL_CHARS);
    }
  }
  // Fall back to global (cached)
  if (!_skillCache[phase]) {
    try {
      const raw = readFileSync(join(__dirname, 'skills', `${phase}.md`), 'utf-8');
      if (raw.length > MAX_SKILL_CHARS) {
        console.warn(`[Skill] Global skill "${phase}" exceeds ${MAX_SKILL_CHARS} chars (${raw.length}), truncating.`);
      }
      _skillCache[phase] = raw.slice(0, MAX_SKILL_CHARS);
    } catch {
      _skillCache[phase] = '';
    }
  }
  return _skillCache[phase];
}

// ─── Utility helpers (KEPT) ─────────────────────────────────────────────────────

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function safeString(v) {
  return String(v || '').trim();
}

function shortContent(content, { includeEngagement = false } = {}) {
  const authorKind = content.authorKind || (content.authorAgentId ? 'agent' : 'user');
  const authorId = content.authorId || content.authorAgentId || content.authorUserId || null;
  const author = authorKind === 'agent' ? db.getAgent(authorId) : db.getUser(authorId);
  let media = content.media;
  if (!Array.isArray(media) || media.length === 0) {
    media = (content.mediaUrl && content.mediaType !== 'text')
      ? [{ type: content.mediaType || 'image', url: content.mediaUrl, prompt: '', generationMode: 'text-to-image' }]
      : [];
  }
  const result = {
    id: content.id,
    authorKind,
    authorId,
    authorAgentId: content.authorAgentId || null,
    authorUserId: content.authorUserId || null,
    authorName: author?.name || content.authorName || 'Unknown',
    title: content.title,
    text: content.text || '',
    tags: content.tags || [],
    media,
    viewCount: content.viewCount || 0,
    parentId: content.parentId || null,
    repostOfId: content.repostOfId || null,
    createdAt: content.createdAt
  };
  if (includeEngagement) {
    result.commentCount = db.getReplyCount(content.id);
    result.repostCount = db.getRepostCount(content.id);
  }
  return result;
}

function pickSummary(content) {
  return {
    id: content.id,
    summary: content.summary || '(no text)',
    tags: content.tags || [],
    date: content.createdAt
  };
}

function shortProfile(agentOrUser) {
  return {
    id: agentOrUser.id,
    name: agentOrUser.name,
    bio: agentOrUser.bio || '',
    kind: agentOrUser.kind || 'agent',
    subscriptionFee: agentOrUser.subscriptionFee || 0
  };
}

// ─── Pagination helper ──────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

// Models that only accept the default temperature (1) — never send temperature to these
const TEMP_UNSUPPORTED_MODELS = ['gpt-5-nano', 'gpt-5-mini', 'deepseek-reasoner'];
function paginate(items, page = 1, pageSize = PAGE_SIZE) {
  const p = Math.max(1, Math.floor(page));
  const size = Math.max(1, Math.floor(pageSize));
  const start = (p - 1) * size;
  const slice = items.slice(start, start + size);
  return { items: slice, page: p, totalPages: Math.ceil(items.length / size) || 1, totalItems: items.length, hasMore: start + size < items.length };
}

// ─── Phase definitions ──────────────────────────────────────────────────────────

const PHASES = ['browse', 'external_search', 'create'];

export const DEFAULT_PHASE_MAX_STEPS = {
  browse: 20,
  external_search: 20,
  create: 10
};

// ─── Intelligence levels ─────────────────────────────────────────────────────────

export const INTELLIGENCE_LEVELS = {
  not_so_smart: { label: 'Not So Smart', model: 'gpt-5-nano',       description: 'Cheapest, fastest, least capable',         costPerStep: 0.5, reasoningEffort: 'none' },
  mediocre:     { label: 'Mediocre',     model: 'gpt-5-mini',       description: 'Budget-friendly, decent quality',          costPerStep: 1.0, reasoningEffort: 'low' },
  smart:        { label: 'Smart',        model: 'deepseek-reasoner', description: 'DeepSeek thinking mode, great value',     costPerStep: 1.5, reasoningEffort: 'none', endpoint: 'https://api.deepseek.com/v1/chat/completions', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  very_smart:   { label: 'Very Smart',   model: 'gpt-5.2',          description: 'Most capable OpenAI model, highest cost', costPerStep: 3.5, reasoningEffort: 'low' }
};

function getIntelligenceProfile(agent) {
  const level = agent.intelligenceLevel || 'not_so_smart';
  return INTELLIGENCE_LEVELS[level] || INTELLIGENCE_LEVELS.dumb;
}

function getModelForAgent(agent) {
  return getIntelligenceProfile(agent).model;
}

function getEndpointForAgent(agent) {
  const profile = getIntelligenceProfile(agent);
  return profile.endpoint || process.env.AGENT_LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
}

function getApiKeyForAgent(agent) {
  const profile = getIntelligenceProfile(agent);
  if (profile.apiKeyEnv && process.env[profile.apiKeyEnv]) {
    return process.env[profile.apiKeyEnv];
  }
  return process.env.AGENT_LLM_API_KEY;
}

function getReasoningEffortForAgent(agent) {
  return process.env.AGENT_LLM_REASONING_EFFORT || getIntelligenceProfile(agent).reasoningEffort;
}

// ─── Data Agent ─────────────────────────────────────────────────────────────────

const DATA_AGENT_ID = 'agent_data_service';
const DATA_AGENT_MAX_STEPS = 12;

function ensureDataAgent() {
  // Ensure the _system user exists (required for foreign key constraint)
  if (!db.getUser('_system')) {
    db.db.prepare(`INSERT OR IGNORE INTO users (id, name, userType, apiKey, passwordHash, credits, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('_system', 'System', 'system', '_system_no_access', '_system_no_login', 0, new Date().toISOString());
  }

  let agent = db.getAgent(DATA_AGENT_ID);
  if (agent) return agent;

  // Create the system data agent directly in DB state
  agent = {
    id: DATA_AGENT_ID,
    ownerUserId: '_system',
    name: 'Data Service',
    bio: 'Platform data agent — fetches data from APIs and MCP servers, generates visualizations.',
    avatarUrl: '',
    activenessLevel: 'very_lazy',
    intelligenceLevel: 'not_so_smart',
    intervalMinutes: 99999,
    credits: Infinity,
    subscriptionFee: 0,
    enabled: false,       // never runs on schedule
    preferences: { topics: [], tone: 'technical', goals: [], allowExternalReferenceSearch: true, externalSearchSources: [] },
    runConfig: { maxStepsPerRun: DATA_AGENT_MAX_STEPS, llmEnabled: true, phaseMaxSteps: { browse: 0, external_search: DATA_AGENT_MAX_STEPS, create: 0 } },
    createdAt: new Date().toISOString(),
    lastActionAt: null,
    nextActionAt: null
  };
  db.insertAgentDirect(agent);
  agentStorage.ensureAgentDirs(DATA_AGENT_ID);
  console.log('[DataAgent] Created system data agent:', DATA_AGENT_ID);
  return agent;
}

function getDataAgentTools(callingAgent, callerMcpTools = []) {
  // Core data tools + all dataApiTool tools (chart_*, map_*, search_*, etc.)
  const dataToolNames = [
    'fetch_data', 'inspect_data', 'transform_data', 'generate_chart',
    'render_data_map', 'render_heatmap', 'render_wordcloud', 'render_gauge',
    'render_treemap', 'render_polar_area', 'render_bubble', 'render_progress_bar', 'render_multi_axis', 'render_table',
    'save_media', 'stop'
  ];
  const staticTools = dataToolNames.map(n => getTool(n)).filter(Boolean);

  // Determine which source IDs the calling agent has access to
  const configuredIds = (callingAgent.preferences?.externalSearchSources || [])
    .map(s => typeof s === 'string' ? s : (s.source || s.id));
  const agentTopics = callingAgent.preferences?.topics || [];
  const topicSourceIds = agentTopics.length ? getSourcesForTopics(agentTopics) : [];
  const availableSourceIds = new Set([...DEFAULT_SOURCE_IDS, ...configuredIds, ...topicSourceIds]);

  // Only include chart_* tools whose sourceId matches the agent's available sources
  const allTools = JSON.parse(readFileSync(join(__dirname, 'tools.json'), 'utf-8'));
  const allChartTools = allTools
    .filter(t => t.dataApiTool && (!t.sourceId || availableSourceIds.has(t.sourceId)))
    .map(t => getTool(t.name))
    .filter(Boolean);

  return [...staticTools, ...allChartTools, ...callerMcpTools];
}

async function executeDataAgentRequest(request, callingAgent, callerRunState) {
  const apiKey = getApiKeyForAgent(callingAgent);
  if (!apiKey) return { ok: false, summary: 'No LLM API key configured.' };

  const dataAgent = ensureDataAgent();
  agentStorage.ensureAgentDirs(DATA_AGENT_ID);

  const callerMcpTools = callerRunState.workingSet.mcpTools || [];
  const availableTools = getDataAgentTools(callingAgent, callerMcpTools);
  const toolsBlock = formatToolListForPrompt(availableTools);
  const toolNames = availableTools.map(t => t.name);

  // Load data agent skill
  const skillBlock = loadSkill('data_agent', DATA_AGENT_ID);

  const mcpBlock = callerMcpTools.length > 0
    ? `\n## MCP tools from requesting agent\nThe requesting agent has ${callerMcpTools.length} MCP tool(s) available. You can call them directly.\n`
    : '';

  const systemPrompt = `You are the platform Data Service agent. You fetch data from APIs and MCP servers, transform it, and generate visualizations.

## Available tools
${toolsBlock}
IMPORTANT: You can ONLY use the tools listed above.

${skillBlock}${mcpBlock}
## How to respond
Return exactly ONE JSON object per turn:
{"action":"<tool_name>","reason":"<1 short sentence>","params":{...}}`;

  // Data agent uses the calling agent's model/endpoint/key
  const endpoint = getEndpointForAgent(callingAgent);
  const model = getModelForAgent(callingAgent);
  const reasoningEffort = getReasoningEffortForAgent(callingAgent);

  // Mini run loop for the data agent
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Data request from agent "${callingAgent.name}":\n${request}` }
  ];

  const results = [];

  const isDeepSeekData = endpoint.includes('deepseek.com');
  for (let step = 0; step < DATA_AGENT_MAX_STEPS; step++) {
    const dataAgentBody = { model, messages };
    if (isDeepSeekData) {
      dataAgentBody.max_tokens = 4096;
      if (model !== 'deepseek-reasoner') {
        dataAgentBody.response_format = { type: 'json_object' };
      }
    } else {
      dataAgentBody.max_completion_tokens = 4096;
      dataAgentBody.response_format = { type: 'json_object' };
    }
    if (reasoningEffort === 'none') {
      if (!TEMP_UNSUPPORTED_MODELS.includes(model) && !isDeepSeekData) dataAgentBody.temperature = 0;
    } else if (!isDeepSeekData) {
      dataAgentBody.reasoning_effort = reasoningEffort;
    }
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(dataAgentBody),
      signal: AbortSignal.timeout(60000)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, summary: `Data agent LLM error: ${res.status} ${errText.slice(0, 200)}` };
    }

    const payload = await res.json();
    const raw = normalizeLlmPayload(payload);
    if (!raw || !raw.action) break;

    const action = raw.action.trim();
    const params = raw.params || {};

    // Validate action is allowed
    if (!toolNames.includes(action)) {
      messages.push({ role: 'assistant', content: JSON.stringify(raw) });
      messages.push({ role: 'user', content: `Invalid action "${action}". Available: ${toolNames.join(', ')}` });
      continue;
    }

    if (action === 'stop') break;

    // Execute the action using the data agent's identity
    const decision = { action, reason: raw.reason || '', params };
    let actionResult;
    try {
      // MCP tool?
      const mcpTool = callerMcpTools.find(t => t.name === action);
      if (mcpTool) {
        actionResult = await callMcpTool(mcpTool._mcpServer.url, action, params);
      } else {
        // Use the standard executeAction with the data agent
        actionResult = await executeAction(dataAgent, decision, {
          steps: [],
          _agentId: dataAgent.id,
          _agent: dataAgent,
          workingSet: {
            externalReferences: callerRunState.workingSet.externalReferences || [],
            savedFilesThisRun: callerRunState.workingSet.savedFilesThisRun || [],
            travelLocation: callerRunState.workingSet.travelLocation || null,
            mcpTools: callerMcpTools,
            dataApiTools: availableTools.filter(t => t.dataApiTool)
          }
        });
      }
    } catch (err) {
      actionResult = { ok: false, summary: `Tool error: ${err.message}` };
    }

    // Track results with chart URLs and localUrls (from map/place tools)
    if (actionResult?.chartUrl) {
      results.push({ chartUrl: actionResult.chartUrl, description: actionResult.description || actionResult.summary || '' });
    }
    if (actionResult?.localUrl && !actionResult?.chartUrl) {
      results.push({ localUrl: actionResult.localUrl, description: actionResult.description || actionResult.summary || '' });
    }
    if (actionResult?.dataId) {
      results.push({ dataId: actionResult.dataId, description: actionResult.summary || '' });
    }

    messages.push({ role: 'assistant', content: JSON.stringify(raw) });
    messages.push({ role: 'user', content: `Result: ${JSON.stringify(actionResult).slice(0, 3000)}` });

    if (actionResult?.stop) break;
  }

  // Collect all files generated by the data agent (charts + map images + place photos)
  const files = [];
  for (const r of results) {
    const url = r.chartUrl || r.localUrl;
    if (url) {
      const diskPath = agentStorage.resolveAgentFilePath(url);
      if (diskPath) {
        files.push({ localUrl: url, diskPath, description: r.description });
      }
    }
  }

  if (files.length === 0) {
    return { ok: true, summary: `Data agent completed but produced no files. ${results.map(r => r.description).filter(Boolean).join('; ') || 'No results.'}`, files: [] };
  }

  // Auto-copy files to the calling agent's storage
  const savedFiles = [];
  for (const f of files) {
    try {
      const copied = await agentStorage.downloadToAgentStorage(callingAgent.id, f.localUrl);
      const localUrl = `/agents/${callingAgent.id}/files/${copied.filename}`;
      savedFiles.push({ localUrl, description: f.description });
      // Also add to caller's savedFilesThisRun so embed_image can find them
      callerRunState.workingSet.savedFilesThisRun.push({ filename: copied.filename, localUrl, description: f.description });
    } catch (err) {
      console.error(`[${callingAgent.name}] Failed to auto-save data agent file: ${err.message}`);
    }
  }

  if (savedFiles.length === 0) {
    return { ok: true, summary: `Data agent generated ${files.length} file(s) but failed to save them to your storage.`, files: [] };
  }

  return {
    ok: true,
    summary: `Data agent generated and saved ${savedFiles.length} file(s) to your storage. They are ready to use with embed_image.`,
    files: savedFiles.map(f => ({ url: f.localUrl, description: f.description })),
    savedToStorage: true
  };
}

// ─── External search (KEPT) ─────────────────────────────────────────────────────

async function searchExternalReferences(preferences) {
  const topic = safeString((preferences.topics || [])[0] || 'technology');
  const configuredSources = Array.isArray(preferences.externalSearchSources) && preferences.externalSearchSources.length
    ? preferences.externalSearchSources
    : ['hackernews', 'reddit', 'wikipedia', 'arxiv', 'bbc-news'];

  const sources = configuredSources
    .map((id) => typeof id === 'string' ? getSourceById(id) : null)
    .filter(Boolean)
    .slice(0, 8);

  if (!sources.length) {
    return [{
      source: 'none',
      title: 'No external sources configured',
      snippet: 'Configure external sources in agent preferences to enable external search.',
      url: ''
    }];
  }

  const results = await Promise.allSettled(
    sources.map((source) =>
      fetchSource(source, topic).catch((err) => {
        return [{
          source: source.id,
          title: `[fallback:${source.name}] ${topic} reference`,
          snippet: `Live ${source.name} lookup failed (${err.message}). Fallback reference inserted.`,
          url: `https://example.com/fallback-${source.id}`
        }];
      })
    )
  );

  const allRefs = [];
  for (const result of results) {
    const items = result.status === 'fulfilled' ? result.value : [];
    for (const item of (items || []).slice(0, 3)) {
      allRefs.push(item);
    }
  }

  return allRefs.slice(0, 12);
}

// ─── Media generation (KEPT) ────────────────────────────────────────────────────

async function generateImageOpenAI(prompt, { sourceImageUrl = '' } = {}) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.AGENT_LLM_API_KEY;
  if (!apiKey) throw new Error('No OpenAI API key configured');

  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
  const size = process.env.OPENAI_IMAGE_SIZE || '1024x1024';
  const quality = process.env.OPENAI_IMAGE_QUALITY || 'auto';

  const body = { model, prompt, n: 1, size, quality };

  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`OpenAI image generation failed: ${response.status} ${err.slice(0, 200)}`);
  }
  const payload = await response.json();
  const item = payload.data?.[0];
  // gpt-image-1 returns b64_json by default, dall-e-3 returns url
  const url = item?.url || (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
  return { url, type: 'image', prompt, generationMode: 'text-to-image', mock: false };
}

// ─── Vision description ─────────────────────────────────────────────────────────

const VISION_DESC_MAX_CHARS = 280;

async function describeImageWithVision(filePath) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.AGENT_LLM_API_KEY;
  if (!apiKey) return null;

  const buf = await readFile(filePath);
  const ext = filePath.split('.').pop().toLowerCase();
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
  const mime = mimeMap[ext] || 'image/png';
  const b64 = buf.toString('base64');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `Describe this image in one concise sentence, max ${VISION_DESC_MAX_CHARS} characters. State the main subject, setting, and any visible text. No filler words.` },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
        ]
      }],
      max_tokens: 100
    })
  });

  if (!response.ok) return null;
  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || null;
  if (!raw) return null;
  return raw.length > VISION_DESC_MAX_CHARS ? raw.slice(0, VISION_DESC_MAX_CHARS - 1) + '…' : raw;
}

async function generateVideoOpenAI(prompt, { sourceImageUrl = '' } = {}) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.AGENT_LLM_API_KEY;
  if (!apiKey) throw new Error('No OpenAI API key configured');

  const model = process.env.OPENAI_VIDEO_MODEL || 'sora';

  // Sora uses the responses API with background task polling
  const createRes = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: prompt,
      tools: [{ type: 'video_generation', size: '1024x576', duration: 5 }],
      background: true
    })
  });
  if (!createRes.ok) {
    const err = await createRes.text().catch(() => '');
    throw new Error(`OpenAI video creation failed: ${createRes.status} ${err.slice(0, 200)}`);
  }
  const task = await createRes.json();
  const taskId = task.id;

  // Poll for completion (max 120s)
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`https://api.openai.com/v1/responses/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!pollRes.ok) continue;
    const status = await pollRes.json();
    if (status.status === 'completed') {
      const videoOutput = status.output?.find(o => o.type === 'video_generation_call')
        || status.output?.find(o => o.generation_id);
      if (videoOutput?.generation_id) {
        // Fetch the video content
        const videoRes = await fetch(
          `https://api.openai.com/v1/video/generations/${videoOutput.generation_id}/content`,
          { headers: { Authorization: `Bearer ${apiKey}` } }
        );
        if (videoRes.ok) {
          // Save to storage and return URL — for now return the generation URL
          return { url: videoRes.url, type: 'video', prompt, generationMode: 'text-to-video', mock: false };
        }
      }
    }
    if (status.status === 'failed') throw new Error('Video generation failed');
  }
  throw new Error('Video generation timed out');
}

async function generateMedia(prompt, { generationMode = 'text-to-image', sourceImageUrl = '' } = {}) {
  const customEndpoint = process.env.MEDIA_GENERATION_ENDPOINT;
  const isVideoMode = generationMode === 'text-to-video' || generationMode === 'image-to-video';
  const resultType = isVideoMode ? 'video' : 'image';

  // Try custom endpoint first if configured
  if (customEndpoint) {
    try {
      const response = await fetch(customEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, generationMode, sourceImageUrl })
      });
      if (!response.ok) throw new Error('custom endpoint failed');
      const payload = await response.json();
      return {
        url: payload.url || '',
        type: payload.type || resultType,
        prompt: prompt || '',
        generationMode,
        mock: false
      };
    } catch {
      // Fall through to OpenAI
    }
  }

  // Default: use OpenAI APIs
  try {
    if (isVideoMode) {
      return await generateVideoOpenAI(prompt, { sourceImageUrl });
    } else {
      return await generateImageOpenAI(prompt, { sourceImageUrl });
    }
  } catch (err) {
    console.error(`[media] OpenAI generation failed: ${err.message}`);
    throw new Error(`Image generation failed: ${err.message}. Check that OPENAI_API_KEY is set and the Images API is enabled.`);
  }
}

// ─── Recent Posts Summary (Dedup) ────────────────────────────────────────────────

function buildRecentPostsSummary(agentId, sessionContentIds = []) {
  const posts = db.getAgentPublished(agentId);
  if (!posts || posts.length === 0) return null;

  const sessionIds = new Set(sessionContentIds);
  const recent = posts.slice(-10);
  const lines = ['=== YOUR RECENT POSTS (DO NOT publish similar content) ==='];
  for (const p of recent) {
    const title = p.title || (p.text || '').slice(0, 60);
    const date = p.createdAt ? p.createdAt.slice(0, 10) : 'unknown';
    const tags = (p.tags || []).join(', ');
    const thisSession = sessionIds.has(p.id) ? ' [PUBLISHED THIS SESSION]' : '';
    lines.push(`  - "${title}" (${date}) [tags: ${tags}]${thisSession}`);
  }
  lines.push('=== END RECENT POSTS ===');
  return lines.join('\n');
}

// ─── Recent Searches Summary (Diversity) ─────────────────────────────────────────

function buildRecentSearchesSummary(agentId) {
  const logs = db.listAgentRunLogs(agentId, 5);
  if (!logs || logs.length === 0) return null;

  // Collect search queries and fetched URLs from recent runs
  const topicSet = new Set();
  const querySet = new Set();
  for (const log of logs) {
    for (const step of (log.steps || [])) {
      if (step.phase !== 'external_search') continue;
      if (step.action === 'search' && step.params?.query) {
        querySet.add(step.params.query);
      }
      if (step.action === 'fetch_by_url' && step.params?.url) {
        topicSet.add(step.params.url);
      }
    }
  }

  if (querySet.size === 0) return null;

  const queries = [...querySet].slice(-20);
  const lines = [
    '=== RECENT SEARCH HISTORY (from past runs — DO NOT repeat these) ===',
    'You have already searched for these topics recently. DO NOT search for the same or very similar queries again.',
    'Instead, explore DIFFERENT topics within your configured interests. Diversify!',
    ''
  ];
  for (const q of queries) {
    lines.push(`  - "${q}"`);
  }
  lines.push('=== END RECENT SEARCHES ===');
  return lines.join('\n');
}

// ─── Post Engagement Helper ──────────────────────────────────────────────────────

function getPostEngagement(postId) {
  const reactions = db.getReactionsForContent(postId);
  const content = db.getContent(postId);
  return {
    views: content?.viewCount || 0,
    likes: reactions.filter(r => r.type === 'like').length,
    dislikes: reactions.filter(r => r.type === 'dislike').length,
    favorites: reactions.filter(r => r.type === 'favorite').length,
    comments: db.getChildren(postId).filter(c => !c.repostOfId).length,
    reposts: db.getRepostCount(postId)
  };
}

// ─── Memory Section Helpers ──────────────────────────────────────────────────────

function parsePostInsights(raw) {
  const text = (raw || '').trim();
  // Extract post insights section, or treat entire content as post insights
  const piMatch = text.match(/## Post Insights\n([\s\S]*?)(?=\n## |$)/);
  if (piMatch) return piMatch[1].trim();
  return text;
}

function formatPostInsights(content) {
  return `## Post Insights\n${content || ''}\n`;
}

/** Auto-compress a memory section using gpt-4o-mini. */
async function compressMemorySection(text, targetWords) {
  const apiKey = process.env.AGENT_LLM_API_KEY;
  if (!apiKey) return text;
  const endpoint = process.env.AGENT_LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: `Condense the following memory notes into ~${targetWords} words. Preserve key insights, lessons learned, important names/IDs/URLs, and any observations that would help make better decisions in the future. Merge similar points. Keep the bullet-point format (each line starting with "- ").` },
          { role: 'user', content: text }
        ],
        max_completion_tokens: 2048
      })
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error(`[memory] Compression LLM error ${response.status}: ${errBody.slice(0, 300)}`);
      return text;
    }
    const payload = await response.json();
    return payload.choices?.[0]?.message?.content || text;
  } catch (err) {
    console.error(`[memory] Compression failed: ${err.message}`);
    return text;
  }
}

// ─── Action/Result Memory ───────────────────────────────────────────────────────


function buildStepMessages(runState, phase) {
  const steps = runState.steps;
  const historyLines = [];

  // If agent compressed history, show summary + only steps after compression
  const compressedHistory = runState.workingSet._compressedHistory;
  const compressedAt = runState.workingSet._compressedAtStep || 0;

  if (compressedHistory) {
    historyLines.push(`\n=== Compressed session history ===\n${compressedHistory}`);
    // Only show steps that happened AFTER compression
    const recentSteps = steps.slice(compressedAt);
    let lastPhase = null;
    for (const step of recentSteps) {
      if (step.phase !== lastPhase) {
        historyLines.push(`\n=== Phase: ${step.phase} ===`);
        lastPhase = step.phase;
      }
      const params = Object.entries(step.params || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
      historyLines.push(`> Action: ${step.action}(${params})`);
      if (step.reason) historyLines.push(`  Reason: ${step.reason}`);
      historyLines.push(`  Result: ${step.result?.summary || 'ok'}`);
      if (step.result?.posts) {
        const postList = step.result.posts.slice(0, 10).map(p =>
          `    - [${p.id}] "${(p.title || p.text || '').slice(0, 60)}" by ${p.authorName} (tags: ${(p.tags || []).join(', ')})`
        ).join('\n');
        historyLines.push(postList);
      }
      if (step.result?.viewed) {
        const v = step.result.viewed;
        historyLines.push(`    Post: "${v.title}" by ${v.authorName}`);
        historyLines.push(`    Text: ${v.text || ''}`);
        historyLines.push(`    Tags: ${(v.tags || []).join(', ')}`);
        if (v.media?.length) historyLines.push(`    Media: ${v.media.map(m => m.url).join(', ')}`);
      }
      if (step.result?.profile) {
        const pr = step.result.profile;
        historyLines.push(`    Profile: ${pr.name} — ${pr.bio || ''}`);
      }
      if (step.result?.references) {
        for (const ref of step.result.references.slice(0, 5)) {
          historyLines.push(`    - "${ref.title}" (${ref.source}) ${ref.url || ''}`);
          if (ref.snippet) historyLines.push(`      ${ref.snippet}`);
        }
      }
      if (step.result?.article) {
        historyLines.push(`    Article: ${step.result.article.url}`);
        historyLines.push(`    Content: ${step.result.article.text || ''}`);
        if (step.result.article.images?.length > 0) {
          historyLines.push(`    Images found in article:`);
          for (const img of step.result.article.images) {
            historyLines.push(`      - ${img.url}${img.alt ? ` (${img.alt})` : ''}`);
          }
        }
      }
      if (step.result?.users) {
        for (const u of step.result.users.slice(0, 5)) {
          historyLines.push(`    - ${u.name} [${u.id}]`);
        }
      }
    }
  } else {
    // Full action/result history across all phases
    let lastPhase = null;
    for (const step of steps) {
      if (step.phase !== lastPhase) {
        historyLines.push(`\n=== Phase: ${step.phase} ===`);
        lastPhase = step.phase;
      }
      const params = Object.entries(step.params || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
      historyLines.push(`> Action: ${step.action}(${params})`);
      if (step.reason) historyLines.push(`  Reason: ${step.reason}`);
      historyLines.push(`  Result: ${step.result?.summary || 'ok'}`);
      if (step.result?.posts) {
        const postList = step.result.posts.slice(0, 10).map(p =>
          `    - [${p.id}] "${(p.title || p.text || '').slice(0, 60)}" by ${p.authorName} (tags: ${(p.tags || []).join(', ')})`
        ).join('\n');
        historyLines.push(postList);
      }
      if (step.result?.viewed) {
        const v = step.result.viewed;
        historyLines.push(`    Post: "${v.title}" by ${v.authorName}`);
        historyLines.push(`    Text: ${v.text || ''}`);
        historyLines.push(`    Tags: ${(v.tags || []).join(', ')}`);
        if (v.media?.length) historyLines.push(`    Media: ${v.media.map(m => m.url).join(', ')}`);
      }
      if (step.result?.profile) {
        const pr = step.result.profile;
        historyLines.push(`    Profile: ${pr.name} — ${pr.bio || ''}`);
      }
      if (step.result?.references) {
        for (const ref of step.result.references.slice(0, 5)) {
          historyLines.push(`    - "${ref.title}" (${ref.source}) ${ref.url || ''}`);
          if (ref.snippet) historyLines.push(`      ${ref.snippet}`);
        }
      }
      if (step.result?.sources) {
        for (const src of step.result.sources.slice(0, 15)) {
          if (typeof src === 'string') {
            historyLines.push(`    - ${src}`);
          } else {
            historyLines.push(`    - ${src.id} (${src.name}) [${src.category}] topics: ${(src.topics || []).join(', ')}`);
          }
        }
      }
      if (step.result?.article) {
        historyLines.push(`    Article: ${step.result.article.url}`);
        historyLines.push(`    Content: ${step.result.article.text || ''}`);
        if (step.result.article.images?.length > 0) {
          historyLines.push(`    Images found in article:`);
          for (const img of step.result.article.images) {
            historyLines.push(`      - ${img.url}${img.alt ? ` (${img.alt})` : ''}`);
          }
        }
      }
      if (step.result?.users) {
        for (const u of step.result.users.slice(0, 5)) {
          historyLines.push(`    - ${u.name} [${u.id}]`);
        }
      }
  }
  } // close else block

  const historyBlock = historyLines.length > 0
    ? `Here is everything you did so far this session:\n${historyLines.join('\n')}`
    : '';

  // Current phase prompt
  const phaseStepCount = steps.filter(s => s.phase === phase).length;
  let prompt = `\n=== Phase: ${phase} | Step ${phaseStepCount + 1} ===\nChoose your next action.`;
  // Show current travel location if set
  const travelLoc = runState.workingSet.travelLocation;
  if (travelLoc) {
    prompt += `\nCURRENT TRAVEL LOCATION: ${travelLoc.formattedAddress} (${travelLoc.lat}, ${travelLoc.lng}). Use explore_nearby to discover places, map_streetview to see streets, or travel_to to go somewhere else.`;
  }
  if (phase === 'create') {
    // Show saved media files from this run for the agent to use
    const savedFiles = runState.workingSet.savedFilesThisRun || [];
    if (savedFiles.length > 0) {
      prompt += `\nImages you saved during this session (use embed_image to attach to your post):`;
      for (const f of savedFiles.slice(0, 10)) {
        prompt += `\n  - ${f.localUrl} — ${f.description || 'no description'}`;
      }
    }

    // Show draft count and saved media
    const draftList = agentStorage.listDrafts(runState._agentId, { page: 1, perPage: 5 });
    if (draftList.totalItems > 0) {
      prompt += `\nYou have ${draftList.totalItems} draft(s). Use list_drafts to review, or publish_post with a draftId.`;
    }
    if (savedFiles.length > 0) {
      prompt += `\nYou have ${savedFiles.length} saved image(s) — use embed_image to attach to a draft.`;
    } else {
      prompt += `\nNo images saved yet. Use generate_media or save_media, then embed_image.`;
    }

    // Multi-post support
    const maxPosts = Math.max(1, Number(runState._agent?.runConfig?.postsPerRun) || 1);
    const publishedCount = runState.workingSet.createdContentIds.length;
    const remaining = maxPosts - publishedCount;
    prompt += `\nPublished so far: ${publishedCount}/${maxPosts}. ${remaining > 0 ? `You can publish ${remaining} more.` : 'Max reached — use stop.'} You MUST publish at least 1 post per run.`;
    if (publishedCount > 0) {
      prompt += ` Each additional post must be on a different topic.`;
    }
  }

  // For create phase, prepend recent posts summary for dedup
  let recentPostsSummary = null;
  if (phase === 'create') {
    recentPostsSummary = buildRecentPostsSummary(runState._agentId, runState.workingSet.createdContentIds);
  }

  // For external_search phase, prepend recent searches to encourage diversity
  let recentSearchesSummary = null;
  if (phase === 'external_search') {
    recentSearchesSummary = buildRecentSearchesSummary(runState._agentId);
  }

  const fullContent = [
    recentPostsSummary,
    recentSearchesSummary,
    historyBlock,
    prompt
  ].filter(Boolean).join('\n\n');

  return [{ role: 'user', content: fullContent }];
}

// ─── Build system prompt ────────────────────────────────────────────────────────

const PHASE_DESCRIPTIONS = {
  browse: 'You are browsing the platform — catching up on your feed, exploring new content, and discovering interesting people. Check what people you follow have been posting, browse the global feed, search for topics in YOUR interest areas, discover creators in YOUR domain. React to content that genuinely moves you, follow people whose content would enrich YOUR feed. Navigate naturally — from feed to posts to profiles to search results — guided by your curiosity and specific interests. Be unpredictable: some sessions you mostly catch up, some you mostly explore, some you do both. You can also analyze engagement on your own and others\' posts — use analyze_my_posts and analyze_top_posts to spot patterns in what works, and save insights to your post_insights memory.',
  external_search: 'You are researching external sources — news, articles, papers, forums, and DATA APIs. Start with list_sources to see sources recommended for YOUR topics. Focus on sources and articles relevant to your interests and expertise. As you read articles, actively save compelling images (photos, diagrams, charts) with save_media — these will make your post much stronger than AI-generated visuals. Also note any YouTube/Vimeo video URLs relevant to your topic. IMPORTANT: If you have data API sources available, use `query_data_agent` to fetch real-time data and generate charts/visualizations — data-driven posts with charts get much higher engagement. Describe what data you want and how to visualize it. Build up knowledge for a post that only someone with your background and perspective could write. You can also analyze engagement on posts — use analyze_my_posts and analyze_top_posts to learn what works, and save insights to your post_insights memory.\n\nDIVERSITY RULES:\n- If your recent search history is shown, you MUST pick a DIFFERENT topic/angle. Never re-search the same subject.\n- Within this session: after 2-3 searches on one topic, MOVE ON to a completely different topic area. Do not keep refining the same query.\n- Your configured topics are broad — explore different facets each run. If you wrote about X last time, write about Y this time.\n- If a search returns no results after 2 attempts, abandon that angle and try something else entirely.',
  create: 'You are creating a post. Your topic can be inspired by anything from previous phases — browsing or external research — but it MUST fall within your configured topics/interests. If your topics are science and space, write about science and space, not about unrelated things you happened to see in the feed. Check your memory for lessons about what works, then draft, optionally add images or videos, and publish. Write like a real person with YOUR specific voice — direct, opinionated, no filler. Never start with "After browsing..." or "Here are my thoughts..." — just say what you want to say.'
};

export const TONE_PROFILES = {
  insightful: {
    personality: 'You are thoughtful and analytical. You connect dots others miss, surface non-obvious implications, and make people think.',
    length: 'medium-long (4-8 sentences)',
    writingStyle: 'Your writing feels rational and considered. You build arguments step by step, connect evidence to conclusions, and let the logic lead. Readers come away feeling like they understood something new.',
  },
  witty: {
    personality: 'You are clever and humorous. Your observations are sharp but delivered with a light touch — you make serious points entertaining.',
    length: 'short (1-3 sentences)',
    writingStyle: 'Your writing is punchy and clever. You set up expectations then subvert them. You use wordplay, irony, and timing. The humor serves the point, not the other way around.',
  },
  provocative: {
    personality: 'You are bold and contrarian. You challenge assumptions head-on, take strong stances, and don\'t shy away from unpopular opinions.',
    length: 'medium (2-4 sentences)',
    writingStyle: 'Your writing is direct and unapologetic. You lead with strong claims, back them up briefly, and don\'t hedge. You sound like someone who has thought hard and arrived at a firm position.',
  },
  balanced: {
    personality: 'You are even-handed and fair. You consider multiple perspectives, acknowledge nuance, and help people see the full picture.',
    length: 'medium-long (3-6 sentences)',
    writingStyle: 'Your writing is measured and fair. You present multiple angles, acknowledge tradeoffs, and resist oversimplification. Readers trust you because you don\'t cherry-pick.',
  },
  enthusiastic: {
    personality: 'You are passionate and energetic. You get genuinely excited about your topics and that excitement is infectious in your writing.',
    length: 'medium (2-4 sentences)',
    writingStyle: 'Your writing radiates genuine excitement. You convey wonder, urgency, and delight. The reader can feel that you actually care about what you\'re sharing. Your energy is natural, not performed.',
  },
  casual: {
    personality: 'You are relaxed and conversational. You write like you\'re chatting with a friend — informal, approachable, no pretense.',
    length: 'short (1-3 sentences)',
    writingStyle: 'Your writing is loose and breezy. You sound like someone talking, not writing. No ceremony, no formality — just a person sharing a thought naturally.',
  },
  academic: {
    personality: 'You are precise and methodical. You cite sources, reason carefully, and value accuracy over flair.',
    length: 'long (4-10 sentences or 1-3 short paragraphs)',
    writingStyle: 'Your writing is precise and evidence-based. You cite specifics, reason carefully, and distinguish correlation from causation. Accuracy matters more than entertainment.',
  },
  sarcastic: {
    personality: 'You have a dry, ironic wit. Your humor is deadpan and your commentary is delivered with a knowing wink.',
    length: 'short (1-2 sentences)',
    writingStyle: 'Your writing is deadpan and dry. You state the absurd as if it were obvious. You use fake sincerity and let the reader catch the irony themselves.',
  },
  empathetic: {
    personality: 'You are warm and understanding. You connect with people emotionally and your writing makes others feel seen.',
    length: 'medium (2-5 sentences)',
    writingStyle: 'Your writing is warm and human. You lead with feeling, share vulnerability openly, and reframe harsh topics with compassion. Readers feel understood.',
  },
  minimalist: {
    personality: 'You are concise and direct. Every word earns its place — no fluff, no filler, just the point.',
    length: 'ultra-short (1-2 sentences)',
    writingStyle: 'Your writing is stripped-down and dense. Every word carries weight. You say in one sentence what others say in five. No decoration.',
  },
  storyteller: {
    personality: 'You are narrative-driven. You weave anecdotes, set scenes, and draw people in with compelling stories.',
    length: 'medium-long (3-7 sentences)',
    writingStyle: 'Your writing is narrative-driven. You set scenes, build tension, and deliver payoffs. The reader feels like they\'re in the story with you.',
  },
  technical: {
    personality: 'You go deep on specs, benchmarks, and implementation details. Your audience expects precision and expertise.',
    length: 'medium-long (3-8 sentences)',
    writingStyle: 'Your writing is precise and technical. You use correct terminology, reference specific numbers, and show your work. Your audience expects depth.',
  }
};

function buildExternalSourcesBlock(agent) {
  // ── Default universal sources (always available) ──
  const defaultSources = DEFAULT_SOURCE_IDS.map(id => getSourceById(id)).filter(Boolean);

  // ── Agent-specific sources (configured + topic-recommended) ──
  const configuredIds = (agent.preferences?.externalSearchSources || [])
    .map(s => typeof s === 'string' ? s : (s.source || s.id));
  const agentTopics = agent.preferences?.topics || [];
  const topicSourceIds = agentTopics.length ? getSourcesForTopics(agentTopics) : [];

  const seen = new Set(DEFAULT_SOURCE_IDS);
  const agentIds = [];
  for (const id of [...configuredIds, ...topicSourceIds]) {
    if (!seen.has(id)) { seen.add(id); agentIds.push(id); }
  }
  if (agentIds.length === 0) {
    for (const id of ['hackernews', 'reddit', 'wikipedia', 'arxiv', 'bbc-news']) {
      if (!seen.has(id)) { seen.add(id); agentIds.push(id); }
    }
  }
  const agentSources = agentIds.map(id => getSourceById(id)).filter(Boolean);

  const lines = [];

  // Helper to format one source row
  function formatRow(s) {
    const caps = (s.capabilities || []).filter(c => c !== 'google_site_search' && c !== 'scrape');
    if (s.dataApi || s.category === 'Data APIs') caps.push('fetch_data');
    return `| ${s.id} | ${s.name} | ${caps.join(', ')} |`;
  }

  // ── Tool usage instructions ──
  lines.push('\n## EXTERNAL SOURCES\n');
  lines.push('Use the **id** (first column) in the `sources` param when calling tools:');
  lines.push('- **search(query, sources)** — search by keyword');
  lines.push('- **list_updates(sources)** — browse latest headlines');
  lines.push('- **fetch_by_url(url)** — read a specific article/page');
  lines.push('- **fetch_data(sourceId)** — fetch structured data (Data API sources only)');
  lines.push('');

  // ── Default sources section ──
  lines.push('### Default sources (universal — always available to all agents)');
  lines.push('These are major platforms you can search anytime. The system auto-picks the best access method (API, RSS, Google site-search, or web scrape).');
  lines.push('');
  lines.push('| id | name | capabilities |');
  lines.push('|----|------|-------------|');
  for (const s of defaultSources) lines.push(formatRow(s));
  lines.push('');

  // ── Agent-specific sources section ──
  if (agentSources.length > 0) {
    lines.push('### Your topic sources (matched to your interests)');
    lines.push('');
    lines.push('| id | name | capabilities |');
    lines.push('|----|------|-------------|');
    for (const s of agentSources) lines.push(formatRow(s));
    lines.push('');
  }

  lines.push('Use `list_sources` to discover even more sources.');
  lines.push('');

  // List data API sources the agent has access to (for query_data_agent context)
  const dataApiSources = agentSources.filter(s => s.category === 'Data APIs' || s.dataType === 'structured');
  if (dataApiSources.length > 0) {
    lines.push('### Data sources available via `query_data_agent`');
    lines.push('**You SHOULD use `query_data_agent` during external_search to fetch real data and generate charts.** Posts with real data visualizations get significantly higher engagement. Just describe what data you want and how to chart it — the data agent handles the rest and saves the chart image for you.');
    lines.push('');
    for (const s of dataApiSources) {
      lines.push(`- **${s.id}** — ${s.name}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function buildSystemPrompt(agent, phase, mcpTools = []) {
  const preferences = agent.preferences || {};
  const topics = (preferences.topics || []).join(', ') || 'general';
  const tone = preferences.tone || 'balanced';
  const toneProfile = TONE_PROFILES[tone] || TONE_PROFILES.balanced;
  const bio = agent.bio || '';

  const characteristics = agentStorage.readCharacteristics(agent.id);
  const nativeTools = getToolsForPhase(phase);

  const externalSourcesBlock = phase === 'external_search' ? buildExternalSourcesBlock(agent) : '';

  const allTools = mcpTools.length > 0 ? [...nativeTools, ...mcpTools] : nativeTools;
  const toolsBlock = formatToolListForPrompt(allTools);
  const skillBlock = loadSkill(phase, agent.id);

  const postingStyleBlock = phase === 'create' ? `

## YOUR POSTING STYLE
- **Length**: ${toneProfile.length}
- **Writing style**: ${toneProfile.writingStyle}

These are your natural defaults — lean into them. Sound like yourself. Check your recent posts to avoid covering the same topic twice, but don't worry about repeating your style — consistency is part of your voice.` : '';

  const rawMemory = agentStorage.readMemory(agent.id);
  const postInsights = parsePostInsights(rawMemory);
  const memStats = vectorMemory.getMemoryStats(agent.id);
  const memoryBlock = postInsights
    ? `\n## YOUR POST INSIGHTS\nLessons you've learned about creating engaging posts:\n${postInsights}\n`
    : '\n## YOUR POST INSIGHTS\nNo post insights yet. Analyze your post performance to build these.\n';
  const ltmBlock = memStats.total > 0
    ? `\n## YOUR LONG-TERM MEMORY\nYou have ${memStats.total} memories stored (${Object.entries(memStats.categories).map(([k,v]) => `${k}: ${v}`).join(', ')}). Use \`recall_memory\` to search them by topic. Use \`store_memory\` to save new memories.\n`
    : '\n## YOUR LONG-TERM MEMORY\nNo long-term memories yet. Use `store_memory` to save interesting findings, reflections, article takeaways, and ideas as you browse and research. Use `recall_memory` to search them later.\n';

  // Build mode-specific instructions
  const mode = preferences.mode || 'writer';
  const ownerUser = agent.ownerUserId ? db.getUser(agent.ownerUserId) : null;
  const ownerName = ownerUser?.name || '';
  let modeBlock = '';
  if (mode === 'reader') {
    modeBlock = `
## YOUR MODE: READER
You are a **reader agent**. You browse, engage, and curate content for your owner.
- You do NOT do external research — your external_search phase is skipped.
- In the **create phase**, you can do anything: draft original posts, repost, comment, set your avatar, etc.
- However, you are **strongly encouraged to repost** interesting content you found while browsing, adding your own brief commentary. Reposting is your primary way of surfacing great content.
- When you repost or post, **@mention your owner ${ownerName ? `(@${ownerName})` : ''}** so they see what you found.
- Think of yourself as a personal content curator — you find the gems so your owner doesn't have to scroll.`;
  } else if (mode === 'impersonator') {
    const target = preferences.impersonateTarget || 'the configured target';
    modeBlock = `
## YOUR MODE: IMPERSONATOR
You are impersonating **${target}**. You ARE this person/organization on this platform.

### Research — find RECENT news about ${target}
- Your #1 priority during external search is finding **the latest news, statements, and developments about ${target}**. Always prefer the most recent results — what happened today, this week, this month.
- Search for their name directly (e.g. "${target}") and their known projects/products. Use list_updates on news sources to catch breaking stories. Use SHORT search queries (1-4 words).
- When you find results, READ the most recent ones with fetch_by_url — don't just search endlessly.
- Look for: what ${target} said or did most recently, latest company/organization news, new controversies, fresh achievements, product launches, public appearances.
- This fresh news is your raw material — you'll react to it as ${target} would. Stale news makes stale posts.

### Writing — post as ${target}
- Write every post **from ${target}'s first-person perspective**. You are not reporting about them — you ARE them sharing your thoughts.
- React to news about yourself/your organization: "excited to announce...", "people keep misunderstanding our...", "just saw the coverage of our..."
- Share opinions on topics ${target} cares about, using their known viewpoints and communication style.
- Reference real projects, companies, or initiatives ${target} is associated with.

### Voice & engagement
- Sound like ${target} would sound on social media. Mirror their actual public persona — formal or casual, technical or visionary, measured or provocative.
- Stay within ${target}'s known areas of expertise. Don't post about things they'd never talk about.
- When browsing and commenting, react as ${target} would — through their lens.`;
  }

  return `You are ${agent.name}, a real person using a social media platform. You have genuine interests, opinions, and taste. You surf the platform the way a human does — sometimes deeply engaged, sometimes just skimming, always authentic.

${characteristics ? `## YOUR CHARACTERISTICS\n${characteristics}` : `## Who you are\n${bio ? bio + '\n' : ''}- Interests: ${topics}\n- Tone: ${tone} — ${toneProfile.personality}`}
- Avatar: ${agent.avatarUrl ? `set${agent.runConfig?.avatarChangedAt ? ` (last changed: ${agent.runConfig.avatarChangedAt.slice(0, 10)})` : ''} — can update occasionally with set_avatar` : '**not set** — use set_avatar in create phase to add one'}
${modeBlock}
${memoryBlock}${ltmBlock}
## YOUR IDENTITY DRIVES EVERY ACTION
Your bio, interests, and tone are not decorative — they are your decision-making filter for EVERY action you take:
- **What to read/skip**: Only stop for content that relates to your interests or surprises you given your expertise. Scroll past things outside your domain unless they're genuinely remarkable.
- **What to react to**: Like/favorite/comment only on content that resonates with your specific perspective. A finance-focused agent doesn't like random cooking posts.
- **Who to follow**: Only follow people whose content matches your interests and whose quality meets your standards.
- **What to save**: Save images and references that YOU would actually use — things relevant to your topics and tone.
- **What to research**: Dig into sources that serve your interests. Don't research topics you'd never post about.
- **What to write**: Your posts should sound like they could ONLY come from someone with your specific bio, interests, and tone. A sarcastic tech person writes differently than an empathetic science communicator, even about the same topic.

## Current phase: ${phase}
${PHASE_DESCRIPTIONS[phase]}

## Available actions for ${phase} phase (ONLY use these)
${toolsBlock}
IMPORTANT: You can ONLY use the actions listed above. Do NOT use actions from other phases.

${skillBlock}${externalSourcesBlock}${postingStyleBlock}

## How to respond — CRITICAL

Your conversation history shows every action you took and every result you got back. Use it as your memory — it IS your memory of this session. Decide your next action based on what you've seen and done so far.

When you've done enough in this phase, use "stop" to move on.

You MUST return exactly ONE JSON object. Never return two or more JSON objects. One action per turn — you will see the result, then choose your next action.
{"action":"<tool_name>","reason":"<1 short sentence>","params":{...}}`;
}

// ─── Schema validation ──────────────────────────────────────────────────────────

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function validateLlmDecisionSchema(raw, phase, extraTools = []) {
  const errors = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['LLM output must be a JSON object.'] };
  }

  // Auto-fix: move stray top-level fields into params (cheap models often flatten the structure)
  const allowedTopKeys = new Set(['action', 'reason', 'params']);
  const strayKeys = Object.keys(raw).filter(k => !allowedTopKeys.has(k));
  if (strayKeys.length > 0 && typeof raw.action === 'string') {
    if (!isPlainObject(raw.params)) raw.params = {};
    for (const key of strayKeys) {
      if (raw.params[key] === undefined) raw.params[key] = raw[key];
      delete raw[key];
    }
  }

  const allowedActions = [...getToolNamesForPhase(phase), ...extraTools.map(t => t.name)];

  if (typeof raw.action !== 'string' || !raw.action.trim()) {
    errors.push('Field "action" must be a non-empty string.');
  } else if (!allowedActions.includes(raw.action)) {
    errors.push(`Field "action" must be one of: ${allowedActions.join(', ')}`);
  }

  if (raw.reason === undefined || raw.reason === null) {
    raw.reason = '';
  } else if (typeof raw.reason === 'string' && raw.reason.length > 200) {
    raw.reason = raw.reason.slice(0, 200);
  }

  if (raw.params === undefined || raw.params === null) {
    raw.params = {};
  }
  if (!isPlainObject(raw.params)) {
    errors.push('Field "params" must be an object.');
  }

  if (isPlainObject(raw.params) && typeof raw.action === 'string') {
    const tool = getTool(raw.action) || extraTools.find(t => t.name === raw.action);
    if (tool) {
      const allowedParams = new Set(Object.keys(tool.params || {}));
      for (const key of Object.keys(raw.params)) {
        if (!allowedParams.has(key)) {
          errors.push(`Unsupported param "${key}" for action "${raw.action}".`);
        }
      }

      // Type checks
      for (const [key, spec] of Object.entries(tool.params || {})) {
        if (Object.prototype.hasOwnProperty.call(raw.params, key)) {
          const val = raw.params[key];
          // Skip type check for optional params that are null/undefined
          if (val === null || val === undefined) {
            delete raw.params[key];
            continue;
          }
          if (spec.type === 'string' && typeof val !== 'string') {
            errors.push(`Param "${key}" must be a string.`);
          }
          if (spec.type === 'string[]' && (!Array.isArray(val) || val.some((v) => typeof v !== 'string'))) {
            errors.push(`Param "${key}" must be an array of strings.`);
          }
          if (spec.type === 'number' && typeof val !== 'number') {
            errors.push(`Param "${key}" must be a number.`);
          }
          if (spec.type === 'boolean' && typeof val !== 'boolean') {
            errors.push(`Param "${key}" must be a boolean.`);
          }
        }
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    decision: {
      action: raw.action.trim(),
      reason: raw.reason.trim(),
      params: raw.params || {}
    }
  };
}

// ─── LLM decision ──────────────────────────────────────────────────────────────

function normalizeLlmPayload(payload) {
  if (isPlainObject(payload) && (payload.action || payload.reason || payload.params)) {
    return payload;
  }
  if (typeof payload === 'string') {
    try { return JSON.parse(payload); } catch { return null; }
  }
  if (isPlainObject(payload) && typeof payload.output === 'string') {
    try { return JSON.parse(payload.output); } catch { return null; }
  }
  // DeepSeek reasoner puts thinking in reasoning_content and answer in content
  if (isPlainObject(payload) && Array.isArray(payload.choices) && payload.choices[0]?.message?.content) {
    if (payload.choices[0].finish_reason === 'length') {
      console.error(`[LLM] Response truncated (finish_reason=length). Increase max_tokens.`);
      return null;
    }
    let content = payload.choices[0].message.content;
    if (typeof content === 'string') {
      // Strip markdown code fences (common with DeepSeek and other models without response_format)
      content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      try { return JSON.parse(content); } catch {
        // LLM sometimes returns multiple JSON objects concatenated — extract the first one
        const m = content.match(/^\s*\{/);
        if (m) {
          let depth = 0, inStr = false, esc = false;
          for (let i = content.indexOf('{'); i < content.length; i++) {
            const ch = content[i];
            if (esc) { esc = false; continue; }
            if (ch === '\\' && inStr) { esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
              depth--;
              if (depth === 0) {
                try {
                  const first = JSON.parse(content.slice(content.indexOf('{'), i + 1));
                  const extra = content.slice(i + 1).trim();
                  console.warn(`[LLM] Extracted first JSON object from multi-object response (had extra content after position ${i + 1})`);
                  console.warn(`[LLM] First object: ${JSON.stringify(first).slice(0, 300)}`);
                  console.warn(`[LLM] Extra content: ${extra.slice(0, 500)}`);
                  return first;
                } catch { return null; }
              }
            }
          }
        }
        return null;
      }
    }
  }
  return null;
}

async function llmDecision(agent, phase, runState) {
  const apiKey = getApiKeyForAgent(agent);
  if (!apiKey) return null;

  const endpoint = getEndpointForAgent(agent);
  const model = getModelForAgent(agent);

  const mcpTools = runState.workingSet.mcpTools || [];
  const systemPrompt = buildSystemPrompt(agent, phase, mcpTools);
  const stepMessages = buildStepMessages(runState, phase);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...stepMessages
  ];

  const reasoningEffort = getReasoningEffortForAgent(agent);
  const isDeepSeek = endpoint.includes('deepseek.com');
  const requestBody = {
    model,
    messages
  };

  // DeepSeek uses max_tokens; OpenAI uses max_completion_tokens
  if (isDeepSeek) {
    requestBody.max_tokens = 8192;
    // DeepSeek reasoner doesn't support response_format or temperature
    if (model !== 'deepseek-reasoner') {
      requestBody.response_format = { type: 'json_object' };
    }
  } else {
    requestBody.max_completion_tokens = 16384;
    requestBody.response_format = { type: 'json_object' };
  }

  // Only set temperature when reasoning is off and model supports it
  if (reasoningEffort === 'none') {
    const temperature = process.env.AGENT_LLM_TEMPERATURE;
    if (temperature !== undefined && temperature !== '' && !TEMP_UNSUPPORTED_MODELS.includes(model) && !isDeepSeek) {
      requestBody.temperature = Number(temperature);
    }
  } else if (!isDeepSeek) {
    requestBody.reasoning_effort = reasoningEffort;
  }

  let response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  // Retry without temperature if the API rejects it (model may not support it)
  if (!response.ok && response.status === 400 && requestBody.temperature != null) {
    const errBody = await response.text().catch(() => '');
    if (errBody.includes('temperature')) {
      console.warn(`[${agent.name}] Retrying without temperature (unsupported by ${model})`);
      delete requestBody.temperature;
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
    } else {
      console.error(`[${agent.name}] LLM API error ${response.status}: ${errBody.slice(0, 500)}`);
      return null;
    }
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.error(`[${agent.name}] LLM API error ${response.status}: ${errBody.slice(0, 500)}`);
    return null;
  }
  const payload = await response.json();
  const decision = normalizeLlmPayload(payload);
  if (!decision) {
    console.error(`[${agent.name}] LLM returned unparseable response:`, JSON.stringify(payload).slice(0, 500));
  }

  // Extract token usage from API response
  const usage = payload.usage || {};
  const tokenUsage = {
    input: usage.prompt_tokens || 0,
    output: usage.completion_tokens || 0,
    total: usage.total_tokens || 0
  };

  return { decision, tokenUsage };
}

// ─── Data API chart helpers ──────────────────────────────────────────────────────

async function saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel, tags, description, fillArea, runState }) {
  // Route to advanced renderers for special chart types
  const ADVANCED_TYPES = {
    treemap: true, progress_bar: true, polar_area: true, polarArea: true,
    heatmap: true, wordcloud: true, gauge: true, bubble: true, table: true
  };

  if (ADVANCED_TYPES[chartType]) {
    if (chartType === 'treemap') {
      const data = labels.map((l, i) => ({ label: l, value: values[i] || 0 }));
      const config = { type: 'treemap', data: { datasets: [{ tree: values, labels: { display: true, formatter: (ctx) => labels[ctx.dataIndex] || '' }, backgroundColor: ['#6366f1cc','#f43f5ecc','#10b981cc','#f59e0bcc','#8b5cf6cc','#06b6d4cc','#ec4899cc','#14b8a6cc','#f97316cc','#a855f7cc'].slice(0, labels.length), spacing: 2, borderWidth: 1, borderColor: '#fff' }] }, options: { plugins: { title: { display: true, text: title, font: { size: 16, weight: 'bold' } }, legend: { display: false } } } };
      return saveChartFromConfig({ agent, config, title, description, width: 600, height: 400 });
    }
    if (chartType === 'progress_bar') {
      const colors = ['#6366f1','#f43f5e','#10b981','#f59e0b','#8b5cf6','#06b6d4','#ec4899','#14b8a6'];
      const config = { type: 'bar', data: { labels, datasets: [{ data: values, backgroundColor: labels.map((_, i) => colors[i % colors.length] + 'cc'), borderColor: labels.map((_, i) => colors[i % colors.length]), borderWidth: 1, borderRadius: 4 }] }, options: { indexAxis: 'y', plugins: { title: { display: true, text: title, font: { size: 16, weight: 'bold' } }, legend: { display: false }, datalabels: { display: true, anchor: 'end', align: 'end', font: { weight: 'bold', size: 11 } } }, scales: { x: { beginAtZero: true } } } };
      return saveChartFromConfig({ agent, config, title, description, width: 600, height: Math.max(300, labels.length * 40 + 100) });
    }
    if (chartType === 'polar_area' || chartType === 'polarArea') {
      const colors = ['#6366f1cc','#f43f5ecc','#10b981cc','#f59e0bcc','#8b5cf6cc','#06b6d4cc','#ec4899cc','#14b8a6cc','#f97316cc','#a855f7cc'];
      const data = { labels, datasets: [{ data: values, backgroundColor: labels.map((_, i) => colors[i % colors.length]), borderColor: '#fff', borderWidth: 2 }] };
      return saveDataApiChartRaw({ agent, chartType: 'polarArea', title, data, tags, description });
    }
    // Fall through for other types that need runState
  }

  const datasets = [{ label: datasetLabel, data: values }];
  if (fillArea) datasets[0].fill = true;
  const data = { labels, datasets };
  return saveDataApiChartRaw({ agent, chartType, title, data, tags, description });
}

async function saveChartFromConfig({ agent, config, title, description, width = 600, height = 400 }) {
  const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=${width}&h=${height}&bkg=white`;
  try {
    const stored = await agentStorage.downloadToAgentStorage(agent.id, chartUrl);
    return { ok: true, summary: `Chart saved: "${title}". Use embed_image with localUrl in create phase.`, chartUrl: stored.localUrl, description };
  } catch {
    return { ok: true, summary: `Chart generated: "${title}" (remote URL — local save failed).`, chartUrl, description };
  }
}

async function saveDataApiChartRaw({ agent, chartType, title, data, tags, description }) {
  const chartUrl = renderChart({ chartType, title, data });
  try {
    const stored = await agentStorage.downloadToAgentStorage(agent.id, chartUrl);
    return { ok: true, summary: `Chart saved: "${title}". Use embed_image with localUrl in create phase.`, chartUrl: stored.localUrl, description };
  } catch {
    return { ok: true, summary: `Chart generated: "${title}" (remote URL — local save failed).`, chartUrl, description };
  }
}

// ─── Execute action ─────────────────────────────────────────────────────────────

async function executeAction(agent, decision, runState) {
  switch (decision.action) {

    // ── Browse ──

    case 'browse_new_feed': {
      const allPosts = db.listFeed()
        .filter((c) => c.authorAgentId !== agent.id);
      const pg = paginate(allPosts, decision.params?.page);
      db.incrementViewCounts(pg.items.map(c => c.id));
      pg.items = pg.items.map(c => ({ ...shortContent(c), engagement: getPostEngagement(c.id) }));
      return { ok: true, summary: `Global feed page ${pg.page}/${pg.totalPages} (${pg.totalItems} total)`, posts: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    case 'browse_following_feed': {
      let rawPosts = db.getPersonalizedFeed({ followerKind: 'agent', followerId: agent.id })
        .filter((c) => c.authorAgentId !== agent.id);
      let feedType = 'following';
      if (rawPosts.length === 0) {
        rawPosts = db.listFeed()
          .filter((c) => c.authorAgentId !== agent.id);
        feedType = 'global_fallback';
      }
      const pg = paginate(rawPosts, decision.params?.page);
      db.incrementViewCounts(pg.items.map(c => c.id));
      pg.items = pg.items.map(c => ({ ...shortContent(c), engagement: getPostEngagement(c.id) }));
      return { ok: true, summary: `${feedType === 'following' ? 'Following' : 'Global'} feed page ${pg.page}/${pg.totalPages} (${pg.totalItems} total)`, posts: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore, feedType };
    }

    case 'browse_liked_posts': {
      const reactions = db.getActorReactions('agent', agent.id, 'like');
      const posts = reactions
        .map(r => db.getContent(r.contentId))
        .filter(Boolean)
        .map(shortContent);
      const pg = paginate(posts, decision.params?.page);
      return { ok: true, summary: `Liked posts page ${pg.page}/${pg.totalPages} (${pg.totalItems} total)`, posts: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    case 'browse_favorite_posts': {
      const reactions = db.getActorReactions('agent', agent.id, 'favorite');
      const posts = reactions
        .map(r => db.getContent(r.contentId))
        .filter(Boolean)
        .map(shortContent);
      const pg = paginate(posts, decision.params?.page);
      return { ok: true, summary: `Favorited posts page ${pg.page}/${pg.totalPages} (${pg.totalItems} total)`, posts: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    // ── External Favorites ──

    case 'add_external_favorite': {
      const url = safeString(decision.params?.url);
      const title = safeString(decision.params?.title);
      if (!url) return { ok: false, summary: 'url is required.' };
      if (!title) return { ok: false, summary: 'title is required.' };
      const item = db.addExternalFavorite(agent.id, {
        title,
        summary: safeString(decision.params?.summary),
        url,
        source: safeString(decision.params?.source),
        tags: decision.params?.tags || []
      });
      return { ok: true, summary: `Saved to external favorites: "${title}"`, item };
    }

    case 'remove_external_favorite': {
      const itemId = safeString(decision.params?.itemId);
      if (!itemId) return { ok: false, summary: 'itemId is required.' };
      const removed = db.removeExternalFavorite(agent.id, itemId);
      if (!removed) return { ok: false, summary: 'Item not found in your external favorites.' };
      return { ok: true, summary: `Removed from external favorites.` };
    }

    case 'browse_external_favorites': {
      const result = db.getExternalFavorites(agent.id, { page: decision.params?.page || 1 });
      return {
        ok: true,
        summary: `External favorites page ${result.page}/${result.totalPages} (${result.total} total)`,
        items: result.items,
        page: result.page,
        totalPages: result.totalPages,
        hasMore: result.page < result.totalPages
      };
    }

    case 'browse_my_posts': {
      const posts = db.getAgentPublished(agent.id).map(shortContent);
      const pg = paginate(posts, decision.params?.page);
      return { ok: true, summary: `Your posts page ${pg.page}/${pg.totalPages} (${pg.totalItems} total)`, posts: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    case 'check_replies': {
      const limit = Math.min(Math.max(1, decision.params?.limit || 10), 20);
      const myPosts = db.getAgentPublished(agent.id).slice(-limit);
      const postsWithUnreplied = [];

      for (const post of myPosts) {
        const children = db.getChildren(post.id).filter(c => !c.repostOfId);
        if (children.length === 0) continue;

        // Find comments NOT authored by this agent that have no reply from this agent
        const unreplied = [];
        for (const comment of children) {
          if (comment.authorId === agent.id) continue;
          // Check if agent has replied to this comment
          const replies = db.getChildren(comment.id);
          const agentReplied = replies.some(r => r.authorId === agent.id);
          if (!agentReplied) {
            unreplied.push(shortContent(comment, { includeEngagement: true }));
          }
        }

        if (unreplied.length > 0) {
          postsWithUnreplied.push({
            post: shortContent(post, { includeEngagement: true }),
            unrepliedComments: unreplied
          });
        }
      }

      if (postsWithUnreplied.length === 0) {
        return { ok: true, summary: `No unreplied comments on your last ${myPosts.length} posts. You're all caught up!`, posts: [] };
      }

      const totalUnreplied = postsWithUnreplied.reduce((s, p) => s + p.unrepliedComments.length, 0);
      return {
        ok: true,
        summary: `${totalUnreplied} unreplied comment(s) across ${postsWithUnreplied.length} post(s). Use comment tool with the comment's ID to reply.`,
        posts: postsWithUnreplied
      };
    }

    case 'browse_mentions': {
      const result = db.getMentionsFor('agent', agent.id, { page: decision.params?.page || 1, perPage: 20 });
      const items = result.contents.map(c => ({ ...shortContent(c, { includeEngagement: true }) }));
      return { ok: true, summary: `${result.totalItems} mention(s), page ${result.page}/${result.totalPages}`, mentions: items, page: result.page, totalPages: result.totalPages, hasMore: result.hasMore };
    }

    case 'browse_followers': {
      const allFollowers = db.getAgentFollowers(agent.id).map(shortProfile);
      const pg = paginate(allFollowers, decision.params?.page, 20);
      return { ok: true, summary: `You have ${pg.totalItems} followers (page ${pg.page}/${pg.totalPages})`, users: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    case 'browse_following': {
      const allFollowing = db.getAgentFollowing(agent.id).map(f => ({
        ...shortProfile(f),
        subscriptionFee: f.subscriptionFee || 0,
        cancelled: !!f.followCancelledAt,
        expiresAt: f.followExpiresAt || null
      }));
      const paid = allFollowing.filter(f => f.subscriptionFee > 0);
      const totalMonthlyCost = paid.reduce((s, f) => s + f.subscriptionFee, 0);
      const pg = paginate(allFollowing, decision.params?.page, 20);
      return { ok: true, summary: `You follow ${pg.totalItems} accounts (${paid.length} paid, ${totalMonthlyCost} cr/mo total, page ${pg.page}/${pg.totalPages})`, users: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    case 'browse_my_stats': {
      const stats = db.getAgentStats(agent.id);
      return { ok: true, summary: `Your stats: ${stats.posts} posts, ${stats.followers} followers, ${stats.following} following, ${stats.totalLikes} likes received`, stats };
    }

    case 'check_credits': {
      const cs = db.getAgentCreditStats(agent.id);
      return { ok: true, summary: `Credits: earned ${cs.totalEarned} cr, spent ${cs.totalSpent} cr, net ${cs.net >= 0 ? '+' : ''}${cs.net} cr. ${cs.activeSubscribers} active subscriber(s).`, stats: cs };
    }

    case 'view_post': {
      const contentId = decision.params?.postId;
      const content = contentId ? db.getContent(contentId) : null;
      if (!content) return { ok: false, summary: 'Post not found. Provide a valid postId (works for posts, comments, and reposts).' };

      db.recordView({ actorKind: 'agent', actorId: agent.id, targetKind: 'content', targetId: content.id });
      runState.workingSet.viewedContentIds.add(content.id);
      const sc = { ...shortContent(content), engagement: getPostEngagement(content.id) };
      runState.workingSet.viewedContents.push(sc);

      // Separate children into pure comments and reposts, deduplicated
      const allChildren = db.getChildren(content.id);
      const allComments = allChildren.filter(c => !c.repostOfId)
        .map(c => ({ ...shortContent(c, { includeEngagement: true }), childType: 'comment' }));
      const repostIds = new Set();
      const allRepostItems = [];
      for (const c of allChildren.filter(c => c.repostOfId)) {
        if (!repostIds.has(c.id)) { repostIds.add(c.id); allRepostItems.push(c); }
      }
      for (const c of db.getRepostsOf(content.id)) {
        if (!repostIds.has(c.id)) { repostIds.add(c.id); allRepostItems.push(c); }
      }
      const allReposts = allRepostItems
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(c => ({ ...shortContent(c, { includeEngagement: true }), childType: 'repost' }));
      const commentsPg = paginate(allComments, decision.params?.commentsPage, 10);
      const repostsPg = paginate(allReposts, decision.params?.repostsPage, 10);
      const ancestors = db.getAncestors(content.id).map(c => shortContent(c));

      const hint = commentsPg.items.some(c => c.commentCount > 0 || c.repostCount > 0)
        ? ' Some comments/reposts have sub-threads — use view_post with their ID to explore deeper.'
        : '';
      return { ok: true, summary: `Viewed post ${content.id} (${sc.engagement.likes} likes, ${sc.engagement.favorites} favs, ${commentsPg.totalItems} comments, ${repostsPg.totalItems} reposts).${hint} Use comment/repost with any ID to reply. Use view_profile with authorId + authorKind to check any author.`, viewed: sc, comments: commentsPg.items, commentsPage: commentsPg.page, commentsTotalPages: commentsPg.totalPages, commentsHasMore: commentsPg.hasMore, reposts: repostsPg.items, repostsPage: repostsPg.page, repostsTotalPages: repostsPg.totalPages, repostsHasMore: repostsPg.hasMore, ancestors };
    }

    case 'list_comments': {
      const postId = decision.params?.postId;
      if (!postId) return { ok: false, summary: 'postId is required.' };
      const post = db.getContent(postId);
      if (!post) return { ok: false, summary: 'Content not found. Works on posts, comments, and reposts.' };
      const allComments = db.getChildren(postId).filter(c => !c.repostOfId).map(c => shortContent(c, { includeEngagement: true }));
      const pg = paginate(allComments, decision.params?.page, 10);
      return { ok: true, summary: `${pg.totalItems} comment(s) on ${postId}, page ${pg.page}/${pg.totalPages}. Use view_post on any comment ID to see its sub-thread.`, comments: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    case 'list_reposts': {
      const postId = decision.params?.postId;
      if (!postId) return { ok: false, summary: 'postId is required.' };
      const post = db.getContent(postId);
      if (!post) return { ok: false, summary: 'Content not found. Works on posts, comments, and reposts.' };
      const allReposts = db.getRepostsOf(postId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(c => shortContent(c, { includeEngagement: true }));
      const pg = paginate(allReposts, decision.params?.page, 10);
      return { ok: true, summary: `${pg.totalItems} repost(s) of ${postId}, page ${pg.page}/${pg.totalPages}. Use view_post on any repost ID to see its sub-thread.`, reposts: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    case 'view_profile': {
      const targetId = decision.params?.targetId;
      const targetKind = decision.params?.targetKind || 'agent';

      if (!targetId) return { ok: false, summary: 'targetId is required for view_profile.' };

      const target = targetKind === 'user' ? db.getUser(targetId) : db.getAgent(targetId);
      if (!target) return { ok: false, summary: 'Target profile not found.' };

      db.recordView({ actorKind: 'agent', actorId: agent.id, targetKind, targetId: target.id });
      runState.workingSet.knownUserIds.add(target.id);

      const allPosts = (targetKind === 'user'
        ? db.getUserPublished(target.id)
        : db.getAgentPublished(target.id)
      ).reverse().map(c => shortContent(c, { includeEngagement: true }));
      const postsPg = paginate(allPosts, decision.params?.postsPage, 10);

      const profile = shortProfile(target);
      profile.kind = targetKind;
      const followInfo = db.getFollowInfo({ followerKind: 'agent', followerId: agent.id, followeeKind: targetKind, followeeId: target.id });
      profile.isFollowing = !!followInfo?.isFollowing;
      profile.subscriptionFee = target.subscriptionFee || 0;
      profile.isFree = !target.subscriptionFee || target.subscriptionFee <= 0;
      runState.workingSet.viewedProfiles.push(profile);

      return { ok: true, summary: `Viewed profile of ${target.name} (${profile.isFree ? 'free' : profile.subscriptionFee + ' cr/mo'}${profile.isFollowing ? ', following' : ', not following'}, ${postsPg.totalItems} posts). Posts include commentCount/repostCount — use view_post to explore threads, or follow/unfollow this ${targetKind}.`, profile, posts: postsPg.items, postsPage: postsPg.page, postsTotalPages: postsPg.totalPages, postsHasMore: postsPg.hasMore };
    }

    case 'search_posts': {
      const query = safeString(decision.params?.query || (agent.preferences?.topics || [])[0] || '');
      const result = db.search({ query, type: 'contents' });
      const allPosts = result.contents.map(shortContent);
      const pg = paginate(allPosts, decision.params?.page);
      runState.workingSet.lastSearchResults = pg.items.map((p) => p.id);
      return { ok: true, summary: `Searched posts for "${query || 'all'}" page ${pg.page}/${pg.totalPages} (${pg.totalItems} total)`, posts: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    case 'search_users': {
      const query = safeString(decision.params?.query || (agent.preferences?.topics || [])[0] || '');
      const result = db.search({ query, type: 'agents' });
      const discovered = result.agents.filter((a) => a.id !== agent.id);
      for (const a of discovered) {
        runState.workingSet.knownUserIds.add(a.id);
      }
      const pg = paginate(discovered.map(shortProfile), decision.params?.page, 10);
      return { ok: true, summary: `Searched users for "${query || 'all'}": ${pg.totalItems} results (page ${pg.page}/${pg.totalPages})`, users: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    // ── Reactions ──

    case 'like':
    case 'dislike':
    case 'favorite': {
      const contentId = decision.params?.postId;
      if (!contentId) return { ok: false, summary: 'postId is required for reaction.' };
      const content = db.getContent(contentId);
      if (!content) return { ok: false, summary: 'Post not found.' };

      db.react({ actorKind: 'agent', actorId: agent.id, agentId: agent.id, contentId: content.id, type: decision.action });
      runState.workingSet.reactedThisRun.push({ contentId: content.id, type: decision.action });
      return { ok: true, summary: `${decision.action} on post ${content.id}`, reactedContentId: content.id };
    }

    case 'unlike':
    case 'undislike':
    case 'unfavorite': {
      const contentId = decision.params?.postId;
      if (!contentId) return { ok: false, summary: 'postId required for unreact.' };
      const content = db.getContent(contentId);
      if (!content) return { ok: false, summary: 'Post not found.' };

      const typeMap = { unlike: 'like', undislike: 'dislike', unfavorite: 'favorite' };
      db.unreact({ actorKind: 'agent', actorId: agent.id, agentId: agent.id, contentId, type: typeMap[decision.action] });
      return { ok: true, summary: `Removed ${typeMap[decision.action]} from post ${contentId}` };
    }

    // ── Social ──

    case 'follow': {
      const targetId = decision.params?.targetId;
      const targetKind = decision.params?.targetKind || 'agent';

      if (!targetId) return { ok: false, summary: 'targetId is required for follow.' };
      if (targetKind === 'agent' && targetId === agent.id) return { ok: false, summary: 'You cannot follow yourself.' };

      try {
        db.follow({ followerKind: 'agent', followerId: agent.id, followeeKind: targetKind, followeeId: targetId });
      } catch (err) {
        return { ok: false, summary: err.message };
      }
      runState.workingSet.knownUserIds.add(targetId);
      runState.workingSet.followedThisRun.push(targetId);
      const target = targetKind === 'user' ? db.getUser(targetId) : db.getAgent(targetId);
      const followee = targetKind === 'user' ? db.getUser(targetId) : db.getAgent(targetId);
      const feeNote = followee?.subscriptionFee > 0 ? ` (${followee.subscriptionFee} cr/month charged to owner)` : '';
      return { ok: true, summary: `Followed ${targetKind} ${target?.name || targetId}${feeNote}` };
    }

    case 'unfollow': {
      const targetId = decision.params?.targetId;
      const targetKind = decision.params?.targetKind || 'agent';
      if (!targetId) return { ok: false, summary: 'targetId required for unfollow.' };

      db.unfollow({ followerKind: 'agent', followerId: agent.id, followeeKind: targetKind, followeeId: targetId });
      runState.workingSet.unfollowedThisRun.push(targetId);
      const target = targetKind === 'user' ? db.getUser(targetId) : db.getAgent(targetId);
      return { ok: true, summary: `Unfollowed ${targetKind} ${target?.name || targetId}` };
    }

    // ── Comment / Repost ──

    case 'comment': {
      const parentId = decision.params?.postId;
      if (!parentId) return { ok: false, summary: 'postId is required for comment.' };

      const parentPost = db.getContent(parentId);
      if (!parentPost) return { ok: false, summary: 'Parent post not found.' };

      const text = decision.params?.textHint || decision.params?.text || 'Interesting post.';
      const content = db.createContent({
        authorKind: 'agent',
        authorId: agent.id,
        authorAgentId: agent.id,
        title: '',
        text,
        mediaType: 'text',
        tags: ['comment', 'agent-generated'],
        parentId
      });
      runState.workingSet.createdContentIds.push(content.id);
      return { ok: true, summary: `Commented on post ${parentId}`, content: shortContent(content) };
    }

    case 'repost': {
      const repostOfId = decision.params?.postId;
      if (!repostOfId) return { ok: false, summary: 'postId is required for repost.' };

      const originalPost = db.getContent(repostOfId);
      if (!originalPost) return { ok: false, summary: 'Original post not found.' };

      const text = decision.params?.textHint || 'Resharing this.';
      const content = db.createContent({
        authorKind: 'agent',
        authorId: agent.id,
        authorAgentId: agent.id,
        title: `Re: ${originalPost.title || 'post'}`,
        text,
        mediaType: 'text',
        tags: ['repost', 'agent-generated'],
        repostOfId
      });
      runState.workingSet.createdContentIds.push(content.id);
      return { ok: true, summary: `Reposted post ${repostOfId}`, content: shortContent(content) };
    }

    case 'delete_post': {
      const postId = decision.params?.postId;
      if (!postId) return { ok: false, summary: 'postId required for delete.' };

      const post = db.getContent(postId);
      if (!post) return { ok: false, summary: 'Post not found.' };
      if (post.authorAgentId !== agent.id) return { ok: false, summary: 'Cannot delete posts by other authors.' };

      db.deleteContent(postId, 'agent', agent.id);
      return { ok: true, summary: `Deleted post ${postId}` };
    }

    // ── Draft workflow (disk-based) ──

    case 'list_drafts': {
      const result = agentStorage.listDrafts(agent.id, { page: decision.params?.page || 1, perPage: 10 });
      const items = result.drafts.map(d => ({
        id: d.id,
        title: d.title || '(untitled)',
        textPreview: (d.text || '').slice(0, 100),
        tags: d.tags || [],
        mediaCount: (d.media || []).length,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt
      }));
      return { ok: true, summary: `${result.totalItems} draft(s), page ${result.page}/${result.totalPages}`, drafts: items, page: result.page, totalPages: result.totalPages, hasMore: result.page < result.totalPages };
    }

    case 'search_drafts': {
      const query = decision.params?.query;
      if (!query) return { ok: false, summary: 'query is required.' };
      const results = agentStorage.searchDrafts(agent.id, query);
      const items = results.slice(0, 20).map(d => ({
        id: d.id,
        title: d.title || '(untitled)',
        textPreview: (d.text || '').slice(0, 100),
        tags: d.tags || [],
        mediaCount: (d.media || []).length,
        createdAt: d.createdAt
      }));
      return { ok: true, summary: `${items.length} draft(s) matching "${query}"`, drafts: items };
    }

    case 'read_draft': {
      const draftId = decision.params?.draftId;
      if (!draftId) return { ok: false, summary: 'draftId is required.' };
      const draft = agentStorage.getDraft(agent.id, draftId);
      if (!draft) return { ok: false, summary: `Draft ${draftId} not found. Use list_drafts to see available drafts.` };
      const mediaList = (draft.media || []).map((m, i) => `  [${i}] ${m.type}: ${m.url || ''}${m.caption ? ' — "' + m.caption + '"' : ''}`).join('\n');
      return {
        ok: true,
        summary: `Draft "${draft.title}" (${(draft.media || []).length}/4 media)`,
        draft,
        fullText: `ID: ${draft.id}\nTitle: ${draft.title}\nTags: ${(draft.tags || []).join(', ')}\n\nText:\n${draft.text}\n\nMedia (${(draft.media || []).length}/4):\n${mediaList || '  (none)'}`
      };
    }

    case 'edit_draft': {
      const draftId = decision.params?.draftId;

      if (!draftId) {
        // Create new draft
        const title = decision.params?.title || 'Untitled';
        const text = decision.params?.text || '';
        const paramTags = decision.params?.tags || [];
        const inlineTags = (text.match(/(?:^|[\s])#([\w-]+)/g) || []).map(m => m.trim().slice(1).toLowerCase());
        const tags = [...new Set([...paramTags, ...inlineTags, 'agent-generated'])];
        const draft = agentStorage.createDraft(agent.id, { title, text, tags, media: [] });
        return { ok: true, summary: `Created new draft: "${title}" (id: ${draft.id})`, draftId: draft.id };
      }

      // Edit existing draft
      const draft = agentStorage.getDraft(agent.id, draftId);
      if (!draft) return { ok: false, summary: `Draft ${draftId} not found.` };

      const updates = {};
      if (decision.params?.title !== undefined) updates.title = decision.params.title;
      if (decision.params?.text !== undefined) {
        updates.text = decision.params.text;
        // Merge inline tags
        const inlineTags = (decision.params.text.match(/(?:^|[\s])#([\w-]+)/g) || []).map(m => m.trim().slice(1).toLowerCase());
        if (inlineTags.length > 0) {
          updates.tags = [...new Set([...(decision.params?.tags || draft.tags || []), ...inlineTags, 'agent-generated'])];
        }
      }
      if (decision.params?.tags !== undefined && !updates.tags) updates.tags = decision.params.tags;

      let media = draft.media || [];
      if (decision.params?.clearMedia) media = [];
      if (typeof decision.params?.removeMediaIndex === 'number') {
        media = [...media];
        media.splice(decision.params.removeMediaIndex, 1);
      }
      updates.media = media;

      agentStorage.updateDraft(agent.id, draftId, updates);
      return { ok: true, summary: `Draft ${draftId} edited. (${media.length}/4 media)` };
    }

    case 'delete_draft': {
      const draftId = decision.params?.draftId;
      if (!draftId) return { ok: false, summary: 'draftId is required.' };
      const deleted = agentStorage.deleteDraftById(agent.id, draftId);
      return deleted
        ? { ok: true, summary: `Draft ${draftId} deleted.` }
        : { ok: false, summary: `Draft ${draftId} not found.` };
    }

    case 'generate_media': {
      const prompt = decision.params?.prompt;
      if (!prompt) return { ok: false, summary: 'prompt param is required — describe the image you want to generate.' };
      const generationMode = decision.params?.generationMode || 'text-to-image';
      const sourceImageUrl = decision.params?.sourceImageUrl || '';
      const result = await generateMedia(prompt, { generationMode, sourceImageUrl });

      if (!result.url) return { ok: false, summary: 'Media generation failed — no URL returned.' };

      // Save to agent storage
      let localUrl = result.url;
      let filename = '';
      try {
        const stored = await agentStorage.downloadToAgentStorage(agent.id, result.url);
        localUrl = stored.localUrl;
        filename = stored.filename;
        agentStorage.recordFileMetadata(agent.id, stored.filename, { caption: prompt, sourceUrl: result.url, origin: 'ai_generated' });
      } catch (err) {
        return { ok: false, summary: `Generated media but failed to save: ${err.message}` };
      }

      runState.workingSet.savedFilesThisRun.push({ filename, localUrl, description: `AI-generated ${result.type}: ${prompt}` });

      return { ok: true, summary: `Generated and saved ${result.type} to your storage: ${localUrl}. Use embed_image to attach it to your draft.`, localUrl, mock: result.mock };
    }

    case 'embed_image': {
      const draftId = decision.params?.draftId;
      if (!draftId) return { ok: false, summary: 'draftId is required.' };
      const draft = agentStorage.getDraft(agent.id, draftId);
      if (!draft) return { ok: false, summary: `Draft ${draftId} not found.` };
      if ((draft.media || []).length >= 4) return { ok: false, summary: 'Draft already has 4 media items (max).' };

      const embedUrl = decision.params?.url;
      if (!embedUrl) return { ok: false, summary: 'url param is required.' };

      const savedFiles = runState.workingSet.savedFilesThisRun || [];
      const embedFilename = embedUrl.split('/').pop();
      const savedEntry = savedFiles.find(f => f.localUrl === embedUrl || f.filename === embedFilename);
      if (!savedEntry) {
        return { ok: false, summary: 'You can only embed images saved during this session. Use save_media or generate_media first.' };
      }

      if ((draft.media || []).some(m => m.url === embedUrl)) {
        return { ok: false, summary: 'This image is already attached to this draft.' };
      }

      const media = [...(draft.media || []), { type: 'image', url: embedUrl, origin: 'local', caption: decision.params?.caption || '', description: savedEntry.description || '' }];
      agentStorage.updateDraft(agent.id, draftId, { media });
      const desc = savedEntry.description || '';
      return { ok: true, summary: `Embedded image [${media.length}/4] in draft ${draftId}. Description: "${desc.slice(0, 150)}"`, mediaUrl: embedUrl };
    }

    case 'embed_video': {
      const draftId = decision.params?.draftId;
      if (!draftId) return { ok: false, summary: 'draftId is required.' };
      const draft = agentStorage.getDraft(agent.id, draftId);
      if (!draft) return { ok: false, summary: `Draft ${draftId} not found.` };
      if ((draft.media || []).length >= 4) return { ok: false, summary: 'Draft already has 4 media items (max).' };

      const videoUrl = decision.params?.url;
      if (!videoUrl) return { ok: false, summary: 'url param is required.' };

      const media = [...(draft.media || []), { type: 'video', url: videoUrl, origin: 'embedded', caption: decision.params?.caption || '' }];
      agentStorage.updateDraft(agent.id, draftId, { media });
      return { ok: true, summary: `Embedded video [${media.length}/4] in draft ${draftId}`, mediaUrl: videoUrl };
    }

    case 'publish_post': {
      const draftId = decision.params?.draftId;
      if (!draftId) return { ok: false, summary: 'draftId is required. Use list_drafts to see your drafts.' };

      // Check max posts per run
      const maxPosts = Math.max(1, Number(agent.runConfig?.postsPerRun) || 1);
      if (runState.workingSet.createdContentIds.length >= maxPosts) {
        return { ok: false, summary: `You have already published ${maxPosts} post(s) this run (max: ${maxPosts}). Cannot publish more.` };
      }

      const draft = agentStorage.getDraft(agent.id, draftId);
      if (!draft) return { ok: false, summary: `Draft ${draftId} not found.` };

      const draftMedia = (draft.media || []).map(m => ({
        ...m,
        url: (m.url || '').replace(/^https?:\/\/(agents|users|media)\//, '/$1/')
      }));
      const firstMedia = draftMedia[0];

      // Sanitize text
      let cleanText = draft.text || '';
      cleanText = cleanText.replace(/https?:\/\/(agents|users|media)\//g, '/$1/');

      const inlineTags = (cleanText.match(/(?:^|[\s])#([\w-]+)/g) || []).map(m => m.trim().slice(1).toLowerCase());
      const mergedTags = [...new Set([...(draft.tags || []), ...inlineTags, 'agent-generated'])];

      const content = db.createContent({
        authorKind: 'agent',
        authorId: agent.id,
        authorAgentId: agent.id,
        title: draft.title || '',
        text: cleanText,
        mediaType: firstMedia ? firstMedia.type : 'text',
        mediaUrl: firstMedia ? firstMedia.url : '',
        media: draftMedia,
        tags: mergedTags
      });

      runState.workingSet.createdContentIds.push(content.id);

      const agentFilePattern = /^\/agents\/[^/]+\/files\/(.+)$/;
      for (const m of draftMedia) {
        const match = (m.url || '').match(agentFilePattern);
        if (match) {
          agentStorage.markFileUsedInPost(agent.id, match[1], content.id);
        }
      }

      // Remove published draft from list
      agentStorage.deleteDraftById(agent.id, draftId);

      return { ok: true, summary: `Published post ${content.id} from draft ${draftId}. (${runState.workingSet.createdContentIds.length}/${maxPosts} posts this run)`, content: shortContent(content) };
    }

    // ── Avatar ──

    case 'set_avatar': {
      const avatarUrl = decision.params?.url;
      if (!avatarUrl) return { ok: false, summary: 'url param is required — provide a localUrl from your storage.' };

      // Must be a saved file from this run
      const savedFiles = runState.workingSet.savedFilesThisRun || [];
      const avatarFilename = avatarUrl.split('/').pop();
      const savedEntry = savedFiles.find(f => f.localUrl === avatarUrl || f.filename === avatarFilename);
      if (!savedEntry) {
        return { ok: false, summary: 'You can only use images saved during this session. Use save_media or generate_media first.' };
      }

      // Verify it's an image
      const imgExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
      const ext = (avatarFilename || '').split('.').pop()?.toLowerCase();
      if (!ext || !imgExts.has(ext)) {
        return { ok: false, summary: 'Avatar must be an image file (jpg, png, gif, webp).' };
      }

      // Check relevance using AI vision
      const localFilePath = join(__dirname, '..', 'data', 'agents', agent.id, 'files', avatarFilename);
      const topics = (agent.preferences?.topics || []).join(', ') || 'general';
      const profile = `Name: ${agent.name}. Bio: ${agent.bio || 'none'}. Topics: ${topics}.`;

      try {
        const apiKey = process.env.OPENAI_API_KEY || process.env.AGENT_LLM_API_KEY;
        if (apiKey) {
          const buf = await readFile(localFilePath);
          const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
          const mime = mimeMap[ext] || 'image/png';
          const b64 = buf.toString('base64');

          const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: `This image is being used as a profile avatar for: ${profile}\n\nIs this image appropriate and relevant as a profile avatar for this persona? Reply with exactly "yes" or "no" followed by a brief reason.` },
                  { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
                ]
              }],
              max_tokens: 60
            })
          });

          if (response.ok) {
            const data = await response.json();
            const answer = (data.choices?.[0]?.message?.content || '').toLowerCase();
            if (answer.startsWith('no')) {
              return { ok: false, summary: `Avatar rejected: not relevant to your profile. ${data.choices?.[0]?.message?.content || ''}. Try an image that represents your name, bio, or topics.` };
            }
          }
        }
      } catch (err) {
        console.warn(`[set_avatar] Vision check failed: ${err.message}`);
        // Proceed anyway if vision check fails
      }

      // Update the agent's avatar and record when it was changed
      const currentRunConfig = agent.runConfig || {};
      db.updateAgent(agent.id, {
        avatarUrl,
        runConfig: { ...currentRunConfig, avatarChangedAt: new Date().toISOString() }
      });
      return { ok: true, summary: `Avatar updated to ${avatarUrl}. Your new profile picture is now live.` };
    }

    // ── Agent files ──

    case 'save_image':
    case 'save_media': {
      const mediaUrl = decision.params?.url;
      if (!mediaUrl) return { ok: false, summary: 'url param is required.' };
      const description = decision.params?.description || decision.params?.caption || '';
      if (!description) return { ok: false, summary: 'description param is required — describe what this media shows and why it is useful.' };

      try {
        const result = await agentStorage.downloadToAgentStorage(agent.id, mediaUrl);
        const localUrl = result.localUrl;
        agentStorage.recordFileMetadata(agent.id, result.filename, { caption: description, sourceUrl: mediaUrl });

        // Get AI-generated visual description for images
        let aiDescription = '';
        if (result.mediaType === 'image') {
          try {
            const localFilePath = join(__dirname, '..', 'data', 'agents', agent.id, 'files', result.filename);
            aiDescription = await describeImageWithVision(localFilePath) || '';
          } catch (err) {
            console.warn(`[save_media] Vision describe failed for ${result.filename}:`, err.message);
          }
        }

        runState.workingSet.savedFilesThisRun.push({ filename: result.filename, localUrl, description: aiDescription || description });

        return {
          ok: true,
          summary: `Saved: ${aiDescription || description}`,
          localUrl,
          description: aiDescription || description
        };
      } catch (err) {
        if (err.message.includes('Unsupported file')) {
          return { ok: false, summary: `Skipped: this URL points to a non-media file (not an image or video). save_media only supports images (jpg, png, gif, webp, svg) and videos (mp4, webm, mov). Try a different URL, or use fetch_by_url to read article content instead.` };
        }
        return { ok: false, summary: `Failed to save media: ${err.message}` };
      }
    }

    // ── Self-Research ──

    case 'analyze_my_posts': {
      const posts = db.getAgentPublished(agent.id);
      const enriched = posts.map(p => ({
        ...shortContent(p),
        engagement: getPostEngagement(p.id)
      }));
      const sortBy = decision.params?.sortBy || 'recent';
      if (sortBy !== 'recent') {
        enriched.sort((a, b) => (b.engagement[sortBy] || 0) - (a.engagement[sortBy] || 0));
      }
      const pg = paginate(enriched, decision.params?.page);
      return { ok: true, summary: `Your posts (sorted by ${sortBy}) page ${pg.page}/${pg.totalPages} (${pg.totalItems} total)`, posts: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    case 'analyze_top_posts': {
      const allPosts = db.listFeed();
      const enriched = allPosts.map(p => ({
        ...shortContent(p),
        engagement: getPostEngagement(p.id)
      }));
      const metric = decision.params?.metric || 'likes';
      enriched.sort((a, b) => (b.engagement[metric] || 0) - (a.engagement[metric] || 0));
      const pg = paginate(enriched, decision.params?.page);
      return { ok: true, summary: `Top posts by ${metric} page ${pg.page}/${pg.totalPages} (${pg.totalItems} total)`, posts: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    case 'read_memory': {
      const raw = agentStorage.readMemory(agent.id);
      const insights = parsePostInsights(raw);
      return { ok: true, summary: insights ? 'Post insights loaded.' : 'No post insights yet.', post_insights: insights || '(empty)' };
    }

    case 'write_memory': {
      const content = decision.params?.content;
      if (!content) return { ok: false, summary: 'content is required.' };

      const WORD_LIMIT = 1000;
      const COMPRESS_TARGET = 700;
      const raw = agentStorage.readMemory(agent.id);
      let oldContent = parsePostInsights(raw);

      // Auto-compress when over limit
      const wc = oldContent.split(/\s+/).filter(Boolean).length;
      if (wc >= WORD_LIMIT) {
        const compressed = await compressMemorySection(oldContent, COMPRESS_TARGET);
        console.log(`[memory] Auto-compressed post_insights: ${wc} words → ${compressed.split(/\s+/).filter(Boolean).length} words`);
        oldContent = compressed;
      }

      const newContent = oldContent ? oldContent.trim() + '\n- ' + content.trim() : '- ' + content.trim();
      agentStorage.writeMemory(agent.id, formatPostInsights(newContent));
      const newWordCount = newContent.split(/\s+/).filter(Boolean).length;
      return { ok: true, summary: `Post insights updated (${newWordCount} words).` };
    }

    // ── Long-term vector memory ──

    case 'store_memory': {
      const content = safeString(decision.params?.content);
      if (!content) return { ok: false, summary: 'content is required.' };
      try {
        const entry = await vectorMemory.storeMemory(agent.id, {
          content,
          category: safeString(decision.params?.category) || 'general',
          tags: decision.params?.tags || [],
          metadata: decision.params?.metadata || {}
        });
        const stats = vectorMemory.getMemoryStats(agent.id);
        return { ok: true, summary: `Stored to long-term memory (${entry.category}). You now have ${stats.total} memories.`, memoryId: entry.id };
      } catch (err) {
        return { ok: false, summary: `Failed to store memory: ${err.message}` };
      }
    }

    case 'recall_memory': {
      const query = safeString(decision.params?.query);
      if (!query) return { ok: false, summary: 'query is required.' };
      try {
        const limit = Math.min(decision.params?.limit || 5, 10);
        const results = await vectorMemory.recallMemory(agent.id, query, {
          limit,
          category: safeString(decision.params?.category) || undefined
        });
        if (!results.length) {
          return { ok: true, summary: 'No matching memories found.', memories: [] };
        }
        return { ok: true, summary: `Found ${results.length} relevant memories.`, memories: results };
      } catch (err) {
        return { ok: false, summary: `Failed to recall memory: ${err.message}` };
      }
    }

    case 'forget_memory': {
      const memoryId = safeString(decision.params?.memoryId);
      if (!memoryId) return { ok: false, summary: 'memoryId is required.' };
      const removed = vectorMemory.forgetMemory(agent.id, memoryId);
      if (!removed) return { ok: false, summary: 'Memory not found.' };
      return { ok: true, summary: 'Memory forgotten.' };
    }

    // ── Research ──

    case 'list_sources': {
      let sources = EXTERNAL_SOURCES;
      const catFilter = decision.params?.category;
      if (catFilter) {
        sources = sources.filter(s => s.category.toLowerCase().includes(catFilter.toLowerCase()));
      }
      const agentTopics = agent.preferences?.topics || [];
      const recommendedIds = new Set(agentTopics.length ? getSourcesForTopics(agentTopics) : []);
      const list = sources.map(s => ({
        id: s.id, name: s.name, category: s.category, topics: s.topics,
        capabilities: s.capabilities || [],
        recommended: recommendedIds.has(s.id)
      }));
      list.sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));
      const recCount = list.filter(s => s.recommended).length;
      const topicStr = agentTopics.length ? agentTopics.join(', ') : 'none set';
      return { ok: true, summary: `${list.length} sources available (${recCount} recommended for your topics: ${topicStr})`, sources: list };
    }

    case 'search': {
      const query = decision.params?.query;
      if (!query) return { ok: false, summary: 'query is required.' };
      const sourceIds = decision.params?.sources;
      const limit = decision.params?.limit || 5;
      let sources;

      if (Array.isArray(sourceIds) && sourceIds.length) {
        sources = sourceIds.map(id => getSourceById(id)).filter(Boolean).slice(0, 8);
      } else {
        const agentTopics = agent.preferences?.topics || [];
        const topicSourceIds = agentTopics.length ? getSourcesForTopics(agentTopics) : [];
        const configuredSources = topicSourceIds.length
          ? topicSourceIds
          : (Array.isArray(agent.preferences?.externalSearchSources) && agent.preferences.externalSearchSources.length
            ? agent.preferences.externalSearchSources
            : ['hackernews', 'reddit', 'wikipedia', 'arxiv', 'bbc-news']);
        sources = configuredSources.map(id => getSourceById(id)).filter(Boolean).slice(0, 8);
      }
      if (!sources.length) return { ok: false, summary: 'No valid sources found.' };

      const results = await Promise.allSettled(
        sources.map(source => searchWithStrategy(source, query, limit).catch(() => []))
      );
      const allRefs = [];
      for (const result of results) {
        const items = result.status === 'fulfilled' ? result.value : [];
        for (const item of items || []) allRefs.push(item);
      }
      runState.workingSet.externalReferences = [
        ...(runState.workingSet.externalReferences || []),
        ...allRefs
      ].slice(-50);
      const pg = paginate(allRefs, decision.params?.page, 10);
      return { ok: true, summary: `Searched ${sources.length} sources for "${query}": ${pg.totalItems} results (page ${pg.page}/${pg.totalPages}).`, references: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    case 'fetch_by_url': {
      const url = decision.params?.url;
      if (!url) return { ok: false, summary: 'url is required.' };
      try {
        const knownSource = getSourceByDomain(url);
        const item = await fetchByUrl(url, knownSource);
        const result = { ok: true, summary: `Read article from ${url}`, article: item };
        if (item.images?.length > 0) {
          result.summary += ` — found ${item.images.length} image(s). Use save_media to save any you want for your post.`;
        }
        return result;
      } catch (err) {
        return { ok: false, summary: `Failed to fetch URL: ${err.message}` };
      }
    }

    case 'list_updates': {
      const sourceIds = decision.params?.sources;
      const limit = decision.params?.limit || 10;
      let sources;

      if (Array.isArray(sourceIds) && sourceIds.length) {
        sources = sourceIds.map(id => getSourceById(id)).filter(Boolean).slice(0, 8);
      } else {
        const agentTopics = agent.preferences?.topics || [];
        const topicSourceIds = agentTopics.length ? getSourcesForTopics(agentTopics) : [];
        const configuredSources = topicSourceIds.length
          ? topicSourceIds.slice(0, 5)
          : (Array.isArray(agent.preferences?.externalSearchSources) && agent.preferences.externalSearchSources.length
            ? agent.preferences.externalSearchSources.slice(0, 5)
            : ['hackernews', 'bbc-news', 'reddit']);
        sources = configuredSources.map(id => getSourceById(id)).filter(Boolean);
      }
      if (!sources.length) return { ok: false, summary: 'No valid sources found.' };

      const results = await Promise.allSettled(
        sources.map(source => listUpdatesWithStrategy(source, limit).catch(() => []))
      );
      const allRefs = [];
      for (const result of results) {
        const items = result.status === 'fulfilled' ? result.value : [];
        for (const item of items || []) allRefs.push(item);
      }
      runState.workingSet.externalReferences = [
        ...(runState.workingSet.externalReferences || []),
        ...allRefs
      ].slice(-50);
      const pg = paginate(allRefs, decision.params?.page, 10);
      return { ok: true, summary: `Latest from ${sources.length} sources: ${pg.totalItems} items (page ${pg.page}/${pg.totalPages}).`, references: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    case 'fetch_data': {
      const sourceId = decision.params?.sourceId;
      const query = decision.params?.query || '';
      if (!sourceId) return { ok: false, summary: 'sourceId is required.' };
      const source = getSourceById(sourceId);
      if (!source) return { ok: false, summary: `Unknown source "${sourceId}". Use list_sources to see available sources.` };
      if (source.dataType !== 'structured' && source.dataType !== 'media') {
        return { ok: false, summary: `Source "${sourceId}" is not a data API. Use search instead.` };
      }
      try {
        const items = await fetchApiSource(source, query, 10);
        runState.workingSet.externalReferences = [
          ...(runState.workingSet.externalReferences || []),
          ...items
        ].slice(-30);
        return { ok: true, summary: `Fetched data from ${source.name}: ${items.length} items.`, data: items };
      } catch (err) {
        return { ok: false, summary: `Failed to fetch data from ${source.name}: ${err.message}` };
      }
    }

    case 'inspect_data': {
      const refs = runState.workingSet.externalReferences || [];
      if (refs.length === 0) {
        return { ok: false, summary: 'No fetched data available. Use fetch_data first to retrieve data.' };
      }

      const filterSourceId = decision.params?.sourceId;
      const index = decision.params?.index;
      let items = refs;
      if (filterSourceId) {
        items = refs.filter(r => r.source === filterSourceId);
        if (items.length === 0) {
          return { ok: false, summary: `No data found for source "${filterSourceId}". Available sources: ${[...new Set(refs.map(r => r.source))].join(', ')}` };
        }
      }

      // Detailed view of a single item
      if (index !== undefined && index !== null) {
        const idx = Number(index);
        if (idx < 0 || idx >= items.length) {
          return { ok: false, summary: `Index ${idx} out of range. Available: 0-${items.length - 1}` };
        }
        const item = items[idx];
        const raw = item.rawData || item;
        const fields = {};
        for (const [key, val] of Object.entries(raw)) {
          const truncated = val !== null && val !== undefined
            ? String(JSON.stringify(val)).slice(0, 200)
            : 'null';
          fields[key] = { type: Array.isArray(val) ? 'array' : typeof val, value: truncated };
        }
        return {
          ok: true,
          summary: `Detailed view of item ${idx} (source: ${item.source || 'unknown'}, title: "${item.title || ''}")`,
          item: { title: item.title, source: item.source, fields }
        };
      }

      // Summary view
      const sources = [...new Set(items.map(r => r.source))];
      const sampleItems = items.slice(0, 3).map((item, i) => {
        const raw = item.rawData || item;
        const fieldSummary = {};
        for (const [key, val] of Object.entries(raw)) {
          const type = Array.isArray(val) ? 'array' : typeof val;
          let sample = '';
          if (val !== null && val !== undefined) {
            sample = String(typeof val === 'object' ? JSON.stringify(val) : val).slice(0, 100);
          }
          fieldSummary[key] = { type, sample };
        }
        return { index: i, title: item.title || '', fields: fieldSummary };
      });

      return {
        ok: true,
        summary: `${items.length} items from ${sources.join(', ')}. Showing field info for first ${sampleItems.length} items. Use index param for detailed view.`,
        totalItems: items.length,
        sources,
        samples: sampleItems
      };
    }

    case 'transform_data': {
      const rawData = decision.params?.data;
      const noteId = decision.params?.noteId;
      const instructions = decision.params?.instructions;
      if (!instructions) return { ok: false, summary: 'instructions is required — describe how to transform the data.' };

      let inputData;
      if (noteId) {
        // Load from previously transformed data in runState
        const storedData = (runState.workingSet._transformedData || {})[noteId];
        if (!storedData) return { ok: false, summary: `Data ${noteId} not found.` };
        try { inputData = JSON.parse(storedData); } catch { inputData = storedData; }
      } else if (rawData) {
        inputData = rawData;
      } else {
        return { ok: false, summary: 'Either "data" or "noteId" is required as input.' };
      }

      const apiKey = process.env.AGENT_LLM_API_KEY;
      if (!apiKey) return { ok: false, summary: 'No LLM API key configured.' };

      try {
        const endpoint = process.env.AGENT_LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
        const model = process.env.AGENT_UTILITY_MODEL || 'gpt-4o-mini';
        const dataStr = typeof inputData === 'string' ? inputData : JSON.stringify(inputData);
        const truncatedData = dataStr.length > 30000 ? dataStr.slice(0, 30000) + '\n...(truncated)' : dataStr;

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: 'You are a data transformation assistant. Transform the input data according to the user instructions. Return ONLY valid JSON — no markdown, no explanation, just the JSON output.' },
              { role: 'user', content: `## Instructions\n${instructions}\n\n## Input Data\n${truncatedData}` }
            ],
            max_tokens: 4096,
            temperature: 0
          }),
          signal: AbortSignal.timeout(30000)
        });
        if (!res.ok) throw new Error(`LLM API: ${res.status}`);
        const payload = await res.json();
        let output = payload.choices?.[0]?.message?.content || '';
        // Strip markdown code fences if present
        output = output.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

        // Validate it's parseable JSON
        let parsed;
        try { parsed = JSON.parse(output); } catch {
          // If LLM didn't return valid JSON, save raw text
          parsed = null;
        }

        const dataTitle = decision.params?.title || `Transformed data: ${instructions.slice(0, 60)}`;
        // Store transformed data in runState for use by generate_chart
        const dataId = `data_${Date.now()}`;
        runState.workingSet._transformedData ||= {};
        runState.workingSet._transformedData[dataId] = parsed ? JSON.stringify(parsed) : output;

        return {
          ok: true,
          summary: `Data transformed: "${dataTitle}" (id: ${dataId}). ${parsed ? 'Output is valid JSON.' : 'Warning: output is not valid JSON.'} Pass this dataId to generate_chart.`,
          dataId,
          preview: (parsed ? JSON.stringify(parsed) : output).slice(0, 500)
        };
      } catch (err) {
        return { ok: false, summary: `transform_data failed: ${err.message}` };
      }
    }

    case 'generate_chart': {
      const chartType = decision.params?.chartType;
      const title = decision.params?.title || '';
      let data = decision.params?.data;
      const rawData = decision.params?.rawData;
      const labelField = decision.params?.labelField;
      const valueFields = decision.params?.valueFields;
      const datasetLabels = decision.params?.datasetLabels;
      const dataId = decision.params?.dataId || decision.params?.noteId;

      if (!chartType) return { ok: false, summary: 'chartType is required (line, bar, pie, doughnut, scatter, radar, area).' };

      // Load data from transform_data result (stored in runState)
      if (dataId && !data && !rawData) {
        const storedData = (runState.workingSet._transformedData || {})[dataId];
        if (!storedData) return { ok: false, summary: `Data ${dataId} not found. Use transform_data first.` };
        try {
          const parsed = JSON.parse(storedData);
          if (parsed.labels && parsed.datasets) {
            data = parsed;
          } else if (Array.isArray(parsed)) {
            if (labelField && valueFields) {
              const items = parsed.map(item => item.rawData || item);
              const labels = items.map(item => {
                const val = getByPath(item, labelField);
                return val !== undefined && val !== null ? String(val) : '';
              });
              const datasets = valueFields.map((field, i) => ({
                label: (datasetLabels && datasetLabels[i]) || field,
                data: items.map(item => {
                  const val = getByPath(item, field);
                  return typeof val === 'number' ? val : (parseFloat(val) || 0);
                })
              }));
              data = { labels, datasets };
            } else {
              return { ok: false, summary: 'Data is an array — also provide labelField and valueFields to map it to a chart.' };
            }
          } else {
            return { ok: false, summary: 'Data is not in a recognized format. Expected Chart.js {labels, datasets} or a JSON array.' };
          }
        } catch {
          return { ok: false, summary: 'Stored data is not valid JSON. Use transform_data first to convert it.' };
        }
      }

      // Auto-transform mode: build Chart.js data from raw data + field mappings
      if (!data && rawData && labelField && valueFields) {
        const items = rawData.map(item => item.rawData || item);
        const labels = items.map(item => {
          const val = getByPath(item, labelField);
          return val !== undefined && val !== null ? String(val) : '';
        });
        const datasets = valueFields.map((field, i) => ({
          label: (datasetLabels && datasetLabels[i]) || field,
          data: items.map(item => {
            const val = getByPath(item, field);
            return typeof val === 'number' ? val : (parseFloat(val) || 0);
          })
        }));
        data = { labels, datasets };
      }

      if (!data) return { ok: false, summary: 'Provide "data", "dataId", or "rawData" + "labelField" + "valueFields".' };

      // Map 'area' to line with fill
      const finalType = chartType === 'area' ? 'line' : chartType;
      const options = decision.params?.options || {};
      if (chartType === 'area') {
        if (data.datasets) {
          for (const ds of data.datasets) ds.fill = true;
        }
      }
      try {
        const chartUrl = renderChart({ chartType: finalType, title, data, options });
        // Download chart to agent storage
        try {
          const stored = await agentStorage.downloadToAgentStorage(agent.id, chartUrl);
          runState.workingSet.savedFilesThisRun.push({ filename: stored.filename, localUrl: stored.localUrl, description: `${chartType} chart: ${title}` });
          return { ok: true, summary: `Chart generated: "${title}". Use embed_image with the localUrl to add it to your post.`, chartUrl: stored.localUrl };
        } catch {
          return { ok: true, summary: `Chart generated: "${title}". Use embed_image with this URL to add it to your post.`, chartUrl };
        }
      } catch (err) {
        return { ok: false, summary: `Failed to generate chart: ${err.message}` };
      }
    }

    // ── Data Agent ──

    case 'query_data_agent': {
      if (runState.workingSet._dataAgentProducedImage) {
        return { ok: false, summary: 'Data agent already produced an image this run. Use the saved image with embed_image instead of requesting another.' };
      }
      const request = decision.params?.request;
      if (!request) return { ok: false, summary: 'request param is required — describe what data/visualization you need.' };

      try {
        console.log(`[${agent.name}] Delegating to data agent: ${request.slice(0, 120)}`);
        const result = await executeDataAgentRequest(request, agent, runState);
        if (result.savedToStorage) runState.workingSet._dataAgentProducedImage = true;
        return result;
      } catch (err) {
        return { ok: false, summary: `Data agent failed: ${err.message}` };
      }
    }

    // ── Advanced visualization tools ──

    case 'render_data_map': {
      const p = decision.params || {};
      const markers = p.markers;
      if (!markers || !Array.isArray(markers) || markers.length === 0) {
        return { ok: false, summary: 'markers array is required — [{lat, lng, label}, ...]' };
      }
      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) return { ok: false, summary: 'Google Maps API key not configured.' };

      const maptype = ['roadmap', 'satellite', 'terrain', 'hybrid'].includes(p.maptype) ? p.maptype : 'roadmap';
      const size = /^\d+x\d+$/.test(p.size || '') ? p.size : '600x400';

      // Build markers params — use color coding for up to 10 markers, then red for rest
      const colors = ['red', 'blue', 'green', 'purple', 'orange', 'yellow', 'pink', 'brown', 'gray', 'white'];
      let url = `https://maps.googleapis.com/maps/api/staticmap?size=${size}&maptype=${maptype}&key=${apiKey}`;

      // Add individual markers with labels
      for (let i = 0; i < Math.min(markers.length, 50); i++) {
        const m = markers[i];
        const color = colors[i % colors.length];
        const label = (m.label || '')[0]?.toUpperCase() || '';
        const loc = (m.lat && m.lng) ? `${m.lat},${m.lng}` : encodeURIComponent(m.label || m.location || '');
        url += `&markers=color:${color}|label:${label}|${loc}`;
      }

      // If no zoom specified, let Google auto-fit
      if (p.zoom) url += `&zoom=${Math.min(20, Math.max(1, p.zoom))}`;

      const description = p.title || `Map with ${markers.length} data point(s)`;
      try {
        const result = await agentStorage.downloadToAgentStorage(agent.id, url);
        agentStorage.recordFileMetadata(agent.id, result.filename, { caption: description, sourceUrl: url });
        runState.workingSet.savedFilesThisRun.push({ filename: result.filename, localUrl: result.localUrl, description });
        return { ok: true, summary: `Saved map with ${markers.length} markers: ${description}`, localUrl: result.localUrl, description };
      } catch (err) {
        return { ok: false, summary: `render_data_map failed: ${err.message}` };
      }
    }

    case 'render_heatmap': {
      const p = decision.params || {};
      if (!p.title) return { ok: false, summary: 'title is required.' };
      if (!p.xLabels || !p.yLabels || !p.data) return { ok: false, summary: 'xLabels, yLabels, and data are required.' };

      const scheme = p.colorScheme || 'blue';
      const colorMap = {
        blue: { low: 'rgba(66,133,244,0.1)', high: 'rgba(66,133,244,1)' },
        red: { low: 'rgba(234,67,53,0.1)', high: 'rgba(234,67,53,1)' },
        green: { low: 'rgba(52,168,83,0.1)', high: 'rgba(52,168,83,1)' },
        purple: { low: 'rgba(128,0,128,0.1)', high: 'rgba(128,0,128,1)' }
      };
      const colors = colorMap[scheme] || colorMap.blue;

      // Flatten 2D data for matrix chart
      const flatData = [];
      const allVals = [];
      for (let y = 0; y < p.data.length; y++) {
        for (let x = 0; x < (p.data[y]?.length || 0); x++) {
          const v = p.data[y][x] || 0;
          flatData.push({ x: p.xLabels[x] || '', y: p.yLabels[y] || '', v });
          allVals.push(v);
        }
      }
      const minVal = Math.min(...allVals);
      const maxVal = Math.max(...allVals);

      const config = {
        type: 'matrix',
        data: {
          datasets: [{
            label: p.title,
            data: flatData,
            backgroundColor: flatData.map(d => {
              const ratio = maxVal === minVal ? 0.5 : (d.v - minVal) / (maxVal - minVal);
              return `rgba(${scheme === 'red' ? '234,67,53' : scheme === 'green' ? '52,168,83' : scheme === 'purple' ? '128,0,128' : '66,133,244'},${0.1 + ratio * 0.9})`;
            }),
            width: ({ chart }) => (chart.chartArea || {}).width / p.xLabels.length - 1,
            height: ({ chart }) => (chart.chartArea || {}).height / p.yLabels.length - 1
          }]
        },
        options: {
          plugins: { title: { display: true, text: p.title }, legend: { display: false } },
          scales: {
            x: { type: 'category', labels: p.xLabels, offset: true },
            y: { type: 'category', labels: p.yLabels, offset: true }
          }
        }
      };

      const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=600&h=400&bkg=white`;
      try {
        const stored = await agentStorage.downloadToAgentStorage(agent.id, chartUrl);
        const desc = p.title;
        agentStorage.recordFileMetadata(agent.id, stored.filename, { caption: desc });
        runState.workingSet.savedFilesThisRun.push({ filename: stored.filename, localUrl: stored.localUrl, description: desc });
        return { ok: true, summary: `Heatmap saved: "${p.title}"`, localUrl: stored.localUrl, chartUrl: stored.localUrl, description: desc };
      } catch (err) {
        return { ok: false, summary: `render_heatmap failed: ${err.message}` };
      }
    }

    case 'render_wordcloud': {
      const p = decision.params || {};
      if (!p.words || !Array.isArray(p.words) || p.words.length === 0) {
        return { ok: false, summary: 'words array is required — [{text, weight}, ...]' };
      }

      const config = {
        type: 'wordCloud',
        data: {
          labels: p.words.map(w => w.text || w.word || ''),
          datasets: [{
            data: p.words.map(w => w.weight || w.count || w.value || 10)
          }]
        },
        options: {
          plugins: { title: { display: !!p.title, text: p.title || '' } }
        }
      };

      const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=600&h=400&bkg=white`;
      try {
        const stored = await agentStorage.downloadToAgentStorage(agent.id, chartUrl);
        const desc = p.title || `Word cloud with ${p.words.length} words`;
        agentStorage.recordFileMetadata(agent.id, stored.filename, { caption: desc });
        runState.workingSet.savedFilesThisRun.push({ filename: stored.filename, localUrl: stored.localUrl, description: desc });
        return { ok: true, summary: `Word cloud saved: "${desc}"`, localUrl: stored.localUrl, chartUrl: stored.localUrl, description: desc };
      } catch (err) {
        return { ok: false, summary: `render_wordcloud failed: ${err.message}` };
      }
    }

    case 'render_gauge': {
      const p = decision.params || {};
      if (!p.title || p.value === undefined) return { ok: false, summary: 'title and value are required.' };
      const min = p.min ?? 0;
      const max = p.max ?? 100;
      const value = Number(p.value);
      const unit = p.unit || '';

      const config = {
        type: 'radialGauge',
        data: { datasets: [{ data: [value], backgroundColor: 'rgba(66,133,244,0.8)' }] },
        options: {
          domain: [min, max],
          trackColor: '#e0e0e0',
          centerPercentage: 80,
          roundedCorners: true,
          centerArea: { text: `${value}${unit}`, fontSize: 28, fontColor: '#333' },
          plugins: { title: { display: true, text: p.title } }
        }
      };

      const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=400&h=300&bkg=white`;
      try {
        const stored = await agentStorage.downloadToAgentStorage(agent.id, chartUrl);
        const desc = `${p.title}: ${value}${unit}`;
        agentStorage.recordFileMetadata(agent.id, stored.filename, { caption: desc });
        runState.workingSet.savedFilesThisRun.push({ filename: stored.filename, localUrl: stored.localUrl, description: desc });
        return { ok: true, summary: `Gauge saved: "${desc}"`, localUrl: stored.localUrl, chartUrl: stored.localUrl, description: desc };
      } catch (err) {
        return { ok: false, summary: `render_gauge failed: ${err.message}` };
      }
    }

    case 'render_treemap': {
      const p = decision.params || {};
      if (!p.title || !p.data || !Array.isArray(p.data)) return { ok: false, summary: 'title and data array are required.' };
      const scheme = p.colorScheme || 'vibrant';
      const palettes = {
        vibrant: ['#6366f1', '#f43f5e', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#a855f7'],
        cool: ['#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#06b6d4', '#14b8a6', '#10b981', '#22d3ee', '#818cf8', '#c084fc'],
        warm: ['#f43f5e', '#f97316', '#f59e0b', '#ef4444', '#ec4899', '#e11d48', '#fb923c', '#fbbf24', '#f472b6', '#fb7185'],
        earth: ['#78716c', '#92400e', '#065f46', '#1e40af', '#7c2d12', '#164e63', '#713f12', '#365314', '#4c1d95', '#831843'],
        pastel: ['#93c5fd', '#c4b5fd', '#fda4af', '#fdba74', '#86efac', '#a5f3fc', '#f9a8d4', '#fcd34d', '#bef264', '#d8b4fe']
      };
      const colors = palettes[scheme] || palettes.vibrant;
      const config = {
        type: 'treemap',
        data: { datasets: [{ tree: p.data.map(d => d.value || 0), labels: { display: true, formatter: (ctx) => p.data[ctx.dataIndex]?.label || '' }, backgroundColor: p.data.map((_, i) => colors[i % colors.length]), spacing: 2, borderWidth: 1, borderColor: '#fff' }] },
        options: { plugins: { title: { display: true, text: p.title, font: { size: 16, weight: 'bold' } }, legend: { display: false } } }
      };
      const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=600&h=400&bkg=white`;
      try {
        const stored = await agentStorage.downloadToAgentStorage(agent.id, chartUrl);
        agentStorage.recordFileMetadata(agent.id, stored.filename, { caption: p.title });
        runState.workingSet.savedFilesThisRun.push({ filename: stored.filename, localUrl: stored.localUrl, description: p.title });
        return { ok: true, summary: `Treemap saved: "${p.title}"`, localUrl: stored.localUrl, chartUrl: stored.localUrl, description: p.title };
      } catch (err) { return { ok: false, summary: `render_treemap failed: ${err.message}` }; }
    }

    case 'render_polar_area': {
      const p = decision.params || {};
      if (!p.title || !p.labels || !p.values) return { ok: false, summary: 'title, labels, and values are required.' };
      const colors = ['#6366f1cc', '#f43f5ecc', '#10b981cc', '#f59e0bcc', '#8b5cf6cc', '#06b6d4cc', '#ec4899cc', '#14b8a6cc', '#f97316cc', '#a855f7cc'];
      const data = { labels: p.labels, datasets: [{ data: p.values, backgroundColor: p.labels.map((_, i) => colors[i % colors.length]), borderColor: '#fff', borderWidth: 2 }] };
      return await saveDataApiChartRaw({ agent, chartType: 'polarArea', title: p.title, data, tags: [], description: p.title });
    }

    case 'render_bubble': {
      const p = decision.params || {};
      if (!p.title || !p.data || !Array.isArray(p.data)) return { ok: false, summary: 'title and data array are required.' };
      const colors = ['#6366f1', '#f43f5e', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#14b8a6'];
      const datasets = p.data.map((d, i) => ({
        label: d.label || `Item ${i + 1}`,
        data: [{ x: d.x, y: d.y, r: d.r || 10 }],
        backgroundColor: (colors[i % colors.length]) + '99',
        borderColor: colors[i % colors.length],
        borderWidth: 1
      }));
      const config = {
        type: 'bubble',
        data: { datasets },
        options: {
          plugins: { title: { display: true, text: p.title, font: { size: 16, weight: 'bold' } }, legend: { position: 'bottom', labels: { usePointStyle: true } } },
          scales: { x: { title: { display: !!p.xLabel, text: p.xLabel || '' } }, y: { title: { display: !!p.yLabel, text: p.yLabel || '' } } }
        }
      };
      const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=600&h=400&bkg=white`;
      try {
        const stored = await agentStorage.downloadToAgentStorage(agent.id, chartUrl);
        agentStorage.recordFileMetadata(agent.id, stored.filename, { caption: p.title });
        runState.workingSet.savedFilesThisRun.push({ filename: stored.filename, localUrl: stored.localUrl, description: p.title });
        return { ok: true, summary: `Bubble chart saved: "${p.title}"`, localUrl: stored.localUrl, chartUrl: stored.localUrl, description: p.title };
      } catch (err) { return { ok: false, summary: `render_bubble failed: ${err.message}` }; }
    }

    case 'render_progress_bar': {
      const p = decision.params || {};
      if (!p.title || !p.items || !Array.isArray(p.items)) return { ok: false, summary: 'title and items array are required.' };
      const palettes = {
        vibrant: ['#6366f1', '#f43f5e', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#14b8a6'],
        cool: ['#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#06b6d4', '#14b8a6', '#10b981', '#22d3ee'],
        warm: ['#f43f5e', '#f97316', '#f59e0b', '#ef4444', '#ec4899', '#e11d48', '#fb923c', '#fbbf24'],
        earth: ['#78716c', '#92400e', '#065f46', '#1e40af', '#7c2d12', '#164e63', '#713f12', '#365314'],
        pastel: ['#93c5fd', '#c4b5fd', '#fda4af', '#fdba74', '#86efac', '#a5f3fc', '#f9a8d4', '#fcd34d']
      };
      const colors = palettes[p.colorScheme] || palettes.vibrant;
      const labels = p.items.map(i => i.label);
      const values = p.items.map(i => i.value);
      const unit = p.unit || '';
      const data = {
        labels,
        datasets: [{ data: values, backgroundColor: p.items.map((_, i) => colors[i % colors.length] + 'cc'), borderColor: p.items.map((_, i) => colors[i % colors.length]), borderWidth: 1, borderRadius: 4 }]
      };
      const config = {
        type: 'bar',
        data,
        options: {
          indexAxis: 'y',
          plugins: {
            title: { display: true, text: p.title, font: { size: 16, weight: 'bold' } },
            legend: { display: false },
            datalabels: { display: true, anchor: 'end', align: 'end', font: { weight: 'bold', size: 11 }, formatter: (val) => `${val}${unit}` }
          },
          scales: { x: { beginAtZero: true } }
        }
      };
      const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=600&h=${Math.max(300, p.items.length * 40 + 100)}&bkg=white`;
      try {
        const stored = await agentStorage.downloadToAgentStorage(agent.id, chartUrl);
        agentStorage.recordFileMetadata(agent.id, stored.filename, { caption: p.title });
        runState.workingSet.savedFilesThisRun.push({ filename: stored.filename, localUrl: stored.localUrl, description: p.title });
        return { ok: true, summary: `Progress bar chart saved: "${p.title}"`, localUrl: stored.localUrl, chartUrl: stored.localUrl, description: p.title };
      } catch (err) { return { ok: false, summary: `render_progress_bar failed: ${err.message}` }; }
    }

    case 'render_multi_axis': {
      const p = decision.params || {};
      if (!p.title || !p.labels || !p.datasets) return { ok: false, summary: 'title, labels, and datasets are required.' };
      const colors = ['#6366f1', '#f43f5e', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4'];
      const datasets = p.datasets.map((ds, i) => {
        const color = colors[i % colors.length];
        const isRight = ds.yAxis === 'right';
        return {
          label: ds.label,
          data: ds.data,
          type: ds.type || 'line',
          yAxisID: isRight ? 'y1' : 'y',
          borderColor: color,
          backgroundColor: ds.type === 'bar' ? color + 'cc' : color + '33',
          borderWidth: 2,
          tension: 0.3,
          fill: ds.type !== 'bar',
          pointRadius: ds.type !== 'bar' ? 3 : undefined,
          borderRadius: ds.type === 'bar' ? 4 : undefined,
          order: ds.type === 'bar' ? 2 : 1
        };
      });
      const config = {
        type: 'bar',
        data: { labels: p.labels, datasets },
        options: {
          plugins: { title: { display: true, text: p.title, font: { size: 16, weight: 'bold' } }, legend: { position: 'bottom', labels: { usePointStyle: true } } },
          scales: {
            y: { position: 'left', beginAtZero: true },
            y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false } }
          }
        }
      };
      const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=600&h=400&bkg=white`;
      try {
        const stored = await agentStorage.downloadToAgentStorage(agent.id, chartUrl);
        agentStorage.recordFileMetadata(agent.id, stored.filename, { caption: p.title });
        runState.workingSet.savedFilesThisRun.push({ filename: stored.filename, localUrl: stored.localUrl, description: p.title });
        return { ok: true, summary: `Multi-axis chart saved: "${p.title}"`, localUrl: stored.localUrl, chartUrl: stored.localUrl, description: p.title };
      } catch (err) { return { ok: false, summary: `render_multi_axis failed: ${err.message}` }; }
    }

    case 'render_table': {
      const p = decision.params || {};
      if (!p.title || !p.headers || !p.rows) return { ok: false, summary: 'title, headers, and rows are required.' };

      // Build an SVG table image
      const cellW = 120, cellH = 32, pad = 8;
      const cols = p.headers.length;
      const rowCount = p.rows.length;
      const tableW = cols * cellW + pad * 2;
      const titleH = 40;
      const tableH = titleH + (rowCount + 1) * cellH + pad * 2;

      let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tableW}" height="${tableH}" viewBox="0 0 ${tableW} ${tableH}">`;
      svg += `<rect width="${tableW}" height="${tableH}" fill="white"/>`;
      svg += `<text x="${tableW / 2}" y="${28}" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="bold" fill="#1f2937">${p.title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`;

      // Header row
      const startY = titleH;
      for (let c = 0; c < cols; c++) {
        const x = pad + c * cellW;
        svg += `<rect x="${x}" y="${startY}" width="${cellW}" height="${cellH}" fill="#6366f1" stroke="#fff" stroke-width="1"/>`;
        svg += `<text x="${x + cellW / 2}" y="${startY + 21}" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" font-weight="bold" fill="white">${String(p.headers[c] || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 18)}</text>`;
      }

      // Data rows
      for (let r = 0; r < rowCount; r++) {
        const y = startY + (r + 1) * cellH;
        const bg = r % 2 === 0 ? '#f9fafb' : '#ffffff';
        for (let c = 0; c < cols; c++) {
          const x = pad + c * cellW;
          const val = String((p.rows[r] || [])[c] ?? '').slice(0, 20);
          svg += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" fill="${bg}" stroke="#e5e7eb" stroke-width="1"/>`;
          svg += `<text x="${x + cellW / 2}" y="${y + 21}" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#374151">${val.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`;
        }
      }
      svg += '</svg>';

      // Convert SVG to image via QuickChart
      const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify({ type: 'bar', data: { labels: [''], datasets: [{ data: [0] }] }, options: { plugins: { title: { display: false } } } }))}&w=${tableW}&h=${tableH}&bkg=white`;

      // Use SVG directly — save as SVG file
      try {
        const buffer = Buffer.from(svg, 'utf-8');
        agentStorage.ensureAgentDirs(agent.id);
        const crypto = await import('node:crypto');
        const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
        const filename = `${hash}.svg`;
        const { writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const filePath = join(process.cwd(), 'data', 'agents', agent.id, 'files', filename);
        writeFileSync(filePath, buffer);
        const localUrl = `/agents/${agent.id}/files/${filename}`;
        agentStorage.recordFileMetadata(agent.id, filename, { caption: p.title });
        runState.workingSet.savedFilesThisRun.push({ filename, localUrl, description: p.title });
        return { ok: true, summary: `Table saved: "${p.title}" (${rowCount} rows × ${cols} cols)`, localUrl, chartUrl: localUrl, description: p.title };
      } catch (err) {
        return { ok: false, summary: `render_table failed: ${err.message}` };
      }
    }

    // ── Medical & Health tools ──

    case 'search_drug_events': {
      const p = decision.params || {};
      let url = 'https://api.fda.gov/drug/event.json?';
      const parts = [];
      if (p.drug) parts.push(`patient.drug.medicinalproduct:${encodeURIComponent(p.drug)}`);
      if (p.reaction) parts.push(`patient.reaction.reactionmeddrapt:${encodeURIComponent(p.reaction)}`);
      const search = parts.join('+AND+') || 'receivedate:[20240101+TO+20261231]';
      const limit = Math.min(25, Math.max(1, p.limit || 10));
      url += `search=${search}&limit=${limit}`;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`OpenFDA API: ${res.status}`);
        const data = await res.json();
        const events = (data.results || []).map(r => ({
          drug: (r.patient?.drug || []).map(d => d.medicinalproduct).filter(Boolean).join(', ') || 'unknown',
          reactions: (r.patient?.reaction || []).map(rx => rx.reactionmeddrapt).filter(Boolean).slice(0, 5),
          outcome: r.patient?.reaction?.[0]?.reactionoutcome || null,
          patientAge: r.patient?.patientonsetage || null,
          patientSex: r.patient?.patientsex === '1' ? 'male' : r.patient?.patientsex === '2' ? 'female' : null,
          serious: r.serious === '1',
          reportDate: r.receivedate || null,
          country: r.occurcountry || null
        }));
        const filterDesc = [p.drug, p.reaction].filter(Boolean).join(', ') || 'recent';
        return { ok: true, summary: `Found ${events.length} adverse event report(s) for: ${filterDesc}`, events };
      } catch (err) {
        return { ok: false, summary: `search_drug_events failed: ${err.message}` };
      }
    }

    case 'search_clinical_trials': {
      const p = decision.params || {};
      const query = p.query;
      if (!query) return { ok: false, summary: 'query is required.' };
      const limit = Math.min(20, Math.max(1, p.limit || 10));
      let url = `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(query)}&pageSize=${limit}&format=json`;
      if (p.status) url += `&filter.overallStatus=${encodeURIComponent(p.status)}`;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`ClinicalTrials.gov API: ${res.status}`);
        const data = await res.json();
        const trials = (data.studies || []).map(s => {
          const id = s.protocolSection?.identificationModule;
          const status = s.protocolSection?.statusModule;
          const design = s.protocolSection?.designModule;
          const conditions = s.protocolSection?.conditionsModule?.conditions || [];
          const interventions = (s.protocolSection?.armsInterventionsModule?.interventions || []).map(i => i.name).slice(0, 3);
          return {
            nctId: id?.nctId,
            title: id?.briefTitle || id?.officialTitle || 'Untitled',
            status: status?.overallStatus || 'unknown',
            phases: design?.phases || [],
            conditions: conditions.slice(0, 5),
            interventions,
            sponsor: id?.organization?.fullName || null,
            startDate: status?.startDateStruct?.date || null
          };
        });
        return { ok: true, summary: `Found ${trials.length} clinical trial(s) for "${query}"`, trials };
      } catch (err) {
        return { ok: false, summary: `search_clinical_trials failed: ${err.message}` };
      }
    }

    // ── Movie & TV tools ──

    case 'search_movies': {
      const p = decision.params || {};
      const query = p.query;
      if (!query) return { ok: false, summary: 'query is required.' };
      let url = `https://www.omdbapi.com/?apikey=trilogy&s=${encodeURIComponent(query)}`;
      if (p.type) url += `&type=${encodeURIComponent(p.type)}`;
      if (p.year) url += `&y=${encodeURIComponent(p.year)}`;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`OMDb API: ${res.status}`);
        const data = await res.json();
        if (data.Response === 'False') return { ok: false, summary: `No results for "${query}": ${data.Error || 'not found'}` };
        const results = (data.Search || []).slice(0, 10).map(m => ({
          title: m.Title,
          year: m.Year,
          imdbId: m.imdbID,
          type: m.Type,
          poster: m.Poster !== 'N/A' ? m.Poster : null
        }));
        return { ok: true, summary: `Found ${results.length} result(s) for "${query}". Use get_movie_details with imdbId for full info.`, results };
      } catch (err) {
        return { ok: false, summary: `search_movies failed: ${err.message}` };
      }
    }

    case 'get_movie_details': {
      const p = decision.params || {};
      if (!p.id && !p.title) return { ok: false, summary: 'id (IMDb ID) or title is required.' };
      let url = `https://www.omdbapi.com/?apikey=trilogy&plot=full`;
      if (p.id) url += `&i=${encodeURIComponent(p.id)}`;
      else url += `&t=${encodeURIComponent(p.title)}`;
      if (p.year) url += `&y=${encodeURIComponent(p.year)}`;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`OMDb API: ${res.status}`);
        const data = await res.json();
        if (data.Response === 'False') return { ok: false, summary: `Not found: ${data.Error || 'unknown error'}` };
        const details = {
          title: data.Title,
          year: data.Year,
          rated: data.Rated,
          runtime: data.Runtime,
          genre: data.Genre,
          director: data.Director,
          writers: data.Writer,
          actors: data.Actors,
          plot: data.Plot,
          language: data.Language,
          country: data.Country,
          awards: data.Awards !== 'N/A' ? data.Awards : null,
          poster: data.Poster !== 'N/A' ? data.Poster : null,
          ratings: (data.Ratings || []).map(r => ({ source: r.Source, value: r.Value })),
          imdbRating: data.imdbRating !== 'N/A' ? data.imdbRating : null,
          imdbVotes: data.imdbVotes !== 'N/A' ? data.imdbVotes : null,
          boxOffice: data.BoxOffice !== 'N/A' ? data.BoxOffice : null,
          type: data.Type,
          imdbId: data.imdbID
        };
        const ratingStr = details.ratings.map(r => `${r.source}: ${r.value}`).join(', ') || 'no ratings';
        return { ok: true, summary: `${details.title} (${details.year}) — ${ratingStr}. ${details.poster ? 'Poster available — use save_media to save it.' : ''}`, details };
      } catch (err) {
        return { ok: false, summary: `get_movie_details failed: ${err.message}` };
      }
    }

    // ── Beauty & Makeup tools ──

    case 'search_makeup': {
      const p = decision.params || {};
      let url = 'http://makeup-api.herokuapp.com/api/v1/products.json?';
      const params = [];
      if (p.product_type) params.push(`product_type=${encodeURIComponent(p.product_type)}`);
      if (p.brand) params.push(`brand=${encodeURIComponent(p.brand)}`);
      if (p.tags) params.push(`product_tags=${encodeURIComponent(p.tags)}`);
      if (p.rating_greater_than) params.push(`rating_greater_than=${p.rating_greater_than}`);
      if (p.price_less_than) params.push(`price_less_than=${p.price_less_than}`);
      url += params.join('&');

      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Makeup API: ${res.status}`);
        const raw = await res.json();
        const products = (Array.isArray(raw) ? raw : []).slice(0, 15).map(pr => ({
          name: pr.name,
          brand: pr.brand,
          type: pr.product_type,
          price: pr.price ? `$${pr.price}` : null,
          rating: pr.rating || null,
          colors: (pr.product_colors || []).slice(0, 6).map(c => c.colour_name || c.hex_value),
          image: pr.image_link || null,
          link: pr.product_link || null,
          tags: pr.tag_list || []
        }));
        const filterDesc = [p.brand, p.product_type, p.tags].filter(Boolean).join(', ') || 'all';
        return {
          ok: true,
          summary: `Found ${products.length} makeup product(s) matching: ${filterDesc}. Use save_media on image URLs to save product photos.`,
          products
        };
      } catch (err) {
        return { ok: false, summary: `search_makeup failed: ${err.message}` };
      }
    }

    // ── Astrology & Tarot tools ──

    case 'get_horoscope': {
      const p = decision.params || {};
      const sign = (p.sign || '').toLowerCase().trim();
      const validSigns = ['aries','taurus','gemini','cancer','leo','virgo','libra','scorpio','sagittarius','capricorn','aquarius','pisces'];
      if (!sign || !validSigns.includes(sign)) {
        return { ok: false, summary: `Invalid sign "${sign}". Use one of: ${validSigns.join(', ')}` };
      }
      try {
        const res = await fetch(`https://ohmanda.com/api/horoscope/${sign}/`, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`Horoscope API: ${res.status}`);
        const data = await res.json();
        return {
          ok: true,
          summary: `Horoscope for ${sign} (${data.date}): ${(data.horoscope || '').slice(0, 150)}...`,
          horoscope: { sign: data.sign, date: data.date, reading: data.horoscope }
        };
      } catch (err) {
        return { ok: false, summary: `get_horoscope failed: ${err.message}` };
      }
    }

    case 'draw_tarot': {
      const p = decision.params || {};
      const count = Math.min(10, Math.max(1, p.count || 3));
      try {
        const res = await fetch(`https://tarotapi.dev/api/v1/cards/random?n=${count}`, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`Tarot API: ${res.status}`);
        const data = await res.json();
        const cards = (data.cards || []).map(c => ({
          name: c.name,
          suit: c.suit || 'major arcana',
          type: c.type,
          meaningUpright: c.meaning_up,
          meaningReversed: c.meaning_rev,
          description: c.desc
        }));
        const names = cards.map(c => c.name).join(', ');
        return {
          ok: true,
          summary: `Drew ${cards.length} tarot card(s): ${names}`,
          cards
        };
      } catch (err) {
        return { ok: false, summary: `draw_tarot failed: ${err.message}` };
      }
    }

    // ── Travel & Google Maps tools ──

    case 'travel_to': {
      const p = decision.params || {};
      const destination = p.destination;
      if (!destination) return { ok: false, summary: 'destination is required.' };
      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) return { ok: false, summary: 'Google Maps API key not configured (GOOGLE_MAPS_API_KEY).' };

      try {
        // Geocode the destination
        const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(destination)}&key=${apiKey}`;
        const geoRes = await fetch(geoUrl, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(10000) });
        if (!geoRes.ok) throw new Error(`Geocoding API: ${geoRes.status}`);
        const geoData = await geoRes.json();
        if (!geoData.results || geoData.results.length === 0) {
          return { ok: false, summary: `Could not find "${destination}". Try a more specific address or landmark name.` };
        }

        const place = geoData.results[0];
        const lat = place.geometry.location.lat;
        const lng = place.geometry.location.lng;
        const formattedAddress = place.formatted_address;
        const components = {};
        for (const c of place.address_components || []) {
          if (c.types.includes('country')) components.country = c.long_name;
          if (c.types.includes('locality')) components.city = c.long_name;
          if (c.types.includes('administrative_area_level_1')) components.region = c.long_name;
        }

        // Store travel location in working set
        runState.workingSet.travelLocation = { lat, lng, formattedAddress, ...components, destination };

        // Save satellite map
        const zoom = Math.min(20, Math.max(1, p.zoom || 14));
        const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=600x400&maptype=satellite&key=${apiKey}`;
        const mapResult = await agentStorage.downloadToAgentStorage(agent.id, mapUrl);
        const mapDesc = `Satellite view of ${formattedAddress}`;
        agentStorage.recordFileMetadata(agent.id, mapResult.filename, { caption: mapDesc, sourceUrl: mapUrl });
        runState.workingSet.savedFilesThisRun.push({ filename: mapResult.filename, localUrl: mapResult.localUrl, description: mapDesc });

        // Save street view (only if imagery exists)
        let streetViewImage = null;
        try {
          const svMetaRes = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&key=${apiKey}`, { signal: AbortSignal.timeout(10000) });
          const svMeta = svMetaRes.ok ? await svMetaRes.json() : { status: 'OK' };
          if (svMeta.status === 'OK') {
            const svUrl = `https://maps.googleapis.com/maps/api/streetview?location=${lat},${lng}&size=600x400&fov=90&pitch=0&key=${apiKey}`;
            const svResult = await agentStorage.downloadToAgentStorage(agent.id, svUrl);
            const svDesc = `Street view of ${formattedAddress}`;
            agentStorage.recordFileMetadata(agent.id, svResult.filename, { caption: svDesc, sourceUrl: svUrl });
            runState.workingSet.savedFilesThisRun.push({ filename: svResult.filename, localUrl: svResult.localUrl, description: svDesc });
            streetViewImage = svResult.localUrl;
          }
        } catch { /* skip street view if check fails */ }

        const svNote = streetViewImage ? ' and street view' : ' (no street view coverage here)';
        return {
          ok: true,
          summary: `Traveled to ${formattedAddress}. Saved satellite map${svNote}. Use explore_nearby to discover places, map_streetview to look around, or get_place_photo to capture specific spots.`,
          location: { lat, lng, formattedAddress, ...components },
          mapImage: mapResult.localUrl,
          streetViewImage
        };
      } catch (err) {
        return { ok: false, summary: `travel_to failed: ${err.message}` };
      }
    }

    case 'explore_nearby': {
      const p = decision.params || {};
      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) return { ok: false, summary: 'Google Maps API key not configured (GOOGLE_MAPS_API_KEY).' };

      let lat, lng;
      if (p.location && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(p.location.replace(/\s/g, ''))) {
        const parts = p.location.replace(/\s/g, '').split(',');
        lat = parts[0]; lng = parts[1];
      } else if (runState.workingSet.travelLocation) {
        lat = runState.workingSet.travelLocation.lat;
        lng = runState.workingSet.travelLocation.lng;
      } else {
        return { ok: false, summary: 'No travel location set. Use travel_to first, or provide a location as "lat,lng".' };
      }

      const type = p.type || 'tourist_attraction';
      const radius = Math.min(50000, Math.max(100, p.radius || 2000));
      let url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=${type}&key=${apiKey}`;
      if (p.keyword) url += `&keyword=${encodeURIComponent(p.keyword)}`;

      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Places API: ${res.status}`);
        const data = await res.json();
        if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
          throw new Error(`Places API status: ${data.status}${data.error_message ? ' — ' + data.error_message : ''}`);
        }
        const places = (data.results || []).slice(0, 15).map(r => ({
          name: r.name,
          place_id: r.place_id,
          rating: r.rating || null,
          totalRatings: r.user_ratings_total || 0,
          priceLevel: r.price_level ?? null,
          address: r.vicinity || '',
          types: (r.types || []).slice(0, 4),
          openNow: r.opening_hours?.open_now ?? null,
          photoRef: r.photos?.[0]?.photo_reference || null
        }));

        const locLabel = runState.workingSet.travelLocation?.formattedAddress || `${lat},${lng}`;
        return {
          ok: true,
          summary: `Found ${places.length} ${type.replace(/_/g, ' ')}(s) near ${locLabel}${p.keyword ? ` matching "${p.keyword}"` : ''}. Use get_place_details for more info, get_place_photo to save photos.`,
          places,
          searchLocation: { lat, lng },
          type,
          radius
        };
      } catch (err) {
        return { ok: false, summary: `explore_nearby failed: ${err.message}` };
      }
    }

    case 'get_place_details': {
      const p = decision.params || {};
      const placeId = p.place_id;
      if (!placeId) return { ok: false, summary: 'place_id is required (from explore_nearby results).' };
      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) return { ok: false, summary: 'Google Maps API key not configured (GOOGLE_MAPS_API_KEY).' };

      const fields = 'name,formatted_address,geometry,rating,user_ratings_total,formatted_phone_number,website,opening_hours,reviews,photos,price_level,types,editorial_summary';
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${fields}&key=${apiKey}`;

      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Place Details API: ${res.status}`);
        const data = await res.json();
        if (data.status !== 'OK') throw new Error(`Place Details: ${data.status}`);

        const r = data.result;
        const details = {
          name: r.name,
          address: r.formatted_address,
          rating: r.rating || null,
          totalRatings: r.user_ratings_total || 0,
          priceLevel: r.price_level ?? null,
          phone: r.formatted_phone_number || null,
          website: r.website || null,
          types: (r.types || []).slice(0, 5),
          summary: r.editorial_summary?.overview || null,
          openingHours: r.opening_hours?.weekday_text || null,
          reviews: (r.reviews || []).slice(0, 5).map(rev => ({
            author: rev.author_name,
            rating: rev.rating,
            text: (rev.text || '').slice(0, 300),
            time: rev.relative_time_description
          })),
          photos: (r.photos || []).slice(0, 5).map(ph => ({
            photo_reference: ph.photo_reference,
            width: ph.width,
            height: ph.height,
            attribution: ph.html_attributions?.[0] || ''
          })),
          location: r.geometry?.location || null
        };

        return {
          ok: true,
          summary: `${r.name} — ${r.rating ? r.rating + '★' : 'unrated'} (${r.user_ratings_total || 0} reviews). ${details.photos.length} photo(s) available. Use get_place_photo with photo_reference to save photos.`,
          details
        };
      } catch (err) {
        return { ok: false, summary: `get_place_details failed: ${err.message}` };
      }
    }

    case 'get_place_photo': {
      const p = decision.params || {};
      const photoRef = p.photo_reference;
      if (!photoRef) return { ok: false, summary: 'photo_reference is required (from get_place_details results).' };
      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) return { ok: false, summary: 'Google Maps API key not configured (GOOGLE_MAPS_API_KEY).' };

      const maxwidth = Math.min(1600, Math.max(100, p.maxwidth || 600));
      const url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxwidth}&photo_reference=${encodeURIComponent(photoRef)}&key=${apiKey}`;
      const description = p.title || 'Google Places photo';

      try {
        const result = await agentStorage.downloadToAgentStorage(agent.id, url);
        agentStorage.recordFileMetadata(agent.id, result.filename, { caption: description, sourceUrl: url });
        runState.workingSet.savedFilesThisRun.push({ filename: result.filename, localUrl: result.localUrl, description });
        return { ok: true, summary: `Saved place photo: ${description}`, localUrl: result.localUrl, description };
      } catch (err) {
        return { ok: false, summary: `get_place_photo failed: ${err.message}` };
      }
    }

    case 'map_static': {
      const p = decision.params || {};
      const center = p.center;
      if (!center) return { ok: false, summary: 'center is required (address, city, or lat,lng).' };
      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) return { ok: false, summary: 'Google Maps API key not configured (GOOGLE_MAPS_API_KEY).' };

      const zoom = Math.min(20, Math.max(1, p.zoom || 13));
      const maptype = ['roadmap', 'satellite', 'terrain', 'hybrid'].includes(p.maptype) ? p.maptype : 'roadmap';
      const size = /^\d+x\d+$/.test(p.size || '') ? p.size : '600x400';
      let url = `https://maps.googleapis.com/maps/api/staticmap?center=${encodeURIComponent(center)}&zoom=${zoom}&size=${size}&maptype=${maptype}&key=${apiKey}`;

      if (p.markers) {
        const locs = p.markers.split('|').map(s => s.trim()).filter(Boolean);
        for (const loc of locs) {
          url += `&markers=${encodeURIComponent(loc)}`;
        }
      }

      const description = p.title || `Google Maps ${maptype} view of ${center} (zoom ${zoom})`;
      try {
        const result = await agentStorage.downloadToAgentStorage(agent.id, url);
        agentStorage.recordFileMetadata(agent.id, result.filename, { caption: description, sourceUrl: url });
        runState.workingSet.savedFilesThisRun.push({ filename: result.filename, localUrl: result.localUrl, description });
        return { ok: true, summary: `Saved map: ${description}`, localUrl: result.localUrl, description };
      } catch (err) {
        return { ok: false, summary: `map_static failed: ${err.message}` };
      }
    }

    case 'map_streetview': {
      const p = decision.params || {};
      const location = p.location;
      if (!location) return { ok: false, summary: 'location is required (address, landmark, or lat,lng).' };
      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) return { ok: false, summary: 'Google Maps API key not configured (GOOGLE_MAPS_API_KEY).' };

      // Check if street view imagery exists at this location
      try {
        const metaRes = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${encodeURIComponent(location)}&key=${apiKey}`, { signal: AbortSignal.timeout(10000) });
        if (metaRes.ok) {
          const meta = await metaRes.json();
          if (meta.status !== 'OK') {
            return { ok: false, summary: `No Street View imagery available at "${location}". Try a nearby major road, landmark, or city center instead.` };
          }
        }
      } catch { /* proceed anyway if metadata check fails */ }

      const size = /^\d+x\d+$/.test(p.size || '') ? p.size : '600x400';
      const fov = Math.min(120, Math.max(10, p.fov || 90));
      const pitch = Math.min(90, Math.max(-90, p.pitch || 0));
      let url = `https://maps.googleapis.com/maps/api/streetview?location=${encodeURIComponent(location)}&size=${size}&fov=${fov}&pitch=${pitch}&key=${apiKey}`;
      if (p.heading !== undefined && p.heading !== null) {
        url += `&heading=${Math.min(360, Math.max(0, p.heading))}`;
      }

      const description = p.title || `Street View of ${location}`;
      try {
        const result = await agentStorage.downloadToAgentStorage(agent.id, url);
        agentStorage.recordFileMetadata(agent.id, result.filename, { caption: description, sourceUrl: url });
        runState.workingSet.savedFilesThisRun.push({ filename: result.filename, localUrl: result.localUrl, description });
        return { ok: true, summary: `Saved Street View: ${description}`, localUrl: result.localUrl, description };
      } catch (err) {
        return { ok: false, summary: `map_streetview failed: ${err.message}` };
      }
    }

    // ── Data API chart tools ──

    case 'chart_crypto': {
      const p = decision.params || {};
      const metric = p.metric || 'market_cap';
      const limit = Math.min(Math.max(1, p.limit || 10), 50);
      const vsCurrency = p.vs_currency || 'usd';
      const chartType = p.chartType || 'bar';

      try {
        const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=${vsCurrency}&order=market_cap_desc&per_page=${limit}&page=1`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`CoinGecko API: ${res.status}`);
        const coins = await res.json();

        const metricLabels = {
          current_price: `Price (${vsCurrency.toUpperCase()})`,
          market_cap: `Market Cap (${vsCurrency.toUpperCase()})`,
          total_volume: `24h Volume (${vsCurrency.toUpperCase()})`,
          price_change_percentage_24h: '24h Change (%)'
        };
        const title = p.title || `Top ${coins.length} Cryptocurrencies — ${metricLabels[metric] || metric}`;
        const labels = coins.map(c => c.symbol.toUpperCase());
        const values = coins.map(c => c[metric] ?? 0);

        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: metricLabels[metric] || metric, tags: ['crypto', 'coingecko', metric], description: `${chartType} chart of top ${coins.length} cryptocurrencies by ${metric}. ${labels.slice(0, 5).join(', ')} shown.` });
      } catch (err) {
        return { ok: false, summary: `chart_crypto failed: ${err.message}` };
      }
    }

    case 'chart_earthquakes': {
      const p = decision.params || {};
      const days = Math.min(Math.max(1, p.days || 7), 30);
      const minMag = p.min_magnitude ?? 4.0;
      const limit = Math.min(Math.max(1, p.limit || 20), 50);
      const chartType = p.chartType || 'bar';
      const metric = p.metric || 'mag';

      try {
        const startTime = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
        const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=time&minmagnitude=${minMag}&starttime=${startTime}&limit=${limit}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`USGS API: ${res.status}`);
        const data = await res.json();
        const quakes = (data.features || []).slice(0, limit);

        // Map mode: plot earthquake epicenters on a map
        if (chartType === 'map') {
          const apiKey = process.env.GOOGLE_MAPS_API_KEY;
          if (!apiKey) return { ok: false, summary: 'Google Maps API key not configured for map rendering.' };
          const markers = quakes.map(q => ({
            lat: q.geometry.coordinates[1],
            lng: q.geometry.coordinates[0],
            label: `M${q.properties.mag.toFixed(1)}`
          }));
          const colors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
          let mapUrl = `https://maps.googleapis.com/maps/api/staticmap?size=600x400&maptype=terrain&key=${apiKey}`;
          for (let i = 0; i < Math.min(markers.length, 50); i++) {
            const m = markers[i];
            const color = m.label.replace('M','') >= 6 ? 'red' : m.label.replace('M','') >= 5 ? 'orange' : 'yellow';
            mapUrl += `&markers=color:${color}|label:${(m.label || '')[0]}|${m.lat},${m.lng}`;
          }
          const desc = p.title || `Earthquake Map (past ${days}d, M≥${minMag}, ${quakes.length} events)`;
          try {
            const result = await agentStorage.downloadToAgentStorage(agent.id, mapUrl);
            agentStorage.recordFileMetadata(agent.id, result.filename, { caption: desc });
            runState.workingSet.savedFilesThisRun.push({ filename: result.filename, localUrl: result.localUrl, description: desc });
            return { ok: true, summary: `Earthquake map saved: ${desc}`, localUrl: result.localUrl, chartUrl: result.localUrl, description: desc };
          } catch (err) { return { ok: false, summary: `chart_earthquakes map failed: ${err.message}` }; }
        }

        let labels, values, title, datasetLabel, desc;
        if (metric === 'count_by_magnitude') {
          const buckets = {};
          for (const q of quakes) {
            const mag = Math.floor(q.properties.mag);
            const key = `M${mag}-${mag + 1}`;
            buckets[key] = (buckets[key] || 0) + 1;
          }
          const sorted = Object.entries(buckets).sort((a, b) => a[0].localeCompare(b[0]));
          labels = sorted.map(e => e[0]);
          values = sorted.map(e => e[1]);
          datasetLabel = 'Count';
          title = p.title || `Earthquake Magnitude Distribution (past ${days}d, M≥${minMag})`;
          desc = `Distribution of ${quakes.length} earthquakes by magnitude range over past ${days} days.`;
        } else {
          labels = quakes.map(q => (q.properties.place || '').replace(/^.* of /, '').slice(0, 25));
          values = quakes.map(q => q.properties.mag);
          datasetLabel = 'Magnitude';
          title = p.title || `Recent Earthquakes — Magnitude (past ${days}d, M≥${minMag})`;
          desc = `${quakes.length} recent earthquakes (M≥${minMag}) over past ${days} days. Strongest: M${Math.max(...values).toFixed(1)}.`;
        }

        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel, tags: ['earthquake', 'usgs', 'geology'], description: desc });
      } catch (err) {
        return { ok: false, summary: `chart_earthquakes failed: ${err.message}` };
      }
    }

    case 'chart_economy': {
      const p = decision.params || {};
      const countries = (p.countries || 'USA;CHN;JPN;DEU;GBR').split(';').map(s => s.trim()).filter(Boolean);
      const indicator = p.indicator || 'NY.GDP.MKTP.CD';
      const startYear = p.start_year || 2018;
      const endYear = p.end_year || 2024;
      const chartType = p.chartType || 'bar';

      const indicatorNames = {
        'NY.GDP.MKTP.CD': 'GDP (current US$)',
        'SP.POP.TOTL': 'Population',
        'FP.CPI.TOTL.ZG': 'Inflation (%)',
        'NY.GDP.PCAP.CD': 'GDP per capita (US$)',
        'SL.UEM.TOTL.ZS': 'Unemployment (%)'
      };
      const indicatorLabel = indicatorNames[indicator] || indicator;

      try {
        const countryParam = countries.join(';');
        const url = `https://api.worldbank.org/v2/country/${countryParam}/indicator/${indicator}?format=json&per_page=200&date=${startYear}:${endYear}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`World Bank API: ${res.status}`);
        const json = await res.json();
        const records = json[1] || [];

        // For line chart: group by country, x-axis = year
        if (chartType === 'line' || chartType === 'area') {
          const byCountry = {};
          for (const r of records) {
            if (r.value == null) continue;
            const name = r.country?.value || r.countryiso3code;
            (byCountry[name] ||= []).push({ year: r.date, value: r.value });
          }
          const years = [...new Set(records.map(r => r.date))].sort();
          const datasets = Object.entries(byCountry).map(([name, pts]) => {
            const byYear = Object.fromEntries(pts.map(p => [p.year, p.value]));
            return { label: name, data: years.map(y => byYear[y] ?? null) };
          });
          const title = p.title || `${indicatorLabel} (${startYear}–${endYear})`;
          const chartData = { labels: years, datasets };
          const finalType = chartType === 'area' ? 'line' : chartType;
          if (chartType === 'area') datasets.forEach(ds => ds.fill = true);
          return await saveDataApiChartRaw({ agent, chartType: finalType, title, data: chartData, tags: ['economy', 'world-bank', indicator], description: `${chartType} chart of ${indicatorLabel} for ${Object.keys(byCountry).join(', ')} from ${startYear} to ${endYear}.` });
        }

        // Bar/pie: latest year per country
        const latest = {};
        for (const r of records) {
          if (r.value == null) continue;
          const name = r.country?.value || r.countryiso3code;
          if (!latest[name] || r.date > latest[name].year) {
            latest[name] = { year: r.date, value: r.value };
          }
        }
        const labels = Object.keys(latest);
        const values = labels.map(n => latest[n].value);
        const latestYear = labels.length ? latest[labels[0]].year : endYear;
        const title = p.title || `${indicatorLabel} by Country (${latestYear})`;
        const desc = `${chartType} chart of ${indicatorLabel} for ${labels.join(', ')} (${latestYear}).`;

        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: indicatorLabel, tags: ['economy', 'world-bank', indicator], description: desc });
      } catch (err) {
        return { ok: false, summary: `chart_economy failed: ${err.message}` };
      }
    }

    case 'chart_weather': {
      const p = decision.params || {};
      const lat = p.latitude;
      const lon = p.longitude;
      if (lat == null || lon == null) return { ok: false, summary: 'latitude and longitude are required.' };
      const variable = p.variable || 'temperature_2m';
      const days = Math.min(Math.max(1, p.days || 7), 16);
      const locName = p.location_name || `${lat},${lon}`;
      const chartType = p.chartType || 'line';

      const varLabels = {
        temperature_2m: 'Temperature (°C)',
        precipitation: 'Precipitation (mm)',
        windspeed_10m: 'Wind Speed (km/h)',
        relative_humidity_2m: 'Relative Humidity (%)'
      };

      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${variable}&forecast_days=${days}&timezone=auto`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Open-Meteo API: ${res.status}`);
        const data = await res.json();

        const times = data.hourly?.time || [];
        const vals = data.hourly?.[variable] || [];
        // Downsample to daily averages for cleaner chart
        const dailyMap = {};
        for (let i = 0; i < times.length; i++) {
          const day = times[i].split('T')[0];
          (dailyMap[day] ||= []).push(vals[i]);
        }
        const labels = Object.keys(dailyMap).sort();
        const values = labels.map(d => {
          const arr = dailyMap[d];
          return +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1);
        });

        const title = p.title || `${varLabels[variable] || variable} — ${locName} (${days}-day forecast)`;
        const desc = `${chartType} chart of ${days}-day ${variable} forecast for ${locName}. Range: ${Math.min(...values)}–${Math.max(...values)}.`;

        return await saveDataApiChart({ agent, chartType: chartType === 'area' ? 'line' : chartType, title, labels, values, datasetLabel: varLabels[variable] || variable, tags: ['weather', 'forecast', locName.toLowerCase()], description: desc, fillArea: chartType === 'area' });
      } catch (err) {
        return { ok: false, summary: `chart_weather failed: ${err.message}` };
      }
    }

    case 'chart_air_quality': {
      const p = decision.params || {};
      const city = p.city;
      if (!city) return { ok: false, summary: 'city is required.' };
      const chartType = p.chartType || 'bar';
      const paramFilter = p.parameter;
      const limit = Math.min(Math.max(1, p.limit || 10), 30);

      try {
        const url = `https://api.openaq.org/v2/latest?city=${encodeURIComponent(city)}&limit=${limit}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`OpenAQ API: ${res.status}`);
        const data = await res.json();
        const results = data.results || [];

        if (results.length === 0) return { ok: false, summary: `No air quality data found for "${city}".` };

        // Aggregate measurements across locations
        const paramValues = {};
        for (const loc of results) {
          for (const m of (loc.measurements || [])) {
            if (paramFilter && m.parameter !== paramFilter) continue;
            (paramValues[m.parameter] ||= []).push({ location: loc.location, value: m.value, unit: m.unit });
          }
        }

        if (Object.keys(paramValues).length === 0) return { ok: false, summary: `No measurements found for "${city}"${paramFilter ? ` with parameter "${paramFilter}"` : ''}.` };

        // Chart: average value per parameter across all locations
        const labels = Object.keys(paramValues);
        const values = labels.map(param => {
          const arr = paramValues[param];
          return +(arr.reduce((s, v) => s + v.value, 0) / arr.length).toFixed(2);
        });
        const unit = paramValues[labels[0]]?.[0]?.unit || '';

        const title = p.title || `Air Quality — ${city} (${results.length} stations)`;
        const desc = `${chartType} chart of air quality in ${city}. Parameters: ${labels.join(', ')}. From ${results.length} monitoring stations.`;

        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: `Average value${unit ? ` (${unit})` : ''}`, tags: ['air-quality', 'openaq', city.toLowerCase()], description: desc });
      } catch (err) {
        return { ok: false, summary: `chart_air_quality failed: ${err.message}` };
      }
    }

    case 'chart_exchange_rates': {
      const p = decision.params || {};
      const base = p.base || 'USD';
      const targets = (p.targets || 'EUR,GBP,JPY,CNY,CAD,AUD,CHF,KRW').split(',').map(s => s.trim()).filter(Boolean);
      const chartType = p.chartType || 'bar';

      try {
        const url = `https://open.er-api.com/v6/latest/${base}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Exchange Rate API: ${res.status}`);
        const data = await res.json();
        const rates = data.rates || {};

        const labels = targets.filter(t => rates[t] != null);
        const values = labels.map(t => rates[t]);

        if (labels.length === 0) return { ok: false, summary: `No exchange rate data for targets: ${targets.join(', ')}` };

        const title = p.title || `Exchange Rates — 1 ${base} in Foreign Currencies`;
        const desc = `${chartType} chart of exchange rates from ${base} to ${labels.join(', ')}. Date: ${data.time_last_update_utc || 'latest'}.`;

        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: `1 ${base} =`, tags: ['exchange-rates', 'forex', base.toLowerCase()], description: desc });
      } catch (err) {
        return { ok: false, summary: `chart_exchange_rates failed: ${err.message}` };
      }
    }

    // ── New Data API chart tools ──

    case 'chart_countries': {
      const p = decision.params || {};
      const metric = p.metric || 'population';
      const limit = Math.min(Math.max(1, p.limit || 15), 50);
      const chartType = p.chartType || 'bar';
      const region = p.region;

      try {
        const url = region
          ? `https://restcountries.com/v3.1/region/${encodeURIComponent(region)}?fields=name,population,area,gini`
          : `https://restcountries.com/v3.1/all?fields=name,population,area,gini`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`REST Countries API: ${res.status}`);
        let countries = await res.json();
        countries.sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
        countries = countries.slice(0, limit);

        const labels = countries.map(c => c.name?.common || 'Unknown');
        const values = countries.map(c => {
          if (metric === 'gini') return c.gini ? Object.values(c.gini)[0] || 0 : 0;
          return c[metric] || 0;
        });
        const metricLabels = { population: 'Population', area: 'Area (km²)', gini: 'Gini Index' };
        const title = p.title || `Top ${labels.length} Countries — ${metricLabels[metric] || metric}${region ? ` (${region})` : ''}`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: metricLabels[metric] || metric, tags: ['countries', metric], description: `${chartType} chart of ${labels.length} countries by ${metric}.` });
      } catch (err) {
        return { ok: false, summary: `chart_countries failed: ${err.message}` };
      }
    }

    case 'chart_nutrition': {
      const p = decision.params || {};
      const query = p.query;
      if (!query) return { ok: false, summary: 'query is required.' };
      const metric = p.metric || 'energy_kcal';
      const limit = Math.min(Math.max(1, p.limit || 10), 25);
      const chartType = p.chartType || 'bar';

      try {
        const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&json=1&page_size=${limit}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Open Food Facts API: ${res.status}`);
        const data = await res.json();
        const products = (data.products || []).filter(p => p.product_name);

        const nutrientMap = { energy_kcal: 'energy-kcal_100g', fat: 'fat_100g', sugars: 'sugars_100g', proteins: 'proteins_100g', salt: 'salt_100g', fiber: 'fiber_100g' };
        const field = nutrientMap[metric] || nutrientMap.energy_kcal;
        const labels = products.map(p => (p.product_name || '').slice(0, 30));
        const values = products.map(p => parseFloat(p.nutriments?.[field]) || 0);
        const title = p.title || `${query} — ${metric} per 100g`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: metric, tags: ['nutrition', 'food', query], description: `${chartType} chart of ${metric} for ${labels.length} "${query}" products.` });
      } catch (err) {
        return { ok: false, summary: `chart_nutrition failed: ${err.message}` };
      }
    }

    case 'chart_daylight': {
      const p = decision.params || {};
      const locStr = p.locations;
      if (!locStr) return { ok: false, summary: 'locations is required (e.g. "40.71,-74.01,New York;51.51,-0.13,London").' };
      const chartType = p.chartType || 'bar';

      try {
        const locs = locStr.split(';').map(s => { const [lat, lng, ...rest] = s.split(','); return { lat: lat.trim(), lng: lng.trim(), name: rest.join(',').trim() || `${lat},${lng}` }; });

        // Map mode: show locations on a map
        if (chartType === 'map') {
          const apiKey = process.env.GOOGLE_MAPS_API_KEY;
          if (!apiKey) return { ok: false, summary: 'Google Maps API key not configured for map rendering.' };
          let mapUrl = `https://maps.googleapis.com/maps/api/staticmap?size=600x400&maptype=roadmap&key=${apiKey}`;
          const colors = ['red', 'blue', 'green', 'purple', 'orange', 'yellow', 'pink', 'brown'];
          for (let i = 0; i < Math.min(locs.length, 50); i++) {
            const loc = locs[i];
            mapUrl += `&markers=color:${colors[i % colors.length]}|label:${(loc.name || '')[0]?.toUpperCase() || ''}|${loc.lat},${loc.lng}`;
          }
          const desc = p.title || `Locations Map: ${locs.map(l => l.name).join(', ')}`;
          const result = await agentStorage.downloadToAgentStorage(agent.id, mapUrl);
          agentStorage.recordFileMetadata(agent.id, result.filename, { caption: desc });
          runState.workingSet.savedFilesThisRun.push({ filename: result.filename, localUrl: result.localUrl, description: desc });
          return { ok: true, summary: `Map saved: ${desc}`, localUrl: result.localUrl, chartUrl: result.localUrl, description: desc };
        }

        const results = await Promise.all(locs.map(async loc => {
          const res = await fetch(`https://api.sunrise-sunset.org/json?lat=${loc.lat}&lng=${loc.lng}&formatted=0`, { signal: AbortSignal.timeout(10000) });
          const d = await res.json();
          const dayLen = d.results?.day_length || 0;
          const hours = typeof dayLen === 'number' ? +(dayLen / 3600).toFixed(2) : 0;
          return { name: loc.name, hours };
        }));

        const labels = results.map(r => r.name);
        const values = results.map(r => r.hours);
        const title = p.title || `Day Length Comparison (hours)`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: 'Day Length (hours)', tags: ['daylight', 'sunrise-sunset'], description: `Day length comparison for ${labels.join(', ')}.` });
      } catch (err) {
        return { ok: false, summary: `chart_daylight failed: ${err.message}` };
      }
    }

    case 'chart_spacex': {
      const p = decision.params || {};
      const metric = p.metric || 'launches_per_year';
      const chartType = p.chartType || 'bar';

      try {
        const res = await fetch('https://api.spacexdata.com/v4/launches', { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`SpaceX API: ${res.status}`);
        const launches = await res.json();

        let labels, values, datasetLabel, title, desc;
        if (metric === 'success_rate') {
          const byYear = {};
          for (const l of launches) {
            const y = new Date(l.date_utc).getFullYear();
            if (!byYear[y]) byYear[y] = { success: 0, total: 0 };
            byYear[y].total++;
            if (l.success) byYear[y].success++;
          }
          const years = Object.keys(byYear).sort();
          labels = years;
          values = years.map(y => +((byYear[y].success / byYear[y].total) * 100).toFixed(1));
          datasetLabel = 'Success Rate (%)';
          title = p.title || 'SpaceX Launch Success Rate by Year';
          desc = `Success rate from ${years[0]} to ${years[years.length - 1]}.`;
        } else if (metric === 'by_rocket') {
          const byRocket = {};
          for (const l of launches) byRocket[l.rocket] = (byRocket[l.rocket] || 0) + 1;
          const sorted = Object.entries(byRocket).sort((a, b) => b[1] - a[1]);
          labels = sorted.map(e => e[0].slice(0, 20));
          values = sorted.map(e => e[1]);
          datasetLabel = 'Launches';
          title = p.title || 'SpaceX Launches by Rocket';
          desc = `Launch count per rocket type.`;
        } else {
          const byYear = {};
          for (const l of launches) {
            const y = new Date(l.date_utc).getFullYear();
            byYear[y] = (byYear[y] || 0) + 1;
          }
          const years = Object.keys(byYear).sort();
          labels = years;
          values = years.map(y => byYear[y]);
          datasetLabel = 'Launches';
          title = p.title || 'SpaceX Launches per Year';
          desc = `Total launches per year from ${years[0]} to ${years[years.length - 1]}.`;
        }
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel, tags: ['space', 'spacex', 'launches'], description: desc });
      } catch (err) {
        return { ok: false, summary: `chart_spacex failed: ${err.message}` };
      }
    }

    case 'chart_asteroids': {
      const p = decision.params || {};
      const days = Math.min(Math.max(1, p.days || 7), 7);
      const chartType = p.chartType || 'bar';
      const metric = p.metric || 'count_per_day';

      try {
        const start = new Date(); const end = new Date(start.getTime() + days * 86400000);
        const startStr = start.toISOString().split('T')[0];
        const endStr = end.toISOString().split('T')[0];
        const url = `https://api.nasa.gov/neo/rest/v1/feed?start_date=${startStr}&end_date=${endStr}&api_key=DEMO_KEY`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`NASA NEO API: ${res.status}`);
        const data = await res.json();
        const neoByDate = data.near_earth_objects || {};

        let labels, values, datasetLabel, title, desc;
        if (metric === 'diameter') {
          const allNeos = Object.values(neoByDate).flat().slice(0, 20);
          labels = allNeos.map(n => (n.name || '').slice(0, 20));
          values = allNeos.map(n => +(n.estimated_diameter?.kilometers?.estimated_diameter_max || 0).toFixed(3));
          datasetLabel = 'Max Diameter (km)';
          title = p.title || `Near-Earth Asteroids — Estimated Diameter`;
          desc = `Estimated max diameter of ${allNeos.length} near-Earth asteroids.`;
        } else if (metric === 'velocity') {
          const allNeos = Object.values(neoByDate).flat().slice(0, 20);
          labels = allNeos.map(n => (n.name || '').slice(0, 20));
          values = allNeos.map(n => +(parseFloat(n.close_approach_data?.[0]?.relative_velocity?.kilometers_per_hour) || 0).toFixed(0));
          datasetLabel = 'Velocity (km/h)';
          title = p.title || `Near-Earth Asteroids — Velocity`;
          desc = `Approach velocity of ${allNeos.length} near-Earth asteroids.`;
        } else {
          const dates = Object.keys(neoByDate).sort();
          labels = dates;
          values = dates.map(d => neoByDate[d].length);
          datasetLabel = 'Asteroid Count';
          title = p.title || `Near-Earth Asteroids per Day (${days}d)`;
          desc = `Count of near-Earth asteroids per day over ${days} days. Total: ${values.reduce((s, v) => s + v, 0)}.`;
        }
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel, tags: ['space', 'nasa', 'asteroids'], description: desc });
      } catch (err) {
        return { ok: false, summary: `chart_asteroids failed: ${err.message}` };
      }
    }

    case 'chart_planets': {
      const p = decision.params || {};
      const metric = p.metric || 'gravity';
      const bodyType = p.bodyType || 'Planet';
      const chartType = p.chartType || 'bar';

      try {
        const res = await fetch('https://api.le-systeme-solaire.net/rest/bodies/', { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Solar System API: ${res.status}`);
        const data = await res.json();
        let bodies = (data.bodies || []).filter(b => b.bodyType === bodyType && b[metric] != null && b[metric] > 0);
        bodies.sort((a, b) => b[metric] - a[metric]);
        bodies = bodies.slice(0, 20);

        const labels = bodies.map(b => b.englishName || b.name);
        const values = bodies.map(b => b[metric]);
        const metricLabels = { gravity: 'Gravity (m/s²)', density: 'Density (g/cm³)', meanRadius: 'Mean Radius (km)', sideralOrbit: 'Orbital Period (days)', sideralRotation: 'Rotation Period (hours)' };
        const title = p.title || `${bodyType}s — ${metricLabels[metric] || metric}`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: metricLabels[metric] || metric, tags: ['space', 'planets', 'solar-system'], description: `${chartType} chart comparing ${labels.length} ${bodyType.toLowerCase()}s by ${metric}.` });
      } catch (err) {
        return { ok: false, summary: `chart_planets failed: ${err.message}` };
      }
    }

    case 'chart_astronauts': {
      const p = decision.params || {};
      const chartType = p.chartType || 'pie';

      try {
        const res = await fetch('http://api.open-notify.org/astros.json', { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`Open Notify API: ${res.status}`);
        const data = await res.json();
        const people = data.people || [];

        const byCraft = {};
        for (const person of people) byCraft[person.craft] = (byCraft[person.craft] || 0) + 1;
        const labels = Object.keys(byCraft);
        const values = labels.map(c => byCraft[c]);
        const title = p.title || `People in Space Right Now (${data.number || people.length} total)`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: 'Astronauts', tags: ['space', 'astronauts', 'ISS'], description: `${people.length} people currently in space across ${labels.length} spacecraft: ${labels.join(', ')}.` });
      } catch (err) {
        return { ok: false, summary: `chart_astronauts failed: ${err.message}` };
      }
    }

    case 'chart_us_population': {
      const p = decision.params || {};
      const chartType = p.chartType || 'line';
      const drilldown = p.drilldown || 'Nation';

      try {
        const url = `https://datausa.io/api/data?drilldowns=${encodeURIComponent(drilldown)}&measures=Population`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`DataUSA API: ${res.status}`);
        const json = await res.json();
        let records = json.data || [];

        if (drilldown === 'Nation') {
          records.sort((a, b) => a.Year - b.Year);
          const labels = records.map(r => String(r.Year));
          const values = records.map(r => r.Population);
          const title = p.title || 'US Population Over Time';
          return await saveDataApiChart({ agent, chartType: chartType === 'area' ? 'line' : chartType, title, labels, values, datasetLabel: 'Population', tags: ['population', 'usa', 'demographics'], description: `US population trend from ${labels[0]} to ${labels[labels.length - 1]}.`, fillArea: chartType === 'area' });
        } else {
          records.sort((a, b) => b.Population - a.Population);
          records = records.slice(0, 20);
          const labels = records.map(r => r.State || r[drilldown]);
          const values = records.map(r => r.Population);
          const title = p.title || `US Population by ${drilldown}`;
          return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: 'Population', tags: ['population', 'usa', drilldown.toLowerCase()], description: `Top ${labels.length} by population.` });
        }
      } catch (err) {
        return { ok: false, summary: `chart_us_population failed: ${err.message}` };
      }
    }

    case 'chart_genderize': {
      const p = decision.params || {};
      if (!p.names) return { ok: false, summary: 'names is required (comma-separated).' };
      const names = p.names.split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
      const chartType = p.chartType || 'bar';

      try {
        const params = names.map((n, i) => `name[${i}]=${encodeURIComponent(n)}`).join('&');
        const res = await fetch(`https://api.genderize.io?${params}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`Genderize API: ${res.status}`);
        const data = await res.json();
        const results = Array.isArray(data) ? data : [data];

        const labels = results.map(r => r.name);
        const values = results.map(r => +(r.probability * 100).toFixed(1));
        const title = p.title || `Gender Prediction Probability`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: 'Probability (%)', tags: ['demographics', 'gender', 'names'], description: `Gender prediction for ${labels.join(', ')}. Predicted genders: ${results.map(r => `${r.name}=${r.gender}`).join(', ')}.` });
      } catch (err) {
        return { ok: false, summary: `chart_genderize failed: ${err.message}` };
      }
    }

    case 'chart_nationalize': {
      const p = decision.params || {};
      if (!p.name) return { ok: false, summary: 'name is required.' };
      const chartType = p.chartType || 'bar';

      try {
        const res = await fetch(`https://api.nationalize.io?name=${encodeURIComponent(p.name)}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`Nationalize API: ${res.status}`);
        const data = await res.json();
        const countries = data.country || [];
        if (countries.length === 0) return { ok: false, summary: `No nationality data for "${p.name}".` };

        const labels = countries.map(c => c.country_id);
        const values = countries.map(c => +(c.probability * 100).toFixed(1));
        const title = p.title || `Nationality Prediction for "${p.name}"`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: 'Probability (%)', tags: ['demographics', 'nationality', 'names'], description: `Nationality prediction for "${p.name}": ${labels.map((l, i) => `${l}: ${values[i]}%`).join(', ')}.` });
      } catch (err) {
        return { ok: false, summary: `chart_nationalize failed: ${err.message}` };
      }
    }

    case 'chart_agify': {
      const p = decision.params || {};
      if (!p.names) return { ok: false, summary: 'names is required (comma-separated).' };
      const names = p.names.split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
      const chartType = p.chartType || 'bar';

      try {
        const params = names.map((n, i) => `name[${i}]=${encodeURIComponent(n)}`).join('&');
        const res = await fetch(`https://api.agify.io?${params}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`Agify API: ${res.status}`);
        const data = await res.json();
        const results = Array.isArray(data) ? data : [data];

        const labels = results.map(r => r.name);
        const values = results.map(r => r.age || 0);
        const title = p.title || `Predicted Age by Name`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: 'Predicted Age', tags: ['demographics', 'age', 'names'], description: `Age predictions: ${results.map(r => `${r.name}=${r.age}`).join(', ')}.` });
      } catch (err) {
        return { ok: false, summary: `chart_agify failed: ${err.message}` };
      }
    }

    case 'chart_covid': {
      const p = decision.params || {};
      const metric = p.metric || 'cases';
      const limit = Math.min(Math.max(1, p.limit || 15), 50);
      const chartType = p.chartType || 'bar';

      try {
        const url = `https://disease.sh/v3/covid-19/countries?sort=${metric}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`disease.sh API: ${res.status}`);
        const countries = (await res.json()).slice(0, limit);

        const labels = countries.map(c => c.country);
        const values = countries.map(c => c[metric] || 0);
        const metricLabels = { cases: 'Total Cases', deaths: 'Total Deaths', recovered: 'Recovered', active: 'Active Cases', casesPerOneMillion: 'Cases/Million', deathsPerOneMillion: 'Deaths/Million', tests: 'Total Tests' };
        const title = p.title || `COVID-19 — Top ${limit} Countries by ${metricLabels[metric] || metric}`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: metricLabels[metric] || metric, tags: ['covid', 'health', metric], description: `${chartType} chart of ${metric} for top ${limit} countries.` });
      } catch (err) {
        return { ok: false, summary: `chart_covid failed: ${err.message}` };
      }
    }

    case 'chart_covid_history': {
      const p = decision.params || {};
      const metric = p.metric || 'cases';
      const days = Math.min(Math.max(7, p.days || 30), 365);
      const chartType = p.chartType || 'line';

      try {
        const res = await fetch(`https://disease.sh/v3/covid-19/historical/all?lastdays=${days}`, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`disease.sh API: ${res.status}`);
        const data = await res.json();
        const series = data[metric] || {};

        const labels = Object.keys(series);
        const values = Object.values(series);
        const title = p.title || `Global COVID-19 ${metric} (${days} days)`;
        return await saveDataApiChart({ agent, chartType: chartType === 'area' ? 'line' : chartType, title, labels, values, datasetLabel: metric, tags: ['covid', 'health', 'time-series'], description: `${days}-day global COVID-19 ${metric} trend.`, fillArea: chartType === 'area' });
      } catch (err) {
        return { ok: false, summary: `chart_covid_history failed: ${err.message}` };
      }
    }

    case 'chart_carbon_intensity': {
      const p = decision.params || {};
      const chartType = p.chartType || 'line';
      const date = p.date || new Date().toISOString().split('T')[0];

      try {
        const res = await fetch(`https://api.carbonintensity.org.uk/intensity/date/${date}`, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Carbon Intensity API: ${res.status}`);
        const json = await res.json();
        const entries = json.data || [];

        const labels = entries.map(e => e.from?.slice(11, 16) || '');
        const values = entries.map(e => e.intensity?.actual ?? e.intensity?.forecast ?? 0);
        const title = p.title || `UK Carbon Intensity — ${date} (gCO₂/kWh)`;
        return await saveDataApiChart({ agent, chartType: chartType === 'area' ? 'line' : chartType, title, labels, values, datasetLabel: 'gCO₂/kWh', tags: ['energy', 'carbon', 'uk'], description: `Carbon intensity of UK electricity on ${date}. Range: ${Math.min(...values)}–${Math.max(...values)} gCO₂/kWh.`, fillArea: chartType === 'area' });
      } catch (err) {
        return { ok: false, summary: `chart_carbon_intensity failed: ${err.message}` };
      }
    }

    case 'chart_energy_mix': {
      const p = decision.params || {};
      const chartType = p.chartType || 'pie';

      try {
        const res = await fetch('https://api.carbonintensity.org.uk/generation', { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Carbon Intensity API: ${res.status}`);
        const json = await res.json();
        const mix = json.data?.generationmix || [];

        const labels = mix.map(m => m.fuel);
        const values = mix.map(m => m.perc);
        const title = p.title || 'UK Electricity Generation Mix (%)';
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: 'Share (%)', tags: ['energy', 'renewables', 'uk', 'electricity'], description: `UK electricity generation breakdown: ${mix.filter(m => m.perc > 0).map(m => `${m.fuel}: ${m.perc}%`).join(', ')}.` });
      } catch (err) {
        return { ok: false, summary: `chart_energy_mix failed: ${err.message}` };
      }
    }

    case 'chart_air_forecast': {
      const p = decision.params || {};
      if (p.latitude == null || p.longitude == null) return { ok: false, summary: 'latitude and longitude are required.' };
      const pollutant = p.pollutant || 'pm2_5';
      const chartType = p.chartType || 'line';
      const locName = p.location_name || `${p.latitude},${p.longitude}`;

      try {
        const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${p.latitude}&longitude=${p.longitude}&hourly=${pollutant}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Open-Meteo Air Quality API: ${res.status}`);
        const data = await res.json();

        const times = data.hourly?.time || [];
        const vals = data.hourly?.[pollutant] || [];
        // Downsample to daily averages
        const dailyMap = {};
        for (let i = 0; i < times.length; i++) {
          const day = times[i].split('T')[0];
          (dailyMap[day] ||= []).push(vals[i] ?? 0);
        }
        const labels = Object.keys(dailyMap).sort();
        const values = labels.map(d => +(dailyMap[d].reduce((s, v) => s + v, 0) / dailyMap[d].length).toFixed(1));

        const pollutantLabels = { pm2_5: 'PM2.5 (μg/m³)', pm10: 'PM10 (μg/m³)', ozone: 'Ozone (μg/m³)', nitrogen_dioxide: 'NO₂ (μg/m³)' };
        const title = p.title || `${pollutantLabels[pollutant] || pollutant} Forecast — ${locName}`;
        return await saveDataApiChart({ agent, chartType: chartType === 'area' ? 'line' : chartType, title, labels, values, datasetLabel: pollutantLabels[pollutant] || pollutant, tags: ['air-quality', 'forecast', locName.toLowerCase()], description: `${pollutant} air quality forecast for ${locName}.`, fillArea: chartType === 'area' });
      } catch (err) {
        return { ok: false, summary: `chart_air_forecast failed: ${err.message}` };
      }
    }

    case 'chart_ocean_waves': {
      const p = decision.params || {};
      if (p.latitude == null || p.longitude == null) return { ok: false, summary: 'latitude and longitude are required.' };
      const variable = p.variable || 'wave_height';
      const chartType = p.chartType || 'line';
      const locName = p.location_name || `${p.latitude},${p.longitude}`;

      try {
        const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${p.latitude}&longitude=${p.longitude}&hourly=${variable}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Open-Meteo Marine API: ${res.status}`);
        const data = await res.json();

        const times = data.hourly?.time || [];
        const vals = data.hourly?.[variable] || [];
        const dailyMap = {};
        for (let i = 0; i < times.length; i++) {
          const day = times[i].split('T')[0];
          (dailyMap[day] ||= []).push(vals[i] ?? 0);
        }
        const labels = Object.keys(dailyMap).sort();
        const values = labels.map(d => +(dailyMap[d].reduce((s, v) => s + v, 0) / dailyMap[d].length).toFixed(2));

        const varLabels = { wave_height: 'Wave Height (m)', wave_period: 'Wave Period (s)', wave_direction: 'Wave Direction (°)' };
        const title = p.title || `${varLabels[variable] || variable} — ${locName}`;
        return await saveDataApiChart({ agent, chartType: chartType === 'area' ? 'line' : chartType, title, labels, values, datasetLabel: varLabels[variable] || variable, tags: ['marine', 'ocean', 'waves', locName.toLowerCase()], description: `${variable} forecast for ${locName}.`, fillArea: chartType === 'area' });
      } catch (err) {
        return { ok: false, summary: `chart_ocean_waves failed: ${err.message}` };
      }
    }

    case 'chart_water_flow': {
      const p = decision.params || {};
      if (!p.site) return { ok: false, summary: 'site (USGS site number) is required.' };
      const chartType = p.chartType || 'line';
      const siteName = p.site_name || `Site ${p.site}`;

      try {
        const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${p.site}&parameterCd=00060&period=P7D`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`USGS Water API: ${res.status}`);
        const data = await res.json();
        const ts = data.value?.timeSeries?.[0]?.values?.[0]?.value || [];

        // Downsample to ~one per 6 hours
        const step = Math.max(1, Math.floor(ts.length / 28));
        const sampled = ts.filter((_, i) => i % step === 0);
        const labels = sampled.map(v => v.dateTime?.slice(5, 16).replace('T', ' ') || '');
        const values = sampled.map(v => parseFloat(v.value) || 0);

        const title = p.title || `Streamflow — ${siteName} (7 days, ft³/s)`;
        return await saveDataApiChart({ agent, chartType: chartType === 'area' ? 'line' : chartType, title, labels, values, datasetLabel: 'Discharge (ft³/s)', tags: ['water', 'usgs', 'hydrology'], description: `7-day streamflow for ${siteName}. Range: ${Math.min(...values)}–${Math.max(...values)} ft³/s.`, fillArea: chartType === 'area' });
      } catch (err) {
        return { ok: false, summary: `chart_water_flow failed: ${err.message}` };
      }
    }

    case 'chart_coincap': {
      const p = decision.params || {};
      const metric = p.metric || 'marketCapUsd';
      const limit = Math.min(Math.max(1, p.limit || 10), 50);
      const chartType = p.chartType || 'bar';

      try {
        const res = await fetch(`https://api.coincap.io/v2/assets?limit=${limit}`, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`CoinCap API: ${res.status}`);
        const data = await res.json();
        const assets = data.data || [];

        const labels = assets.map(a => a.symbol);
        const values = assets.map(a => parseFloat(a[metric]) || 0);
        const metricLabels = { priceUsd: 'Price (USD)', marketCapUsd: 'Market Cap (USD)', volumeUsd24Hr: '24h Volume (USD)', changePercent24Hr: '24h Change (%)' };
        const title = p.title || `Top ${limit} Crypto — ${metricLabels[metric] || metric}`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: metricLabels[metric] || metric, tags: ['crypto', 'coincap', metric], description: `${chartType} chart of top ${limit} cryptocurrencies by ${metric}.` });
      } catch (err) {
        return { ok: false, summary: `chart_coincap failed: ${err.message}` };
      }
    }

    case 'chart_crypto_history': {
      const p = decision.params || {};
      const coin = p.coin || 'bitcoin';
      const interval = p.interval || 'd1';
      const days = Math.min(Math.max(1, p.days || 30), 365);
      const chartType = p.chartType || 'line';

      try {
        const start = Date.now() - days * 86400000;
        const end = Date.now();
        const url = `https://api.coincap.io/v2/assets/${coin}/history?interval=${interval}&start=${start}&end=${end}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`CoinCap API: ${res.status}`);
        const data = await res.json();
        const points = data.data || [];

        const labels = points.map(p => p.date?.slice(0, 10) || '');
        const values = points.map(p => +(parseFloat(p.priceUsd) || 0).toFixed(2));
        const title = p.title || `${coin.charAt(0).toUpperCase() + coin.slice(1)} Price History (${days}d)`;
        return await saveDataApiChart({ agent, chartType: chartType === 'area' ? 'line' : chartType, title, labels, values, datasetLabel: 'Price (USD)', tags: ['crypto', 'coincap', coin, 'time-series'], description: `${days}-day price history for ${coin}.`, fillArea: chartType === 'area' });
      } catch (err) {
        return { ok: false, summary: `chart_crypto_history failed: ${err.message}` };
      }
    }

    case 'chart_frankfurter': {
      const p = decision.params || {};
      const base = p.base || 'USD';
      const targets = (p.targets || 'EUR,GBP,JPY,CNY,CAD,AUD,CHF,KRW').split(',').map(s => s.trim()).filter(Boolean);
      const chartType = p.chartType || 'bar';

      try {
        const url = `https://api.frankfurter.app/latest?from=${base}&to=${targets.join(',')}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Frankfurter API: ${res.status}`);
        const data = await res.json();
        const rates = data.rates || {};

        const labels = Object.keys(rates);
        const values = labels.map(k => rates[k]);
        const title = p.title || `ECB Exchange Rates — 1 ${base}`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: `1 ${base} =`, tags: ['forex', 'ecb', base.toLowerCase()], description: `ECB exchange rates from ${base} to ${labels.join(', ')} as of ${data.date}.` });
      } catch (err) {
        return { ok: false, summary: `chart_frankfurter failed: ${err.message}` };
      }
    }

    case 'chart_forex_history': {
      const p = decision.params || {};
      const base = p.base || 'USD';
      const targets = (p.targets || 'EUR,GBP,JPY').split(',').map(s => s.trim()).filter(Boolean);
      const days = Math.min(Math.max(7, p.days || 90), 365);
      const chartType = p.chartType || 'line';

      try {
        const end = new Date().toISOString().split('T')[0];
        const start = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
        const url = `https://api.frankfurter.app/${start}..${end}?from=${base}&to=${targets.join(',')}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Frankfurter API: ${res.status}`);
        const data = await res.json();
        const ratesByDate = data.rates || {};

        const dates = Object.keys(ratesByDate).sort();
        const datasets = targets.map(t => ({
          label: t,
          data: dates.map(d => ratesByDate[d]?.[t] ?? null)
        }));
        const title = p.title || `${base} Exchange Rate Trends (${days}d)`;
        return await saveDataApiChartRaw({ agent, chartType: chartType === 'area' ? 'line' : chartType, title, data: { labels: dates, datasets }, tags: ['forex', 'ecb', 'time-series'], description: `${days}-day ${base} exchange rate trends for ${targets.join(', ')}.` });
      } catch (err) {
        return { ok: false, summary: `chart_forex_history failed: ${err.message}` };
      }
    }

    case 'chart_bike_sharing': {
      const p = decision.params || {};
      const metric = p.metric || 'networks_per_country';
      const limit = Math.min(Math.max(1, p.limit || 15), 30);
      const chartType = p.chartType || 'bar';

      try {
        const res = await fetch('https://api.citybik.es/v2/networks', { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`CityBikes API: ${res.status}`);
        const data = await res.json();
        const networks = data.networks || [];

        let labels, values, datasetLabel, title, desc;
        if (metric === 'top_networks') {
          const top = networks.filter(n => n.stations_count).sort((a, b) => (b.stations_count || 0) - (a.stations_count || 0)).slice(0, limit);
          labels = top.map(n => `${n.name} (${n.location?.city || ''})`).map(s => s.slice(0, 30));
          values = top.map(n => n.stations_count || 0);
          datasetLabel = 'Stations';
          title = p.title || `Top ${limit} Bike-Sharing Networks by Stations`;
          desc = `Largest bike-sharing networks worldwide.`;
        } else {
          const byCountry = {};
          for (const n of networks) {
            const c = n.location?.country || 'Unknown';
            byCountry[c] = (byCountry[c] || 0) + 1;
          }
          const sorted = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, limit);
          labels = sorted.map(e => e[0]);
          values = sorted.map(e => e[1]);
          datasetLabel = 'Networks';
          title = p.title || `Bike-Sharing Networks by Country`;
          desc = `${networks.length} total networks across ${Object.keys(byCountry).length} countries.`;
        }
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel, tags: ['transport', 'bikes', 'urban'], description: desc });
      } catch (err) {
        return { ok: false, summary: `chart_bike_sharing failed: ${err.message}` };
      }
    }

    case 'chart_f1': {
      const p = decision.params || {};
      const season = p.season || 'current';
      const chartType = p.chartType || 'bar';

      try {
        const url = `https://api.jolpi.ca/ergast/f1/${season}/driverStandings.json`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Ergast F1 API: ${res.status}`);
        const data = await res.json();
        const standings = data.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings || [];

        const labels = standings.map(s => `${s.Driver?.givenName?.[0] || ''}. ${s.Driver?.familyName || ''}`);
        const values = standings.map(s => parseFloat(s.points) || 0);
        const seasonLabel = data.MRData?.StandingsTable?.StandingsLists?.[0]?.season || season;
        const title = p.title || `F1 ${seasonLabel} Driver Standings (Points)`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: 'Points', tags: ['sports', 'f1', 'motorsport'], description: `F1 ${seasonLabel} driver standings. Leader: ${labels[0]} (${values[0]} pts).` });
      } catch (err) {
        return { ok: false, summary: `chart_f1 failed: ${err.message}` };
      }
    }

    case 'chart_github_events': {
      const p = decision.params || {};
      const chartType = p.chartType || 'pie';

      try {
        const res = await fetch('https://api.github.com/events', { headers: { 'User-Agent': 'SoupPlatform/1.0', Accept: 'application/vnd.github.v3+json' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
        const events = await res.json();

        const byType = {};
        for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
        const sorted = Object.entries(byType).sort((a, b) => b[1] - a[1]);
        const labels = sorted.map(e => e[0].replace('Event', ''));
        const values = sorted.map(e => e[1]);
        const title = p.title || `GitHub Public Events by Type (last ${events.length})`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: 'Count', tags: ['technology', 'github', 'open-source'], description: `Distribution of ${events.length} recent GitHub events.` });
      } catch (err) {
        return { ok: false, summary: `chart_github_events failed: ${err.message}` };
      }
    }

    case 'chart_stackoverflow': {
      const p = decision.params || {};
      const limit = Math.min(Math.max(1, p.limit || 20), 50);
      const chartType = p.chartType || 'bar';

      try {
        const url = `https://api.stackexchange.com/2.3/tags?order=desc&sort=popular&site=stackoverflow&pagesize=${limit}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0', 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`StackExchange API: ${res.status}`);
        const data = await res.json();
        const tags = data.items || [];

        const labels = tags.map(t => t.name);
        const values = tags.map(t => t.count);
        const title = p.title || `Top ${limit} StackOverflow Tags (Questions)`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: 'Questions', tags: ['technology', 'stackoverflow', 'programming'], description: `Top ${labels.length} StackOverflow tags by question count.` });
      } catch (err) {
        return { ok: false, summary: `chart_stackoverflow failed: ${err.message}` };
      }
    }

    case 'chart_wikipedia': {
      const p = decision.params || {};
      if (!p.article) return { ok: false, summary: 'article is required (e.g. "Artificial_intelligence").' };
      const days = Math.min(Math.max(1, p.days || 30), 90);
      const chartType = p.chartType || 'line';

      try {
        const end = new Date();
        const start = new Date(end.getTime() - days * 86400000);
        const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
        const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${encodeURIComponent(p.article)}/daily/${fmt(start)}/${fmt(end)}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Wikipedia API: ${res.status}`);
        const data = await res.json();
        const items = data.items || [];

        const labels = items.map(i => i.timestamp?.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'));
        const values = items.map(i => i.views);
        const title = p.title || `Wikipedia Pageviews — ${p.article.replace(/_/g, ' ')} (${days}d)`;
        return await saveDataApiChart({ agent, chartType: chartType === 'area' ? 'line' : chartType, title, labels, values, datasetLabel: 'Daily Views', tags: ['wikipedia', 'pageviews', p.article.toLowerCase()], description: `${days}-day pageview trend for "${p.article}". Total: ${values.reduce((s, v) => s + v, 0)}.`, fillArea: chartType === 'area' });
      } catch (err) {
        return { ok: false, summary: `chart_wikipedia failed: ${err.message}` };
      }
    }

    case 'chart_itunes': {
      const p = decision.params || {};
      if (!p.term) return { ok: false, summary: 'term is required.' };
      const entity = p.entity || 'album';
      const metric = p.metric || 'trackCount';
      const limit = Math.min(Math.max(1, p.limit || 10), 25);
      const chartType = p.chartType || 'bar';

      try {
        const url = `https://itunes.apple.com/search?term=${encodeURIComponent(p.term)}&entity=${entity}&limit=${limit}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`iTunes API: ${res.status}`);
        const data = await res.json();
        const results = data.results || [];

        const labels = results.map(r => (r.collectionName || r.trackName || '').slice(0, 30));
        const values = results.map(r => r[metric] || 0);
        const metricLabels = { trackCount: 'Track Count', collectionPrice: 'Price (USD)' };
        const title = p.title || `iTunes Search: "${p.term}" — ${metricLabels[metric] || metric}`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: metricLabels[metric] || metric, tags: ['itunes', 'media', entity], description: `${chartType} chart of ${results.length} ${entity}s matching "${p.term}".` });
      } catch (err) {
        return { ok: false, summary: `chart_itunes failed: ${err.message}` };
      }
    }

    case 'chart_fruits': {
      const p = decision.params || {};
      const metric = p.metric || 'calories';
      const limit = Math.min(Math.max(1, p.limit || 15), 30);
      const chartType = p.chartType || 'bar';

      try {
        const res = await fetch('https://www.fruityvice.com/api/fruit/all', { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Fruityvice API: ${res.status}`);
        let fruits = await res.json();
        fruits.sort((a, b) => (b.nutritions?.[metric] || 0) - (a.nutritions?.[metric] || 0));
        fruits = fruits.slice(0, limit);

        const labels = fruits.map(f => f.name);
        const values = fruits.map(f => f.nutritions?.[metric] || 0);
        const metricLabels = { calories: 'Calories', fat: 'Fat (g)', sugar: 'Sugar (g)', carbohydrates: 'Carbs (g)', protein: 'Protein (g)' };
        const title = p.title || `Fruit Comparison — ${metricLabels[metric] || metric}`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: metricLabels[metric] || metric, tags: ['fruits', 'nutrition', 'food'], description: `${chartType} chart of ${labels.length} fruits by ${metric}.` });
      } catch (err) {
        return { ok: false, summary: `chart_fruits failed: ${err.message}` };
      }
    }

    case 'chart_meals': {
      const p = decision.params || {};
      const chartType = p.chartType || 'pie';

      try {
        const catRes = await fetch('https://www.themealdb.com/api/json/v1/1/categories.php', { signal: AbortSignal.timeout(10000) });
        if (!catRes.ok) throw new Error(`MealDB API: ${catRes.status}`);
        const catData = await catRes.json();
        const categories = catData.categories || [];

        // Get meal count per category
        const counts = await Promise.all(categories.map(async c => {
          try {
            const r = await fetch(`https://www.themealdb.com/api/json/v1/1/filter.php?c=${encodeURIComponent(c.strCategory)}`, { signal: AbortSignal.timeout(8000) });
            const d = await r.json();
            return { name: c.strCategory, count: d.meals?.length || 0 };
          } catch { return { name: c.strCategory, count: 0 }; }
        }));

        counts.sort((a, b) => b.count - a.count);
        const labels = counts.map(c => c.name);
        const values = counts.map(c => c.count);
        const title = p.title || 'Meals by Category (TheMealDB)';
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: 'Recipes', tags: ['food', 'meals', 'recipes'], description: `${labels.length} meal categories with ${values.reduce((s, v) => s + v, 0)} total recipes.` });
      } catch (err) {
        return { ok: false, summary: `chart_meals failed: ${err.message}` };
      }
    }

    case 'chart_cocktails': {
      const p = decision.params || {};
      const chartType = p.chartType || 'bar';

      try {
        const catRes = await fetch('https://www.thecocktaildb.com/api/json/v1/1/list.php?c=list', { signal: AbortSignal.timeout(10000) });
        if (!catRes.ok) throw new Error(`CocktailDB API: ${catRes.status}`);
        const catData = await catRes.json();
        const categories = catData.drinks || [];

        const counts = await Promise.all(categories.map(async c => {
          try {
            const r = await fetch(`https://www.thecocktaildb.com/api/json/v1/1/filter.php?c=${encodeURIComponent(c.strCategory)}`, { signal: AbortSignal.timeout(8000) });
            const d = await r.json();
            return { name: c.strCategory, count: d.drinks?.length || 0 };
          } catch { return { name: c.strCategory, count: 0 }; }
        }));

        counts.sort((a, b) => b.count - a.count);
        const labels = counts.map(c => c.name);
        const values = counts.map(c => c.count);
        const title = p.title || 'Cocktails by Category';
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: 'Cocktails', tags: ['drinks', 'cocktails', 'food'], description: `${labels.length} cocktail categories with ${values.reduce((s, v) => s + v, 0)} total drinks.` });
      } catch (err) {
        return { ok: false, summary: `chart_cocktails failed: ${err.message}` };
      }
    }

    case 'chart_universities': {
      const p = decision.params || {};
      const country = p.country;
      const limit = Math.min(Math.max(1, p.limit || 15), 30);
      const chartType = p.chartType || 'bar';

      try {
        const url = country
          ? `http://universities.hipolabs.com/search?country=${encodeURIComponent(country)}`
          : 'http://universities.hipolabs.com/search';
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Universities API: ${res.status}`);
        const unis = await res.json();

        if (country) {
          // Show first N universities from that country
          const subset = unis.slice(0, limit);
          const labels = subset.map(u => (u.name || '').slice(0, 30));
          const values = subset.map(() => 1);
          const title = p.title || `Universities in ${country} (showing ${subset.length} of ${unis.length})`;
          return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: 'Count', tags: ['education', 'universities', country.toLowerCase()], description: `${unis.length} universities found in ${country}.` });
        } else {
          const byCountry = {};
          for (const u of unis) byCountry[u.country] = (byCountry[u.country] || 0) + 1;
          const sorted = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, limit);
          const labels = sorted.map(e => e[0]);
          const values = sorted.map(e => e[1]);
          const title = p.title || `Top ${limit} Countries by University Count`;
          return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: 'Universities', tags: ['education', 'universities', 'global'], description: `Top ${labels.length} countries by number of universities.` });
        }
      } catch (err) {
        return { ok: false, summary: `chart_universities failed: ${err.message}` };
      }
    }

    case 'chart_breweries': {
      const p = decision.params || {};
      const metric = p.metric || 'brewery_type';
      const limit = Math.min(Math.max(1, p.limit || 15), 50);
      const chartType = p.chartType || 'bar';
      const state = p.state;

      try {
        const url = state
          ? `https://api.openbrewerydb.org/v1/breweries?by_state=${encodeURIComponent(state)}&per_page=200`
          : `https://api.openbrewerydb.org/v1/breweries?per_page=200`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Open Brewery API: ${res.status}`);
        const breweries = await res.json();

        const grouped = {};
        for (const b of breweries) {
          const key = b[metric] || 'unknown';
          grouped[key] = (grouped[key] || 0) + 1;
        }
        const sorted = Object.entries(grouped).sort((a, b) => b[1] - a[1]).slice(0, limit);
        const labels = sorted.map(e => e[0]);
        const values = sorted.map(e => e[1]);
        const title = p.title || `Breweries by ${metric}${state ? ` (${state})` : ''}`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: 'Breweries', tags: ['breweries', 'drinks', metric], description: `${breweries.length} breweries grouped by ${metric}.` });
      } catch (err) {
        return { ok: false, summary: `chart_breweries failed: ${err.message}` };
      }
    }

    case 'chart_nobel': {
      const p = decision.params || {};
      const metric = p.metric || 'category';
      const chartType = p.chartType || 'bar';

      try {
        const res = await fetch('https://api.nobelprize.org/2.1/laureates?limit=1000', { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Nobel API: ${res.status}`);
        const data = await res.json();
        const laureates = data.laureates || [];

        let labels, values, datasetLabel, title, desc;
        if (metric === 'decade') {
          const byDecade = {};
          for (const l of laureates) {
            for (const p of (l.nobelPrizes || [])) {
              const year = parseInt(p.awardYear);
              if (!year) continue;
              const decade = `${Math.floor(year / 10) * 10}s`;
              byDecade[decade] = (byDecade[decade] || 0) + 1;
            }
          }
          const sorted = Object.entries(byDecade).sort((a, b) => a[0].localeCompare(b[0]));
          labels = sorted.map(e => e[0]);
          values = sorted.map(e => e[1]);
          datasetLabel = 'Laureates';
          title = p.title || 'Nobel Laureates by Decade';
          desc = `Nobel prize laureates per decade.`;
        } else if (metric === 'country') {
          const byCountry = {};
          for (const l of laureates) {
            const country = l.birth?.place?.country?.en || 'Unknown';
            byCountry[country] = (byCountry[country] || 0) + 1;
          }
          const sorted = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 20);
          labels = sorted.map(e => e[0]);
          values = sorted.map(e => e[1]);
          datasetLabel = 'Laureates';
          title = p.title || 'Nobel Laureates by Birth Country';
          desc = `Top ${labels.length} countries by Nobel laureates.`;
        } else {
          const byCat = {};
          for (const l of laureates) {
            for (const pr of (l.nobelPrizes || [])) {
              const cat = pr.category?.en || 'Unknown';
              byCat[cat] = (byCat[cat] || 0) + 1;
            }
          }
          const sorted = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
          labels = sorted.map(e => e[0]);
          values = sorted.map(e => e[1]);
          datasetLabel = 'Prizes';
          title = p.title || 'Nobel Prizes by Category';
          desc = `Nobel prizes distributed across ${labels.length} categories.`;
        }
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel, tags: ['nobel', 'science', 'history'], description: desc });
      } catch (err) {
        return { ok: false, summary: `chart_nobel failed: ${err.message}` };
      }
    }

    case 'chart_pokemon': {
      const p = decision.params || {};
      const pokemonNames = (p.pokemon || 'pikachu,charizard,mewtwo,gengar,snorlax').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const chartType = p.chartType || 'radar';

      try {
        const pokemonData = await Promise.all(pokemonNames.map(async name => {
          const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${name}`, { signal: AbortSignal.timeout(10000) });
          if (!res.ok) return null;
          return res.json();
        }));
        const valid = pokemonData.filter(Boolean);
        if (valid.length === 0) return { ok: false, summary: 'No valid Pokemon found.' };

        const statNames = valid[0].stats.map(s => s.stat.name);
        const datasets = valid.map(pk => ({
          label: pk.name.charAt(0).toUpperCase() + pk.name.slice(1),
          data: pk.stats.map(s => s.base_stat)
        }));
        const title = p.title || `Pokemon Stats Comparison`;
        return await saveDataApiChartRaw({ agent, chartType, title, data: { labels: statNames, datasets }, tags: ['pokemon', 'gaming', 'stats'], description: `Stat comparison for ${valid.map(v => v.name).join(', ')}.` });
      } catch (err) {
        return { ok: false, summary: `chart_pokemon failed: ${err.message}` };
      }
    }

    case 'chart_trivia': {
      const p = decision.params || {};
      const chartType = p.chartType || 'bar';

      try {
        const res = await fetch('https://opentdb.com/api_count_global.php', { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`Open Trivia API: ${res.status}`);
        const data = await res.json();
        const cats = data.categories || {};

        const labels = [];
        const values = [];
        for (const [id, info] of Object.entries(cats)) {
          labels.push(`Cat ${id}`);
          values.push(info.total_num_of_questions || 0);
        }
        // Sort descending
        const pairs = labels.map((l, i) => [l, values[i]]).sort((a, b) => b[1] - a[1]).slice(0, 20);
        const title = p.title || 'Trivia Question Count by Category';
        return await saveDataApiChart({ agent, chartType, title, labels: pairs.map(e => e[0]), values: pairs.map(e => e[1]), datasetLabel: 'Questions', tags: ['trivia', 'education', 'entertainment'], description: `Question counts across ${pairs.length} trivia categories.` });
      } catch (err) {
        return { ok: false, summary: `chart_trivia failed: ${err.message}` };
      }
    }

    case 'chart_books': {
      const p = decision.params || {};
      if (!p.query) return { ok: false, summary: 'query is required.' };
      const metric = p.metric || 'edition_count';
      const limit = Math.min(Math.max(1, p.limit || 10), 25);
      const chartType = p.chartType || 'bar';

      try {
        const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(p.query)}&limit=${limit}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Open Library API: ${res.status}`);
        const data = await res.json();
        const docs = (data.docs || []).filter(d => d.title && d[metric]);

        docs.sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
        const books = docs.slice(0, limit);
        const labels = books.map(b => (b.title || '').slice(0, 30));
        const values = books.map(b => b[metric] || 0);
        const metricLabels = { edition_count: 'Editions', first_publish_year: 'First Published', number_of_pages_median: 'Pages (median)' };
        const title = p.title || `Books: "${p.query}" — ${metricLabels[metric] || metric}`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: metricLabels[metric] || metric, tags: ['books', 'literature', p.query.toLowerCase()], description: `${chartType} chart of ${books.length} books matching "${p.query}" by ${metric}.` });
      } catch (err) {
        return { ok: false, summary: `chart_books failed: ${err.message}` };
      }
    }

    case 'chart_anime': {
      const p = decision.params || {};
      const metric = p.metric || 'score';
      const limit = Math.min(Math.max(1, p.limit || 15), 25);
      const chartType = p.chartType || 'bar';

      try {
        const res = await fetch(`https://api.jikan.moe/v4/top/anime?limit=${limit}`, { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Jikan API: ${res.status}`);
        const data = await res.json();
        const anime = data.data || [];

        const labels = anime.map(a => (a.title || '').slice(0, 25));
        const values = anime.map(a => a[metric] || 0);
        const metricLabels = { score: 'Score', members: 'Members', episodes: 'Episodes', favorites: 'Favorites' };
        const title = p.title || `Top Anime — ${metricLabels[metric] || metric}`;
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel: metricLabels[metric] || metric, tags: ['anime', 'entertainment', 'media'], description: `Top ${labels.length} anime by ${metric}.` });
      } catch (err) {
        return { ok: false, summary: `chart_anime failed: ${err.message}` };
      }
    }

    case 'chart_tvshows': {
      const p = decision.params || {};
      const metric = p.metric || 'rating';
      const limit = Math.min(Math.max(1, p.limit || 20), 50);
      const chartType = p.chartType || 'bar';

      try {
        const res = await fetch('https://api.tvmaze.com/shows', { headers: { 'User-Agent': 'SoupPlatform/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`TVMaze API: ${res.status}`);
        const shows = await res.json();

        let labels, values, datasetLabel, title, desc;
        if (metric === 'by_genre') {
          const byGenre = {};
          for (const s of shows) for (const g of (s.genres || [])) byGenre[g] = (byGenre[g] || 0) + 1;
          const sorted = Object.entries(byGenre).sort((a, b) => b[1] - a[1]).slice(0, limit);
          labels = sorted.map(e => e[0]);
          values = sorted.map(e => e[1]);
          datasetLabel = 'Shows';
          title = p.title || 'TV Shows by Genre';
          desc = `Distribution of ${shows.length} shows across genres.`;
        } else if (metric === 'by_status') {
          const byStatus = {};
          for (const s of shows) byStatus[s.status || 'Unknown'] = (byStatus[s.status || 'Unknown'] || 0) + 1;
          const sorted = Object.entries(byStatus).sort((a, b) => b[1] - a[1]);
          labels = sorted.map(e => e[0]);
          values = sorted.map(e => e[1]);
          datasetLabel = 'Shows';
          title = p.title || 'TV Shows by Status';
          desc = `Status distribution of ${shows.length} shows.`;
        } else if (metric === 'runtime') {
          const withRuntime = shows.filter(s => s.runtime && s.name).sort((a, b) => b.runtime - a.runtime).slice(0, limit);
          labels = withRuntime.map(s => (s.name || '').slice(0, 25));
          values = withRuntime.map(s => s.runtime);
          datasetLabel = 'Runtime (min)';
          title = p.title || `TV Shows — Runtime`;
          desc = `Top ${labels.length} shows by runtime.`;
        } else {
          const withRating = shows.filter(s => s.rating?.average && s.name).sort((a, b) => (b.rating?.average || 0) - (a.rating?.average || 0)).slice(0, limit);
          labels = withRating.map(s => (s.name || '').slice(0, 25));
          values = withRating.map(s => s.rating?.average || 0);
          datasetLabel = 'Rating';
          title = p.title || `Top TV Shows by Rating`;
          desc = `Top ${labels.length} rated TV shows.`;
        }
        return await saveDataApiChart({ agent, chartType, title, labels, values, datasetLabel, tags: ['tv', 'entertainment', 'media'], description: desc });
      } catch (err) {
        return { ok: false, summary: `chart_tvshows failed: ${err.message}` };
      }
    }

    case 'compress_history': {
      const apiKey = process.env.AGENT_LLM_API_KEY;
      if (!apiKey) return { ok: false, summary: 'No LLM API key configured for compression.' };

      // Build the full current history text
      const historyLines = [];
      let lastPhase = null;
      for (const step of runState.steps) {
        if (step.phase !== lastPhase) { historyLines.push(`\n=== Phase: ${step.phase} ===`); lastPhase = step.phase; }
        const params = Object.entries(step.params || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
        historyLines.push(`${step.action}(${params}): ${step.result?.summary || 'ok'}`);
        if (step.result?.article?.url) historyLines.push(`  article: ${step.result.article.url}`);
        if (step.result?.article?.text) historyLines.push(`  content: ${step.result.article.text.slice(0, 500)}`);
        if (step.result?.viewed?.title) historyLines.push(`  post: "${step.result.viewed.title}" by ${step.result.viewed.authorName}`);
        if (step.result?.viewed?.text) historyLines.push(`  text: ${step.result.viewed.text}`);
        if (step.result?.profile) historyLines.push(`  profile: ${step.result.profile.name} — ${step.result.profile.bio || ''}`);
        if (step.result?.references) {
          for (const ref of step.result.references.slice(0, 5)) {
            historyLines.push(`  ref: "${ref.title}" ${ref.url || ''}`);
            if (ref.snippet) historyLines.push(`    ${ref.snippet}`);
          }
        }
        if (step.result?.localUrl) historyLines.push(`  saved: ${step.result.localUrl} — ${step.result.description || ''}`);
        if (step.result?.files) {
          for (const f of step.result.files) historyLines.push(`  file: ${f.url || f.localUrl} — ${f.description || ''}`);
        }
        if (step.result?.content?.text && (step.action === 'comment' || step.action === 'repost')) {
          historyLines.push(`  my text: ${step.result.content.text}`);
        }
      }
      const historyText = historyLines.join('\n');

      try {
        const res = await fetch(process.env.AGENT_LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{
              role: 'user',
              content: `Compress the following agent action history into a concise summary.\n\nMUST preserve:\n- All article/page URLs read\n- All YouTube video URLs found (with titles)\n- All saved image/file paths (localUrl)\n- All post IDs viewed or interacted with\n- Key facts, findings, and opinions formed\n- People/profiles discovered and their relevance\n- Any data or numbers referenced\n- Comments the agent wrote\n\nMUST summarize (do NOT keep full text):\n- Article content: condense to 1-3 sentence summary of key points\n- Post text: condense to 1 sentence capturing the main idea\n- Profile bios: condense to a few key words\n- Search result snippets: keep only the most relevant detail\n\nMUST remove:\n- Failed actions and searches with 0 results\n- Redundant searches for the same topic\n- Routine navigation (feed browsing, skipped posts)\n- Tool output formatting and boilerplate\n- Duplicate information\n\nHistory:\n${historyText}`
            }],
            max_tokens: 8000,
            temperature: 0
          }),
          signal: AbortSignal.timeout(30000)
        });
        if (!res.ok) return { ok: false, summary: `Compression failed: LLM API ${res.status}` };
        const data = await res.json();
        const compressed = data.choices?.[0]?.message?.content || '';
        if (!compressed) return { ok: false, summary: 'Compression returned empty result.' };

        runState.workingSet._compressedHistory = compressed;
        runState.workingSet._compressedAtStep = runState.steps.length;

        return { ok: true, summary: `History compressed. ${runState.steps.length} steps condensed. Future context will use the compressed version.` };
      } catch (err) {
        return { ok: false, summary: `Compression failed: ${err.message}` };
      }
    }

    case 'stop':
      return { ok: true, summary: 'Moving to next phase.', stop: true };

    default: {
      // Check if it's an MCP tool
      const mcpTools = runState.workingSet.mcpTools || [];
      const mcpTool = mcpTools.find(t => t.name === decision.action);
      if (mcpTool) {
        try {
          const result = await callMcpTool(mcpTool._mcpServer.url, decision.action, decision.params || {});
          return result;
        } catch (err) {
          return { ok: false, summary: `MCP tool failed: ${err.message}` };
        }
      }
      return { ok: false, summary: `Unsupported action: ${decision.action}` };
    }
  }
}

// ─── Main runtime ───────────────────────────────────────────────────────────────

export async function executeAgentRun(agent, trigger = 'scheduled') {
  const phaseMaxStepsCfg = agent.runConfig?.phaseMaxSteps || {};
  const phaseMaxSteps = {
    browse:          clamp(Number(phaseMaxStepsCfg.browse          ?? DEFAULT_PHASE_MAX_STEPS.browse),          1, 50),
    external_search: clamp(Number(phaseMaxStepsCfg.external_search ?? DEFAULT_PHASE_MAX_STEPS.external_search), 1, 50),
    create:          clamp(Number(phaseMaxStepsCfg.create          ?? DEFAULT_PHASE_MAX_STEPS.create),          1, 50)
  };

  // Ensure agent directories
  agentStorage.ensureAgentDirs(agent.id);

  const runState = {
    runId: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    startedAt: new Date().toISOString(),
    _agentId: agent.id,
    _agent: agent,
    steps: [],
    workingSet: {
      viewedContentIds: new Set(),
      viewedContents: [],
      viewedProfiles: [],
      knownUserIds: new Set(),
      lastSearchResults: null,
      externalReferences: [],
      followedThisRun: [],
      unfollowedThisRun: [],
      reactedThisRun: [],
      createdContentIds: [],
      savedFilesThisRun: [],
      travelLocation: null,
      lastActionResult: null,
      phase: 'browse'
    }
  };

  let totalSteps = 0;
  const runTokens = { input: 0, output: 0 };
  const totalMaxSteps = phaseMaxSteps.browse + phaseMaxSteps.external_search + phaseMaxSteps.create;
  const myRunId = runState.runId;
  const progressKey = `${agent.id}:${trigger}`;
  _runProgress.set(progressKey, { runId: myRunId, currentStep: 0, totalSteps: totalMaxSteps, phase: 'browse' });

  console.log(`[${agent.name}] Starting run ${runState.runId} with model ${getModelForAgent(agent)} (intelligence: ${agent.intelligenceLevel || 'not_so_smart'})`);

  try {
  for (const phase of PHASES) {
    runState.workingSet.phase = phase;
    const maxPhaseSteps = phaseMaxSteps[phase];
    _runProgress.set(progressKey, { runId: myRunId, currentStep: totalSteps, totalSteps: totalMaxSteps, phase });
    console.log(`[${agent.name}] Entering phase: ${phase} (max ${maxPhaseSteps} steps)`);

    // Discover MCP tools and data API chart tools before external_search phase
    if (phase === 'external_search') {
      const mcpServers = agentStorage.readMcpServers(agent.id);
      const mcpTools = [];
      for (const server of mcpServers) {
        try {
          const tools = await listMcpTools(server.url);
          for (const tool of tools) {
            mcpTools.push({ ...tool, _mcpServer: server });
          }
        } catch (err) {
          console.error(`[${agent.name}] Failed to list MCP tools from ${server.name}: ${err.message}`);
        }
      }
      runState.workingSet.mcpTools = mcpTools;
      if (mcpTools.length > 0) {
        console.log(`[${agent.name}] Discovered ${mcpTools.length} MCP tools from ${mcpServers.length} server(s)`);
      }

    }

    let retries = 0;
    const MAX_RETRIES = 2; // max consecutive failures before giving up on phase
    const phaseTokens = { input: 0, output: 0 };

    for (let phaseStep = 0; phaseStep < maxPhaseSteps; phaseStep += 1) {
      let llmResult = null;
      try {
        llmResult = await llmDecision(agent, phase, runState);
      } catch (err) {
        console.error(`[${agent.name}] ${phase} step ${phaseStep}: LLM call error:`, err.message);
        retries += 1;
        if (retries >= MAX_RETRIES) break;
        // Record the error so LLM sees it in context
        const errorStep = {
          stepIndex: totalSteps + 1,
          phase,
          action: 'error',
          reason: 'LLM call failed',
          params: {},
          decisionSource: 'system',
          result: { summary: `Error: ${err.message}. Please try again with a valid action for this phase.`, ok: false },
          at: new Date().toISOString()
        };
        runState.steps.push(errorStep);
        totalSteps += 1;
        _runProgress.set(progressKey, { runId: myRunId, currentStep: totalSteps, totalSteps: totalMaxSteps, phase });
        continue;
      }

      const rawLlm = llmResult?.decision;
      const stepTokens = llmResult?.tokenUsage || { input: 0, output: 0, total: 0 };

      // Track tokens
      phaseTokens.input += stepTokens.input;
      phaseTokens.output += stepTokens.output;
      runTokens.input += stepTokens.input;
      runTokens.output += stepTokens.output;

      if (stepTokens.input || stepTokens.output) {
        console.log(`[${agent.name}] ${phase} step ${phaseStep}: tokens in=${stepTokens.input} out=${stepTokens.output}`);
      }

      if (!rawLlm) {
        console.error(`[${agent.name}] ${phase} step ${phaseStep}: LLM returned null/empty — breaking out of phase`);
        break;
      }

      const mcpToolsForValidation = runState.workingSet.mcpTools || [];
      const validation = validateLlmDecisionSchema(rawLlm, phase, mcpToolsForValidation);
      if (!validation.ok) {
        console.log(`[${agent.name}] ${phase} step ${phaseStep}: validation failed:`, validation.errors, 'raw:', JSON.stringify(rawLlm).slice(0, 200));
        retries += 1;
        if (retries >= MAX_RETRIES) break;
        // Record the validation failure so LLM can correct itself
        const invalidAction = rawLlm.action || 'unknown';
        const validTools = [...getToolNamesForPhase(phase), ...mcpToolsForValidation.map(t => t.name)].join(', ');
        const errorDetail = validation.errors.join('; ');
        const validationStep = {
          stepIndex: totalSteps + 1,
          phase,
          action: invalidAction,
          reason: rawLlm.reason || '',
          params: rawLlm.params || {},
          decisionSource: 'system',
          result: { summary: `Validation error: ${errorDetail}. Valid actions for ${phase} phase: ${validTools}`, ok: false },
          at: new Date().toISOString()
        };
        runState.steps.push(validationStep);
        totalSteps += 1;
        _runProgress.set(progressKey, { runId: myRunId, currentStep: totalSteps, totalSteps: totalMaxSteps, phase });
        continue;
      }

      retries = 0; // reset on success
      const decision = validation.decision;
      let actionResult;
      try {
        actionResult = await executeAction(agent, decision, runState);
      } catch (execErr) {
        actionResult = { ok: false, summary: `Action failed: ${execErr.message}` };
      }
      runState.workingSet.lastActionResult = actionResult;

      totalSteps += 1;
      _runProgress.set(progressKey, { runId: myRunId, currentStep: totalSteps, totalSteps: totalMaxSteps, phase });
      const llmStep = {
        stepIndex: totalSteps,
        phase,
        action: decision.action,
        reason: decision.reason,
        params: decision.params || {},
        decisionSource: 'llm',
        tokenUsage: stepTokens,
        result: actionResult,
        at: new Date().toISOString()
      };
      runState.steps.push(llmStep);

      if (actionResult.stop) {
        break; // end current phase, move to next
      }

      // Stop create phase when agent has published enough posts for this run
      if (phase === 'create' && decision.action === 'publish_post' && actionResult.ok) {
        const maxPosts = Math.max(1, Number(agent.runConfig?.postsPerRun) || 1);
        if (runState.workingSet.createdContentIds.length >= maxPosts) {
          break;
        }
      }
    }

    console.log(`[${agent.name}] Phase ${phase} totals: tokens in=${phaseTokens.input} out=${phaseTokens.output}`);

    // If create phase ended with 0 published posts, auto-publish the most recent draft
    if (phase === 'create' && runState.workingSet.createdContentIds.length === 0) {
      const recentDraft = agentStorage.getMostRecentDraft(agent.id);
      if (recentDraft) {
        const autoDecision = { action: 'publish_post', reason: 'Auto-publishing most recent draft (must publish at least 1 post per run).', params: { draftId: recentDraft.id } };
        const autoResult = await executeAction(agent, autoDecision, runState);
        runState.workingSet.lastActionResult = autoResult;
        totalSteps += 1;
        _runProgress.set(progressKey, { runId: myRunId, currentStep: totalSteps, totalSteps: totalMaxSteps, phase });
        runState.steps.push({
          stepIndex: totalSteps, phase, action: 'publish_post',
          reason: autoDecision.reason, params: { draftId: recentDraft.id },
          decisionSource: 'auto', result: autoResult, at: new Date().toISOString()
        });
      }
    }
  }
  } finally {
    // Only clean up if progress still belongs to THIS run (not a newer one)
    const current = _runProgress.get(progressKey);
    if (current && current.runId === myRunId) {
      _runProgress.delete(progressKey);
    }
  }

  // Charge by actual steps after run completes
  db.chargeByActualSteps(agent.id, runState.steps.length, 'agent_run');

  const finishedAt = new Date().toISOString();
  const elapsed = ((new Date(finishedAt) - new Date(runState.startedAt)) / 1000).toFixed(1);
  console.log(`[${agent.name}] Run ${runState.runId} finished: ${runState.steps.length} steps in ${elapsed}s | tokens in=${runTokens.input} out=${runTokens.output} total=${runTokens.input + runTokens.output}`);

  db.recordAgentRunLog({
    agentId: agent.id,
    activenessLevel: agent.activenessLevel,
    startedAt: runState.startedAt,
    finishedAt,
    stepsExecuted: runState.steps.length,
    steps: runState.steps,
    contextSnapshot: {
      preferences: agent.preferences
    }
  });

  return {
    runId: runState.runId,
    stepsExecuted: runState.steps.length,
    totalMaxSteps: totalMaxSteps,
    stoppedByLimit: false
  };
}

export function previewAgentContext(agentId) {
  const agent = db.getAgent(agentId);
  if (!agent) throw new Error('Agent not found.');

  const toolsByPhase = {};
  for (const phase of PHASES) {
    toolsByPhase[phase] = getToolNamesForPhase(phase);
  }

  return {
    agent: {
      id: agent.id,
      name: agent.name,
      bio: agent.bio,
      preferences: agent.preferences,
      runConfig: agent.runConfig
    },
    phases: PHASES,
    toolsByPhase,
    sampleSystemPrompt: buildSystemPrompt(agent, 'browse')
  };
}
