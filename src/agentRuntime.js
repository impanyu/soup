import { db } from './db.js';
import { EXTERNAL_SOURCES, fetchSource, fetchRssSource, fetchApiSource, getSourceById, getSourcesForTopics, TOPICS } from './externalSources.js';
import { renderChart } from './chartRenderer.js';
import { getByPath } from './sourceFetcher.js';
import * as mediaStorage from './mediaStorage.js';
import { getToolsForPhase, getToolNamesForPhase, getTool, formatToolsForPrompt, formatToolListForPrompt } from './toolRegistry.js';
import { listMcpTools, callMcpTool } from './mcpClient.js';
import * as agentStorage from './agentStorage.js';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Skill file loader ─────────────────────────────────────────────────────────

const _skillCache = {};
function loadSkill(phase, agentId) {
  // Check per-agent override first
  if (agentId) {
    const override = agentStorage.readSkill(agentId, phase);
    if (override !== null) return override;
  }
  // Fall back to global (cached)
  if (!_skillCache[phase]) {
    try {
      _skillCache[phase] = readFileSync(join(__dirname, 'skills', `${phase}.md`), 'utf-8');
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

function shortContent(content) {
  const author = content.authorAgentId
    ? db.getAgent(content.authorAgentId)
    : null;
  let media = content.media;
  if (!Array.isArray(media) || media.length === 0) {
    media = (content.mediaUrl && content.mediaType !== 'text')
      ? [{ type: content.mediaType || 'image', url: content.mediaUrl, prompt: '', generationMode: 'text-to-image' }]
      : [];
  }
  return {
    id: content.id,
    authorAgentId: content.authorAgentId || null,
    authorUserId: content.authorUserId || null,
    authorName: author?.name || content.authorName || 'Unknown',
    title: content.title,
    text: (content.text || '').slice(0, 240),
    tags: content.tags || [],
    media,
    parentId: content.parentId || null,
    repostOfId: content.repostOfId || null,
    createdAt: content.createdAt
  };
}

function pickSummary(content) {
  return {
    id: content.id,
    summary: content.summary || '(no text)',
    tags: (content.tags || []).slice(0, 3),
    date: content.createdAt
  };
}

function shortProfile(agentOrUser) {
  return {
    id: agentOrUser.id,
    name: agentOrUser.name,
    bio: (agentOrUser.bio || '').slice(0, 200),
    kind: agentOrUser.kind || 'agent'
  };
}

// ─── Pagination helper ──────────────────────────────────────────────────────────

const PAGE_SIZE = 20;
function paginate(items, page = 1) {
  const p = Math.max(1, Math.floor(page));
  const start = (p - 1) * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);
  return { items: slice, page: p, totalPages: Math.ceil(items.length / PAGE_SIZE), totalItems: items.length, hasMore: start + PAGE_SIZE < items.length };
}

// ─── Phase definitions ──────────────────────────────────────────────────────────

const PHASES = ['browse', 'external_search', 'self_research', 'create'];

export const DEFAULT_PHASE_MAX_STEPS = {
  browse: 30,
  external_search: 20,
  self_research: 10,
  create: 20
};

// ─── Intelligence levels ─────────────────────────────────────────────────────────

export const INTELLIGENCE_LEVELS = {
  dumb:        { label: 'Dumb',        model: 'gpt-4o-nano',  description: 'Cheapest, fastest, least capable' },
  not_so_smart: { label: 'Not So Smart', model: 'gpt-5-mini', description: 'Budget-friendly, decent quality' },
  mediocre:    { label: 'Mediocre',    model: 'gpt-5.2',      description: 'Good all-rounder, balanced cost/quality' },
  smart:       { label: 'Smart',       model: 'gpt-5.4',      description: 'Most capable, highest cost' }
};

function getModelForAgent(agent) {
  const level = agent.intelligenceLevel || 'mediocre';
  const profile = INTELLIGENCE_LEVELS[level];
  return profile ? profile.model : (process.env.AGENT_LLM_MODEL || 'gpt-5.2');
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
    console.log(`[media] OpenAI generation failed: ${err.message}`);
    return {
      url: `https://example.com/mock-media/${generationMode}?prompt=${encodeURIComponent(prompt || 'agent-generated')}`,
      type: resultType,
      prompt: prompt || '',
      generationMode,
      mock: true
    };
  }
}

// ─── Recent Posts Summary (Dedup) ────────────────────────────────────────────────

function buildRecentPostsSummary(agentId) {
  const posts = db.getAgentPublished(agentId);
  if (!posts || posts.length === 0) return null;

  const recent = posts.slice(-10);
  const lines = ['=== YOUR RECENT POSTS (avoid duplicates) ==='];
  for (const p of recent) {
    const title = p.title || (p.text || '').slice(0, 60);
    const date = p.createdAt ? p.createdAt.slice(0, 10) : 'unknown';
    const tags = (p.tags || []).join(', ');
    lines.push(`  - "${title}" (${date}) [tags: ${tags}]`);
  }
  lines.push('=== END RECENT POSTS ===');
  return lines.join('\n');
}

// ─── Post Engagement Helper ──────────────────────────────────────────────────────

function getPostEngagement(postId) {
  const reactions = db.state.reactions.filter(r => r.contentId === postId);
  return {
    likes: reactions.filter(r => r.type === 'like').length,
    dislikes: reactions.filter(r => r.type === 'dislike').length,
    favorites: reactions.filter(r => r.type === 'favorite').length,
    comments: db.getChildren(postId).filter(c => !c.repostOfId).length,
    reposts: db.state.contents.filter(c => c.repostOfId === postId).length
  };
}

// ─── Action/Result Memory ───────────────────────────────────────────────────────

function buildStepMessages(runState, phase) {
  // Build a single user message containing the full action/result history + current phase prompt.
  // This avoids multi-turn alternation issues and keeps context clear.
  const historyLines = [];
  let lastPhase = null;
  for (const step of runState.steps) {
    if (step.phase !== lastPhase) {
      historyLines.push(`\n=== Phase: ${step.phase} ===`);
      lastPhase = step.phase;
    }
    const params = Object.entries(step.params || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
    historyLines.push(`> Action: ${step.action}(${params})`);
    if (step.reason) historyLines.push(`  Reason: ${step.reason}`);
    historyLines.push(`  Result: ${step.result?.summary || 'ok'}`);
    // Include key details from result
    if (step.result?.posts) {
      const postList = step.result.posts.slice(0, 10).map(p =>
        `    - [${p.id}] "${(p.title || p.text || '').slice(0, 60)}" by ${p.authorName} (tags: ${(p.tags || []).join(', ')})`
      ).join('\n');
      historyLines.push(postList);
    }
    if (step.result?.viewed) {
      const v = step.result.viewed;
      historyLines.push(`    Post: "${v.title}" by ${v.authorName}`);
      historyLines.push(`    Text: ${(v.text || '').slice(0, 200)}`);
      historyLines.push(`    Tags: ${(v.tags || []).join(', ')}`);
      if (v.media?.length) historyLines.push(`    Media: ${v.media.map(m => m.url).join(', ')}`);
    }
    if (step.result?.profile) {
      const pr = step.result.profile;
      historyLines.push(`    Profile: ${pr.name} — ${(pr.bio || '').slice(0, 100)}`);
    }
    if (step.result?.references) {
      for (const ref of step.result.references.slice(0, 5)) {
        historyLines.push(`    - "${ref.title}" (${ref.source}) ${ref.url || ''}`);
        if (ref.snippet) historyLines.push(`      ${ref.snippet.slice(0, 150)}`);
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
      historyLines.push(`    Content: ${step.result.article.text.slice(0, 500)}`);
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

  // Current phase prompt
  const phaseStepCount = runState.steps.filter(s => s.phase === phase).length;
  let prompt = `\n=== Phase: ${phase} | Step ${phaseStepCount + 1} ===\nChoose your next action.`;
  if (phase === 'create') {
    // Show files saved during this run — but only those not already used in previous posts
    const savedThisRun = runState.workingSet.savedFilesThisRun || [];
    const metadata = agentStorage.readFilesMetadata(runState._agentId);
    const unusedThisRun = savedThisRun.filter(f => {
      const fileMeta = metadata.files[f.filename];
      return !fileMeta || !fileMeta.usedInPostIds || fileMeta.usedInPostIds.length === 0;
    });
    if (unusedThisRun.length > 0) {
      prompt += `\nImages you saved this session that have NOT been used yet (use embed_image to attach to your post):`;
      for (const f of unusedThisRun) {
        prompt += `\n  - ${f.localUrl} — ${f.description || f.caption || 'no description'}`;
      }
    }
    if (savedThisRun.length > unusedThisRun.length) {
      prompt += `\n(${savedThisRun.length - unusedThisRun.length} image(s) saved this session were already used in previous posts — skipped.)`;
    }

    // Remind about media options — prioritize real images over AI generation
    if (!runState.workingSet.hasDraft) {
      if (unusedThisRun.length > 0) {
        prompt += `\nYou saved ${unusedThisRun.length} unused image(s) during research — use them in your post with embed_image. Real images from articles look more authentic than AI-generated ones.`;
      } else {
        prompt += `\nMedia tip: Use list_unused_media to find saved images you haven't used yet. Or try downloading a photo from an article (download_image), embedding a YouTube video (embed_video), or creating a chart from data (generate_chart). Only use generate_media as a last resort — and if you do, write a vivid scene-based prompt, not a generic "infographic about X".`;
      }
    }

    if (runState.workingSet.hasDraft) {
      const markdown = agentStorage.readDraft(runState._agentId);
      if (markdown) {
        const parsed = agentStorage.parseDraft(markdown, runState._agentId);
        prompt += `\nCurrent draft: title="${parsed.title}", tags=[${parsed.tags.join(', ')}], text="${(parsed.text || '').slice(0, 300)}", media=${parsed.media.length}/4`;
      }
    }
  }

  const historyBlock = historyLines.length > 0
    ? `Here is everything you did so far this session:\n${historyLines.join('\n')}`
    : '';

  // For create phase, prepend recent posts summary for dedup
  let recentPostsSummary = null;
  if (phase === 'create') {
    recentPostsSummary = buildRecentPostsSummary(runState._agentId);
  }

  const fullContent = [
    recentPostsSummary,
    historyBlock,
    prompt
  ].filter(Boolean).join('\n\n');

  return [{ role: 'user', content: fullContent }];
}

// ─── Build system prompt ────────────────────────────────────────────────────────

const PHASE_DESCRIPTIONS = {
  browse: 'You are browsing the platform — catching up on your feed, exploring new content, and discovering interesting people. Check what people you follow have been posting, browse the global feed, search for topics in YOUR interest areas, discover creators in YOUR domain. React to content that genuinely moves you, follow people whose content would enrich YOUR feed. Navigate naturally — from feed to posts to profiles to search results — guided by your curiosity and specific interests. Be unpredictable: some sessions you mostly catch up, some you mostly explore, some you do both.',
  external_search: 'You are researching external sources — news, articles, papers, forums. Start with list_sources to see sources recommended for YOUR topics. Focus on sources and articles relevant to your interests and expertise. As you read articles, actively save compelling images (photos, diagrams, charts) with save_media — these will make your post much stronger than AI-generated visuals. Also note any YouTube/Vimeo video URLs relevant to your topic. Build up knowledge for a post that only someone with your background and perspective could write.',
  self_research: 'You are analyzing what makes posts successful. Browse your own posts and popular posts by others. Compare engagement metrics — likes, favorites, comments, reposts — to find patterns in what works. Update your memory with actionable lessons for creating better posts. Be concise — rewrite your full memory each time, don\'t just append.',
  create: 'You are creating a post. Your topic can be inspired by anything from previous phases — browsing or external research — but it MUST fall within your configured topics/interests. If your topics are science and space, write about science and space, not about unrelated things you happened to see in the feed. Check your memory for lessons about what works, then draft, optionally add images or videos, and publish. Write like a real person with YOUR specific voice — direct, opinionated, no filler. Never start with "After browsing..." or "Here are my thoughts..." — just say what you want to say.'
};

export const TONE_PROFILES = {
  insightful: {
    personality: 'You are thoughtful and analytical. You connect dots others miss, surface non-obvious implications, and make people think.',
    length: 'medium-long (4-8 sentences)',
    writingStyle: 'rational and structured — build your argument step by step, connect evidence to conclusions, let the logic speak',
    format: 'itemized insights or numbered takeaways when connecting multiple ideas; a clean "observation → implication → question" arc for single-point posts'
  },
  witty: {
    personality: 'You are clever and humorous. Your observations are sharp but delivered with a light touch — you make serious points entertaining.',
    length: 'short (1-3 sentences)',
    writingStyle: 'punchy and clever — set up expectations then subvert them, use wordplay and irony, land the joke fast',
    format: 'one-liners or tight setup-punchline pairs; occasionally a short list of absurd observations'
  },
  provocative: {
    personality: 'You are bold and contrarian. You challenge assumptions head-on, take strong stances, and don\'t shy away from unpopular opinions.',
    length: 'medium (2-4 sentences)',
    writingStyle: 'direct and confrontational — state your controversial claim upfront, back it with one piece of evidence, drop the mic',
    format: 'bold opening claim followed by supporting evidence; "unpopular opinion" or "hot take" framing; direct challenges to conventional wisdom'
  },
  balanced: {
    personality: 'You are even-handed and fair. You consider multiple perspectives, acknowledge nuance, and help people see the full picture.',
    length: 'medium-long (3-6 sentences)',
    writingStyle: 'measured and fair — present multiple angles, acknowledge tradeoffs, avoid oversimplification',
    format: '"on one hand / on the other" structures; pros-and-cons breakdowns; "both sides get X right" framing'
  },
  enthusiastic: {
    personality: 'You are passionate and energetic. You get genuinely excited about your topics and that excitement is infectious in your writing.',
    length: 'medium (2-4 sentences)',
    writingStyle: 'energetic and excitable — let your genuine excitement show, use emphatic language, convey urgency and wonder',
    format: '"holy shit, look at this" reactions; excited breakdowns with rapid-fire bullet points; discovery-style reveals'
  },
  casual: {
    personality: 'You are relaxed and conversational. You write like you\'re chatting with a friend — informal, approachable, no pretense.',
    length: 'short (1-3 sentences)',
    writingStyle: 'loose and conversational — write like you text, no ceremony, keep it breezy and approachable',
    format: 'offhand observations; "random thought but..." openers; quick rhetorical questions; stream-of-consciousness vibes'
  },
  academic: {
    personality: 'You are precise and methodical. You cite sources, reason carefully, and value accuracy over flair.',
    length: 'long (4-10 sentences or 1-3 short paragraphs)',
    writingStyle: 'precise and evidence-based — cite specifics, reason carefully, distinguish correlation from causation, value accuracy over flair',
    format: 'structured with clear claims and supporting evidence; "new paper shows X" summaries; methodology critiques; data tables or bullet-pointed findings'
  },
  sarcastic: {
    personality: 'You have a dry, ironic wit. Your humor is deadpan and your commentary is delivered with a knowing wink.',
    length: 'short (1-2 sentences)',
    writingStyle: 'deadpan and dry — state the absurd as if it were obvious, use fake sincerity, let the reader catch the irony',
    format: 'dry one-liners; mock-serious observations; stating the obvious to highlight the absurd; slow-build setups with a dry punchline'
  },
  empathetic: {
    personality: 'You are warm and understanding. You connect with people emotionally and your writing makes others feel seen.',
    length: 'medium (2-5 sentences)',
    writingStyle: 'warm and human — lead with feeling, share vulnerability, reframe harsh takes with compassion',
    format: '"I felt this" reactions; personal reflections that invite connection; reframing technical topics through the human side; gentle questions'
  },
  minimalist: {
    personality: 'You are concise and direct. Every word earns its place — no fluff, no filler, just the point.',
    length: 'ultra-short (1-2 sentences)',
    writingStyle: 'stripped-down and direct — every word must earn its place, zero filler, maximum density of meaning',
    format: 'single declarative statements; a number and its implication; a question with no preamble; bare assertions'
  },
  storyteller: {
    personality: 'You are narrative-driven. You weave anecdotes, set scenes, and draw people in with compelling stories.',
    length: 'medium-long (3-7 sentences)',
    writingStyle: 'narrative-driven — set scenes, build tension, deliver payoffs, make the reader feel like they\'re there',
    format: 'micro-narratives with a twist; "picture this" openers; before/after contrasts; personal anecdotes that build to a point'
  },
  technical: {
    personality: 'You go deep on specs, benchmarks, and implementation details. Your audience expects precision and expertise.',
    length: 'medium-long (3-8 sentences)',
    writingStyle: 'precise and technical — use correct terminology, reference specific numbers and benchmarks, show your work',
    format: '"I tested X and found Y" results; architecture breakdowns with bullet points; performance comparisons; code-adjacent explanations with concrete examples'
  }
};

function buildExternalSourcesBlock(agent) {
  const configuredIds = (agent.preferences?.externalSearchSources || [])
    .map(s => typeof s === 'string' ? s : (s.source || s.id));
  if (configuredIds.length === 0) return '';

  const sources = configuredIds.map(id => getSourceById(id)).filter(Boolean);
  if (sources.length === 0) return '';

  const lines = ['\n## YOUR CONFIGURED EXTERNAL SOURCES\n'];
  lines.push('Use the source `id` as the `sourceId` parameter in these tools:');
  lines.push('- **get_new_rss** — browse latest headlines (sources with RSS)');
  lines.push('- **search_source** — search within a source by keyword (sources with Search)');
  lines.push('- **search_external** — search across multiple sources at once (pass IDs in `sources` param)');
  lines.push('- **fetch_data** — fetch structured/numeric data (Data API sources)');
  lines.push('');

  for (const s of sources) {
    const caps = [];
    if (s.rss) caps.push('get_new_rss');
    if (s.search) caps.push('search_source');
    if (s.dataApi || s.category === 'Data APIs') caps.push('fetch_data');
    lines.push(`- **${s.id}** — ${s.name} → usable with: ${caps.length > 0 ? caps.join(', ') : 'search_external'}`);
  }
  lines.push('');

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
  const allTools = mcpTools.length > 0 ? [...nativeTools, ...mcpTools] : nativeTools;
  const toolsBlock = formatToolListForPrompt(allTools);
  const skillBlock = loadSkill(phase, agent.id);

  const externalSourcesBlock = phase === 'external_search' ? buildExternalSourcesBlock(agent) : '';

  const postingStyleBlock = phase === 'create' ? `

## YOUR POSTING STYLE
- **Length**: ${toneProfile.length}
- **Writing style**: ${toneProfile.writingStyle}
- **Format**: ${toneProfile.format}

These are your defaults — follow them in general, but vary a little from post to post to stay fresh. Maybe go slightly shorter or longer, try a different format, open with a different hook. Same voice, slightly different shape each time. Check your recent posts and consciously avoid repeating the exact same structure.` : '';

  const memory = agentStorage.readMemory(agent.id);
  const memoryBlock = memory
    ? `\n## YOUR MEMORY\nThese are lessons you've learned from analyzing your past posts and engagement:\n${memory}\n`
    : '\n## YOUR MEMORY\nNo memories yet. You haven\'t analyzed your post performance yet.\n';

  return `You are ${agent.name}, a real person using a social media platform. You have genuine interests, opinions, and taste. You surf the platform the way a human does — sometimes deeply engaged, sometimes just skimming, always authentic.

${characteristics ? `## YOUR CHARACTERISTICS\n${characteristics}` : `## Who you are\n${bio ? bio + '\n' : ''}- Interests: ${topics}\n- Tone: ${tone} — ${toneProfile.personality}`}
${memoryBlock}
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

  const allowedTopKeys = new Set(['action', 'reason', 'params']);
  for (const key of Object.keys(raw)) {
    if (!allowedTopKeys.has(key)) {
      errors.push(`Unknown top-level field: ${key}`);
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
  if (isPlainObject(payload) && Array.isArray(payload.choices) && payload.choices[0]?.message?.content) {
    if (payload.choices[0].finish_reason === 'length') {
      console.error(`[LLM] Response truncated (finish_reason=length). Increase max_tokens.`);
      return null;
    }
    const content = payload.choices[0].message.content;
    if (typeof content === 'string') {
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
  const apiKey = process.env.AGENT_LLM_API_KEY;
  if (!apiKey) return null;

  const endpoint = process.env.AGENT_LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
  const model = getModelForAgent(agent);

  const mcpTools = runState.workingSet.mcpTools || [];
  const systemPrompt = buildSystemPrompt(agent, phase, mcpTools);
  const stepMessages = buildStepMessages(runState, phase);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...stepMessages
  ];

  const reasoningEffort = process.env.AGENT_LLM_REASONING_EFFORT || 'low';
  const requestBody = {
    model,
    messages,
    max_completion_tokens: 16384,
    reasoning_effort: reasoningEffort,
    response_format: { type: 'json_object' }
  };
  // Only set temperature when reasoning is off — reasoning models ignore/reject temperature
  if (reasoningEffort === 'none') {
    const temperature = process.env.AGENT_LLM_TEMPERATURE;
    if (temperature !== undefined && temperature !== '') {
      requestBody.temperature = Number(temperature);
    }
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

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

// ─── Execute action ─────────────────────────────────────────────────────────────

async function executeAction(agent, decision, runState) {
  switch (decision.action) {

    // ── Browse ──

    case 'browse_new_feed': {
      const allPosts = db.listFeed()
        .filter((c) => c.authorAgentId !== agent.id)
        .map(shortContent);
      const pg = paginate(allPosts, decision.params?.page);
      return { ok: true, summary: `Global feed page ${pg.page}/${pg.totalPages} (${pg.totalItems} total)`, posts: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    case 'browse_following_feed': {
      let allPosts = db.getPersonalizedFeed({ followerKind: 'agent', followerId: agent.id })
        .filter((c) => c.authorAgentId !== agent.id)
        .map(shortContent);
      let feedType = 'following';
      if (allPosts.length === 0) {
        allPosts = db.listFeed()
          .filter((c) => c.authorAgentId !== agent.id)
          .map(shortContent);
        feedType = 'global_fallback';
      }
      const pg = paginate(allPosts, decision.params?.page);
      return { ok: true, summary: `${feedType === 'following' ? 'Following' : 'Global'} feed page ${pg.page}/${pg.totalPages} (${pg.totalItems} total)`, posts: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore, feedType };
    }

    case 'browse_liked_posts': {
      const reactions = db.getActorReactions('agent', agent.id, 'like');
      const posts = reactions
        .map(r => db.state.contents.find(c => c.id === r.contentId))
        .filter(Boolean)
        .map(shortContent);
      const pg = paginate(posts, decision.params?.page);
      return { ok: true, summary: `Liked posts page ${pg.page}/${pg.totalPages} (${pg.totalItems} total)`, posts: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    case 'browse_favorite_posts': {
      const reactions = db.getActorReactions('agent', agent.id, 'favorite');
      const posts = reactions
        .map(r => db.state.contents.find(c => c.id === r.contentId))
        .filter(Boolean)
        .map(shortContent);
      const pg = paginate(posts, decision.params?.page);
      return { ok: true, summary: `Favorited posts page ${pg.page}/${pg.totalPages} (${pg.totalItems} total)`, posts: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    case 'browse_my_posts': {
      const posts = db.getAgentPublished(agent.id).map(shortContent);
      const pg = paginate(posts, decision.params?.page);
      return { ok: true, summary: `Your posts page ${pg.page}/${pg.totalPages} (${pg.totalItems} total)`, posts: pg.items, page: pg.page, totalPages: pg.totalPages, hasMore: pg.hasMore };
    }

    case 'browse_followers': {
      const followers = db.getAgentFollowers(agent.id).map(shortProfile);
      return { ok: true, summary: `You have ${followers.length} followers`, users: followers };
    }

    case 'browse_following': {
      const following = db.getAgentFollowing(agent.id).map(shortProfile);
      return { ok: true, summary: `You follow ${following.length} accounts`, users: following };
    }

    case 'browse_my_stats': {
      const stats = db.getAgentStats(agent.id);
      return { ok: true, summary: `Your stats: ${stats.posts} posts, ${stats.followers} followers, ${stats.following} following, ${stats.totalLikes} likes received`, stats };
    }

    case 'view_post': {
      const contentId = decision.params?.postId;
      const content = contentId ? db.state.contents.find((c) => c.id === contentId) : null;
      if (!content) return { ok: false, summary: 'Post not found. Provide a valid postId.' };

      db.recordView({ actorKind: 'agent', actorId: agent.id, targetKind: 'content', targetId: content.id });
      runState.workingSet.viewedContentIds.add(content.id);
      const sc = shortContent(content);
      runState.workingSet.viewedContents.push(sc);

      const children = db.getChildren(content.id).slice(0, 10).map(shortContent);
      const ancestors = db.getAncestors(content.id).map(shortContent);

      return { ok: true, summary: `Viewed post ${content.id}`, viewed: sc, children, ancestors };
    }

    case 'view_profile': {
      const targetId = decision.params?.targetId;
      const targetKind = decision.params?.targetKind || 'agent';

      if (!targetId) return { ok: false, summary: 'targetId is required for view_profile.' };

      const target = targetKind === 'user' ? db.getUser(targetId) : db.getAgent(targetId);
      if (!target) return { ok: false, summary: 'Target profile not found.' };

      db.recordView({ actorKind: 'agent', actorId: agent.id, targetKind, targetId: target.id });
      runState.workingSet.knownUserIds.add(target.id);

      const posts = (targetKind === 'user'
        ? db.getUserPublished(target.id)
        : db.getAgentPublished(target.id)
      ).slice(-5).map(shortContent);

      const profile = shortProfile(target);
      profile.kind = targetKind;
      runState.workingSet.viewedProfiles.push(profile);

      return { ok: true, summary: `Viewed profile of ${target.name}`, profile, posts };
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
      const discovered = result.agents.filter((a) => a.id !== agent.id).slice(0, 15);
      for (const a of discovered) {
        runState.workingSet.knownUserIds.add(a.id);
      }
      return { ok: true, summary: `Searched users for: ${query || 'all'}`, resultCount: discovered.length, users: discovered.map(shortProfile) };
    }

    // ── Reactions ──

    case 'like':
    case 'dislike':
    case 'favorite': {
      const contentId = decision.params?.postId;
      if (!contentId) return { ok: false, summary: 'postId is required for reaction.' };
      const content = db.state.contents.find((c) => c.id === contentId);
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
      const content = db.state.contents.find((c) => c.id === contentId);
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

      db.follow({ followerKind: 'agent', followerId: agent.id, followeeKind: targetKind, followeeId: targetId });
      runState.workingSet.knownUserIds.add(targetId);
      runState.workingSet.followedThisRun.push(targetId);
      const target = targetKind === 'user' ? db.getUser(targetId) : db.getAgent(targetId);
      return { ok: true, summary: `Followed ${targetKind} ${target?.name || targetId}` };
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

      const parentPost = db.state.contents.find((c) => c.id === parentId);
      if (!parentPost) return { ok: false, summary: 'Parent post not found.' };

      const text = decision.params?.textHint || 'Interesting post.';
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

      const originalPost = db.state.contents.find((c) => c.id === repostOfId);
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

      const post = db.state.contents.find((c) => c.id === postId);
      if (!post) return { ok: false, summary: 'Post not found.' };
      if (post.authorAgentId !== agent.id) return { ok: false, summary: 'Cannot delete posts by other authors.' };

      db.deleteContent(postId, 'agent', agent.id);
      return { ok: true, summary: `Deleted post ${postId}` };
    }

    // ── Draft workflow (disk-based) ──

    case 'draft_post': {
      const title = decision.params?.title || 'Untitled';
      const text = decision.params?.text || '';
      const paramTags = decision.params?.tags || [];
      // Extract #hashtags from text and merge with explicit tags
      const inlineTags = (text.match(/(?:^|[\s])#([\w-]+)/g) || []).map(m => m.trim().slice(1).toLowerCase());
      const tags = [...new Set([...paramTags, ...inlineTags, 'agent-generated'])];

      const markdown = agentStorage.draftToMarkdown({ title, tags, text, media: [] });
      agentStorage.writeDraft(agent.id, markdown);
      runState.workingSet.hasDraft = true;

      return { ok: true, summary: `Drafted post: "${title}"`, draft: { title, text: text.slice(0, 200), tags, mediaCount: 0 } };
    }

    case 'edit_draft': {
      const markdown = agentStorage.readDraft(agent.id);
      if (!markdown) return { ok: false, summary: 'No draft to edit. Use draft_post first.' };

      const parsed = agentStorage.parseDraft(markdown, agent.id);

      if (decision.params?.title) parsed.title = decision.params.title;
      if (decision.params?.text) parsed.text = decision.params.text;
      if (decision.params?.tags) parsed.tags = decision.params.tags;
      if (decision.params?.clearMedia) parsed.media = [];
      if (typeof decision.params?.removeMediaIndex === 'number') {
        parsed.media.splice(decision.params.removeMediaIndex, 1);
      }

      const updated = agentStorage.draftToMarkdown(parsed);
      agentStorage.writeDraft(agent.id, updated);

      return { ok: true, summary: `Edited draft`, draft: { title: parsed.title, text: parsed.text.slice(0, 200), tags: parsed.tags, mediaCount: parsed.media.length } };
    }

    case 'generate_media': {
      const markdown = agentStorage.readDraft(agent.id);
      if (!markdown) return { ok: false, summary: 'No draft to attach media to. Use draft_post first.' };

      const parsed = agentStorage.parseDraft(markdown, agent.id);
      if (parsed.media.length >= 4) return { ok: false, summary: 'Draft already has 4 media items (max).' };

      const prompt = decision.params?.prompt || `${parsed.title}: ${parsed.text.slice(0, 100)}`;
      const generationMode = decision.params?.generationMode || 'text-to-image';
      const sourceImageUrl = decision.params?.sourceImageUrl || '';
      const result = await generateMedia(prompt, { generationMode, sourceImageUrl });

      let mediaEntry = { type: result.type, url: result.url, origin: 'ai_generated', caption: prompt };
      if (!result.mock) {
        try {
          const stored = await mediaStorage.downloadAiMedia(result);
          mediaEntry.url = stored.localUrl;
        } catch {
          mediaEntry.origin = 'embedded';
        }
      }

      parsed.media.push(mediaEntry);
      const updated = agentStorage.draftToMarkdown(parsed);
      agentStorage.writeDraft(agent.id, updated);

      return { ok: true, summary: `Generated ${result.type} media via ${generationMode}${result.mock ? ' (mock)' : ''} [${parsed.media.length}/4]`, mediaUrl: mediaEntry.url, mock: result.mock };
    }

    case 'download_image': {
      const markdown = agentStorage.readDraft(agent.id);
      if (!markdown) return { ok: false, summary: 'No draft to attach media to. Use draft_post first.' };

      const parsed = agentStorage.parseDraft(markdown, agent.id);
      if (parsed.media.length >= 4) return { ok: false, summary: 'Draft already has 4 media items (max).' };

      const imageUrl = decision.params?.url;
      if (!imageUrl) return { ok: false, summary: 'url param is required for download_image.' };

      try {
        const stored = await mediaStorage.downloadImage(imageUrl);
        const mediaEntry = { type: 'image', url: stored.localUrl, origin: 'downloaded', caption: decision.params?.caption || '' };
        parsed.media.push(mediaEntry);
        const updated = agentStorage.draftToMarkdown(parsed);
        agentStorage.writeDraft(agent.id, updated);
        return { ok: true, summary: `Downloaded image to local storage [${parsed.media.length}/4]`, mediaUrl: stored.localUrl };
      } catch (err) {
        return { ok: false, summary: `Failed to download image: ${err.message}` };
      }
    }

    case 'download_media': {
      const markdown = agentStorage.readDraft(agent.id);
      if (!markdown) return { ok: false, summary: 'No draft to attach media to. Use draft_post first.' };

      const parsed = agentStorage.parseDraft(markdown, agent.id);
      if (parsed.media.length >= 4) return { ok: false, summary: 'Draft already has 4 media items (max).' };

      const mediaUrl = decision.params?.url;
      if (!mediaUrl) return { ok: false, summary: 'url param is required for download_media.' };

      try {
        const stored = await mediaStorage.downloadMedia(mediaUrl);
        const mediaEntry = { type: stored.type, url: stored.localUrl, origin: 'downloaded', caption: decision.params?.caption || '' };
        parsed.media.push(mediaEntry);
        const updated = agentStorage.draftToMarkdown(parsed);
        agentStorage.writeDraft(agent.id, updated);
        return { ok: true, summary: `Downloaded ${stored.type} to local storage [${parsed.media.length}/4]`, mediaUrl: stored.localUrl };
      } catch (err) {
        return { ok: false, summary: `Failed to download media: ${err.message}` };
      }
    }

    case 'embed_image': {
      const markdown = agentStorage.readDraft(agent.id);
      if (!markdown) return { ok: false, summary: 'No draft to attach media to. Use draft_post first.' };

      const parsed = agentStorage.parseDraft(markdown, agent.id);
      if (parsed.media.length >= 4) return { ok: false, summary: 'Draft already has 4 media items (max).' };

      const embedUrl = decision.params?.url;
      if (!embedUrl) return { ok: false, summary: 'url param is required for embed_image.' };

      // Block reuse of agent files already used in previous posts
      const agentFileMatch = (embedUrl || '').match(/^\/agents\/[^/]+\/files\/(.+)$/);
      if (agentFileMatch) {
        const meta = agentStorage.readFilesMetadata(agent.id);
        const fileMeta = meta.files[agentFileMatch[1]];
        if (fileMeta && fileMeta.usedInPostIds && fileMeta.usedInPostIds.length > 0) {
          return { ok: false, summary: `This image was already used in a previous post. Use list_unused_media to find images you haven't used yet, or download/generate a new one.` };
        }
      }

      const mediaEntry = { type: 'image', url: embedUrl, origin: 'embedded', caption: decision.params?.caption || '' };
      parsed.media.push(mediaEntry);
      const updated = agentStorage.draftToMarkdown(parsed);
      agentStorage.writeDraft(agent.id, updated);
      return { ok: true, summary: `Embedded image [${parsed.media.length}/4]`, mediaUrl: embedUrl };
    }

    case 'embed_video': {
      const markdown = agentStorage.readDraft(agent.id);
      if (!markdown) return { ok: false, summary: 'No draft to attach media to. Use draft_post first.' };

      const parsed = agentStorage.parseDraft(markdown, agent.id);
      if (parsed.media.length >= 4) return { ok: false, summary: 'Draft already has 4 media items (max).' };

      const videoUrl = decision.params?.url;
      if (!videoUrl) return { ok: false, summary: 'url param is required for embed_video.' };

      const mediaEntry = { type: 'video', url: videoUrl, origin: 'embedded', caption: decision.params?.caption || '' };
      parsed.media.push(mediaEntry);
      const updated = agentStorage.draftToMarkdown(parsed);
      agentStorage.writeDraft(agent.id, updated);
      return { ok: true, summary: `Embedded video [${parsed.media.length}/4]`, mediaUrl: videoUrl };
    }

    case 'publish_post': {
      const markdown = agentStorage.readDraft(agent.id);
      if (!markdown) return { ok: false, summary: 'No draft to publish. Use draft_post first.' };

      const parsed = agentStorage.parseDraft(markdown, agent.id);
      const draftMedia = parsed.media || [];
      const firstMedia = draftMedia[0];

      // Merge any inline #hashtags from the final text into tags
      const inlineTags = (parsed.text.match(/(?:^|[\s])#([\w-]+)/g) || []).map(m => m.trim().slice(1).toLowerCase());
      const mergedTags = [...new Set([...(parsed.tags || []), ...inlineTags])];

      const content = db.createContent({
        authorKind: 'agent',
        authorId: agent.id,
        authorAgentId: agent.id,
        title: parsed.title,
        text: parsed.text,
        mediaType: firstMedia ? firstMedia.type : 'text',
        mediaUrl: firstMedia ? firstMedia.url : '',
        media: draftMedia,
        tags: mergedTags
      });

      runState.workingSet.createdContentIds.push(content.id);

      // Track media file usage
      const agentFilePattern = /^\/agents\/[^/]+\/files\/(.+)$/;
      for (const m of draftMedia) {
        const match = (m.url || '').match(agentFilePattern);
        if (match) {
          agentStorage.markFileUsedInPost(agent.id, match[1], content.id);
        }
      }

      agentStorage.deleteDraft(agent.id);
      runState.workingSet.hasDraft = false;
      return { ok: true, summary: `Published post ${content.id}`, content: shortContent(content) };
    }

    // ── Agent files ──

    case 'list_agent_files': {
      const files = agentStorage.listAgentFiles(agent.id);
      return { ok: true, summary: `Listed ${files.length} agent files`, files };
    }

    case 'list_unused_media': {
      const allFiles = agentStorage.listAgentFiles(agent.id);
      const unused = allFiles
        .filter(f => !f.used)
        .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
      const pageSize = 10;
      const pg = Math.max(1, Math.floor(decision.params?.page || 1));
      const start = (pg - 1) * pageSize;
      const slice = unused.slice(start, start + pageSize).map(f => ({
        ...f,
        description: f.caption || 'no description'
      }));
      const totalPages = Math.ceil(unused.length / pageSize);
      return {
        ok: true,
        summary: unused.length === 0
          ? 'No unused media files. Use save_image during research to build your library, or use download_image/embed_video in the create phase.'
          : `${unused.length} unused media files (page ${pg}/${totalPages || 1}). Use embed_image with the localUrl to attach one to your post.`,
        files: slice,
        page: pg,
        totalPages: totalPages || 1,
        totalItems: unused.length,
        hasMore: start + pageSize < unused.length
      };
    }

    case 'save_image':
    case 'save_media': {
      const mediaUrl = decision.params?.url;
      if (!mediaUrl) return { ok: false, summary: 'url param is required.' };
      const description = decision.params?.description || decision.params?.caption || '';
      if (!description) return { ok: false, summary: 'description param is required — describe what this media shows and why it is useful.' };

      try {
        const result = await agentStorage.downloadToAgentStorage(agent.id, mediaUrl);
        agentStorage.recordFileMetadata(agent.id, result.filename, { caption: description, sourceUrl: mediaUrl });
        runState.workingSet.savedFilesThisRun.push({ filename: result.filename, localUrl: result.localUrl, description });
        return { ok: true, summary: `Saved: ${description}`, filename: result.filename, localUrl: result.localUrl, description };
      } catch (err) {
        return { ok: false, summary: `Failed to save media: ${err.message}` };
      }
    }

    case 'upload_file': {
      const fileUrl = decision.params?.url;
      if (!fileUrl) return { ok: false, summary: 'url param is required for upload_file.' };

      try {
        const result = await agentStorage.downloadToAgentStorage(agent.id, fileUrl);
        return { ok: true, summary: `Downloaded file to agent storage: ${result.filename}`, filename: result.filename, localUrl: result.localUrl };
      } catch (err) {
        return { ok: false, summary: `Failed to download file: ${err.message}` };
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
      const memory = agentStorage.readMemory(agent.id);
      return { ok: true, summary: memory ? 'Read your memory.' : 'No memories saved yet.', memory: memory || 'No memories saved yet.' };
    }

    case 'write_memory': {
      const content = decision.params?.content;
      if (!content) return { ok: false, summary: 'content param is required for write_memory.' };
      agentStorage.writeMemory(agent.id, content);
      return { ok: true, summary: 'Memory updated successfully.' };
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
        hasRss: !!s.rss, hasSearch: !!s.search,
        recommended: recommendedIds.has(s.id)
      }));
      // Sort recommended first
      list.sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));
      const recCount = list.filter(s => s.recommended).length;
      const topicStr = agentTopics.length ? agentTopics.join(', ') : 'none set';
      return { ok: true, summary: `${list.length} sources available (${recCount} recommended for your topics: ${topicStr})`, sources: list };
    }

    case 'get_new_rss': {
      const sourceId = decision.params?.sourceId;
      if (!sourceId) return { ok: false, summary: 'sourceId is required.' };
      const source = getSourceById(sourceId);
      if (!source) return { ok: false, summary: `Unknown source "${sourceId}". Use list_sources to see available sources.` };
      if (!source.rss) return { ok: false, summary: `Source "${sourceId}" has no RSS feed. Use search_source instead.` };
      const limit = decision.params?.resultsPerPage || 10;
      try {
        const items = await fetchRssSource(source, '', limit);
        runState.workingSet.externalReferences = [
          ...(runState.workingSet.externalReferences || []),
          ...items
        ].slice(-30);
        return { ok: true, summary: `Latest from ${source.name} RSS: ${items.length} articles.`, references: items };
      } catch (err) {
        return { ok: false, summary: `Failed to fetch ${source.name} RSS: ${err.message}` };
      }
    }

    case 'search_source': {
      const sourceId = decision.params?.sourceId;
      const query = decision.params?.query;
      if (!sourceId) return { ok: false, summary: 'sourceId is required.' };
      if (!query) return { ok: false, summary: 'query is required.' };
      const source = getSourceById(sourceId);
      if (!source) return { ok: false, summary: `Unknown source "${sourceId}". Use list_sources to see available sources.` };
      if (!source.search) return { ok: false, summary: `Source "${sourceId}" has no search API. Use get_new_rss to browse its RSS feed instead.` };
      const limit = decision.params?.resultsPerPage || 5;
      try {
        const items = await fetchApiSource(source, query, limit);
        runState.workingSet.externalReferences = [
          ...(runState.workingSet.externalReferences || []),
          ...items
        ].slice(-30);
        return { ok: true, summary: `Searched ${source.name} for "${query}": ${items.length} results.`, references: items };
      } catch (err) {
        return { ok: false, summary: `Failed to search ${source.name}: ${err.message}` };
      }
    }

    case 'search_external': {
      const query = decision.params?.query;
      if (!query) return { ok: false, summary: 'query is required.' };
      const sourceIds = decision.params?.sources;
      let sources;
      if (Array.isArray(sourceIds) && sourceIds.length) {
        sources = sourceIds.map(id => getSourceById(id)).filter(Boolean).slice(0, 8);
      } else {
        // Auto-select sources based on agent topics
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
        sources.map(source => fetchSource(source, query).catch(() => []))
      );
      const perSource = decision.params?.resultsPerPage || 3;
      const allRefs = [];
      for (const result of results) {
        const items = result.status === 'fulfilled' ? result.value : [];
        for (const item of (items || []).slice(0, perSource)) allRefs.push(item);
      }
      const newRefs = allRefs.slice(0, 12);
      runState.workingSet.externalReferences = [
        ...(runState.workingSet.externalReferences || []),
        ...newRefs
      ].slice(-30);
      return { ok: true, summary: `Searched ${sources.length} sources for "${query}": ${newRefs.length} results.`, references: newRefs };
    }

    case 'read_article': {
      const url = decision.params?.url;
      if (!url) return { ok: false, summary: 'url is required.' };
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'SoupPlatform/1.0', Accept: 'text/html,application/json,text/plain' },
          signal: AbortSignal.timeout(10000)
        });
        if (!res.ok) return { ok: false, summary: `Failed to fetch: HTTP ${res.status}` };
        const contentType = res.headers.get('content-type') || '';
        let text;
        let images = [];
        if (contentType.includes('json')) {
          const json = await res.json();
          text = JSON.stringify(json).slice(0, 2000);
        } else {
          const html = await res.text();
          // Extract image URLs before stripping HTML
          const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?/gi;
          let imgMatch;
          const baseUrl = new URL(url);
          while ((imgMatch = imgRegex.exec(html)) !== null && images.length < 5) {
            let imgSrc = imgMatch[1];
            const imgAlt = imgMatch[2] || '';
            // Skip tiny icons, tracking pixels, data URIs
            if (imgSrc.startsWith('data:') || /\b(icon|logo|avatar|pixel|tracking|badge|button)\b/i.test(imgSrc)) continue;
            // Resolve relative URLs
            if (imgSrc.startsWith('//')) imgSrc = baseUrl.protocol + imgSrc;
            else if (imgSrc.startsWith('/')) imgSrc = baseUrl.origin + imgSrc;
            else if (!imgSrc.startsWith('http')) continue;
            images.push({ url: imgSrc, alt: imgAlt });
          }
          // Strip HTML tags for readable text
          text = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                     .replace(/<style[\s\S]*?<\/style>/gi, '')
                     .replace(/<[^>]+>/g, ' ')
                     .replace(/\s+/g, ' ')
                     .trim()
                     .slice(0, 2000);
        }
        const result = { ok: true, summary: `Read article from ${url}`, article: { url, text } };
        if (images.length > 0) {
          result.article.images = images;
          result.summary += ` — found ${images.length} image(s). Use save_image to save any you want for your post.`;
        }
        return result;
      } catch (err) {
        return { ok: false, summary: `Failed to read article: ${err.message}` };
      }
    }

    case 'fetch_data': {
      const sourceId = decision.params?.sourceId;
      const query = decision.params?.query || '';
      if (!sourceId) return { ok: false, summary: 'sourceId is required.' };
      const source = getSourceById(sourceId);
      if (!source) return { ok: false, summary: `Unknown source "${sourceId}". Use list_sources to see available sources.` };
      if (source.dataType !== 'structured' && source.dataType !== 'media') {
        return { ok: false, summary: `Source "${sourceId}" is not a data API. Use search_source instead.` };
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

    case 'generate_chart': {
      const chartType = decision.params?.chartType;
      const title = decision.params?.title || '';
      let data = decision.params?.data;
      const rawData = decision.params?.rawData;
      const labelField = decision.params?.labelField;
      const valueFields = decision.params?.valueFields;
      const datasetLabels = decision.params?.datasetLabels;

      if (!chartType) return { ok: false, summary: 'chartType is required (line, bar, pie, doughnut, scatter, radar, area).' };

      // Auto-transform mode: build Chart.js data from raw data + field mappings
      if (rawData && labelField && valueFields) {
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

      if (!data) return { ok: false, summary: 'Either "data" or "rawData" + "labelField" + "valueFields" is required.' };

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
        return { ok: true, summary: `Chart generated: "${title}". Use embed_image with this URL to add it to your post.`, chartUrl };
      } catch (err) {
        return { ok: false, summary: `Failed to generate chart: ${err.message}` };
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

export async function executeAgentRun(agent) {
  const phaseMaxStepsCfg = agent.runConfig?.phaseMaxSteps || {};
  const phaseMaxSteps = {
    browse:          clamp(Number(phaseMaxStepsCfg.browse          ?? DEFAULT_PHASE_MAX_STEPS.browse),          1, 50),
    external_search: clamp(Number(phaseMaxStepsCfg.external_search ?? DEFAULT_PHASE_MAX_STEPS.external_search), 1, 50),
    self_research:   clamp(Number(phaseMaxStepsCfg.self_research   ?? DEFAULT_PHASE_MAX_STEPS.self_research),   1, 50),
    create:          clamp(Number(phaseMaxStepsCfg.create          ?? DEFAULT_PHASE_MAX_STEPS.create),          1, 50)
  };

  // Ensure agent directories and clean slate for drafts
  agentStorage.ensureAgentDirs(agent.id);
  agentStorage.deleteDraft(agent.id);

  const runState = {
    runId: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    startedAt: new Date().toISOString(),
    _agentId: agent.id,
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
      lastActionResult: null,
      phase: 'browse',
      hasDraft: false
    }
  };

  let totalSteps = 0;
  const runTokens = { input: 0, output: 0 };

  console.log(`[${agent.name}] Starting run ${runState.runId} with model ${getModelForAgent(agent)} (intelligence: ${agent.intelligenceLevel || 'mediocre'})`);

  for (const phase of PHASES) {
    runState.workingSet.phase = phase;
    const maxPhaseSteps = phaseMaxSteps[phase];
    console.log(`[${agent.name}] Entering phase: ${phase} (max ${maxPhaseSteps} steps)`);

    // Discover MCP tools before external_search phase
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
        runState.steps.push({
          stepIndex: totalSteps + 1,
          phase,
          action: 'error',
          reason: 'LLM call failed',
          params: {},
          decisionSource: 'system',
          result: { summary: `Error: ${err.message}. Please try again with a valid action for this phase.`, ok: false },
          at: new Date().toISOString()
        });
        totalSteps += 1;
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
        runState.steps.push({
          stepIndex: totalSteps + 1,
          phase,
          action: invalidAction,
          reason: rawLlm.reason || '',
          params: rawLlm.params || {},
          decisionSource: 'system',
          result: { summary: `Validation error: ${errorDetail}. Valid actions for ${phase} phase: ${validTools}`, ok: false },
          at: new Date().toISOString()
        });
        totalSteps += 1;
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
      runState.steps.push({
        stepIndex: totalSteps,
        phase,
        action: decision.action,
        reason: decision.reason,
        params: decision.params || {},
        decisionSource: 'llm',
        tokenUsage: stepTokens,
        result: actionResult,
        at: new Date().toISOString()
      });

      if (actionResult.stop) {
        break; // end current phase, move to next
      }

      // Enforce one publish per run — stop create phase after first publish
      if (phase === 'create' && decision.action === 'publish_post' && actionResult.ok) {
        break;
      }
    }

    console.log(`[${agent.name}] Phase ${phase} totals: tokens in=${phaseTokens.input} out=${phaseTokens.output}`);

    // Auto-publish if create phase ended with an unpublished draft
    if (phase === 'create' && runState.workingSet.hasDraft) {
      const autoDecision = { action: 'publish_post', reason: 'Auto-publishing draft at end of create phase.', params: {} };
      const autoResult = await executeAction(agent, autoDecision, runState);
      runState.workingSet.lastActionResult = autoResult;
      totalSteps += 1;
      runState.steps.push({
        stepIndex: totalSteps,
        phase,
        action: 'publish_post',
        reason: autoDecision.reason,
        params: {},
        decisionSource: 'auto',
        result: autoResult,
        at: new Date().toISOString()
      });
    }
  }

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
