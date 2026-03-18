import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'soup.db');
const JSON_DB_FILE = path.join(DB_DIR, 'db.json');
const CREDITS_PER_DOLLAR = 100;

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, encoded) {
  if (!encoded || !encoded.includes(':')) return false;
  const [salt, expected] = encoded.split(':');
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const aa = Buffer.from(actual, 'hex');
  const bb = Buffer.from(expected, 'hex');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

/** Bucket entries into ISO-week (Mon–Sun) stats sorted newest-first. */
function computeWeeklyStats(entries) {
  const buckets = {};
  for (const e of entries) {
    const d = new Date(e.startedAt);
    const day = d.getUTCDay();
    const diff = (day === 0 ? -6 : 1) - day;
    const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
    const key = mon.toISOString().slice(0, 10);
    if (!buckets[key]) buckets[key] = { spent: 0, earned: 0 };
    buckets[key].spent += (e.cost || 0);
    buckets[key].earned += (e.amount || 0);
  }
  return Object.keys(buckets)
    .sort((a, b) => b.localeCompare(a))
    .map(weekStart => {
      const sun = new Date(weekStart);
      sun.setUTCDate(sun.getUTCDate() + 6);
      const weekEnd = sun.toISOString().slice(0, 10);
      const b = buckets[weekStart];
      return { weekStart, weekEnd, spent: b.spent, earned: b.earned, net: b.earned - b.spent };
    });
}

function defaultAgentPreferences() {
  return {
    topics: ['technology', 'creators'],
    tone: 'insightful',
    goals: ['discover quality content', 'grow audience', 'publish useful posts'],
    allowExternalReferenceSearch: true,
    externalSearchSources: [
      'google', 'reddit', 'x', 'medium', 'substack', 'quora',
      'zhihu', 'xiaohongshu', 'bilibili', 'weibo', 'douyin',
      'telegram', 'linkedin', 'pinterest', 'instagram',
      'hackernews', 'wikipedia', 'arxiv', 'bbc-news'
    ]
  };
}

function defaultAgentRunConfig() {
  return {
    maxStepsPerRun: 25,
    minStepsPerRun: 2,
    llmEnabled: true,
    actionLogSize: 20,
    postsPerRun: 1,
    phaseMaxSteps: {
      browse: 25,
      external_search: 15,
      create: 10
    }
  };
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

function jp(val) { try { return val ? JSON.parse(val) : null; } catch { return null; } }
function js(val) { return val == null ? null : JSON.stringify(val); }

// ─── Row → Object hydrators ──────────────────────────────────────────────────

function hydrateAgent(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: !!row.enabled,
    isFree: !!row.isFree,
    preferences: jp(row.preferences) || defaultAgentPreferences(),
    runConfig: jp(row.runConfig) || defaultAgentRunConfig(),
    mcpServers: jp(row.mcpServers) || [],
    externalArticlesHistory: jp(row.externalArticlesHistory) || []
  };
}

function hydrateContent(row) {
  if (!row) return null;
  return {
    ...row,
    media: jp(row.media) || [],
    tags: jp(row.tags) || [],
    parentId: row.parentId || null,
    repostOfId: row.repostOfId || null
  };
}

function hydrateFollow(row) {
  if (!row) return null;
  return {
    ...row,
    subscribedFee: row.subscribedFee || 0,
    cancelledAt: row.cancelledAt || null,
    expiresAt: row.expiresAt || null,
    lastChargedAt: row.lastChargedAt || null
  };
}

function hydrateTransfer(row) {
  if (!row) return null;
  return { ...row, meta: jp(row.meta) || {} };
}

function hydrateRunLog(row) {
  if (!row) return null;
  const data = jp(row.data) || {};
  return { ...row, ...data, data: undefined };
}

function hydrateExternalFavorite(row) {
  if (!row) return null;
  return { ...row, tags: jp(row.tags) || [] };
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bio TEXT DEFAULT '',
  avatarUrl TEXT DEFAULT '',
  userType TEXT DEFAULT 'human',
  apiKey TEXT NOT NULL,
  passwordHash TEXT NOT NULL,
  credits REAL DEFAULT 100,
  subscriptionFee REAL DEFAULT 0,
  stripeCustomerId TEXT,
  googleId TEXT,
  email TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_name ON users(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_users_apiKey ON users(apiKey);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  ownerUserId TEXT NOT NULL,
  name TEXT NOT NULL,
  bio TEXT DEFAULT '',
  avatarUrl TEXT DEFAULT '',
  activenessLevel TEXT DEFAULT 'medium',
  intelligenceLevel TEXT DEFAULT 'dumb',
  intervalMinutes REAL,
  credits REAL DEFAULT 0,
  subscriptionFee REAL DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  isFree INTEGER DEFAULT 0,
  preferences TEXT DEFAULT '{}',
  runConfig TEXT DEFAULT '{}',
  mcpServers TEXT DEFAULT '[]',
  externalArticlesHistory TEXT DEFAULT '[]',
  createdAt TEXT NOT NULL,
  lastActionAt TEXT,
  nextActionAt TEXT,
  FOREIGN KEY (ownerUserId) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(ownerUserId);

CREATE TABLE IF NOT EXISTS contents (
  id TEXT PRIMARY KEY,
  authorKind TEXT DEFAULT 'agent',
  authorId TEXT,
  authorAgentId TEXT,
  authorUserId TEXT,
  parentId TEXT,
  repostOfId TEXT,
  title TEXT DEFAULT '',
  text TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  mediaType TEXT DEFAULT 'text',
  mediaUrl TEXT DEFAULT '',
  media TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]',
  viewCount INTEGER DEFAULT 0,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contents_authorAgent ON contents(authorAgentId);
CREATE INDEX IF NOT EXISTS idx_contents_authorKindId ON contents(authorKind, authorId);
CREATE INDEX IF NOT EXISTS idx_contents_parentId ON contents(parentId);
CREATE INDEX IF NOT EXISTS idx_contents_repostOfId ON contents(repostOfId);
CREATE INDEX IF NOT EXISTS idx_contents_createdAt ON contents(createdAt);

CREATE TABLE IF NOT EXISTS reactions (
  id TEXT PRIMARY KEY,
  actorKind TEXT NOT NULL,
  actorId TEXT NOT NULL,
  agentId TEXT,
  userId TEXT,
  contentId TEXT NOT NULL,
  type TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reactions_content ON reactions(contentId);
CREATE INDEX IF NOT EXISTS idx_reactions_actor ON reactions(actorKind, actorId, type);

CREATE TABLE IF NOT EXISTS follows (
  id TEXT PRIMARY KEY,
  followerKind TEXT NOT NULL,
  followerId TEXT NOT NULL,
  followeeKind TEXT NOT NULL,
  followeeId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  lastChargedAt TEXT,
  expiresAt TEXT,
  cancelledAt TEXT,
  subscribedFee REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(followerKind, followerId);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followeeKind, followeeId);

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  fromKind TEXT,
  fromId TEXT,
  toKind TEXT,
  toId TEXT,
  amount REAL DEFAULT 0,
  meta TEXT DEFAULT '{}',
  description TEXT DEFAULT '',
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfers_type ON transfers(type);
CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(fromKind, fromId);
CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(toKind, toId);

CREATE TABLE IF NOT EXISTS tenantCharges (
  id TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  amount REAL DEFAULT 0,
  reason TEXT DEFAULT '',
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tenantCharges_agent ON tenantCharges(agentId);

CREATE TABLE IF NOT EXISTS viewHistory (
  id TEXT PRIMARY KEY,
  actorKind TEXT NOT NULL,
  actorId TEXT NOT NULL,
  targetKind TEXT NOT NULL,
  targetId TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_viewHistory_actor ON viewHistory(actorKind, actorId, targetKind);

CREATE TABLE IF NOT EXISTS externalFavorites (
  id TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  title TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  url TEXT NOT NULL,
  source TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_extfav_agent ON externalFavorites(agentId);

CREATE TABLE IF NOT EXISTS agentRunLogs (
  id TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  startedAt TEXT,
  finishedAt TEXT,
  stepsExecuted INTEGER DEFAULT 0,
  data TEXT DEFAULT '{}',
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runlogs_agent ON agentRunLogs(agentId);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  key TEXT,
  type TEXT,
  agentId TEXT,
  status TEXT DEFAULT 'queued',
  dueAt TEXT,
  attempts INTEGER DEFAULT 0,
  maxAttempts INTEGER DEFAULT 5,
  lockedUntil TEXT,
  lockedBy TEXT,
  lastRunAt TEXT,
  lastError TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_agent ON jobs(agentId);
CREATE INDEX IF NOT EXISTS idx_jobs_key ON jobs(key);

CREATE TABLE IF NOT EXISTS pendingStripeTopups (
  id TEXT PRIMARY KEY,
  externalUserId TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'usd',
  paymentIntentId TEXT,
  provider TEXT DEFAULT 'stripe',
  status TEXT DEFAULT 'pending',
  createdAt TEXT NOT NULL,
  creditedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_topups_pi ON pendingStripeTopups(paymentIntentId);

CREATE TABLE IF NOT EXISTS stripeWebhookEvents (
  eventId TEXT PRIMARY KEY,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS authSessions (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  userId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON authSessions(token);
`;

// ─── SqliteDB class ──────────────────────────────────────────────────────────

class SqliteDB {
  constructor(dbPath) {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');

    // Create tables
    this.db.exec(SCHEMA);

    // Schema migrations for existing databases
    this._runMigrations();

    // Migrate from JSON if SQLite is empty and JSON file exists
    if (this._isEmpty() && fs.existsSync(JSON_DB_FILE)) {
      this._migrateFromJson();
    }

    // Backward compat: expose a no-op save() and a minimal state proxy
    // so any leftover `db.state.X` reads and `db.save()` calls don't crash during migration
    this.state = new Proxy({}, {
      get: (_, prop) => {
        // These are the most accessed properties — return live data
        if (prop === 'agents') return this.getAllAgents();
        if (prop === 'users') return this.getAllUsers();
        if (prop === 'contents') return this.getAllContents();
        if (prop === 'reactions') return this.getAllReactions();
        if (prop === 'follows') return this.getAllFollows();
        if (prop === 'transfers') return this.getAllTransfers();
        if (prop === 'tenantCharges') return this.getAllTenantCharges();
        if (prop === 'viewHistory') return [];
        if (prop === 'externalFavorites') return this.getAllExternalFavorites();
        if (prop === 'agentRunLogs') return this.getAllRunLogs();
        if (prop === 'jobs') return this.getAllJobs();
        if (prop === 'pendingStripeTopups') return this.getAllPendingTopups();
        if (prop === 'stripeWebhookEvents') return this.getAllWebhookEventIds();
        if (prop === 'authSessions') return this.getAllAuthSessions();
        if (prop === 'metadata') return { createdAt: nowIso(), updatedAt: nowIso() };
        return undefined;
      }
    });
  }

  _runMigrations() {
    const cols = this.db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
    if (!cols.includes('googleId')) {
      this.db.exec('ALTER TABLE users ADD COLUMN googleId TEXT');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_users_googleId ON users(googleId)');
    }
    if (!cols.includes('email')) {
      this.db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    }
  }

  _isEmpty() {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM users').get();
    return row.cnt === 0;
  }

  // ── JSON migration ──────────────────────────────────────────────────────────

  _migrateFromJson() {
    console.log('[db] Migrating from db.json to SQLite...');
    let raw;
    try { raw = fs.readFileSync(JSON_DB_FILE, 'utf8'); } catch { return; }
    const state = raw.trim() ? JSON.parse(raw) : null;
    if (!state) return;

    // Disable FK enforcement during migration — source data may have orphaned references
    this.db.pragma('foreign_keys = OFF');

    const insert = this.db.transaction(() => {
      // Users
      for (const u of (state.users || [])) {
        this.db.prepare(`INSERT OR IGNORE INTO users (id, name, bio, avatarUrl, userType, apiKey, passwordHash, credits, subscriptionFee, stripeCustomerId, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          u.id, u.name, u.bio || '', u.avatarUrl || '', u.userType || 'human',
          u.apiKey || newId('key'), u.passwordHash || hashPassword(u.apiKey || newId('pw')),
          u.credits ?? 100, u.subscriptionFee ?? 0, u.stripeCustomerId || null, u.createdAt || nowIso()
        );
      }

      // Agents
      for (const a of (state.agents || [])) {
        // Apply enrichment
        if (!a.name) a.name = 'Agent ' + a.id.slice(-6);
        if (!a.activenessLevel) a.activenessLevel = 'medium';
        const prefs = { ...defaultAgentPreferences(), ...(a.preferences || {}) };
        const rc = { ...defaultAgentRunConfig(), ...(a.runConfig || {}) };
        // Migrate phaseMaxSteps
        const pms = rc.phaseMaxSteps || {};
        if (pms.research !== undefined) {
          pms.external_search = pms.external_search || (pms.research === 5 ? 15 : pms.research);
          delete pms.research;
        }
        if (pms.create === 5) pms.create = 10;
        if (pms.self_research !== undefined) {
          const bonus = Math.floor((pms.self_research || 0) / 2);
          pms.browse = (pms.browse || 25) + bonus;
          pms.external_search = (pms.external_search || 15) + Math.ceil((pms.self_research || 0) / 2);
          delete pms.self_research;
        }
        rc.phaseMaxSteps = pms;
        // Migrate source IDs
        const OLD_TO_NEW = {
          google: 'bbc-news', youtube: 'techcrunch', x: 'mastodon',
          reddit: 'reddit', wikipedia: 'wikipedia', 'hacker news': 'hackernews',
          arxiv: 'arxiv', github: 'github-trending', 'stack overflow': 'stackoverflow', medium: 'dev-to'
        };
        if (Array.isArray(prefs.externalSearchSources)) {
          prefs.externalSearchSources = [...new Set(prefs.externalSearchSources.map(s => {
            const key = typeof s === 'string' ? s.toLowerCase() : '';
            return OLD_TO_NEW[key] || key;
          }).filter(Boolean))];
        }

        this.db.prepare(`INSERT OR IGNORE INTO agents (id, ownerUserId, name, bio, avatarUrl, activenessLevel, intelligenceLevel, intervalMinutes, credits, subscriptionFee, enabled, isFree, preferences, runConfig, mcpServers, externalArticlesHistory, createdAt, lastActionAt, nextActionAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          a.id, a.ownerUserId, a.name, a.bio || '', a.avatarUrl || '',
          a.activenessLevel || 'medium', a.intelligenceLevel || 'dumb',
          a.intervalMinutes ?? 720, a.credits ?? 0, a.subscriptionFee ?? 0,
          a.enabled ? 1 : 0, a.isFree ? 1 : 0,
          js(prefs), js(rc), js(a.mcpServers || []), js(a.externalArticlesHistory || []),
          a.createdAt || nowIso(), a.lastActionAt || null, a.nextActionAt || null
        );
      }

      // Contents (with migration of old comments)
      const contents = state.contents || [];
      // Migrate old comments into contents
      for (const c of (state.comments || [])) {
        const alreadyMigrated = contents.some(x => x._migratedFromComment === c.id);
        if (alreadyMigrated) continue;
        contents.push({
          id: newId('content'),
          _migratedFromComment: c.id,
          authorKind: c.actorKind || 'agent',
          authorId: c.actorId,
          authorAgentId: c.actorKind === 'agent' ? c.actorId : null,
          parentId: c.contentId,
          repostOfId: null,
          title: '', text: c.text || '',
          mediaType: 'text', mediaUrl: '', media: [], tags: [],
          createdAt: c.createdAt || nowIso(), viewCount: 0
        });
      }
      for (const c of contents) {
        if (!c.authorKind) { c.authorKind = 'agent'; c.authorId = c.authorAgentId; }
        if (!Array.isArray(c.media)) {
          c.media = (c.mediaUrl && c.mediaType && c.mediaType !== 'text')
            ? [{ type: c.mediaType, url: c.mediaUrl, prompt: '', generationMode: 'text-to-image' }]
            : [];
        }
        if (!c.summary) c.summary = (c.title || '').slice(0, 80) || (c.text || '').slice(0, 80) || '(no text)';
        this.db.prepare(`INSERT OR IGNORE INTO contents (id, authorKind, authorId, authorAgentId, authorUserId, parentId, repostOfId, title, text, summary, mediaType, mediaUrl, media, tags, viewCount, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          c.id, c.authorKind, c.authorId, c.authorAgentId || null, c.authorUserId || null,
          c.parentId || null, c.repostOfId || null,
          c.title || '', c.text || '', c.summary || '',
          c.mediaType || 'text', c.mediaUrl || '',
          js(c.media), js(c.tags || []),
          c.viewCount || 0, c.createdAt || nowIso()
        );
      }

      // Reactions
      for (const r of (state.reactions || [])) {
        if (!r.actorKind) { r.actorKind = 'agent'; r.actorId = r.agentId; }
        this.db.prepare(`INSERT OR IGNORE INTO reactions (id, actorKind, actorId, agentId, userId, contentId, type, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          r.id, r.actorKind, r.actorId, r.agentId || null, r.userId || null,
          r.contentId, r.type, r.createdAt || nowIso()
        );
      }

      // Follows
      const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
      const agentIdSet = new Set((state.agents || []).map(a => a.id));
      for (const f of (state.follows || [])) {
        // Skip follows referencing deleted agents
        if (f.followeeKind === 'agent' && !agentIdSet.has(f.followeeId)) continue;
        if (f.followerKind === 'agent' && !agentIdSet.has(f.followerId)) continue;
        if (!f.followerKind) {
          f.followerKind = 'agent'; f.followerId = f.followerAgentId;
          f.followeeKind = 'agent'; f.followeeId = f.followeeAgentId;
        }
        if (f.cancelledAt === undefined) f.cancelledAt = null;
        if (f.expiresAt === undefined && f.lastChargedAt) {
          f.expiresAt = new Date(new Date(f.lastChargedAt).getTime() + THIRTY_DAYS).toISOString();
        }
        if (f.expiresAt === undefined) f.expiresAt = null;
        if (f.subscribedFee === undefined) {
          const fe = f.followeeKind === 'user'
            ? (state.users || []).find(u => u.id === f.followeeId)
            : (state.agents || []).find(a => a.id === f.followeeId);
          f.subscribedFee = (fe && fe.subscriptionFee) ? fe.subscriptionFee : 0;
        }
        this.db.prepare(`INSERT OR IGNORE INTO follows (id, followerKind, followerId, followeeKind, followeeId, createdAt, lastChargedAt, expiresAt, cancelledAt, subscribedFee)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          f.id, f.followerKind, f.followerId, f.followeeKind, f.followeeId,
          f.createdAt || nowIso(), f.lastChargedAt || null, f.expiresAt || null,
          f.cancelledAt || null, f.subscribedFee || 0
        );
      }

      // Transfers
      for (const t of (state.transfers || [])) {
        this.db.prepare(`INSERT OR IGNORE INTO transfers (id, type, fromKind, fromId, toKind, toId, amount, meta, description, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          t.id, t.type, t.fromKind || null, t.fromId || null,
          t.toKind || null, t.toId || null, t.amount || 0,
          js(t.meta || {}), t.description || '', t.createdAt || nowIso()
        );
      }

      // TenantCharges
      for (const c of (state.tenantCharges || [])) {
        this.db.prepare(`INSERT OR IGNORE INTO tenantCharges (id, agentId, amount, reason, createdAt)
          VALUES (?, ?, ?, ?, ?)`).run(
          c.id, c.agentId, c.amount || 0, c.reason || '', c.createdAt || nowIso()
        );
      }

      // ViewHistory
      for (const v of (state.viewHistory || [])) {
        this.db.prepare(`INSERT OR IGNORE INTO viewHistory (id, actorKind, actorId, targetKind, targetId, createdAt)
          VALUES (?, ?, ?, ?, ?, ?)`).run(
          v.id, v.actorKind, v.actorId, v.targetKind, v.targetId, v.createdAt || nowIso()
        );
      }

      // External Favorites
      for (const f of (state.externalFavorites || [])) {
        this.db.prepare(`INSERT OR IGNORE INTO externalFavorites (id, agentId, title, summary, url, source, tags, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          f.id, f.agentId, f.title || '', f.summary || '', f.url, f.source || '',
          js(f.tags || []), f.createdAt || nowIso()
        );
      }

      // Run logs
      for (const l of (state.agentRunLogs || [])) {
        const { id, agentId, startedAt, finishedAt, stepsExecuted, createdAt, ...rest } = l;
        this.db.prepare(`INSERT OR IGNORE INTO agentRunLogs (id, agentId, startedAt, finishedAt, stepsExecuted, data, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          id, agentId, startedAt || null, finishedAt || null, stepsExecuted || 0,
          js(rest), createdAt || nowIso()
        );
      }

      // Jobs
      for (const j of (state.jobs || [])) {
        this.db.prepare(`INSERT OR IGNORE INTO jobs (id, key, type, agentId, status, dueAt, attempts, maxAttempts, lockedUntil, lockedBy, lastRunAt, lastError, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          j.id, j.key || null, j.type || null, j.agentId || null,
          j.status || 'queued', j.dueAt || null, j.attempts || 0, j.maxAttempts || 5,
          j.lockedUntil || null, j.lockedBy || null, j.lastRunAt || null, j.lastError || null,
          j.createdAt || nowIso(), j.updatedAt || nowIso()
        );
      }

      // Pending topups
      for (const t of (state.pendingStripeTopups || [])) {
        this.db.prepare(`INSERT OR IGNORE INTO pendingStripeTopups (id, externalUserId, amount, currency, paymentIntentId, provider, status, createdAt, creditedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          t.id, t.externalUserId, t.amount, t.currency || 'usd',
          t.paymentIntentId || null, t.provider || 'stripe',
          t.status || 'pending', t.createdAt || nowIso(), t.creditedAt || null
        );
      }

      // Stripe webhook events
      const events = state.stripeWebhookEvents || [];
      for (const e of events) {
        const eventId = typeof e === 'string' ? e : e.eventId;
        if (eventId) {
          this.db.prepare(`INSERT OR IGNORE INTO stripeWebhookEvents (eventId, createdAt) VALUES (?, ?)`).run(eventId, nowIso());
        }
      }

      // Auth sessions
      for (const s of (state.authSessions || [])) {
        this.db.prepare(`INSERT OR IGNORE INTO authSessions (id, token, userId, createdAt, expiresAt)
          VALUES (?, ?, ?, ?, ?)`).run(
          s.id, s.token, s.userId, s.createdAt || nowIso(), s.expiresAt
        );
      }
    });

    insert();
    // Re-enable FK enforcement
    this.db.pragma('foreign_keys = ON');
    // Rename old JSON file
    try { fs.renameSync(JSON_DB_FILE, JSON_DB_FILE + '.migrated'); } catch {}
    console.log('[db] Migration complete.');
  }

  // ── Backward compat ────────────────────────────────────────────────────────

  save() { /* no-op — SQLite auto-persists */ }

  // ── Bulk accessors (for db.state.* proxy + queue.js compat) ────────────────

  getAllAgents() { return this.db.prepare('SELECT * FROM agents').all().map(hydrateAgent); }
  getAllUsers() { return this.db.prepare('SELECT * FROM users').all(); }
  getAllContents() { return this.db.prepare('SELECT * FROM contents ORDER BY createdAt DESC').all().map(hydrateContent); }
  getAllReactions() { return this.db.prepare('SELECT * FROM reactions').all(); }
  getAllFollows() { return this.db.prepare('SELECT * FROM follows').all().map(hydrateFollow); }
  getAllTransfers() { return this.db.prepare('SELECT * FROM transfers').all().map(hydrateTransfer); }
  getAllTenantCharges() { return this.db.prepare('SELECT * FROM tenantCharges').all(); }
  getAllExternalFavorites() { return this.db.prepare('SELECT * FROM externalFavorites').all().map(hydrateExternalFavorite); }
  getAllRunLogs() { return this.db.prepare('SELECT * FROM agentRunLogs ORDER BY createdAt DESC').all().map(hydrateRunLog); }
  getAllJobs() { return this.db.prepare('SELECT * FROM jobs').all(); }
  getAllPendingTopups() { return this.db.prepare('SELECT * FROM pendingStripeTopups').all(); }
  getAllWebhookEventIds() { return this.db.prepare('SELECT eventId FROM stripeWebhookEvents').all().map(r => r.eventId); }
  getAllAuthSessions() { return this.db.prepare('SELECT * FROM authSessions').all(); }

  // ── New accessor methods (replacing db.state.X direct access) ──────────────

  getContent(id) {
    return hydrateContent(this.db.prepare('SELECT * FROM contents WHERE id = ?').get(id));
  }

  getReactionsForContent(contentId) {
    return this.db.prepare('SELECT * FROM reactions WHERE contentId = ?').all(contentId);
  }

  getRepostsOf(contentId) {
    return this.db.prepare('SELECT * FROM contents WHERE repostOfId = ? ORDER BY createdAt ASC').all(contentId).map(hydrateContent);
  }

  getRepostCount(contentId) {
    return this.db.prepare('SELECT COUNT(*) as cnt FROM contents WHERE repostOfId = ?').get(contentId).cnt;
  }

  getReplyCount(contentId) {
    return this.db.prepare('SELECT COUNT(*) as cnt FROM contents WHERE parentId = ? AND (repostOfId IS NULL OR repostOfId = \'\')').get(contentId).cnt;
  }

  getUserCount() {
    return this.db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  }

  getAgentCount() {
    return this.db.prepare('SELECT COUNT(*) as cnt FROM agents').get().cnt;
  }

  getContentCount() {
    return this.db.prepare('SELECT COUNT(*) as cnt FROM contents').get().cnt;
  }

  getContentCountByAuthor(agentId) {
    return this.db.prepare('SELECT COUNT(*) as cnt FROM contents WHERE authorAgentId = ?').get(agentId).cnt;
  }

  incrementViewCount(contentId) {
    this.db.prepare('UPDATE contents SET viewCount = viewCount + 1 WHERE id = ?').run(contentId);
  }

  incrementViewCounts(contentIds) {
    if (!contentIds.length) return;
    const stmt = this.db.prepare('UPDATE contents SET viewCount = viewCount + 1 WHERE id = ?');
    const tx = this.db.transaction(() => { for (const id of contentIds) stmt.run(id); });
    tx();
  }

  insertAgentDirect(agent) {
    this.db.prepare(`INSERT OR IGNORE INTO agents (id, ownerUserId, name, bio, avatarUrl, activenessLevel, intelligenceLevel, intervalMinutes, credits, subscriptionFee, enabled, isFree, preferences, runConfig, mcpServers, externalArticlesHistory, createdAt, lastActionAt, nextActionAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      agent.id, agent.ownerUserId, agent.name, agent.bio || '', agent.avatarUrl || '',
      agent.activenessLevel || 'medium', agent.intelligenceLevel || 'dumb',
      agent.intervalMinutes ?? 99999, agent.credits ?? 0, agent.subscriptionFee ?? 0,
      agent.enabled ? 1 : 0, agent.isFree ? 1 : 0,
      js(agent.preferences || {}), js(agent.runConfig || {}),
      js(agent.mcpServers || []), js(agent.externalArticlesHistory || []),
      agent.createdAt || nowIso(), agent.lastActionAt || null, agent.nextActionAt || null
    );
  }

  // ── User methods ───────────────────────────────────────────────────────────

  createUser({ name, userType = 'human', initialCredits = 100, password = '', subscriptionFee = 0, bio = '', googleId = null, email = null, avatarUrl = '' }) {
    if (this.getUserByName(name)) {
      throw new Error(`Username "${name}" is already taken.`);
    }
    const user = {
      id: newId('user'),
      name,
      bio: String(bio || ''),
      avatarUrl: avatarUrl || '',
      userType,
      apiKey: newId('key'),
      passwordHash: hashPassword(password || newId('pw')),
      credits: Number(initialCredits),
      subscriptionFee: Number(subscriptionFee),
      stripeCustomerId: null,
      googleId: googleId || null,
      email: email || null,
      createdAt: nowIso()
    };
    this.db.prepare(`INSERT INTO users (id, name, bio, avatarUrl, userType, apiKey, passwordHash, credits, subscriptionFee, stripeCustomerId, googleId, email, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      user.id, user.name, user.bio, user.avatarUrl, user.userType,
      user.apiKey, user.passwordHash, user.credits, user.subscriptionFee,
      user.stripeCustomerId, user.googleId, user.email, user.createdAt
    );
    return user;
  }

  getUser(userId) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) || null;
  }

  updateUser(userId, patch) {
    const user = this.getUser(userId);
    if (!user) return null;
    if (patch.bio !== undefined) this.db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(String(patch.bio || ''), userId);
    if (patch.name !== undefined) this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(patch.name), userId);
    if (patch.avatarUrl !== undefined) this.db.prepare('UPDATE users SET avatarUrl = ? WHERE id = ?').run(String(patch.avatarUrl || ''), userId);
    if (patch.googleId !== undefined) this.db.prepare('UPDATE users SET googleId = ? WHERE id = ?').run(patch.googleId, userId);
    if (patch.email !== undefined) this.db.prepare('UPDATE users SET email = ? WHERE id = ?').run(patch.email, userId);
    return this.getUser(userId);
  }

  getUserByName(name) {
    const lower = String(name || '').toLowerCase();
    return this.db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(lower) || null;
  }

  getUserByApiKey(apiKey) {
    return this.db.prepare('SELECT * FROM users WHERE apiKey = ?').get(apiKey) || null;
  }

  getUserByGoogleId(googleId) {
    return this.db.prepare('SELECT * FROM users WHERE googleId = ?').get(googleId) || null;
  }

  getUserByEmail(email) {
    return this.db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email) || null;
  }

  verifyUserPassword(userId, password) {
    const user = this.getUser(userId);
    if (!user) return false;
    return verifyPassword(password, user.passwordHash);
  }

  // ── Auth sessions ──────────────────────────────────────────────────────────

  createAuthSession(userId, ttlHours = 24 * 7) {
    const user = this.getUser(userId);
    if (!user) throw new Error('User not found.');
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
    const session = { id: newId('sess'), token: newId('token'), userId, createdAt: nowIso(), expiresAt };
    this.db.prepare(`INSERT INTO authSessions (id, token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)`).run(
      session.id, session.token, session.userId, session.createdAt, session.expiresAt
    );
    // Prune old sessions
    const count = this.db.prepare('SELECT COUNT(*) as cnt FROM authSessions').get().cnt;
    if (count > 5000) {
      this.db.prepare('DELETE FROM authSessions WHERE id IN (SELECT id FROM authSessions ORDER BY createdAt ASC LIMIT ?)').run(count - 5000);
    }
    return session;
  }

  getUserBySessionToken(token) {
    const session = this.db.prepare('SELECT * FROM authSessions WHERE token = ?').get(token);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
    return this.getUser(session.userId) || null;
  }

  revokeSession(token) {
    this.db.prepare('DELETE FROM authSessions WHERE token = ?').run(token);
  }

  // ── Agent methods ──────────────────────────────────────────────────────────

  createAgent({ ownerUserId, name, bio = '', activenessLevel = 'medium', intelligenceLevel = 'dumb', preferences, runConfig }) {
    const intervalMinutes = this.getActivenessConfig(activenessLevel).intervalMinutes;
    const createdAt = nowIso();
    const nextActionAt = new Date(new Date(createdAt).getTime() + intervalMinutes * 60_000).toISOString();
    const prefs = { ...defaultAgentPreferences(), ...preferences };
    const rc = { ...defaultAgentRunConfig(), ...runConfig };
    const agent = {
      id: newId('agent'), ownerUserId, name, bio, avatarUrl: '',
      activenessLevel, intelligenceLevel, intervalMinutes,
      credits: 0, subscriptionFee: 0, enabled: true, isFree: false,
      preferences: prefs, runConfig: rc,
      mcpServers: [], externalArticlesHistory: [],
      createdAt, lastActionAt: null, nextActionAt
    };
    this.db.prepare(`INSERT INTO agents (id, ownerUserId, name, bio, avatarUrl, activenessLevel, intelligenceLevel, intervalMinutes, credits, subscriptionFee, enabled, isFree, preferences, runConfig, mcpServers, externalArticlesHistory, createdAt, lastActionAt, nextActionAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      agent.id, agent.ownerUserId, agent.name, agent.bio, agent.avatarUrl,
      agent.activenessLevel, agent.intelligenceLevel, agent.intervalMinutes,
      agent.credits, agent.subscriptionFee, agent.enabled ? 1 : 0, 0,
      js(agent.preferences), js(agent.runConfig), js([]), js([]),
      agent.createdAt, null, agent.nextActionAt
    );
    // Owner auto-subscribes
    this.follow({ followerKind: 'user', followerId: ownerUserId, followeeKind: 'agent', followeeId: agent.id });
    return agent;
  }

  getAgent(agentId) {
    return hydrateAgent(this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId));
  }

  updateAgent(agentId, patch) {
    const agent = this.getAgent(agentId);
    if (!agent) return null;

    const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = { ...agent, ...cleanPatch };

    if (patch.activenessLevel) {
      const intervalMinutes = this.getActivenessConfig(patch.activenessLevel).intervalMinutes;
      next.intervalMinutes = intervalMinutes;
      if (!patch.nextActionAt) {
        const intervalMs = intervalMinutes * 60_000;
        const created = new Date(agent.createdAt).getTime();
        const now = Date.now();
        const elapsed = now - created;
        const periods = Math.floor(elapsed / intervalMs) + 1;
        next.nextActionAt = new Date(created + periods * intervalMs).toISOString();
      }
    }
    if (patch.preferences) {
      next.preferences = { ...agent.preferences, ...patch.preferences };
    }
    if (patch.runConfig) {
      next.runConfig = { ...agent.runConfig, ...patch.runConfig };
    }

    // Enrich defaults
    if (!next.name) next.name = 'Agent ' + next.id.slice(-6);
    if (!next.activenessLevel) next.activenessLevel = 'medium';
    if (!next.preferences) next.preferences = defaultAgentPreferences();
    if (!next.runConfig) next.runConfig = defaultAgentRunConfig();

    this.db.prepare(`UPDATE agents SET
      ownerUserId=?, name=?, bio=?, avatarUrl=?, activenessLevel=?, intelligenceLevel=?,
      intervalMinutes=?, credits=?, subscriptionFee=?, enabled=?, isFree=?,
      preferences=?, runConfig=?, mcpServers=?, externalArticlesHistory=?,
      lastActionAt=?, nextActionAt=?
      WHERE id=?`).run(
      next.ownerUserId, next.name, next.bio || '', next.avatarUrl || '',
      next.activenessLevel, next.intelligenceLevel || 'dumb',
      next.intervalMinutes, next.credits ?? 0, next.subscriptionFee ?? 0,
      next.enabled ? 1 : 0, next.isFree ? 1 : 0,
      js(next.preferences), js(next.runConfig),
      js(next.mcpServers || []), js(next.externalArticlesHistory || []),
      next.lastActionAt || null, next.nextActionAt || null,
      agentId
    );
    return this.getAgent(agentId);
  }

  getOwnedAgents(userId) {
    return this.db.prepare('SELECT * FROM agents WHERE ownerUserId = ?').all(userId).map(hydrateAgent);
  }

  deleteAgent(agentId, ownerUserId) {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error('Agent not found.');
    if (agent.ownerUserId !== ownerUserId) throw new Error('Not the owner of this agent.');
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
      this.db.prepare("DELETE FROM follows WHERE (followeeKind = 'agent' AND followeeId = ?) OR (followerKind = 'agent' AND followerId = ?)").run(agentId, agentId);
    });
    tx();
    return agent;
  }

  enrichAgentDefaults(agent) {
    // No-op for backward compat — enrichment happens in createAgent/updateAgent and migration
  }

  // ── Content methods ────────────────────────────────────────────────────────

  createContent({ authorKind = 'agent', authorId, authorAgentId, title = '', text = '', mediaType = 'text', mediaUrl = '', media = [], tags = [], parentId = null, repostOfId = null }) {
    const resolvedKind = authorKind;
    const resolvedId = authorId || authorAgentId;
    const summary = (title || '').slice(0, 80) || (text || '').slice(0, 80) || '(no text)';
    const content = {
      id: newId('content'),
      authorKind: resolvedKind,
      authorId: resolvedId,
      authorAgentId: resolvedKind === 'agent' ? resolvedId : null,
      authorUserId: resolvedKind === 'user' ? resolvedId : null,
      parentId: parentId || null,
      repostOfId: repostOfId || null,
      title, text, summary,
      mediaType, mediaUrl,
      media: Array.isArray(media) ? media : [],
      tags: tags || [],
      createdAt: nowIso(),
      viewCount: 0
    };
    this.db.prepare(`INSERT INTO contents (id, authorKind, authorId, authorAgentId, authorUserId, parentId, repostOfId, title, text, summary, mediaType, mediaUrl, media, tags, viewCount, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      content.id, content.authorKind, content.authorId, content.authorAgentId, content.authorUserId,
      content.parentId, content.repostOfId, content.title, content.text, content.summary,
      content.mediaType, content.mediaUrl, js(content.media), js(content.tags),
      content.viewCount, content.createdAt
    );
    return content;
  }

  deleteContent(contentId, actorKind, actorId) {
    const content = this.getContent(contentId);
    if (!content) throw new Error('Content not found.');
    if (content.authorKind !== actorKind || content.authorId !== actorId) {
      throw new Error('Not the author of this content.');
    }
    // Recursively collect all descendant ids
    const toDelete = new Set();
    const collect = (id) => {
      toDelete.add(id);
      const children = this.db.prepare('SELECT id FROM contents WHERE parentId = ?').all(id);
      for (const child of children) collect(child.id);
    };
    collect(contentId);

    const tx = this.db.transaction(() => {
      for (const id of toDelete) {
        this.db.prepare('DELETE FROM contents WHERE id = ?').run(id);
        this.db.prepare('DELETE FROM reactions WHERE contentId = ?').run(id);
        this.db.prepare("DELETE FROM viewHistory WHERE targetKind = 'content' AND targetId = ?").run(id);
      }
    });
    tx();
  }

  getAgentPublished(agentId) {
    return this.db.prepare("SELECT * FROM contents WHERE authorKind = 'agent' AND authorId = ? AND (parentId IS NULL OR parentId = '') AND (repostOfId IS NULL OR repostOfId = '') ORDER BY createdAt ASC").all(agentId).map(hydrateContent);
  }

  getUserPublished(userId) {
    return this.db.prepare("SELECT * FROM contents WHERE authorKind = 'user' AND authorId = ? AND (parentId IS NULL OR parentId = '') AND (repostOfId IS NULL OR repostOfId = '') ORDER BY createdAt ASC").all(userId).map(hydrateContent);
  }

  getUserAllContent(userId) {
    return this.db.prepare("SELECT * FROM contents WHERE authorKind = 'user' AND authorId = ? ORDER BY createdAt DESC").all(userId).map(hydrateContent);
  }

  listFeed() {
    return this.db.prepare("SELECT * FROM contents WHERE (parentId IS NULL OR parentId = '') ORDER BY createdAt DESC").all().map(hydrateContent);
  }

  getPersonalizedFeed({ followerKind, followerId }) {
    const followedKeys = this.db.prepare('SELECT followeeKind, followeeId FROM follows WHERE followerKind = ? AND followerId = ?').all(followerKind, followerId);
    if (!followedKeys.length) return [];
    // Build a set of "kind:id" for quick filtering
    const followedSet = new Set(followedKeys.map(f => `${f.followeeKind}:${f.followeeId}`));
    // Fetch all top-level content and filter by followed authors
    const all = this.db.prepare("SELECT * FROM contents WHERE (parentId IS NULL OR parentId = '') ORDER BY createdAt DESC").all().map(hydrateContent);
    return all.filter(c => followedSet.has(`${c.authorKind}:${c.authorId}`));
  }

  getChildren(contentId) {
    return this.db.prepare('SELECT * FROM contents WHERE parentId = ? ORDER BY createdAt ASC').all(contentId).map(hydrateContent);
  }

  getAncestors(contentId) {
    const ancestors = [];
    let current = this.getContent(contentId);
    while (current?.parentId) {
      const parent = this.getContent(current.parentId);
      if (!parent) break;
      ancestors.unshift(parent);
      current = parent;
    }
    return ancestors;
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  search({ query = '', type = 'all' }) {
    const raw = query.trim();
    const isTagSearch = raw.startsWith('#') && raw.length > 1;
    const tagName = isTagSearch ? raw.slice(1).toLowerCase() : '';
    const q = raw.toLowerCase();
    const results = { agents: [], users: [], contents: [] };

    if (!isTagSearch && (type === 'all' || type === 'agents')) {
      if (q) {
        results.agents = this.db.prepare("SELECT * FROM agents WHERE name LIKE ? OR bio LIKE ?").all(`%${q}%`, `%${q}%`).map(hydrateAgent);
      } else {
        results.agents = this.getAllAgents();
      }
    }

    if (!isTagSearch && (type === 'all' || type === 'users')) {
      const rows = q
        ? this.db.prepare('SELECT * FROM users WHERE name LIKE ?').all(`%${q}%`)
        : this.getAllUsers();
      results.users = rows.map(u => ({ id: u.id, name: u.name, userType: u.userType, credits: u.credits, avatarUrl: u.avatarUrl || '', createdAt: u.createdAt }));
    }

    if (type === 'all' || type === 'contents') {
      if (isTagSearch) {
        // Search by exact tag — tags stored as JSON array
        const all = this.db.prepare("SELECT * FROM contents WHERE (parentId IS NULL OR parentId = '') ORDER BY createdAt DESC").all().map(hydrateContent);
        results.contents = all.filter(c => (c.tags || []).some(t => t.toLowerCase() === tagName));
      } else if (q) {
        results.contents = this.db.prepare("SELECT * FROM contents WHERE (parentId IS NULL OR parentId = '') AND (title LIKE ? OR text LIKE ? OR tags LIKE ?) ORDER BY createdAt DESC").all(`%${q}%`, `%${q}%`, `%${q}%`).map(hydrateContent);
      } else {
        results.contents = this.db.prepare("SELECT * FROM contents WHERE (parentId IS NULL OR parentId = '') ORDER BY createdAt DESC").all().map(hydrateContent);
      }
    }

    return results;
  }

  searchByName(query) {
    const q = String(query || '').toLowerCase().trim();
    const results = [];
    const users = q
      ? this.db.prepare('SELECT id, name, avatarUrl FROM users WHERE name LIKE ? LIMIT 10').all(`%${q}%`)
      : this.db.prepare('SELECT id, name, avatarUrl FROM users LIMIT 10').all();
    for (const u of users) {
      results.push({ kind: 'user', id: u.id, name: u.name, avatarUrl: u.avatarUrl || '' });
      if (results.length >= 10) return results;
    }
    const agents = q
      ? this.db.prepare('SELECT id, name, avatarUrl FROM agents WHERE name LIKE ? LIMIT ?').all(`%${q}%`, 10 - results.length)
      : this.db.prepare('SELECT id, name, avatarUrl FROM agents LIMIT ?').all(10 - results.length);
    for (const a of agents) {
      results.push({ kind: 'agent', id: a.id, name: a.name, avatarUrl: a.avatarUrl || '' });
      if (results.length >= 10) return results;
    }
    return results;
  }

  getAllNames() {
    const results = [];
    for (const u of this.db.prepare('SELECT id, name, avatarUrl FROM users').all()) {
      results.push({ kind: 'user', id: u.id, name: u.name, avatarUrl: u.avatarUrl || '' });
    }
    for (const a of this.db.prepare('SELECT id, name, avatarUrl FROM agents').all()) {
      results.push({ kind: 'agent', id: a.id, name: a.name, avatarUrl: a.avatarUrl || '' });
    }
    return results;
  }

  // ── Follow / Subscription methods ──────────────────────────────────────────

  _findFollow({ followerKind, followerId, followeeKind, followeeId }) {
    return hydrateFollow(this.db.prepare('SELECT * FROM follows WHERE followerKind = ? AND followerId = ? AND followeeKind = ? AND followeeId = ?').get(followerKind, followerId, followeeKind, followeeId));
  }

  _followDirect({ followerKind, followerId, followeeKind, followeeId }) {
    const exists = this._findFollow({ followerKind, followerId, followeeKind, followeeId });
    if (!exists) {
      this.db.prepare(`INSERT INTO follows (id, followerKind, followerId, followeeKind, followeeId, createdAt, lastChargedAt, expiresAt, cancelledAt, subscribedFee)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        newId('follow'), followerKind, followerId, followeeKind, followeeId, nowIso(), null, null, null, 0
      );
    }
  }

  setSubscriptionFee(kind, id, fee) {
    const numFee = Math.max(0, Number(fee || 0));
    if (kind === 'user') {
      const user = this.getUser(id);
      if (!user) throw new Error('User not found.');
      this.db.prepare('UPDATE users SET subscriptionFee = ? WHERE id = ?').run(numFee, id);
    } else {
      const agent = this.getAgent(id);
      if (!agent) throw new Error('Agent not found.');
      this.db.prepare('UPDATE agents SET subscriptionFee = ? WHERE id = ?').run(numFee, id);
    }
  }

  follow({ followerKind = 'agent', followerId, followeeKind = 'agent', followeeId }) {
    if (followerKind === followeeKind && followerId === followeeId) {
      throw new Error('Cannot follow yourself.');
    }

    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const followee = followeeKind === 'user' ? this.getUser(followeeId) : this.getAgent(followeeId);
    const hasFee = followee && followee.subscriptionFee > 0;
    const existing = this._findFollow({ followerKind, followerId, followeeKind, followeeId });

    if (existing) {
      const isExpired = existing.expiresAt && new Date(existing.expiresAt).getTime() <= Date.now();

      if (existing.cancelledAt && !isExpired) {
        this.db.prepare('UPDATE follows SET cancelledAt = NULL WHERE id = ?').run(existing.id);
        return;
      }

      if (existing.cancelledAt && isExpired) {
        this.db.prepare('DELETE FROM follows WHERE id = ?').run(existing.id);
      } else if (!existing.cancelledAt) {
        return;
      }
    }

    const tx = this.db.transaction(() => {
      if (hasFee) {
        let payer;
        if (followerKind === 'agent') {
          const agent = this.getAgent(followerId);
          payer = agent ? this.getUser(agent.ownerUserId) : null;
        } else {
          payer = this.getUser(followerId);
        }
        if (!payer) throw new Error('Follower (or owner) not found.');

        let payee;
        if (followeeKind === 'agent') {
          const agent = this.getAgent(followeeId);
          payee = agent ? this.getUser(agent.ownerUserId) : null;
        } else {
          payee = this.getUser(followeeId);
        }

        if (payer.credits < followee.subscriptionFee) {
          throw new Error(`Insufficient credits. Following ${followee.name || 'this user'} costs ${followee.subscriptionFee} cr/month.`);
        }
        this.db.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').run(followee.subscriptionFee, payer.id);
        if (payee) this.db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(followee.subscriptionFee, payee.id);
        this.db.prepare(`INSERT INTO transfers (id, type, fromKind, fromId, toKind, toId, amount, meta, description, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          newId('tx'), 'subscription', followerKind, followerId, followeeKind, followeeId,
          followee.subscriptionFee, '{}', '', nowIso()
        );
      }

      const now = nowIso();
      this.db.prepare(`INSERT INTO follows (id, followerKind, followerId, followeeKind, followeeId, createdAt, lastChargedAt, expiresAt, cancelledAt, subscribedFee)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        newId('follow'), followerKind, followerId, followeeKind, followeeId,
        now, hasFee ? now : null,
        hasFee ? new Date(Date.now() + THIRTY_DAYS).toISOString() : null,
        null, hasFee ? followee.subscriptionFee : 0
      );
    });
    tx();
  }

  chargeMonthlySubscriptions() {
    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const allFollows = this.getAllFollows();
    const toRemove = [];
    let charged = 0;

    const tx = this.db.transaction(() => {
      for (const f of allFollows) {
        if (f.cancelledAt && f.expiresAt && new Date(f.expiresAt).getTime() <= now) {
          toRemove.push(f.id);
          continue;
        }
        if (!f.lastChargedAt) continue;
        if (f.cancelledAt) continue;
        if (f.expiresAt && new Date(f.expiresAt).getTime() > now) continue;

        const followee = f.followeeKind === 'user' ? this.getUser(f.followeeId) : this.getAgent(f.followeeId);
        const renewalFee = followee ? followee.subscriptionFee : 0;
        if (!renewalFee || renewalFee <= 0) {
          this.db.prepare('UPDATE follows SET subscribedFee = 0, lastChargedAt = NULL, expiresAt = NULL WHERE id = ?').run(f.id);
          continue;
        }

        let payer;
        if (f.followerKind === 'agent') {
          const agent = this.getAgent(f.followerId);
          payer = agent ? this.getUser(agent.ownerUserId) : null;
        } else {
          payer = this.getUser(f.followerId);
        }
        if (!payer) { toRemove.push(f.id); continue; }

        let payee;
        if (f.followeeKind === 'agent') {
          const agent = this.getAgent(f.followeeId);
          payee = agent ? this.getUser(agent.ownerUserId) : null;
        } else {
          payee = this.getUser(f.followeeId);
        }

        if (payer.credits < renewalFee) { toRemove.push(f.id); continue; }

        this.db.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').run(renewalFee, payer.id);
        if (payee) this.db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(renewalFee, payee.id);
        const chargeTime = nowIso();
        this.db.prepare('UPDATE follows SET lastChargedAt = ?, expiresAt = ?, subscribedFee = ? WHERE id = ?').run(
          chargeTime, new Date(now + THIRTY_DAYS).toISOString(), renewalFee, f.id
        );
        charged++;
        this.db.prepare(`INSERT INTO transfers (id, type, fromKind, fromId, toKind, toId, amount, meta, description, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          newId('tx'), 'subscription_renewal', f.followerKind, f.followerId, f.followeeKind, f.followeeId, renewalFee, '{}', '', chargeTime
        );
      }

      for (const id of toRemove) {
        this.db.prepare('DELETE FROM follows WHERE id = ?').run(id);
      }
    });
    tx();
    return { charged, removed: toRemove.length };
  }

  unfollow({ followerKind = 'agent', followerId, followeeKind = 'agent', followeeId }) {
    const follow = this._findFollow({ followerKind, followerId, followeeKind, followeeId });
    if (!follow) return;

    if (follow.expiresAt && new Date(follow.expiresAt).getTime() > Date.now() && !follow.cancelledAt) {
      this.db.prepare('UPDATE follows SET cancelledAt = ? WHERE id = ?').run(nowIso(), follow.id);
      return;
    }
    this.db.prepare('DELETE FROM follows WHERE id = ?').run(follow.id);
  }

  isFollowing({ followerKind, followerId, followeeKind, followeeId }) {
    const f = this._findFollow({ followerKind, followerId, followeeKind, followeeId });
    if (!f) return false;
    if (f.cancelledAt && f.expiresAt && new Date(f.expiresAt).getTime() <= Date.now()) return false;
    return true;
  }

  getFollowInfo({ followerKind, followerId, followeeKind, followeeId }) {
    const f = this._findFollow({ followerKind, followerId, followeeKind, followeeId });
    if (!f) return null;
    if (f.cancelledAt && f.expiresAt && new Date(f.expiresAt).getTime() <= Date.now()) return null;
    return {
      isFollowing: true,
      cancelledAt: f.cancelledAt || null,
      expiresAt: f.expiresAt || null,
      lastChargedAt: f.lastChargedAt || null,
      subscribedFee: f.subscribedFee != null ? f.subscribedFee : 0
    };
  }

  getActorFollowers(followeeKind, followeeId) {
    const now = Date.now();
    const rows = this.db.prepare('SELECT * FROM follows WHERE followeeKind = ? AND followeeId = ?').all(followeeKind, followeeId).map(hydrateFollow);
    return rows
      .filter(f => !(f.cancelledAt && f.expiresAt && new Date(f.expiresAt).getTime() <= now))
      .map(f => {
        let entity;
        if (f.followerKind === 'agent') entity = { kind: 'agent', ...this.getAgent(f.followerId) };
        else if (f.followerKind === 'user') {
          const u = this.getUser(f.followerId);
          entity = u ? { kind: 'user', id: u.id, name: u.name, userType: u.userType, avatarUrl: u.avatarUrl || '' } : null;
        }
        return entity || null;
      })
      .filter(Boolean);
  }

  getActorFollowing(followerKind, followerId) {
    const now = Date.now();
    const rows = this.db.prepare('SELECT * FROM follows WHERE followerKind = ? AND followerId = ?').all(followerKind, followerId).map(hydrateFollow);
    return rows
      .filter(f => !(f.cancelledAt && f.expiresAt && new Date(f.expiresAt).getTime() <= now))
      .map(f => {
        let entity;
        if (f.followeeKind === 'agent') entity = { kind: 'agent', ...this.getAgent(f.followeeId) };
        else if (f.followeeKind === 'user') {
          const u = this.getUser(f.followeeId);
          entity = u ? { kind: 'user', id: u.id, name: u.name, userType: u.userType, avatarUrl: u.avatarUrl || '', bio: u.bio || '' } : null;
        }
        if (!entity) return null;
        entity.subscriptionFee = f.subscribedFee != null ? f.subscribedFee : (entity.subscriptionFee || 0);
        entity.followCancelledAt = f.cancelledAt || null;
        entity.followExpiresAt = f.expiresAt || null;
        return entity;
      })
      .filter(Boolean);
  }

  getAgentFollowers(agentId) { return this.getActorFollowers('agent', agentId); }
  getAgentFollowing(agentId) { return this.getActorFollowing('agent', agentId); }

  getActorStats(kind, id) {
    const posts = this.db.prepare("SELECT COUNT(*) as cnt FROM contents WHERE authorKind = ? AND authorId = ? AND (parentId IS NULL OR parentId = '')").get(kind, id).cnt;
    const now = new Date().toISOString();
    // Active followers
    const followers = this.db.prepare(`SELECT COUNT(*) as cnt FROM follows WHERE followeeKind = ? AND followeeId = ?
      AND (cancelledAt IS NULL OR expiresAt IS NULL OR expiresAt > ?)`).get(kind, id, now).cnt;
    const following = this.db.prepare(`SELECT COUNT(*) as cnt FROM follows WHERE followerKind = ? AND followerId = ?
      AND (cancelledAt IS NULL OR expiresAt IS NULL OR expiresAt > ?)`).get(kind, id, now).cnt;
    // Total likes received on this actor's content
    const totalLikes = this.db.prepare(`SELECT COUNT(*) as cnt FROM reactions r
      JOIN contents c ON r.contentId = c.id
      WHERE c.authorKind = ? AND c.authorId = ? AND r.type = 'like'`).get(kind, id).cnt;
    const result = { posts, followers, following, totalLikes };
    if (kind === 'user') {
      result.agents = this.db.prepare('SELECT COUNT(*) as cnt FROM agents WHERE ownerUserId = ?').get(id).cnt;
    }
    return result;
  }

  getAgentStats(agentId) { return this.getActorStats('agent', agentId); }

  // ── Reactions ──────────────────────────────────────────────────────────────

  react({ actorKind = 'agent', actorId, agentId, contentId, type }) {
    const resolvedKind = actorKind;
    const resolvedId = actorId || agentId;
    const valid = new Set(['like', 'dislike', 'favorite']);
    if (!valid.has(type)) throw new Error('Invalid reaction type.');

    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM reactions WHERE actorKind = ? AND actorId = ? AND contentId = ? AND type = ?').run(resolvedKind, resolvedId, contentId, type);
      this.db.prepare(`INSERT INTO reactions (id, actorKind, actorId, agentId, userId, contentId, type, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        newId('reaction'), resolvedKind, resolvedId,
        resolvedKind === 'agent' ? resolvedId : null,
        resolvedKind === 'user' ? resolvedId : null,
        contentId, type, nowIso()
      );
    });
    tx();
  }

  unreact({ actorKind = 'agent', actorId, agentId, contentId, type }) {
    const resolvedKind = actorKind;
    const resolvedId = actorId || agentId;
    const valid = new Set(['like', 'dislike', 'favorite']);
    if (!valid.has(type)) throw new Error('Invalid reaction type.');
    this.db.prepare('DELETE FROM reactions WHERE actorKind = ? AND actorId = ? AND contentId = ? AND type = ?').run(resolvedKind, resolvedId, contentId, type);
  }

  getActorReactions(actorKind, actorId, type) {
    const reactions = this.db.prepare(`SELECT * FROM reactions WHERE (actorKind = ? AND actorId = ? AND type = ?) OR (? = 'agent' AND agentId = ? AND type = ?) ORDER BY createdAt DESC`)
      .all(actorKind, actorId, type, actorKind, actorId, type);
    const contentIds = reactions.map(r => r.contentId);
    return contentIds.map(id => this.getContent(id)).filter(Boolean);
  }

  getAgentFavorites(agentId) { return this.getActorReactions('agent', agentId, 'favorite'); }
  getAgentLiked(agentId) { return this.getActorReactions('agent', agentId, 'like'); }

  // ── View history ───────────────────────────────────────────────────────────

  recordView({ actorKind, actorId, targetKind, targetId }) {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM viewHistory WHERE actorKind = ? AND actorId = ? AND targetKind = ? AND targetId = ?').run(actorKind, actorId, targetKind, targetId);
      this.db.prepare(`INSERT INTO viewHistory (id, actorKind, actorId, targetKind, targetId, createdAt) VALUES (?, ?, ?, ?, ?, ?)`).run(
        newId('view'), actorKind, actorId, targetKind, targetId, nowIso()
      );
      if (targetKind === 'content') {
        this.db.prepare('UPDATE contents SET viewCount = viewCount + 1 WHERE id = ?').run(targetId);
      }
    });
    tx();
  }

  getActorViewHistory(actorKind, actorId, targetKind) {
    const views = this.db.prepare('SELECT * FROM viewHistory WHERE actorKind = ? AND actorId = ? AND targetKind = ? ORDER BY createdAt DESC').all(actorKind, actorId, targetKind);
    return views.map(v => {
      if (v.targetKind === 'content') return this.getContent(v.targetId);
      if (v.targetKind === 'agent') return this.getAgent(v.targetId);
      if (v.targetKind === 'user') return this.getUser(v.targetId);
      return null;
    }).filter(Boolean);
  }

  // ── External Favorites ─────────────────────────────────────────────────────

  addExternalFavorite(agentId, { title, summary, url, source, tags }) {
    if (!url) throw new Error('url is required.');
    const existing = this.db.prepare('SELECT * FROM externalFavorites WHERE agentId = ? AND url = ?').get(agentId, url);
    if (existing) return hydrateExternalFavorite(existing);
    const item = {
      id: newId('extfav'), agentId,
      title: (title || '').slice(0, 300),
      summary: (summary || '').slice(0, 1000),
      url, source: source || '',
      tags: tags || [],
      createdAt: nowIso()
    };
    this.db.prepare(`INSERT INTO externalFavorites (id, agentId, title, summary, url, source, tags, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      item.id, item.agentId, item.title, item.summary, item.url, item.source, js(item.tags), item.createdAt
    );
    return item;
  }

  removeExternalFavorite(agentId, itemId) {
    const info = this.db.prepare('DELETE FROM externalFavorites WHERE agentId = ? AND id = ?').run(agentId, itemId);
    return info.changes > 0;
  }

  getExternalFavorites(agentId, { page = 1, perPage = 20 } = {}) {
    const total = this.db.prepare('SELECT COUNT(*) as cnt FROM externalFavorites WHERE agentId = ?').get(agentId).cnt;
    const totalPages = Math.ceil(total / perPage) || 1;
    const offset = (page - 1) * perPage;
    const items = this.db.prepare('SELECT * FROM externalFavorites WHERE agentId = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?').all(agentId, perPage, offset).map(hydrateExternalFavorite);
    return { items, page, perPage, total, totalPages };
  }

  // ── Comment (legacy compat) ────────────────────────────────────────────────

  comment({ actorKind = 'agent', actorId, agentId, contentId, text }) {
    return this.createContent({
      authorKind: actorKind,
      authorId: actorId || agentId,
      parentId: contentId,
      text,
    });
  }

  // ── Credits & Billing ──────────────────────────────────────────────────────

  addCreditsToUser(userId, amount, meta = {}) {
    const user = this.getUser(userId);
    if (!user) throw new Error('User not found.');
    const credits = Number(amount) * CREDITS_PER_DOLLAR;
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(credits, userId);
      this.db.prepare(`INSERT INTO transfers (id, type, fromKind, fromId, toKind, toId, amount, meta, description, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        newId('tx'), 'topup', 'stripe', 'stripe', 'user', userId,
        Number(amount), js(meta), '', nowIso()
      );
    });
    tx();
    return this.getUser(userId);
  }

  getUserBillingHistory(userId, { page = 1, perPage = 20 } = {}) {
    const topups = this.db.prepare("SELECT * FROM transfers WHERE type = 'topup' AND toKind = 'user' AND toId = ? ORDER BY createdAt DESC").all(userId).map(hydrateTransfer);
    const entries = topups.map(t => ({
      id: t.id, date: t.createdAt,
      dollars: t.amount, credits: t.amount * CREDITS_PER_DOLLAR
    }));
    const totalDollars = entries.reduce((s, e) => s + e.dollars, 0);
    const totalCredits = entries.reduce((s, e) => s + e.credits, 0);
    const total = entries.length;
    const totalPages = Math.ceil(total / perPage) || 1;
    const paged = entries.slice((page - 1) * perPage, page * perPage);
    return { entries: paged, page, perPage, total, totalPages, totalDollars, totalCredits };
  }

  getActivenessConfig(level) {
    const table = {
      very_lazy: { intervalMinutes: 48 * 60 },
      lazy: { intervalMinutes: 24 * 60 },
      medium: { intervalMinutes: 12 * 60 },
      diligent: { intervalMinutes: 6 * 60 },
      very_diligent: { intervalMinutes: 3 * 60 },
      workaholic: { intervalMinutes: 60 }
    };
    return table[level] || table.medium;
  }

  chargeTenantFee(agentId, reason = 'scheduled_action') {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error('Agent not found.');
    const fee = this.calculateRunCost(agent);

    if (agent.credits < fee) {
      this.db.prepare('UPDATE agents SET enabled = 0 WHERE id = ?').run(agentId);
      return { charged: 0, disabled: true, reason: 'insufficient_agent_credits' };
    }

    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE agents SET credits = credits - ? WHERE id = ?').run(fee, agentId);
      this.db.prepare(`INSERT INTO tenantCharges (id, agentId, amount, reason, createdAt) VALUES (?, ?, ?, ?, ?)`).run(
        newId('tenant'), agentId, fee, reason, nowIso()
      );
    });
    tx();
    return { charged: fee, disabled: false };
  }

  calculateRunCost(agent) {
    const costPerStepTable = { dumb: 0.1, not_so_smart: 0.5, mediocre: 2.0, smart: 4.0 };
    const costPerStep = costPerStepTable[agent.intelligenceLevel] || costPerStepTable.dumb;
    const phaseSteps = agent.runConfig?.phaseMaxSteps || {};
    const totalSteps = (phaseSteps.browse || 20) + (phaseSteps.external_search || 20) + (phaseSteps.create || 10);
    return Math.round(costPerStep * totalSteps);
  }

  transferCreditsToAgent(userId, agentId, amount) {
    const user = this.getUser(userId);
    if (!user) throw new Error('User not found.');
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error('Agent not found.');
    if (agent.ownerUserId !== userId) throw new Error('Not the owner of this agent.');
    if (amount <= 0) throw new Error('Amount must be positive.');
    if (user.credits < amount) throw new Error('Insufficient credits.');
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').run(amount, userId);
      this.db.prepare('UPDATE agents SET credits = credits + ? WHERE id = ?').run(amount, agentId);
      this.db.prepare(`INSERT INTO transfers (id, type, fromKind, fromId, toKind, toId, amount, meta, description, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        newId('tx'), 'transfer', 'user', userId, 'agent', agentId,
        amount, '{}', `Transfer ${amount} cr to agent ${agent.name}`, nowIso()
      );
    });
    tx();
    return { user: this.getUser(userId), agent: this.getAgent(agentId) };
  }

  withdrawCreditsFromAgent(userId, agentId, amount) {
    const user = this.getUser(userId);
    if (!user) throw new Error('User not found.');
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error('Agent not found.');
    if (agent.ownerUserId !== userId) throw new Error('Not the owner of this agent.');
    if (amount <= 0) throw new Error('Amount must be positive.');
    if (agent.credits < amount) throw new Error('Agent has insufficient credits.');
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE agents SET credits = credits - ? WHERE id = ?').run(amount, agentId);
      this.db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(amount, userId);
      this.db.prepare(`INSERT INTO transfers (id, type, fromKind, fromId, toKind, toId, amount, meta, description, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        newId('tx'), 'withdraw', 'agent', agentId, 'user', userId,
        amount, '{}', `Withdraw ${amount} cr from agent ${agent.name}`, nowIso()
      );
    });
    tx();
    return { user: this.getUser(userId), agent: this.getAgent(agentId) };
  }

  getMonthlyIncurredCost(agentId) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const row = this.db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM tenantCharges WHERE agentId = ? AND createdAt >= ?').get(agentId, monthStart);
    return row.total;
  }

  getAgentCostRuns(agentId, { page = 1, perPage = 20 } = {}) {
    const charges = this.db.prepare('SELECT * FROM tenantCharges WHERE agentId = ? ORDER BY createdAt DESC').all(agentId);
    const runs = this.db.prepare('SELECT * FROM agentRunLogs WHERE agentId = ? ORDER BY COALESCE(startedAt, createdAt) DESC').all(agentId).map(hydrateRunLog);

    const usedCharges = new Set();
    const entries = runs.map(run => {
      const runStart = new Date(run.startedAt || run.createdAt).getTime();
      let bestCharge = null;
      let bestDiff = Infinity;
      for (const c of charges) {
        if (usedCharges.has(c.id)) continue;
        const ct = new Date(c.createdAt).getTime();
        const diff = runStart - ct;
        if (diff >= 0 && diff < 300_000 && diff < bestDiff) { bestDiff = diff; bestCharge = c; }
      }
      if (bestCharge) usedCharges.add(bestCharge.id);
      const durationMs = run.finishedAt && run.startedAt ? new Date(run.finishedAt) - new Date(run.startedAt) : null;
      return {
        id: run.id, type: 'run', agentId: run.agentId,
        startedAt: run.startedAt || run.createdAt, finishedAt: run.finishedAt || null,
        durationMs, stepsExecuted: run.stepsExecuted || 0,
        cost: bestCharge ? bestCharge.amount : 0, amount: 0,
        reason: bestCharge ? bestCharge.reason : 'unknown'
      };
    });

    // Subscription fees paid by this agent
    const subPaid = this.db.prepare("SELECT * FROM transfers WHERE (type = 'subscription' OR type = 'subscription_renewal') AND fromKind = 'agent' AND fromId = ?").all(agentId).map(hydrateTransfer);
    for (const t of subPaid) {
      const followee = t.toKind === 'user' ? this.getUser(t.toId) : this.getAgent(t.toId);
      entries.push({
        id: t.id, type: 'subscription', agentId,
        startedAt: t.createdAt, finishedAt: null, durationMs: null, stepsExecuted: 0,
        cost: t.amount, amount: 0,
        reason: t.type === 'subscription_renewal' ? 'subscription_renewal' : 'subscription',
        detail: `Paid → ${followee?.name || t.toId}`
      });
    }

    // Subscription fees earned by this agent
    const subEarned = this.db.prepare("SELECT * FROM transfers WHERE (type = 'subscription' OR type = 'subscription_renewal') AND toKind = 'agent' AND toId = ?").all(agentId).map(hydrateTransfer);
    for (const t of subEarned) {
      const follower = t.fromKind === 'user' ? this.getUser(t.fromId) : this.getAgent(t.fromId);
      entries.push({
        id: t.id, type: 'subscription_earned', agentId,
        startedAt: t.createdAt, finishedAt: null, durationMs: null, stepsExecuted: 0,
        cost: 0, amount: t.amount,
        reason: t.type === 'subscription_renewal' ? 'sub_earned_renewal' : 'sub_earned',
        detail: `Earned ← ${follower?.name || t.fromId}`
      });
    }

    entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const total = entries.length;
    const totalPages = Math.ceil(total / perPage);
    const paged = entries.slice((page - 1) * perPage, page * perPage);
    const totalCost = charges.reduce((s, c) => s + c.amount, 0) + subPaid.reduce((s, t) => s + t.amount, 0);
    const totalEarned = subEarned.reduce((s, t) => s + t.amount, 0);
    const weeklyStats = computeWeeklyStats(entries);
    return { runs: paged, page, perPage, total, totalPages, totalCost, totalEarned, weeklyStats };
  }

  getAgentCreditStats(agentId) {
    const earned = this.db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM transfers WHERE (type = 'subscription' OR type = 'subscription_renewal') AND toKind = 'agent' AND toId = ?").get(agentId);
    const totalEarned = earned.total;

    const runCharges = this.db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM tenantCharges WHERE agentId = ?').get(agentId).total;
    const subPaid = this.db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM transfers WHERE (type = 'subscription' OR type = 'subscription_renewal') AND fromKind = 'agent' AND fromId = ?").get(agentId).total;
    const totalSpent = runCharges + subPaid;
    const net = totalEarned - totalSpent;

    const activeSubscribers = this.db.prepare('SELECT COUNT(*) as cnt FROM follows WHERE followeeId = ? AND cancelledAt IS NULL').get(agentId).cnt;

    const recentEarnings = this.db.prepare("SELECT * FROM transfers WHERE (type = 'subscription' OR type = 'subscription_renewal') AND toKind = 'agent' AND toId = ? ORDER BY createdAt DESC LIMIT 10").all(agentId).map(hydrateTransfer);
    const recentEarningsMapped = recentEarnings.map(t => {
      const follower = t.fromKind === 'user' ? this.getUser(t.fromId) : this.getAgent(t.fromId);
      return { date: t.createdAt, amount: t.amount, from: follower?.name || t.fromId };
    });

    return { totalEarned, totalSpent, runCharges, subscriptionsPaid: subPaid, net, activeSubscribers, recentEarnings: recentEarningsMapped };
  }

  getUserCostRuns(userId, { page = 1, perPage = 20 } = {}) {
    const ownedAgents = this.getOwnedAgents(userId);
    const agentNames = {};
    for (const a of ownedAgents) agentNames[a.id] = a.name;

    const entries = [];

    // Credit top-ups
    const topups = this.db.prepare("SELECT * FROM transfers WHERE type = 'topup' AND toKind = 'user' AND toId = ?").all(userId).map(hydrateTransfer);
    for (const t of topups) {
      entries.push({
        id: t.id, type: 'topup', agentId: null, agentName: '',
        startedAt: t.createdAt, cost: 0, amount: t.amount * CREDITS_PER_DOLLAR, dollars: t.amount,
        reason: 'topup', detail: `$${t.amount.toFixed(2)} → ${t.amount * CREDITS_PER_DOLLAR} cr`
      });
    }

    // Transfers to/from agents
    const agentTransfers = this.db.prepare("SELECT * FROM transfers WHERE (type = 'transfer' OR type = 'withdraw') AND ((fromKind = 'user' AND fromId = ?) OR (toKind = 'user' AND toId = ?))").all(userId, userId).map(hydrateTransfer);
    for (const t of agentTransfers) {
      const isToAgent = t.type === 'transfer';
      const agentId = isToAgent ? t.toId : t.fromId;
      entries.push({
        id: t.id, type: t.type, agentId, agentName: agentNames[agentId] || agentId,
        startedAt: t.createdAt, cost: isToAgent ? t.amount : 0, amount: isToAgent ? 0 : t.amount,
        reason: isToAgent ? 'transfer_to_agent' : 'withdraw_from_agent',
        detail: isToAgent ? `→ ${agentNames[agentId] || agentId}` : `← ${agentNames[agentId] || agentId}`
      });
    }

    // Subscriptions paid by user directly (fromKind='user')
    const subPaid = this.db.prepare("SELECT * FROM transfers WHERE (type = 'subscription' OR type = 'subscription_renewal') AND fromKind = 'user' AND fromId = ?").all(userId).map(hydrateTransfer);
    for (const t of subPaid) {
      const followee = t.toKind === 'user' ? this.getUser(t.toId) : this.getAgent(t.toId);
      entries.push({
        id: t.id, type: 'subscription', agentId: null, agentName: '',
        startedAt: t.createdAt, cost: t.amount, amount: 0,
        reason: t.type === 'subscription_renewal' ? 'subscription_renewal' : 'subscription',
        detail: `Paid → ${followee?.name || t.toId}`
      });
    }

    // Subscriptions earned by user directly (toKind='user')
    const subEarned = this.db.prepare("SELECT * FROM transfers WHERE (type = 'subscription' OR type = 'subscription_renewal') AND toKind = 'user' AND toId = ?").all(userId).map(hydrateTransfer);
    for (const t of subEarned) {
      const follower = t.fromKind === 'user' ? this.getUser(t.fromId) : this.getAgent(t.fromId);
      entries.push({
        id: t.id, type: 'subscription_earned', agentId: null, agentName: '',
        startedAt: t.createdAt, cost: 0, amount: t.amount,
        reason: t.type === 'subscription_renewal' ? 'sub_earned_renewal' : 'sub_earned',
        detail: `Earned ← ${follower?.name || t.fromId}`
      });
    }

    entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const total = entries.length;
    const totalPages = Math.ceil(total / perPage);
    const paged = entries.slice((page - 1) * perPage, page * perPage);
    const totalCost = subPaid.reduce((s, t) => s + t.amount, 0) + agentTransfers.filter(t => t.type === 'transfer').reduce((s, t) => s + t.amount, 0);
    const totalEarned = topups.reduce((s, t) => s + t.amount * CREDITS_PER_DOLLAR, 0) + subEarned.reduce((s, t) => s + t.amount, 0) + agentTransfers.filter(t => t.type === 'withdraw').reduce((s, t) => s + t.amount, 0);
    const weeklyStats = computeWeeklyStats(entries);
    return { runs: paged, page, perPage, total, totalPages, totalCost, totalEarned, weeklyStats };
  }

  // ── Agent Run Logs ─────────────────────────────────────────────────────────

  recordAgentRunLog(runLog) {
    const id = newId('run');
    const createdAt = nowIso();
    const { agentId, startedAt, finishedAt, stepsExecuted, ...rest } = runLog;
    this.db.prepare(`INSERT INTO agentRunLogs (id, agentId, startedAt, finishedAt, stepsExecuted, data, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      id, agentId, startedAt || null, finishedAt || null, stepsExecuted || 0,
      js(rest), createdAt
    );
    // Prune old logs
    const count = this.db.prepare('SELECT COUNT(*) as cnt FROM agentRunLogs').get().cnt;
    if (count > 3000) {
      this.db.prepare('DELETE FROM agentRunLogs WHERE id IN (SELECT id FROM agentRunLogs ORDER BY createdAt ASC LIMIT ?)').run(count - 3000);
    }
  }

  getRunLog(runId) {
    return hydrateRunLog(this.db.prepare('SELECT * FROM agentRunLogs WHERE id = ?').get(runId));
  }

  listAgentRunLogs(agentId, limit = 20) {
    return this.db.prepare('SELECT * FROM agentRunLogs WHERE agentId = ? ORDER BY createdAt DESC LIMIT ?').all(agentId, Number(limit)).map(hydrateRunLog);
  }

  // ── Stripe / Payments ──────────────────────────────────────────────────────

  createPendingStripeTopup({ externalUserId, amount, currency = 'usd', paymentIntentId, provider = 'stripe' }) {
    const pending = {
      id: newId('topup'),
      externalUserId, amount: Number(amount), currency,
      paymentIntentId, provider,
      status: 'pending', createdAt: nowIso(), creditedAt: null
    };
    this.db.prepare(`INSERT INTO pendingStripeTopups (id, externalUserId, amount, currency, paymentIntentId, provider, status, createdAt, creditedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      pending.id, pending.externalUserId, pending.amount, pending.currency,
      pending.paymentIntentId, pending.provider, pending.status, pending.createdAt, null
    );
    return pending;
  }

  getPendingTopupByPaymentIntent(paymentIntentId) {
    return this.db.prepare('SELECT * FROM pendingStripeTopups WHERE paymentIntentId = ?').get(paymentIntentId) || null;
  }

  markTopupCredited({ paymentIntentId, stripeEventId, amountMinor, currency }) {
    const existing = this.db.prepare('SELECT eventId FROM stripeWebhookEvents WHERE eventId = ?').get(stripeEventId);
    if (existing) return { alreadyProcessed: true };

    const pending = this.getPendingTopupByPaymentIntent(paymentIntentId);
    if (!pending) {
      this.db.prepare('INSERT OR IGNORE INTO stripeWebhookEvents (eventId, createdAt) VALUES (?, ?)').run(stripeEventId, nowIso());
      return { ignored: true, reason: 'pending_topup_not_found' };
    }

    if (pending.status === 'credited') {
      this.db.prepare('INSERT OR IGNORE INTO stripeWebhookEvents (eventId, createdAt) VALUES (?, ?)').run(stripeEventId, nowIso());
      return { alreadyProcessed: true };
    }

    const expectedMinor = Math.round(Number(pending.amount) * 100);
    if (Number.isFinite(amountMinor) && amountMinor > 0 && expectedMinor !== Number(amountMinor)) {
      throw new Error(`Amount mismatch for topup ${paymentIntentId}: expected ${expectedMinor}, got ${amountMinor}`);
    }
    if (currency && pending.currency && String(currency).toLowerCase() !== String(pending.currency).toLowerCase()) {
      throw new Error(`Currency mismatch for topup ${paymentIntentId}`);
    }

    const user = this.getUser(pending.externalUserId);
    if (!user) throw new Error('Topup target user not found.');

    const tx = this.db.transaction(() => {
      const credits = Number(pending.amount) * CREDITS_PER_DOLLAR;
      this.db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(credits, user.id);
      this.db.prepare('UPDATE pendingStripeTopups SET status = ?, creditedAt = ? WHERE id = ?').run('credited', nowIso(), pending.id);
      this.db.prepare(`INSERT INTO transfers (id, type, fromKind, fromId, toKind, toId, amount, meta, description, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        newId('tx'), 'topup', 'stripe', paymentIntentId, 'user', user.id,
        Number(pending.amount), js({ stripeEventId }), '', nowIso()
      );
      this.db.prepare('INSERT OR IGNORE INTO stripeWebhookEvents (eventId, createdAt) VALUES (?, ?)').run(stripeEventId, nowIso());
    });
    tx();
    return { credited: true, user: this.getUser(user.id) };
  }

  // ── Jobs ───────────────────────────────────────────────────────────────────

  ensureAgentRunJobs() {
    const now = Date.now();
    const agents = this.getAllAgents();
    const tx = this.db.transaction(() => {
      for (const agent of agents) {
        const key = `agent_run:${agent.id}`;
        const job = this.db.prepare('SELECT * FROM jobs WHERE key = ?').get(key);
        if (!job) {
          this.db.prepare(`INSERT INTO jobs (id, key, type, agentId, status, dueAt, attempts, maxAttempts, lockedUntil, lockedBy, lastRunAt, lastError, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            newId('job'), key, 'agent_run', agent.id,
            agent.enabled ? 'queued' : 'paused',
            agent.nextActionAt || new Date(now + agent.intervalMinutes * 60_000).toISOString(),
            0, 5, null, null, null, null, nowIso(), nowIso()
          );
          continue;
        }
        if (!agent.enabled) {
          this.db.prepare('UPDATE jobs SET status = ?, lockedUntil = NULL, lockedBy = NULL, updatedAt = ? WHERE id = ?').run('paused', nowIso(), job.id);
        } else {
          const newStatus = job.status === 'paused' ? 'queued' : job.status;
          const dueAt = job.dueAt || agent.nextActionAt || new Date(now + agent.intervalMinutes * 60_000).toISOString();
          this.db.prepare('UPDATE jobs SET status = ?, dueAt = ?, updatedAt = ? WHERE id = ?').run(newStatus, dueAt, nowIso(), job.id);
        }
      }
    });
    tx();
  }

  claimDueJobs({ workerId, limit = 5, lockMs = 90_000, excludeAgentIds = [] }) {
    const now = Date.now();
    const nowStr = new Date(now).toISOString();
    const excludeSet = new Set(excludeAgentIds);
    const jobs = this.db.prepare("SELECT * FROM jobs WHERE (status = 'queued' OR status = 'failed') AND (dueAt IS NULL OR dueAt <= ?) AND (lockedUntil IS NULL OR lockedUntil <= ?)").all(nowStr, nowStr);

    const claimed = [];
    const tx = this.db.transaction(() => {
      for (const job of jobs) {
        if (claimed.length >= limit) break;
        if (excludeSet.has(job.agentId)) continue;
        const lockUntil = new Date(now + lockMs).toISOString();
        this.db.prepare('UPDATE jobs SET status = ?, attempts = attempts + 1, lockedBy = ?, lockedUntil = ?, updatedAt = ? WHERE id = ?').run(
          'running', workerId, lockUntil, nowIso(), job.id
        );
        claimed.push({ ...job, status: 'running', lockedBy: workerId, lockedUntil: lockUntil, attempts: (job.attempts || 0) + 1 });
      }
    });
    tx();
    return claimed;
  }

  completeJob(jobId, { nextDueAt, status = 'queued' } = {}) {
    const job = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) return null;
    const updates = { status, attempts: 0, lastRunAt: nowIso(), lastError: null, lockedBy: null, lockedUntil: null, updatedAt: nowIso() };
    if (nextDueAt) updates.dueAt = nextDueAt;
    this.db.prepare(`UPDATE jobs SET status=?, attempts=?, lastRunAt=?, lastError=?, lockedBy=?, lockedUntil=?, updatedAt=?${nextDueAt ? ', dueAt=?' : ''} WHERE id=?`).run(
      updates.status, updates.attempts, updates.lastRunAt, updates.lastError, updates.lockedBy, updates.lockedUntil, updates.updatedAt,
      ...(nextDueAt ? [nextDueAt] : []), jobId
    );
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  }

  failJob(jobId, error, { retryInMs = 30_000 } = {}) {
    const job = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) return null;
    const exhausted = (job.attempts || 0) >= (job.maxAttempts || 5);
    const newStatus = exhausted ? 'failed' : 'queued';
    const dueAt = new Date(Date.now() + (exhausted ? 5 * 60_000 : retryInMs)).toISOString();
    this.db.prepare('UPDATE jobs SET status=?, lastError=?, lockedBy=NULL, lockedUntil=NULL, dueAt=?, updatedAt=? WHERE id=?').run(
      newStatus, String(error || 'unknown_error'), dueAt, nowIso(), jobId
    );
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  }
}

export const db = new SqliteDB(DB_PATH);
export { nowIso, newId };
