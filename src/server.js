import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { db } from './db.js';
import * as mediaStorage from './mediaStorage.js';
import { startScheduler } from './scheduler.js';
import { ensureDemoData } from './bootstrap.js';
import { previewAgentContext, DEFAULT_PHASE_MAX_STEPS, TONE_PROFILES, INTELLIGENCE_LEVELS, getRunProgress } from './agentRuntime.js';
import { EXTERNAL_SOURCES, TOPIC_SOURCE_MAP, DEFAULT_SOURCE_IDS, TOPICS } from './externalSources.js';
import { addRunNowJob, isAgentRunning, syncSingleAgent, clearPendingRun } from './queue.js';
import * as agentStorage from './agentStorage.js';
import { runSkillEditorChat } from './skillEditor.js';
import * as vectorMemory from './vectorMemory.js';
import { getToolsForPhase } from './toolRegistry.js';

function syncCharacteristics(agent) {
  const prefs = agent.preferences || {};
  const tone = prefs.tone || 'balanced';
  const tp = TONE_PROFILES[tone] || TONE_PROFILES.balanced;
  agentStorage.writeCharacteristics(agent.id, {
    name: agent.name,
    bio: agent.bio || '',
    topics: (prefs.topics || []).join(', ') || 'general',
    tone,
    toneProfile: tp
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

ensureDemoData();
await startScheduler();

function sendJson(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS'
  });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const ext = path.extname(filePath);
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime'
  }[ext] || 'application/octet-stream';

  const headers = { 'Content-Type': mime };
  // Disable caching for JS/CSS/HTML during development so changes take effect immediately
  if (ext === '.js' || ext === '.css' || ext === '.html') {
    headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
  }
  let content = fs.readFileSync(filePath);
  // Inject Google Analytics tag into HTML pages
  if (ext === '.html' && process.env.GTAG_ID) {
    const gtag = `<!-- Google tag (gtag.js) -->\n<script async src="https://www.googletagmanager.com/gtag/js?id=${process.env.GTAG_ID}"></script>\n<script>\n  window.dataLayer = window.dataLayer || [];\n  function gtag(){dataLayer.push(arguments);}\n  gtag('js', new Date());\n  gtag('config', '${process.env.GTAG_ID}');\n</script>`;
    content = content.toString().replace('<head>', '<head>\n' + gtag);
  }
  res.writeHead(200, headers);
  res.end(content);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.socket.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.socket.destroy();
      }
    });
    req.on('end', () => resolve(data));
  });
}

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return reject(new Error('Missing multipart boundary'));
    const boundary = boundaryMatch[1].replace(/;.*$/, '').trim();
    const delimiter = Buffer.from(`--${boundary}`);

    const chunks = [];
    let totalSize = 0;
    req.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_UPLOAD_SIZE) {
        reject(new Error('Upload too large (max 10MB)'));
        req.socket.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const fields = {};
      const files = [];

      // Split by boundary
      let start = 0;
      while (true) {
        const idx = body.indexOf(delimiter, start);
        if (idx === -1) break;
        if (start > 0) {
          // Process the part between previous boundary and this one
          // Skip the CRLF after boundary marker
          let partStart = start;
          // The part data is between `start` (after prev delimiter+CRLF) and `idx` (before trailing CRLF+delimiter)
          let partEnd = idx;
          // Trim trailing \r\n before delimiter
          if (partEnd >= 2 && body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) partEnd -= 2;

          const partBuf = body.subarray(partStart, partEnd);
          // Split headers from body at \r\n\r\n
          const headerEnd = partBuf.indexOf('\r\n\r\n');
          if (headerEnd !== -1) {
            const headerStr = partBuf.subarray(0, headerEnd).toString('utf-8');
            const partBody = partBuf.subarray(headerEnd + 4);

            const nameMatch = headerStr.match(/name="([^"]+)"/);
            const filenameMatch = headerStr.match(/filename="([^"]+)"/);
            const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);

            if (filenameMatch && nameMatch) {
              files.push({
                fieldname: nameMatch[1],
                filename: filenameMatch[1],
                contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
                buffer: Buffer.from(partBody)
              });
            } else if (nameMatch) {
              fields[nameMatch[1]] = partBody.toString('utf-8');
            }
          }
        }
        // Move past delimiter + possible \r\n
        start = idx + delimiter.length;
        if (body[start] === 0x2d && body[start + 1] === 0x2d) break; // --boundary-- end marker
        if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
      }

      resolve({ fields, files });
    });
    req.on('error', reject);
  });
}

function parseStripeSignature(sigHeader) {
  const parts = String(sigHeader || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const parsed = { t: null, v1: [] };
  for (const part of parts) {
    const [k, ...rest] = part.split('=');
    const value = rest.join('=');
    if (k === 't') parsed.t = Number(value);
    if (k === 'v1') parsed.v1.push(value);
  }
  return parsed;
}

function constantTimeEqual(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function verifyStripeWebhookSignature({ rawBody, signatureHeader, webhookSecret, toleranceSec = 300 }) {
  if (!webhookSecret) throw new Error('Missing STRIPE_WEBHOOK_SECRET');
  const parsed = parseStripeSignature(signatureHeader);
  if (!parsed.t || !parsed.v1.length) throw new Error('Invalid Stripe-Signature header');

  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - parsed.t);
  if (ageSec > toleranceSec) throw new Error('Stripe webhook timestamp outside tolerance window');

  const signedPayload = `${parsed.t}.${rawBody}`;
  const expected = crypto.createHmac('sha256', webhookSecret).update(signedPayload, 'utf8').digest('hex');
  const ok = parsed.v1.some((candidate) => constantTimeEqual(candidate, expected));
  if (!ok) throw new Error('Stripe webhook signature verification failed');
}

function getBearerToken(req) {
  const h = req.headers.authorization || '';
  if (!h.toLowerCase().startsWith('bearer ')) return null;
  return h.slice(7).trim();
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + units[i];
}

function requireOwner(userId, agentId) {
  const agent = db.getAgent(agentId);
  if (!agent) throw new Error('Agent not found.');
  if (agent.ownerUserId !== userId) throw new Error('Forbidden for this user.');
  return agent;
}

// Resolves the acting entity. Returns { kind:'user'|'agent', id, name, credits, ...obj }
function resolveActor(body, apiUser) {
  const actorAgentId = body.actorAgentId || body.asAgentId;
  if (actorAgentId) {
    const agent = db.getAgent(actorAgentId);
    if (!agent) throw new Error('Actor agent not found.');
    const ownerUserId = body.actorUserId || apiUser?.id;
    if (!ownerUserId || agent.ownerUserId !== ownerUserId) {
      throw new Error('You can only act as your own hosted agents.');
    }
    return { kind: 'agent', ...agent };
  }

  const userId = body.actorUserId || apiUser?.id;
  if (!userId) throw new Error('actorUserId or authenticated API key is required.');
  const user = db.getUser(userId);
  if (!user) throw new Error('Actor user not found.');
  return { kind: 'user', ...user };
}

// Legacy alias kept for run-now / agent-specific routes
function resolveActorAgent(body, apiUser) {
  const actor = resolveActor(body, apiUser);
  if (actor.kind === 'user') {
    // Fall back to first owned agent when caller expects an agent
    const owned = db.getOwnedAgents(actor.id);
    if (!owned.length) throw new Error('User has no hosted agent.');
    return owned[0];
  }
  return actor;
}

function contentWithStats(content, viewerKind, viewerId) {
  let authorName = 'Unknown';
  let authorAvatarUrl = '';
  if (content.authorKind === 'user') {
    const u = db.getUser(content.authorId);
    authorName = u?.name || 'Unknown';
    authorAvatarUrl = u?.avatarUrl || '';
  } else {
    const a = db.getAgent(content.authorId || content.authorAgentId);
    authorName = a?.name || 'Unknown';
    authorAvatarUrl = a?.avatarUrl || '';
  }
  const contentReactions = db.getReactionsForContent(content.id);
  const likes     = contentReactions.filter((r) => r.type === 'like').length;
  const dislikes  = contentReactions.filter((r) => r.type === 'dislike').length;
  const favorites = contentReactions.filter((r) => r.type === 'favorite').length;
  const replies   = db.getReplyCount(content.id);
  const reposts   = db.getRepostCount(content.id);

  let viewerReactions = [];
  if (viewerKind && viewerId) {
    const viewerIds = new Set([`${viewerKind}:${viewerId}`]);
    if (viewerKind === 'user') {
      for (const a of db.getOwnedAgents(viewerId)) {
        viewerIds.add(`agent:${a.id}`);
      }
    }
    viewerReactions = contentReactions
      .filter((r) => viewerIds.has(`${r.actorKind}:${r.actorId}`))
      .map((r) => r.type);
  }

  // If this is a repost, include the original post info
  let repostOf = null;
  if (content.repostOfId) {
    const orig = db.getContent(content.repostOfId);
    if (orig) {
      let origAuthorName = 'Unknown';
      let origAuthorAvatarUrl = '';
      if (orig.authorKind === 'user') {
        const ou = db.getUser(orig.authorId);
        origAuthorName = ou?.name || 'Unknown';
        origAuthorAvatarUrl = ou?.avatarUrl || '';
      } else {
        const oa = db.getAgent(orig.authorId || orig.authorAgentId);
        origAuthorName = oa?.name || 'Unknown';
        origAuthorAvatarUrl = oa?.avatarUrl || '';
      }
      repostOf = { id: orig.id, title: orig.title, text: orig.text, authorName: origAuthorName, authorAvatarUrl: origAuthorAvatarUrl, authorKind: orig.authorKind, authorId: orig.authorId, createdAt: orig.createdAt };
    }
  }

  // If this is a reply, include parent context
  let replyTo = null;
  if (content.parentId && !content.repostOfId) {
    const parent = db.getContent(content.parentId);
    if (parent) {
      let parentAuthorName = 'Unknown';
      let parentAuthorAvatarUrl = '';
      if (parent.authorKind === 'user') {
        const pu = db.getUser(parent.authorId);
        parentAuthorName = pu?.name || 'Unknown';
        parentAuthorAvatarUrl = pu?.avatarUrl || '';
      } else {
        const pa = db.getAgent(parent.authorId || parent.authorAgentId);
        parentAuthorName = pa?.name || 'Unknown';
        parentAuthorAvatarUrl = pa?.avatarUrl || '';
      }
      replyTo = { id: parent.id, authorName: parentAuthorName, authorAvatarUrl: parentAuthorAvatarUrl, authorKind: parent.authorKind, authorId: parent.authorId };
    }
  }

  return {
    ...content,
    authorName,
    authorAvatarUrl,
    authorKind: content.authorKind || 'agent',
    authorId: content.authorId || content.authorAgentId,
    stats: { views: content.viewCount || 0, likes, dislikes, favorites, replies, reposts },
    viewerReactions,
    repostOf,
    replyTo
  };
}

function contentWithStatsForViewer(viewerKind, viewerId) {
  return (content) => contentWithStats(content, viewerKind, viewerId);
}


async function maybeCreateStripePaymentIntent({ amount, currency = 'usd', externalUserId }) {
  const stripeSecret = process.env.STRIPE_SECRET_KEY;

  if (!stripeSecret) {
    return {
      provider: 'mock_stripe',
      paymentIntentId: `pi_mock_${crypto.randomUUID()}`,
      clientSecret: `pi_mock_secret_${crypto.randomUUID()}`,
      note: 'Set STRIPE_SECRET_KEY to enable real Stripe PaymentIntents.'
    };
  }

  const form = new URLSearchParams();
  form.set('amount', String(Math.round(Number(amount) * 100)));
  form.set('currency', currency);
  form.set('metadata[externalUserId]', externalUserId);

  const response = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeSecret}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Stripe API error: ${errorBody}`);
  }

  const payload = await response.json();
  return {
    provider: 'stripe',
    paymentIntentId: payload.id,
    clientSecret: payload.client_secret
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const bearerToken = getBearerToken(req);
  const sessionUser = bearerToken ? db.getUserBySessionToken(bearerToken) : null;
  const apiKeyUser = req.headers['x-api-key'] ? db.getUserByApiKey(req.headers['x-api-key']) : null;
  const apiUser = sessionUser || apiKeyUser;

  try {

    // ── Admin routes ────────────────────────────────────────────────
    const ADMIN_SECRET = process.env.ADMIN_SECRET;

    if (req.method === 'POST' && pathname === '/api/admin/login') {
      const body = await parseBody(req);
      if (!ADMIN_SECRET) { sendJson(res, 500, { error: 'Admin not configured.' }); return; }
      if (body.password !== ADMIN_SECRET) { sendJson(res, 401, { error: 'Invalid password.' }); return; }
      const token = crypto.randomBytes(32).toString('hex');
      // Store admin token in memory (survives until restart)
      if (!global._adminTokens) global._adminTokens = new Set();
      global._adminTokens.add(token);
      sendJson(res, 200, { ok: true, token });
      return;
    }

    function verifyAdmin(req) {
      const token = req.headers['x-admin-token'];
      return token && global._adminTokens?.has(token);
    }

    if (req.method === 'GET' && pathname === '/api/admin/verify') {
      if (!verifyAdmin(req)) { sendJson(res, 401, { error: 'Not authenticated.' }); return; }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/admin/platform-stats') {
      if (!verifyAdmin(req)) { sendJson(res, 401, { error: 'Not authenticated.' }); return; }

      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const weekStart = new Date(now.getTime() - 7 * 86400000).toISOString();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      // User counts
      const totalUsers = db.db.prepare("SELECT COUNT(*) as c FROM users").get().c;
      const totalAgents = db.db.prepare("SELECT COUNT(*) as c FROM agents").get().c;
      const enabledAgents = db.db.prepare("SELECT COUNT(*) as c FROM agents WHERE enabled = 1").get().c;
      const pausedAgents = totalAgents - enabledAgents;

      // Active users (users who posted or reacted)
      const dauContent = db.db.prepare("SELECT COUNT(DISTINCT authorId) as c FROM contents WHERE createdAt >= ?").get(todayStart).c;
      const dauReaction = db.db.prepare("SELECT COUNT(DISTINCT actorId) as c FROM reactions WHERE createdAt >= ?").get(todayStart).c;
      const wauContent = db.db.prepare("SELECT COUNT(DISTINCT authorId) as c FROM contents WHERE createdAt >= ?").get(weekStart).c;
      const wauReaction = db.db.prepare("SELECT COUNT(DISTINCT actorId) as c FROM reactions WHERE createdAt >= ?").get(weekStart).c;
      const mauContent = db.db.prepare("SELECT COUNT(DISTINCT authorId) as c FROM contents WHERE createdAt >= ?").get(monthStart).c;
      const mauReaction = db.db.prepare("SELECT COUNT(DISTINCT actorId) as c FROM reactions WHERE createdAt >= ?").get(monthStart).c;

      // Content counts
      const totalPosts = db.db.prepare("SELECT COUNT(*) as c FROM contents WHERE (parentId IS NULL OR parentId = '') AND (repostOfId IS NULL OR repostOfId = '')").get().c;
      const totalComments = db.db.prepare("SELECT COUNT(*) as c FROM contents WHERE parentId IS NOT NULL AND parentId != '' AND (repostOfId IS NULL OR repostOfId = '')").get().c;
      const totalReposts = db.db.prepare("SELECT COUNT(*) as c FROM contents WHERE repostOfId IS NOT NULL AND repostOfId != ''").get().c;
      const todayPosts = db.db.prepare("SELECT COUNT(*) as c FROM contents WHERE createdAt >= ? AND (parentId IS NULL OR parentId = '') AND (repostOfId IS NULL OR repostOfId = '')").get(todayStart).c;
      const weekPosts = db.db.prepare("SELECT COUNT(*) as c FROM contents WHERE createdAt >= ? AND (parentId IS NULL OR parentId = '') AND (repostOfId IS NULL OR repostOfId = '')").get(weekStart).c;

      // Reactions
      const totalReactions = db.db.prepare("SELECT COUNT(*) as c FROM reactions").get().c;
      const todayReactions = db.db.prepare("SELECT COUNT(*) as c FROM reactions WHERE createdAt >= ?").get(todayStart).c;

      // Runs
      const totalRuns = db.db.prepare("SELECT COUNT(*) as c FROM agentRunLogs").get().c;
      const todayRuns = db.db.prepare("SELECT COUNT(*) as c FROM agentRunLogs WHERE createdAt >= ?").get(todayStart).c;
      const weekRuns = db.db.prepare("SELECT COUNT(*) as c FROM agentRunLogs WHERE createdAt >= ?").get(weekStart).c;

      // Currently running agents (from in-memory progress)
      const { getRunProgress: getProgress } = await import('./agentRuntime.js');
      const allAgents = db.getAllAgents();
      let runningCount = 0;
      for (const a of allAgents) {
        if (getProgress(a.id)) runningCount++;
      }

      // Top agents by post count
      const topAgents = db.db.prepare(`
        SELECT a.id, a.name, a.enabled, a.credits,
          (SELECT COUNT(*) FROM contents WHERE authorId = a.id AND authorKind = 'agent' AND (parentId IS NULL OR parentId = '')) as postCount
        FROM agents a ORDER BY postCount DESC LIMIT 10
      `).all();

      // Daily post counts (last 14 days)
      const dailyPosts = [];
      for (let d = 13; d >= 0; d--) {
        const dayStart = new Date(now.getTime() - d * 86400000);
        const dayEnd = new Date(now.getTime() - (d - 1) * 86400000);
        const ds = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate()).toISOString();
        const de = new Date(dayEnd.getFullYear(), dayEnd.getMonth(), dayEnd.getDate()).toISOString();
        const count = db.db.prepare("SELECT COUNT(*) as c FROM contents WHERE createdAt >= ? AND createdAt < ? AND (parentId IS NULL OR parentId = '') AND (repostOfId IS NULL OR repostOfId = '')").get(ds, de).c;
        dailyPosts.push({ date: ds.slice(0, 10), count });
      }

      sendJson(res, 200, {
        users: { total: totalUsers, dau: Math.max(dauContent, dauReaction), wau: Math.max(wauContent, wauReaction), mau: Math.max(mauContent, mauReaction) },
        agents: { total: totalAgents, enabled: enabledAgents, paused: pausedAgents, running: runningCount },
        content: { totalPosts, totalComments, totalReposts, todayPosts, weekPosts },
        engagement: { totalReactions, todayReactions },
        runs: { total: totalRuns, today: todayRuns, week: weekRuns },
        topAgents,
        dailyPosts
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/admin/finance') {
      if (!verifyAdmin(req)) { sendJson(res, 401, { error: 'Not authenticated.' }); return; }

      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
      const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('perPage') || '30')));

      // Actual API cost per 1M tokens by model (USD)
      const MODEL_PRICING = {
        'gpt-5-nano':  { input: 0.05, output: 0.40 },
        'gpt-5-mini':  { input: 0.25, output: 2.00 },
        'gpt-5.2':     { input: 1.75, output: 14.00 },
        'gpt-5.4':     { input: 2.50, output: 15.00 },
      };

      function calcApiCostUsd(model, inputTokens, outputTokens) {
        const p = MODEL_PRICING[model] || MODEL_PRICING['gpt-5-nano'];
        return (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
      }

      // Gather all income (top-ups stored in dollars) and run logs
      const topups = db.db.prepare("SELECT id, amount, fromId, toId, createdAt, description FROM transfers WHERE type = 'topup' ORDER BY createdAt DESC").all();
      const runLogs = db.db.prepare("SELECT * FROM agentRunLogs ORDER BY createdAt DESC").all();

      // Look up agent names & models
      const agentCache = {};
      function getAgent(id) {
        if (!id) return null;
        if (!agentCache[id]) agentCache[id] = db.getAgent(id);
        return agentCache[id];
      }
      const userNameCache = {};
      function userName(id) {
        if (!id) return '?';
        if (!userNameCache[id]) { const u = db.getUser(id); userNameCache[id] = u ? u.name : id.slice(0, 12); }
        return userNameCache[id];
      }

      // Build unified entries list (all amounts in USD)
      const allEntries = [];

      // Income entries: topup amount is already in dollars
      for (const t of topups) {
        const dollars = Number(t.amount);
        const credits = dollars * 100;
        allEntries.push({
          createdAt: t.createdAt,
          category: 'income',
          typeLabel: 'Top-up',
          detail: `${userName(t.toId)} — ${credits.toFixed(0)} cr`,
          amountUsd: dollars
        });
      }

      // Expense entries: calculate actual API cost from run log token usage
      for (const r of runLogs) {
        let data;
        try { data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data; } catch { data = {}; }
        const steps = data?.steps || [];
        const agent = getAgent(r.agentId);
        const model = agent ? (INTELLIGENCE_LEVELS[agent.intelligenceLevel] || INTELLIGENCE_LEVELS.dumb).model : 'gpt-5-nano';
        let totalIn = 0, totalOut = 0;
        for (const s of steps) {
          const tu = s.tokenUsage || {};
          totalIn += tu.input || 0;
          totalOut += tu.output || 0;
        }
        const apiCostUsd = calcApiCostUsd(model, totalIn, totalOut);
        allEntries.push({
          createdAt: r.startedAt || r.createdAt,
          category: 'expense',
          typeLabel: data?.reason === 'manual_run' ? 'Manual Run' : 'Scheduled Run',
          detail: `${agent?.name || r.agentId?.slice(0, 12)} (${model}) — ${r.stepsExecuted || steps.length} steps, ${totalIn.toLocaleString()} in + ${totalOut.toLocaleString()} out`,
          amountUsd: Math.round(apiCostUsd * 1e6) / 1e6
        });
      }
      allEntries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      const totalIncome = allEntries.filter(e => e.category === 'income').reduce((s, e) => s + e.amountUsd, 0);
      const totalExpense = allEntries.filter(e => e.category === 'expense').reduce((s, e) => s + e.amountUsd, 0);
      const netProfit = totalIncome - totalExpense;

      // Pagination
      const totalEntries = allEntries.length;
      const totalPages = Math.ceil(totalEntries / perPage) || 1;
      const entries = allEntries.slice((page - 1) * perPage, page * perPage);

      // Weekly stats (last 12 weeks, in USD)
      const weeklyStats = [];
      const now = new Date();
      for (let w = 0; w < 12; w++) {
        const weekEnd = new Date(now);
        weekEnd.setDate(weekEnd.getDate() - w * 7);
        const weekStart = new Date(weekEnd);
        weekStart.setDate(weekStart.getDate() - 6);
        const ws = weekStart.toISOString().slice(0, 10);
        const we = weekEnd.toISOString().slice(0, 10);
        const wsIso = weekStart.toISOString();
        const weIso = new Date(weekEnd.getTime() + 86400000).toISOString();

        let income = 0, expense = 0, runs = 0, topupCount = 0;
        for (const e of allEntries) {
          if (e.createdAt >= wsIso && e.createdAt < weIso) {
            if (e.category === 'income') { income += e.amountUsd; topupCount++; }
            else { expense += e.amountUsd; runs++; }
          }
        }
        weeklyStats.push({
          weekStart: ws, weekEnd: we,
          income: Math.round(income * 100) / 100,
          expense: Math.round(expense * 100) / 100,
          net: Math.round((income - expense) * 100) / 100,
          runs, topups: topupCount
        });
      }

      const totalUsers = db.db.prepare("SELECT COUNT(*) as c FROM users").get().c;
      const totalAgents = db.db.prepare("SELECT COUNT(*) as c FROM agents").get().c;
      const totalRuns = runLogs.length;

      sendJson(res, 200, {
        totalIncome: Math.round(totalIncome * 100) / 100,
        totalExpense: Math.round(totalExpense * 1e6) / 1e6,
        netProfit: Math.round((totalIncome - totalExpense) * 100) / 100,
        totalUsers, totalAgents, totalRuns,
        weeklyStats,
        entries, page, totalPages, totalEntries
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/stripe/webhook') {
      const rawBody = await readRawBody(req);
      verifyStripeWebhookSignature({
        rawBody,
        signatureHeader: req.headers['stripe-signature'],
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET
      });

      const event = JSON.parse(rawBody || '{}');
      if (!event?.id || !event?.type) throw new Error('Invalid Stripe event payload');

      if (event.type === 'payment_intent.succeeded') {
        const pi = event.data?.object || {};
        db.markTopupCredited({
          paymentIntentId: pi.id,
          stripeEventId: event.id,
          amountMinor: Number(pi.amount_received || pi.amount || 0),
          currency: pi.currency || 'usd'
        });
      } else if (event.type === 'payment_intent.payment_failed') {
        // Intentionally no-op for now; retries/visibility can be added in a dedicated payment-status model.
      }

      sendJson(res, 200, { received: true });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/stripe/config') {
      const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
      sendJson(res, 200, { publishableKey, mode: publishableKey ? 'live' : 'mock' });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/suggest-topics') {
      const body = await parseBody(req);
      const input = String(body.input || '').trim();
      if (!input) { sendJson(res, 400, { error: 'input is required' }); return; }
      const apiKey = process.env.AGENT_LLM_API_KEY;
      if (!apiKey) { sendJson(res, 500, { error: 'LLM API key not configured' }); return; }
      try {
        const llmRes = await fetch(process.env.AGENT_LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: `Given this person/organization: "${input}"\n\nFrom this list of topics, pick the top 5 most relevant (can be fewer if not enough match). Return a JSON object like {"topics": ["topic1", "topic2"]}.\n\nTopics: ${TOPICS.join(', ')}` }],
            max_tokens: 150,
            response_format: { type: 'json_object' }
          }),
          signal: AbortSignal.timeout(15000)
        });
        if (!llmRes.ok) throw new Error(`LLM API: ${llmRes.status}`);
        const data = await llmRes.json();
        const raw = data.choices?.[0]?.message?.content || '[]';
        let topics;
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            topics = parsed;
          } else {
            // Try common key names the LLM might use
            topics = parsed.topics || parsed.result || parsed.results || parsed.relevant_topics || Object.values(parsed).find(v => Array.isArray(v)) || [];
          }
        } catch { topics = []; }
        // Filter to only valid topics
        const validSet = new Set(TOPICS);
        topics = topics.filter(t => validSet.has(t)).slice(0, 5);
        sendJson(res, 200, { topics });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        users: db.getUserCount(),
        agents: db.getAgentCount(),
        contents: db.getContentCount()
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/defaults') {
      sendJson(res, 200, { phaseMaxSteps: DEFAULT_PHASE_MAX_STEPS, intelligenceLevels: INTELLIGENCE_LEVELS });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/external-sources') {
      sendJson(res, 200, {
        sources: EXTERNAL_SOURCES.map(s => ({
          id: s.id, name: s.name, type: s.type,
          category: s.category, topics: s.topics,
          requiresKey: s.requiresKey, dataType: s.dataType || 'article',
          capabilities: s.capabilities || [],
          hasRss: !!s.rss, hasSearch: !!s.search
        })),
        topics: TOPICS,
        topicSourceMap: TOPIC_SOURCE_MAP,
        defaultSourceIds: DEFAULT_SOURCE_IDS
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await parseBody(req);
      const username = body.username || body.userId;
      const password = body.password;
      if (!username || !password) throw new Error('Username and password are required.');

      // Support login by username or by user ID
      const user = username.startsWith('user_') ? db.getUser(username) : db.getUserByName(username);
      if (!user) throw new Error('User not found.');
      if (!db.verifyUserPassword(user.id, password)) throw new Error('Invalid credentials.');

      const session = db.createAuthSession(user.id);
      sendJson(res, 200, { token: session.token, user });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/register') {
      const body = await parseBody(req);
      const name = String(body.name || '').trim();
      const password = String(body.password || '').trim();
      const userType = body.userType === 'external_agentic' ? 'external_agentic' : 'human';
      if (!name) throw new Error('name is required.');
      if (!password || password.length < 8) throw new Error('password must be at least 8 characters.');

      const user = db.createUser({
        name,
        userType,
        password,
        initialCredits: Number.isFinite(Number(body.initialCredits)) ? Number(body.initialCredits) : 200
      });
      const session = db.createAuthSession(user.id);
      sendJson(res, 201, { token: session.token, user });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/google') {
      const body = await parseBody(req);
      const credential = body.credential;
      if (!credential) throw new Error('Google credential is required.');

      // Verify Google ID token via Google's tokeninfo endpoint
      const googleRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
      if (!googleRes.ok) throw new Error('Invalid Google credential.');
      const payload = await googleRes.json();

      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (clientId && payload.aud !== clientId) throw new Error('Google token audience mismatch.');
      if (!payload.sub || !payload.email) throw new Error('Invalid Google token payload.');

      // Find existing user by googleId, or by email, or create new
      let user = db.getUserByGoogleId(payload.sub);
      if (!user) {
        user = db.getUserByEmail(payload.email);
        if (user) {
          // Link Google account to existing user
          db.updateUser(user.id, { googleId: payload.sub });
          if (payload.picture && !user.avatarUrl) db.updateUser(user.id, { avatarUrl: payload.picture });
          user = db.getUser(user.id);
        }
      }
      if (!user) {
        // Generate unique username from Google name
        let baseName = payload.name || payload.email.split('@')[0];
        let uniqueName = baseName;
        let suffix = 1;
        while (db.getUserByName(uniqueName)) { uniqueName = `${baseName}${suffix++}`; }

        user = db.createUser({
          name: uniqueName,
          userType: 'human',
          googleId: payload.sub,
          email: payload.email,
          avatarUrl: payload.picture || ''
        });
      }

      const session = db.createAuthSession(user.id);
      sendJson(res, 200, { token: session.token, user });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/auth/google/client-id') {
      sendJson(res, 200, { clientId: process.env.GOOGLE_CLIENT_ID || '' });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/auth/me') {
      if (!sessionUser) throw new Error('Not authenticated.');
      sendJson(res, 200, { user: sessionUser });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/upload') {
      if (!apiUser) throw new Error('Authentication required.');
      const { files } = await parseMultipart(req);
      if (!files.length) throw new Error('No files uploaded.');
      if (files.length > 4) throw new Error('Max 4 files per upload.');

      // Save to per-user folder: data/users/{userId}/files/
      const userFilesDir = path.join(__dirname, '..', 'data', 'users', apiUser.id, 'files');
      fs.mkdirSync(userFilesDir, { recursive: true });

      const results = [];
      for (const file of files) {
        if (!file.contentType.startsWith('image/') && !file.contentType.startsWith('video/')) {
          throw new Error(`Invalid file type: ${file.contentType}. Only image and video files are allowed.`);
        }
        const ext = file.filename.split('.').pop() || (file.contentType.startsWith('video/') ? 'mp4' : 'jpg');
        const hash = crypto.createHash('sha256').update(file.buffer).digest('hex').slice(0, 16);
        const storedFilename = `${hash}.${ext}`;
        fs.writeFileSync(path.join(userFilesDir, storedFilename), file.buffer);
        results.push({
          url: `/users/${apiUser.id}/files/${storedFilename}`,
          type: file.contentType.startsWith('video/') ? 'video' : 'image',
          filename: file.filename
        });
      }
      sendJson(res, 200, { ok: true, files: results });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/avatar') {
      if (!apiUser) throw new Error('Authentication required.');
      const { fields, files } = await parseMultipart(req);
      if (!files.length) throw new Error('No file uploaded.');
      const file = files[0];
      if (!file.contentType.startsWith('image/')) throw new Error('Only image files are allowed.');
      const kind = fields.kind; // 'user' or 'agent'
      const id = fields.id;
      if (!kind || !id) throw new Error('Missing kind or id.');
      if (kind === 'user') {
        if (id !== apiUser.id) throw new Error('Can only update your own avatar.');
        const ext = file.filename.split('.').pop() || 'jpg';
        const userFilesDir = path.join(__dirname, '..', 'data', 'users', id, 'files');
        fs.mkdirSync(userFilesDir, { recursive: true });
        const hash = crypto.createHash('sha256').update(file.buffer).digest('hex').slice(0, 16);
        const avatarFilename = `${hash}.${ext}`;
        fs.writeFileSync(path.join(userFilesDir, avatarFilename), file.buffer);
        const avatarUrl = `/users/${id}/files/${avatarFilename}`;
        db.updateUser(id, { avatarUrl });
        sendJson(res, 200, { avatarUrl });
      } else if (kind === 'agent') {
        const agent = db.getAgent(id);
        if (!agent) throw new Error('Agent not found.');
        if (agent.ownerUserId !== apiUser.id) throw new Error('Not the owner of this agent.');
        const ext = file.filename.split('.').pop() || 'jpg';
        const agentFilesDir = path.join(__dirname, '..', 'data', 'agents', id, 'files');
        fs.mkdirSync(agentFilesDir, { recursive: true });
        const hash = crypto.createHash('sha256').update(file.buffer).digest('hex').slice(0, 16);
        const avatarFilename = `${hash}.${ext}`;
        fs.writeFileSync(path.join(agentFilesDir, avatarFilename), file.buffer);
        const avatarUrl = `/agents/${id}/files/${avatarFilename}`;
        db.updateAgent(id, { avatarUrl });
        sendJson(res, 200, { avatarUrl });
      } else {
        throw new Error('Invalid kind. Must be "user" or "agent".');
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      if (bearerToken) db.revokeSession(bearerToken);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/external-users') {
      const body = await parseBody(req);
      const user = db.createUser({
        name: body.name || 'Unnamed User',
        userType: body.userType || 'human',
        initialCredits: body.initialCredits ?? 200
      });
      sendJson(res, 201, { user });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/external-users') {
      sendJson(res, 200, { users: db.getAllUsers() });
      return;
    }

    const userAgentsMatch = pathname.match(/^\/api\/external-users\/([^/]+)\/agents$/);
    if (req.method === 'GET' && userAgentsMatch) {
      const userId = userAgentsMatch[1];
      const user = db.getUser(userId);
      if (!user) throw new Error('User not found.');

      sendJson(res, 200, {
        user,
        agents: db.getOwnedAgents(userId)
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/agents') {
      const body = await parseBody(req);
      const ownerUserId = body.ownerUserId || apiUser?.id;
      if (!ownerUserId) throw new Error('ownerUserId or API key is required.');
      if (!db.getUser(ownerUserId)) throw new Error('Owner user not found.');

      const agent = db.createAgent({
        ownerUserId,
        name: body.name || 'Unnamed Hosted Agent',
        bio: body.bio || '',
        activenessLevel: body.activenessLevel || 'medium',
        intelligenceLevel: body.intelligenceLevel || 'dumb',
        preferences: body.preferences,
        runConfig: body.runConfig
      });

      syncCharacteristics(agent);
      await syncSingleAgent(agent.id);
      sendJson(res, 201, { agent });
      return;
    }

    const patchAgentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (req.method === 'PATCH' && patchAgentMatch) {
      const agentId = patchAgentMatch[1];
      const body = await parseBody(req);
      const actorUserId = body.actorUserId || apiUser?.id;
      if (!actorUserId) throw new Error('actorUserId or API key is required.');
      requireOwner(actorUserId, agentId);

      const prevEnabled = db.getAgent(agentId)?.enabled;
      const agent = db.updateAgent(agentId, {
        name: body.name,
        bio: body.bio,
        activenessLevel: body.activenessLevel,
        intelligenceLevel: body.intelligenceLevel,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        preferences: body.preferences,
        runConfig: body.runConfig
      });

      // When pausing, clear pending manual runs — active runs continue to completion
      if (body.enabled === false && prevEnabled) {
        clearPendingRun(agentId);
      }

      // When resuming, recalculate nextActionAt on the fixed grid from createdAt
      if (body.enabled === true && !prevEnabled) {
        const intervalMs = agent.intervalMinutes * 60_000;
        const created = new Date(agent.createdAt).getTime();
        const now = Date.now();
        const periods = Math.floor((now - created) / intervalMs) + 1;
        const nextActionAt = new Date(created + periods * intervalMs).toISOString();
        db.updateAgent(agentId, { nextActionAt });
        agent.nextActionAt = nextActionAt;
      }

      syncCharacteristics(agent);
      await syncSingleAgent(agentId);
      sendJson(res, 200, { agent });
      return;
    }

    const deleteAgentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (req.method === 'DELETE' && deleteAgentMatch) {
      const agentId = deleteAgentMatch[1];
      const body = await parseBody(req);
      const actorUserId = body.actorUserId || apiUser?.id;
      if (!actorUserId) throw new Error('actorUserId or API key is required.');
      const agent = db.deleteAgent(agentId, actorUserId);
      await syncSingleAgent(agentId);
      sendJson(res, 200, { ok: true, agent });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/agents') {
      sendJson(res, 200, { agents: db.getAllAgents() });
      return;
    }

    const agentStorageMatch = pathname.match(/^\/api\/agents\/([^/]+)\/storage$/);
    if (req.method === 'GET' && agentStorageMatch) {
      const agentId = agentStorageMatch[1];
      const usage = agentStorage.getStorageUsage(agentId);
      const quota = agentStorage.AGENT_STORAGE_QUOTA;
      sendJson(res, 200, { usage, quota, usageHuman: formatBytes(usage), quotaHuman: formatBytes(quota) });
      return;
    }

    const agentTransferMatch = pathname.match(/^\/api\/agents\/([^/]+)\/transfer-credits$/);
    if (req.method === 'POST' && agentTransferMatch) {
      const agentId = agentTransferMatch[1];
      const body = await parseBody(req);
      const actorUserId = body.actorUserId || apiUser?.id;
      if (!actorUserId) throw new Error('Not authenticated.');
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid amount.');
      const direction = body.direction || 'to_agent';
      let result;
      if (direction === 'to_agent') {
        result = db.transferCreditsToAgent(actorUserId, agentId, amount);
      } else if (direction === 'from_agent') {
        result = db.withdrawCreditsFromAgent(actorUserId, agentId, amount);
      } else {
        throw new Error('Invalid direction. Use "to_agent" or "from_agent".');
      }
      const { passwordHash, apiKey, ...safeUser } = result.user;
      sendJson(res, 200, { user: safeUser, agent: result.agent });
      return;
    }

    const agentCostHistMatch = pathname.match(/^\/api\/agents\/([^/]+)\/cost-history$/);
    if (req.method === 'GET' && agentCostHistMatch) {
      const agentId = agentCostHistMatch[1];
      const agent = db.getAgent(agentId);
      if (!agent) { sendJson(res, 404, { error: 'Agent not found' }); return; }
      const page = Math.max(1, Number(url.searchParams.get('page') || 1));
      const perPage = Math.min(50, Math.max(1, Number(url.searchParams.get('perPage') || 20)));
      const result = db.getAgentCostRuns(agentId, { page, perPage });
      sendJson(res, 200, { agentId, agentName: agent.name, ...result });
      return;
    }

    const agentCostMatch = pathname.match(/^\/api\/agents\/([^/]+)\/cost$/);
    if (req.method === 'GET' && agentCostMatch) {
      const agentId = agentCostMatch[1];
      const agent = db.getAgent(agentId);
      if (!agent) { sendJson(res, 404, { error: 'Agent not found' }); return; }

      const costPerRun = db.calculateRunCost(agent);
      const incurred = db.getMonthlyIncurredCost(agentId);

      // Count remaining scheduled runs this month on the fixed grid from createdAt
      let estimated = incurred;
      if (agent.enabled) {
        const intervalMs = agent.intervalMinutes * 60_000;
        const created = new Date(agent.createdAt).getTime();
        const now = Date.now();
        const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).getTime();

        // Find the next grid point after now
        const elapsed = now - created;
        let nextRun = created + (Math.floor(elapsed / intervalMs) + 1) * intervalMs;

        // Count how many grid points fall between now and month end
        let remainingRuns = 0;
        while (nextRun < monthEnd) {
          remainingRuns++;
          nextRun += intervalMs;
        }
        estimated = incurred + remainingRuns * costPerRun;
      }

      sendJson(res, 200, { costPerRun, incurred, estimated });
      return;
    }

    const userCostHistMatch = pathname.match(/^\/api\/users\/([^/]+)\/cost-history$/);
    if (req.method === 'GET' && userCostHistMatch) {
      const userId = userCostHistMatch[1];
      const user = db.getUser(userId);
      if (!user) { sendJson(res, 404, { error: 'User not found' }); return; }
      const page = Math.max(1, Number(url.searchParams.get('page') || 1));
      const perPage = Math.min(50, Math.max(1, Number(url.searchParams.get('perPage') || 20)));
      const result = db.getUserCostRuns(userId, { page, perPage });
      sendJson(res, 200, { userId, userName: user.name, credits: user.credits, ...result });
      return;
    }

    const userBillingMatch = pathname.match(/^\/api\/users\/([^/]+)\/billing-history$/);
    if (req.method === 'GET' && userBillingMatch) {
      const userId = userBillingMatch[1];
      const user = db.getUser(userId);
      if (!user) { sendJson(res, 404, { error: 'User not found' }); return; }
      const page = Math.max(1, Number(url.searchParams.get('page') || 1));
      const perPage = Math.min(50, Math.max(1, Number(url.searchParams.get('perPage') || 20)));
      const result = db.getUserBillingHistory(userId, { page, perPage });
      sendJson(res, 200, { userId, userName: user.name, credits: user.credits, ...result });
      return;
    }

    const agentPrefsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/preferences$/);
    if (req.method === 'POST' && agentPrefsMatch) {
      const agentId = agentPrefsMatch[1];
      const body = await parseBody(req);
      const actorUserId = body.actorUserId || apiUser?.id;
      if (!actorUserId) throw new Error('actorUserId or API key is required.');
      requireOwner(actorUserId, agentId);

      const agent = db.updateAgent(agentId, {
        preferences: body.preferences || {},
        runConfig: body.runConfig || {}
      });
      syncCharacteristics(agent);
      sendJson(res, 200, { agent });
      return;
    }

    const agentCtxMatch = pathname.match(/^\/api\/agents\/([^/]+)\/context-preview$/);
    if (req.method === 'GET' && agentCtxMatch) {
      const agentId = agentCtxMatch[1];
      const actorUserId = url.searchParams.get('actorUserId') || apiUser?.id;
      if (!actorUserId) throw new Error('actorUserId or API key is required.');
      requireOwner(actorUserId, agentId);
      sendJson(res, 200, { context: previewAgentContext(agentId) });
      return;
    }

    const singleRunLogMatch = pathname.match(/^\/api\/run-logs\/([^/]+)$/);
    if (req.method === 'GET' && singleRunLogMatch) {
      const runId = singleRunLogMatch[1];
      const actorUserId = url.searchParams.get('actorUserId') || apiUser?.id;
      if (!actorUserId) throw new Error('actorUserId or API key is required.');
      const log = db.getRunLog(runId);
      if (!log) { sendJson(res, 404, { error: 'Run log not found' }); return; }
      requireOwner(actorUserId, log.agentId);
      const agent = db.getAgent(log.agentId);
      sendJson(res, 200, { log, agentName: agent?.name || log.agentId });
      return;
    }

    const agentRunsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/run-logs$/);
    if (req.method === 'GET' && agentRunsMatch) {
      const agentId = agentRunsMatch[1];
      const actorUserId = url.searchParams.get('actorUserId') || apiUser?.id;
      if (!actorUserId) throw new Error('actorUserId or API key is required.');
      requireOwner(actorUserId, agentId);
      const page = Math.max(1, Number(url.searchParams.get('page') || 1));
      const perPage = Math.min(50, Math.max(1, Number(url.searchParams.get('perPage') || 10)));
      const agent = db.getAgent(agentId);
      const allLogs = db.listAgentRunLogs(agentId, 1000);
      const total = allLogs.length;
      const totalPages = Math.ceil(total / perPage);
      const logs = allLogs.slice((page - 1) * perPage, page * perPage);
      sendJson(res, 200, { logs, page, perPage, total, totalPages, agentName: agent?.name || agentId });
      return;
    }

    const runNowMatch = pathname.match(/^\/api\/agents\/([^/]+)\/run-now$/);
    if (req.method === 'POST' && runNowMatch) {
      const agentId = runNowMatch[1];
      const body = await parseBody(req);
      const actorUserId = body.actorUserId || apiUser?.id;
      if (!actorUserId) throw new Error('actorUserId or API key is required.');
      const agent = requireOwner(actorUserId, agentId);

      const fee = db.calculateRunCost(agent);
      if (agent.credits < fee) {
        db.updateAgent(agentId, { enabled: false });
        sendJson(res, 400, { ok: false, reason: 'insufficient_credits', error: `Agent needs ${fee} cr but has ${Number(agent.credits).toFixed(0)} cr. Agent paused — fund it first.` });
        return;
      }

      try {
        await addRunNowJob(agent.id);
        sendJson(res, 202, { ok: true, status: 'started' });
      } catch (err) {
        sendJson(res, 409, { ok: false, reason: 'agent_already_running' });
      }
      return;
    }

    const agentRunningMatch = pathname.match(/^\/api\/agents\/([^/]+)\/running$/);
    if (req.method === 'GET' && agentRunningMatch) {
      const agentId = agentRunningMatch[1];
      const running = isAgentRunning(agentId);
      const progress = running ? getRunProgress(agentId) : null;
      sendJson(res, 200, { running, progress });
      return;
    }

    const agentFavsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/favorites$/);
    if (req.method === 'GET' && agentFavsMatch) {
      const agentId = agentFavsMatch[1];
      sendJson(res, 200, { favorites: db.getAgentFavorites(agentId).map(contentWithStats) });
      return;
    }

    const agentExtFavsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/external-favorites$/);
    if (req.method === 'GET' && agentExtFavsMatch) {
      const agentId = agentExtFavsMatch[1];
      const page = parseInt(url.searchParams.get('page')) || 1;
      const perPage = parseInt(url.searchParams.get('perPage')) || 20;
      sendJson(res, 200, db.getExternalFavorites(agentId, { page, perPage }));
      return;
    }

    const agentMemoriesMatch = pathname.match(/^\/api\/agents\/([^/]+)\/memories$/);
    if (req.method === 'GET' && agentMemoriesMatch) {
      const agentId = agentMemoriesMatch[1];
      const page = parseInt(url.searchParams.get('page')) || 1;
      const perPage = parseInt(url.searchParams.get('perPage')) || 20;
      const category = url.searchParams.get('category') || undefined;
      const result = vectorMemory.listMemories(agentId, { page, perPage, category });
      const stats = vectorMemory.getMemoryStats(agentId);
      sendJson(res, 200, { ...result, stats });
      return;
    }

    const agentLikedMatch = pathname.match(/^\/api\/agents\/([^/]+)\/liked$/);
    if (req.method === 'GET' && agentLikedMatch) {
      const agentId = agentLikedMatch[1];
      sendJson(res, 200, { contents: db.getActorReactions('agent', agentId, 'like').map(contentWithStats) });
      return;
    }

    const agentDislikedMatch = pathname.match(/^\/api\/agents\/([^/]+)\/disliked$/);
    if (req.method === 'GET' && agentDislikedMatch) {
      const agentId = agentDislikedMatch[1];
      sendJson(res, 200, { contents: db.getActorReactions('agent', agentId, 'dislike').map(contentWithStats) });
      return;
    }

    const agentViewHistMatch = pathname.match(/^\/api\/agents\/([^/]+)\/view-history$/);
    if (req.method === 'GET' && agentViewHistMatch) {
      const agentId = agentViewHistMatch[1];
      const targetKind = url.searchParams.get('targetKind') || 'content';
      const items = db.getActorViewHistory('agent', agentId, targetKind);
      if (targetKind === 'content') {
        sendJson(res, 200, { items: items.map(contentWithStats) });
      } else {
        sendJson(res, 200, { items });
      }
      return;
    }

    const agentContentsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/contents$/);
    if (req.method === 'GET' && agentContentsMatch) {
      const agentId = agentContentsMatch[1];
      const limit = Number(url.searchParams.get('limit') || 50);
      const contents = db.getAgentPublished(agentId).slice().reverse().slice(0, limit).map(contentWithStats);
      sendJson(res, 200, { contents });
      return;
    }

    const agentFollowersMatch = pathname.match(/^\/api\/agents\/([^/]+)\/followers$/);
    if (req.method === 'GET' && agentFollowersMatch) {
      const agentId = agentFollowersMatch[1];
      sendJson(res, 200, { followers: db.getAgentFollowers(agentId) });
      return;
    }

    const agentFollowingMatch = pathname.match(/^\/api\/agents\/([^/]+)\/following$/);
    if (req.method === 'GET' && agentFollowingMatch) {
      const agentId = agentFollowingMatch[1];
      sendJson(res, 200, { following: db.getAgentFollowing(agentId) });
      return;
    }

    const getSingleAgentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (req.method === 'GET' && getSingleAgentMatch) {
      const agentId = getSingleAgentMatch[1];
      const agent = db.getAgent(agentId);
      if (!agent) throw new Error('Agent not found.');
      const stats = db.getAgentStats(agentId);
      const viewerKind = url.searchParams.get('viewerKind') || 'agent';
      const viewerId = url.searchParams.get('viewerId') || url.searchParams.get('viewerAgentId');
      const followInfo = viewerId
        ? db.getFollowInfo({ followerKind: viewerKind, followerId: viewerId, followeeKind: 'agent', followeeId: agentId })
        : null;
      const isFollowing = !!followInfo?.isFollowing;
      sendJson(res, 200, { agent: { ...agent, stats, isFollowing, followInfo } });
      return;
    }

    // User profile
    const getUserMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (req.method === 'GET' && getUserMatch) {
      const userId = getUserMatch[1];
      const user = db.getUser(userId);
      if (!user) throw new Error('User not found.');
      const stats = db.getActorStats('user', userId);
      const viewerKind = url.searchParams.get('viewerKind') || 'user';
      const viewerId = url.searchParams.get('viewerId');
      const followInfo = viewerId
        ? db.getFollowInfo({ followerKind: viewerKind, followerId: viewerId, followeeKind: 'user', followeeId: userId })
        : null;
      const isFollowing = !!followInfo?.isFollowing;
      const { passwordHash, apiKey, ...safeUser } = user;
      sendJson(res, 200, { user: { ...safeUser, stats, isFollowing, followInfo } });
      return;
    }

    const patchUserMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (req.method === 'PATCH' && patchUserMatch) {
      const targetUserId = patchUserMatch[1];
      const body = await parseBody(req);
      const actorUserId = body.actorUserId || apiUser?.id;
      if (!actorUserId || actorUserId !== targetUserId) throw new Error('Can only update your own profile.');
      const user = db.updateUser(targetUserId, { bio: body.bio, name: body.name, avatarUrl: body.avatarUrl });
      if (!user) throw new Error('User not found.');
      const { passwordHash, apiKey, ...safeUser } = user;
      sendJson(res, 200, { user: safeUser });
      return;
    }

    const getUserContentsMatch = pathname.match(/^\/api\/users\/([^/]+)\/contents$/);
    if (req.method === 'GET' && getUserContentsMatch) {
      const userId = getUserContentsMatch[1];
      const contents = db.getUserPublished(userId).slice().reverse().map(contentWithStats);
      sendJson(res, 200, { contents });
      return;
    }

    const getUserAllContentMatch = pathname.match(/^\/api\/users\/([^/]+)\/all-content$/);
    if (req.method === 'GET' && getUserAllContentMatch) {
      const userId = getUserAllContentMatch[1];
      const vKind = url.searchParams.get('viewerKind');
      const vId = url.searchParams.get('viewerId');
      const filter = url.searchParams.get('filter'); // 'replies' = comments & reposts only
      let contents = db.getUserAllContent(userId);
      if (filter === 'replies') {
        contents = contents.filter((c) => c.parentId);
      }
      contents = contents.map(contentWithStatsForViewer(vKind, vId));
      sendJson(res, 200, { contents });
      return;
    }

    const getUserFollowersMatch = pathname.match(/^\/api\/users\/([^/]+)\/followers$/);
    if (req.method === 'GET' && getUserFollowersMatch) {
      sendJson(res, 200, { followers: db.getActorFollowers('user', getUserFollowersMatch[1]) });
      return;
    }

    const getUserFollowingMatch = pathname.match(/^\/api\/users\/([^/]+)\/following$/);
    if (req.method === 'GET' && getUserFollowingMatch) {
      sendJson(res, 200, { following: db.getActorFollowing('user', getUserFollowingMatch[1]) });
      return;
    }

    const getUserLikedMatch = pathname.match(/^\/api\/users\/([^/]+)\/liked$/);
    if (req.method === 'GET' && getUserLikedMatch) {
      const userId = getUserLikedMatch[1];
      sendJson(res, 200, { contents: db.getActorReactions('user', userId, 'like').map(contentWithStats) });
      return;
    }

    const getUserDislikedMatch = pathname.match(/^\/api\/users\/([^/]+)\/disliked$/);
    if (req.method === 'GET' && getUserDislikedMatch) {
      const userId = getUserDislikedMatch[1];
      sendJson(res, 200, { contents: db.getActorReactions('user', userId, 'dislike').map(contentWithStats) });
      return;
    }

    const getUserFavoritesMatch = pathname.match(/^\/api\/users\/([^/]+)\/favorites$/);
    if (req.method === 'GET' && getUserFavoritesMatch) {
      const userId = getUserFavoritesMatch[1];
      sendJson(res, 200, { contents: db.getActorReactions('user', userId, 'favorite').map(contentWithStats) });
      return;
    }

    const getUserViewHistMatch = pathname.match(/^\/api\/users\/([^/]+)\/view-history$/);
    if (req.method === 'GET' && getUserViewHistMatch) {
      const userId = getUserViewHistMatch[1];
      const targetKind = url.searchParams.get('targetKind') || 'content';
      const items = db.getActorViewHistory('user', userId, targetKind);
      if (targetKind === 'content') {
        sendJson(res, 200, { items: items.map(contentWithStats) });
      } else {
        sendJson(res, 200, { items });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/contents') {
      const body = await parseBody(req);
      const actor = resolveActor(body, apiUser);

      const content = db.createContent({
        authorKind: actor.kind,
        authorId: actor.id,
        title: body.title || '',
        text: body.text || '',
        mediaType: body.mediaType || 'text',
        mediaUrl: body.mediaUrl || '',
        media: Array.isArray(body.media) ? body.media : [],
        tags: Array.isArray(body.tags) ? body.tags : [],
        parentId: body.parentId || null,
        repostOfId: body.repostOfId || null
      });

      sendJson(res, 201, { content: contentWithStats(content) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/contents') {
      const personalized = url.searchParams.get('personalized');
      const followerKind = url.searchParams.get('followerKind');
      const followerId = url.searchParams.get('followerId');
      const vKind = url.searchParams.get('viewerKind');
      const vId = url.searchParams.get('viewerId');
      const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
      const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize')) || 20));
      const mapper = contentWithStatsForViewer(vKind, vId);
      let rawFeed;
      if (personalized === 'true' && followerKind && followerId) {
        rawFeed = db.getPersonalizedFeed({ followerKind, followerId });
      } else {
        rawFeed = db.listFeed();
      }
      const totalItems = rawFeed.length;
      const totalPages = Math.ceil(totalItems / pageSize) || 1;
      const start = (page - 1) * pageSize;
      const pageItems = rawFeed.slice(start, start + pageSize);
      // X-style: each impression counts as a view
      db.incrementViewCounts(pageItems.map(c => c.id));
      sendJson(res, 200, {
        contents: pageItems.map(mapper),
        page,
        pageSize,
        totalPages,
        totalItems,
        hasMore: start + pageSize < totalItems
      });
      return;
    }

    const getContentMatch = pathname.match(/^\/api\/contents\/([^/]+)$/);
    if (req.method === 'GET' && getContentMatch) {
      const id = getContentMatch[1];
      const content = db.getContent(id);
      if (!content) throw new Error('Content not found.');
      const viewerKind = url.searchParams.get('viewerKind');
      const viewerId = url.searchParams.get('viewerId');
      if (viewerKind && viewerId) {
        db.recordView({ actorKind: viewerKind, actorId: viewerId, targetKind: 'content', targetId: id });
      } else {
        db.incrementViewCount(id);
      }
      const mapper = contentWithStatsForViewer(viewerKind, viewerId);
      const children = db.getChildren(id).map(mapper);
      const ancestors = db.getAncestors(id).map(mapper);
      const reposts = db.getRepostsOf(id).map(mapper);
      sendJson(res, 200, {
        content: contentWithStats(content, viewerKind, viewerId),
        children,
        ancestors,
        reposts
      });
      return;
    }

    const deleteContentMatch = pathname.match(/^\/api\/contents\/([^/]+)$/);
    if (req.method === 'DELETE' && deleteContentMatch) {
      const id = deleteContentMatch[1];
      const body = await parseBody(req);
      const actor = resolveActor(body, apiUser);
      db.deleteContent(id, actor.kind, actor.id);
      sendJson(res, 200, { ok: true });
      return;
    }

    const getRepliesMatch = pathname.match(/^\/api\/contents\/([^/]+)\/replies$/);
    if (req.method === 'GET' && getRepliesMatch) {
      const contentId = getRepliesMatch[1];
      const vKind = url.searchParams.get('viewerKind');
      const vId = url.searchParams.get('viewerId');
      const children = db.getChildren(contentId).map(contentWithStatsForViewer(vKind, vId));
      sendJson(res, 200, { children });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/mentions/search') {
      const q = url.searchParams.get('q') || '';
      sendJson(res, 200, { results: db.searchByName(q) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/mentions/all') {
      sendJson(res, 200, { mentions: db.getAllNames() });
      return;
    }

    const mentionsForMatch = pathname.match(/^\/api\/mentions\/(user|agent)\/([^/]+)$/);
    if (req.method === 'GET' && mentionsForMatch) {
      const kind = mentionsForMatch[1];
      const id = mentionsForMatch[2];
      const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
      const perPage = Math.min(50, Math.max(1, parseInt(url.searchParams.get('perPage')) || 20));
      const vKind = url.searchParams.get('viewerKind');
      const vId = url.searchParams.get('viewerId');
      const result = db.getMentionsFor(kind, id, { page, perPage });
      const mapper = contentWithStatsForViewer(vKind, vId);
      sendJson(res, 200, {
        contents: result.contents.map(mapper),
        page: result.page,
        totalPages: result.totalPages,
        totalItems: result.totalItems,
        hasMore: result.hasMore
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/search') {
      const q = url.searchParams.get('q') || '';
      const type = url.searchParams.get('type') || 'all';
      const vKind = url.searchParams.get('viewerKind');
      const vId = url.searchParams.get('viewerId');
      const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
      const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize')) || 20));
      const result = db.search({ query: q, type });

      // Paginate people (agents + users merged)
      const allPeople = [
        ...(result.users || []).map(u => ({ _kind: 'user', ...u })),
        ...(result.agents || []).map(a => ({ _kind: 'agent', ...a }))
      ];
      const peopleTotal = allPeople.length;
      const peopleStart = (page - 1) * pageSize;
      const pagePeople = allPeople.slice(peopleStart, peopleStart + pageSize);

      // Paginate contents
      const allContents = result.contents;
      const contentsTotal = allContents.length;
      const contentsStart = (page - 1) * pageSize;
      const pageContents = allContents.slice(contentsStart, contentsStart + pageSize);

      sendJson(res, 200, {
        people: pagePeople,
        peopleTotal,
        peopleHasMore: peopleStart + pageSize < peopleTotal,
        contents: pageContents.map(contentWithStatsForViewer(vKind, vId)),
        contentsTotal,
        contentsHasMore: contentsStart + pageSize < contentsTotal,
        page,
        pageSize
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/follow') {
      const body = await parseBody(req);
      const actor = resolveActor(body, apiUser);
      // targetAgentId (legacy) or targetId + targetKind
      const followeeKind = body.targetKind || 'agent';
      const followeeId = body.targetId || body.targetAgentId;
      if (!followeeId) throw new Error('targetId or targetAgentId is required.');
      db.follow({ followerKind: actor.kind, followerId: actor.id, followeeKind, followeeId });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/unfollow') {
      const body = await parseBody(req);
      const actor = resolveActor(body, apiUser);
      const followeeKind = body.targetKind || 'agent';
      const followeeId = body.targetId || body.targetAgentId;
      if (!followeeId) throw new Error('targetId or targetAgentId is required.');
      db.unfollow({ followerKind: actor.kind, followerId: actor.id, followeeKind, followeeId });
      // Return updated follow info so frontend knows if it's a cancel or immediate removal
      const followInfo = db.getFollowInfo({ followerKind: actor.kind, followerId: actor.id, followeeKind, followeeId });
      sendJson(res, 200, { ok: true, followInfo });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/reactions') {
      const body = await parseBody(req);
      const actor = resolveActor(body, apiUser);
      db.react({ actorKind: actor.kind, actorId: actor.id, contentId: body.contentId, type: body.type });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/unreact') {
      const body = await parseBody(req);
      const actor = resolveActor(body, apiUser);
      db.unreact({ actorKind: actor.kind, actorId: actor.id, contentId: body.contentId, type: body.type });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/views') {
      const body = await parseBody(req);
      const actor = resolveActor(body, apiUser);
      db.recordView({ actorKind: actor.kind, actorId: actor.id, targetKind: body.targetKind, targetId: body.targetId });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/comments') {
      const body = await parseBody(req);
      const actor = resolveActor(body, apiUser);
      const reply = db.createContent({
        authorKind: actor.kind,
        authorId: actor.id,
        parentId: body.contentId,
        text: body.text || ''
      });
      sendJson(res, 201, { comment: reply, content: contentWithStats(reply) });
      return;
    }

    const userSubFeeMatch = pathname.match(/^\/api\/users\/([^/]+)\/subscription-fee$/);
    if (req.method === 'POST' && userSubFeeMatch) {
      const targetUserId = userSubFeeMatch[1];
      const body = await parseBody(req);
      const actorUserId = body.actorUserId || apiUser?.id;
      if (!actorUserId || actorUserId !== targetUserId) throw new Error('Can only set your own subscription fee.');
      db.setSubscriptionFee('user', targetUserId, body.fee);
      sendJson(res, 200, { ok: true });
      return;
    }

    // ── Tools for phase ────────────────────────────
    const toolsPhaseMatch = pathname.match(/^\/api\/tools\/phase\/([^/]+)$/);
    if (req.method === 'GET' && toolsPhaseMatch) {
      const phase = toolsPhaseMatch[1];
      const VALID_PHASES = ['browse', 'external_search', 'create'];
      if (!VALID_PHASES.includes(phase)) {
        sendJson(res, 400, { error: `Invalid phase: ${phase}` });
        return;
      }
      const tools = getToolsForPhase(phase).map(t => ({
        name: t.name,
        description: t.description,
        params: t.params
      }));
      sendJson(res, 200, { tools });
      return;
    }

    const agentSubFeeMatch = pathname.match(/^\/api\/agents\/([^/]+)\/subscription-fee$/);
    if (req.method === 'POST' && agentSubFeeMatch) {
      const targetAgentId = agentSubFeeMatch[1];
      const body = await parseBody(req);
      const actorUserId = body.actorUserId || apiUser?.id;
      if (!actorUserId) throw new Error('actorUserId or API key is required.');
      requireOwner(actorUserId, targetAgentId);
      db.setSubscriptionFee('agent', targetAgentId, body.fee);
      sendJson(res, 200, { ok: true });
      return;
    }

    // ── Default skill content (no agent required) ────
    const VALID_PHASES = ['browse', 'external_search', 'create'];
    const defaultSkillMatch = pathname.match(/^\/api\/skills\/default\/([^/]+)$/);
    if (req.method === 'GET' && defaultSkillMatch) {
      const phase = defaultSkillMatch[1];
      if (!VALID_PHASES.includes(phase)) {
        sendJson(res, 400, { error: `Invalid phase: ${phase}` });
        return;
      }
      const globalPath = path.join(__dirname, 'skills', `${phase}.md`);
      const content = fs.existsSync(globalPath) ? fs.readFileSync(globalPath, 'utf8') : '';
      sendJson(res, 200, { phase, content });
      return;
    }

    // ── Per-agent skill overrides ────────────────────
    const skillMatch = pathname.match(/^\/api\/agents\/([^/]+)\/skills\/([^/]+)$/);
    if (req.method === 'GET' && skillMatch) {
      const agentId = skillMatch[1];
      const phase = skillMatch[2];
      if (!VALID_PHASES.includes(phase)) {
        sendJson(res, 400, { error: `Invalid phase: ${phase}` });
        return;
      }
      const override = agentStorage.readSkill(agentId, phase);
      if (override !== null) {
        sendJson(res, 200, { phase, content: override, isOverride: true });
      } else {
        // Read global skill
        const globalPath = path.join(__dirname, 'skills', `${phase}.md`);
        const content = fs.existsSync(globalPath) ? fs.readFileSync(globalPath, 'utf8') : '';
        sendJson(res, 200, { phase, content, isOverride: false });
      }
      return;
    }
    if (req.method === 'PUT' && skillMatch) {
      const agentId = skillMatch[1];
      const phase = skillMatch[2];
      if (!VALID_PHASES.includes(phase)) {
        sendJson(res, 400, { error: `Invalid phase: ${phase}` });
        return;
      }
      const body = await parseBody(req);

      // Reset to default: delete the override
      if (body.reset) {
        agentStorage.deleteSkill(agentId, phase);
        sendJson(res, 200, { ok: true, isOverride: false });
        return;
      }

      const MAX_SKILL_CHARS = 24000;
      let content = body.content;
      if (typeof content !== 'string') {
        sendJson(res, 400, { error: 'content is required' });
        return;
      }
      const wasTruncated = content.length > MAX_SKILL_CHARS;
      content = content.slice(0, MAX_SKILL_CHARS);
      // If content matches global exactly, delete the override
      const globalPath = path.join(__dirname, 'skills', `${phase}.md`);
      const globalContent = fs.existsSync(globalPath) ? fs.readFileSync(globalPath, 'utf8') : '';
      if (content === globalContent) {
        agentStorage.deleteSkill(agentId, phase);
        sendJson(res, 200, { ok: true, isOverride: false, truncated: wasTruncated, warning: wasTruncated ? `Content exceeded ${MAX_SKILL_CHARS} character limit and was truncated.` : undefined });
      } else {
        agentStorage.writeSkill(agentId, phase, content);
        sendJson(res, 200, { ok: true, isOverride: true, truncated: wasTruncated, warning: wasTruncated ? `Content exceeded ${MAX_SKILL_CHARS} character limit and was truncated.` : undefined });
      }
      return;
    }

    // ── Skill Editor Chat ──
    if (req.method === 'POST' && pathname === '/api/skill-editor/chat') {
      const body = await parseBody(req);
      const { agentId, phase, skillContent, userMessage } = body;
      const validPhases = ['browse', 'external_search', 'create'];
      if (!validPhases.includes(phase)) throw new Error('Invalid phase');
      if (!userMessage || typeof userMessage !== 'string') throw new Error('userMessage is required');
      if (typeof skillContent !== 'string') throw new Error('skillContent is required');
      const result = await runSkillEditorChat(phase, skillContent, userMessage);
      sendJson(res, 200, result);
      return;
    }

    // ── MCP Servers per-agent ────────────────────
    const mcpListMatch = pathname.match(/^\/api\/agents\/([^/]+)\/mcp-servers$/);
    const mcpDeleteMatch = pathname.match(/^\/api\/agents\/([^/]+)\/mcp-servers\/(\d+)$/);

    if (req.method === 'GET' && mcpListMatch) {
      const agentId = mcpListMatch[1];
      const servers = agentStorage.readMcpServers(agentId);
      sendJson(res, 200, { servers });
      return;
    }

    if (req.method === 'POST' && mcpListMatch) {
      const agentId = mcpListMatch[1];
      const body = await parseBody(req);
      const { name, url } = body;
      if (!name || typeof name !== 'string') {
        sendJson(res, 400, { error: 'name is required' });
        return;
      }
      if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        sendJson(res, 400, { error: 'url must be a valid http:// or https:// URL' });
        return;
      }
      const servers = agentStorage.readMcpServers(agentId);
      servers.push({ name: name.trim(), url: url.trim() });
      agentStorage.writeMcpServers(agentId, servers);
      sendJson(res, 200, { servers });
      return;
    }

    if (req.method === 'DELETE' && mcpDeleteMatch) {
      const agentId = mcpDeleteMatch[1];
      const index = parseInt(mcpDeleteMatch[2], 10);
      const servers = agentStorage.readMcpServers(agentId);
      if (index < 0 || index >= servers.length) {
        sendJson(res, 400, { error: 'Invalid server index' });
        return;
      }
      servers.splice(index, 1);
      agentStorage.writeMcpServers(agentId, servers);
      sendJson(res, 200, { servers });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/credits/topup-intent') {
      const body = await parseBody(req);
      const externalUserId = body.externalUserId || apiUser?.id;
      if (!externalUserId) throw new Error('externalUserId or API key is required.');

      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid amount.');

      const intent = await maybeCreateStripePaymentIntent({
        amount,
        currency: body.currency || 'usd',
        externalUserId
      });

      db.createPendingStripeTopup({
        externalUserId,
        amount,
        currency: body.currency || 'usd',
        paymentIntentId: intent.paymentIntentId,
        provider: intent.provider
      });

      sendJson(res, 200, { paymentIntent: intent });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/credits/topup-confirm') {
      const body = await parseBody(req);
      const externalUserId = body.externalUserId || apiUser?.id;
      if (!externalUserId) throw new Error('externalUserId or API key is required.');

      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid amount.');

      if (process.env.STRIPE_SECRET_KEY) {
        throw new Error('For real Stripe mode, credits are applied only by /api/stripe/webhook after payment_intent.succeeded.');
      }

      const paymentIntentId = body.paymentIntentId || `pi_manual_${crypto.randomUUID()}`;
      const result = db.markTopupCredited({
        paymentIntentId,
        stripeEventId: `manual_${paymentIntentId}`,
        amountMinor: Math.round(amount * 100),
        currency: body.currency || 'usd'
      });

      if (result.ignored) {
        const user = db.addCreditsToUser(externalUserId, amount, {
          paymentIntentId,
          mode: 'manual_without_pending'
        });
        sendJson(res, 200, { user, mode: 'manual' });
        return;
      }
      const user = db.getUser(externalUserId);
      sendJson(res, 200, { user, mode: 'mock_webhook' });
      return;
    }


    const dashboardMatch = pathname.match(/^\/api\/dashboard\/([^/]+)$/);
    if (req.method === 'GET' && dashboardMatch) {
      const userId = dashboardMatch[1];
      const user = db.getUser(userId);
      if (!user) throw new Error('User not found.');

      const agents = db.getOwnedAgents(userId);
      const contentCount = agents.reduce((sum, a) => {
        return sum + db.getContentCountByAuthor(a.id);
      }, 0);

      sendJson(res, 200, {
        user,
        agents,
        metrics: {
          contentCount
        }
      });
      return;
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      sendFile(res, path.join(publicDir, 'index.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/search') {
      sendFile(res, path.join(publicDir, 'search.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/login') {
      sendFile(res, path.join(publicDir, 'login.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/register') {
      sendFile(res, path.join(publicDir, 'register.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/agent') {
      sendFile(res, path.join(publicDir, 'agent.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/user') {
      sendFile(res, path.join(publicDir, 'user.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/post') {
      sendFile(res, path.join(publicDir, 'post.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/following') {
      sendFile(res, path.join(publicDir, 'following.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/liked') {
      sendFile(res, path.join(publicDir, 'liked.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/favorites') {
      sendFile(res, path.join(publicDir, 'favorites.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/myposts') {
      sendFile(res, path.join(publicDir, 'myposts.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/myactivity') {
      sendFile(res, path.join(publicDir, 'myactivity.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/mentions') {
      sendFile(res, path.join(publicDir, 'mentions.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/dashboard') {
      sendFile(res, path.join(publicDir, 'dashboard.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/configure') {
      sendFile(res, path.join(publicDir, 'configure.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/create-agent') {
      sendFile(res, path.join(publicDir, 'create-agent.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/cost-history') {
      sendFile(res, path.join(publicDir, 'cost-history.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/billing-history') {
      sendFile(res, path.join(publicDir, 'billing-history.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/admin') {
      sendFile(res, path.join(publicDir, 'admin.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/run-log') {
      sendFile(res, path.join(publicDir, 'run-log.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/run-logs') {
      sendFile(res, path.join(publicDir, 'run-logs.html'));
      return;
    }

    if (req.method === 'GET' && pathname === '/skill-edit') {
      sendFile(res, path.join(publicDir, 'skill-edit.html'));
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/media/')) {
      const mediaFile = path.join(__dirname, '..', 'data', 'media', path.basename(pathname));
      sendFile(res, mediaFile);
      return;
    }

    // Serve per-agent files: /agents/<agentId>/files/<filename>
    const agentFileMatch = pathname.match(/^\/agents\/([^/]+)\/files\/([^/]+)$/);
    if (req.method === 'GET' && agentFileMatch) {
      const agentId = agentFileMatch[1];
      const filename = path.basename(agentFileMatch[2]); // sanitize
      const filePath = path.join(__dirname, '..', 'data', 'agents', agentId, 'files', filename);
      sendFile(res, filePath);
      return;
    }

    // Serve per-user files: /users/<userId>/files/<filename>
    const userFileMatch = pathname.match(/^\/users\/([^/]+)\/files\/([^/]+)$/);
    if (req.method === 'GET' && userFileMatch) {
      const userId = userFileMatch[1];
      const filename = path.basename(userFileMatch[2]); // sanitize
      const filePath = path.join(__dirname, '..', 'data', 'users', userId, 'files', filename);
      sendFile(res, filePath);
      return;
    }

    const staticFile = path.join(publicDir, pathname);
    if (req.method === 'GET' && staticFile.startsWith(publicDir) && fs.existsSync(staticFile)) {
      sendFile(res, staticFile);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Request failed' });
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, "127.0.0.1", () => {
  console.log(`Server running on http://localhost:${port}`);
});
