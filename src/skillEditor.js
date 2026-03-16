import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatToolsForPrompt } from './toolRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = path.join(__dirname, '..', 'data', 'skill-editor');
const MEMORY_PATH = path.join(MEMORY_DIR, 'memory.md');

// ─── Memory helpers ──────────────────────────────────────────────────────────

function readMemory() {
  if (!fs.existsSync(MEMORY_PATH)) return '';
  return fs.readFileSync(MEMORY_PATH, 'utf8');
}

function writeMemory(content) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_PATH, content, 'utf8');
}

// ─── Phase descriptions ──────────────────────────────────────────────────────

const PHASE_DESCRIPTIONS = {
  browse: 'The agent browses its feed, explores the global feed, searches for topics, discovers new creators, engages with content, and can analyze engagement patterns to learn what works.',
  external_search: 'The agent searches external sources (news, articles, papers, forums) for reference material related to its topics, and can analyze engagement patterns on posts.',
  create: 'The agent drafts a post inspired by what it saw, optionally generates media (image/video), edits the draft, then publishes.'
};

// ─── System prompt builder ───────────────────────────────────────────────────

function buildSystemPrompt(phase, skillContent) {
  const phaseDesc = PHASE_DESCRIPTIONS[phase] || phase;
  const memory = readMemory();

  return `You are a skill-file editing assistant for the Soup platform.

## Current phase: ${phase}
${phaseDesc}

## Current skill file content
\`\`\`
${skillContent}
\`\`\`

${memory ? `## Your persistent memory\n${memory}\n` : ''}
## Available tools
- read_skill — Read the current skill file content (no params)
- edit_skill — Replace the skill file content (params: { "content": "<new content>" })
- get_phase_tools — Get the list of native tools available to the agent in this phase (no params)
- update_memory — Append a lesson to your persistent memory (params: { "lesson": "<lesson text>" })
- respond — Send a text response to the user (params: { "message": "<response text>" })

## Constraints
- You may ONLY help with editing the current phase's skill file ("${phase}").
- Refuse any questions or requests unrelated to this skill file.
- When editing, preserve the overall markdown structure unless the user asks to change it.
- Always use "respond" to communicate with the user.
- When the user asks what the agent can do, what tools are available, or about agent capabilities in this phase, use "get_phase_tools" first to get the actual tool list, then respond with a helpful summary.

## Output format
You MUST return exactly one JSON object:
{"action": "<tool_name>", "reason": "<short explanation>", "params": {...}}`;
}

// ─── LLM call ────────────────────────────────────────────────────────────────

async function callLLM(messages) {
  const endpoint = process.env.AGENT_LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
  const apiKey = process.env.AGENT_LLM_API_KEY;
  if (!apiKey) throw new Error('AGENT_LLM_API_KEY is not set');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.AGENT_LLM_MODEL || 'gpt-4o-mini',
      messages,
      temperature: 0.7,
      max_completion_tokens: 4096,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`LLM API error ${response.status}: ${errBody.slice(0, 500)}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    console.error('[SkillEditor] LLM returned no content:', JSON.stringify(payload).slice(0, 500));
    return null;
  }

  try {
    return JSON.parse(content);
  } catch (e) {
    console.error('[SkillEditor] Failed to parse LLM JSON:', content.slice(0, 500));
    return null;
  }
}

// ─── Agent loop ──────────────────────────────────────────────────────────────

async function runSkillEditorChat(phase, skillContent, userMessage) {
  const systemPrompt = buildSystemPrompt(phase, skillContent);
  const steps = [];
  let currentSkillContent = skillContent;
  let responseMessage = "I wasn't able to generate a response. Please try again.";
  let didEdit = false;

  for (let i = 0; i < 5; i++) {
    // Build trajectory text
    let trajectoryText = '';
    if (steps.length > 0) {
      trajectoryText = '\n\nPrevious steps in this conversation:\n' +
        steps.map((s, idx) => `Step ${idx + 1}: action=${s.action}, reason=${s.reason}\nResult: ${JSON.stringify(s.result)}`).join('\n');
    }

    const userContent = `User message: ${userMessage}${trajectoryText}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];

    let decision;
    try {
      decision = await callLLM(messages);
    } catch (err) {
      console.error('[SkillEditor] LLM call failed:', err.message);
      responseMessage = 'LLM call failed: ' + err.message;
      break;
    }
    if (!decision || !decision.action) {
      console.error('[SkillEditor] No valid decision from LLM:', JSON.stringify(decision));
      break;
    }

    const { action, reason, params } = decision;
    let result;

    switch (action) {
      case 'read_skill':
        result = { ok: true, summary: 'Current skill content', content: currentSkillContent };
        break;

      case 'edit_skill':
        if (params?.content != null) {
          currentSkillContent = params.content;
          didEdit = true;
          result = { ok: true, summary: 'Skill updated' };
        } else {
          result = { ok: false, summary: 'Missing content parameter' };
        }
        break;

      case 'get_phase_tools':
        result = { ok: true, summary: `Tools for ${phase} phase`, tools: formatToolsForPrompt(phase) };
        break;

      case 'update_memory': {
        if (params?.lesson) {
          const existing = readMemory();
          const updated = existing ? existing + '\n- ' + params.lesson : '- ' + params.lesson;
          writeMemory(updated);
          result = { ok: true, summary: 'Memory updated' };
        } else {
          result = { ok: false, summary: 'Missing lesson parameter' };
        }
        break;
      }

      case 'respond':
        responseMessage = params?.message || responseMessage;
        return {
          message: responseMessage,
          editedContent: didEdit ? currentSkillContent : null
        };

      default:
        result = { ok: false, summary: `Unknown action: ${action}` };
        break;
    }

    steps.push({ action, reason, result });
  }

  return {
    message: responseMessage,
    editedContent: didEdit ? currentSkillContent : null
  };
}

export { runSkillEditorChat };
