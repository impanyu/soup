import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');
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

function baseState() {
  return {
    users: [],
    agents: [],
    contents: [],
    follows: [],
    reactions: [],
    comments: [],
    purchases: [],
    transfers: [],
    tenantCharges: [],
    viewHistory: [],
    externalFavorites: [],
    agentRunLogs: [],
    jobs: [],
    pendingStripeTopups: [],
    stripeWebhookEvents: [],
    authSessions: [],
    metadata: {
      createdAt: nowIso(),
      updatedAt: nowIso()
    }
  };
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

class JsonDB {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = baseState();
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.save();
      return;
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    this.state = raw.trim() ? JSON.parse(raw) : baseState();
    this.state.agentRunLogs ||= [];
    this.state.users ||= [];
    this.state.agents ||= [];
    this.state.contents ||= [];
    this.state.follows ||= [];
    this.state.reactions ||= [];
    this.state.comments ||= [];
    this.state.purchases ||= [];
    this.state.transfers ||= [];
    this.state.tenantCharges ||= [];
    this.state.viewHistory ||= [];
    this.state.jobs ||= [];
    this.state.pendingStripeTopups ||= [];
    this.state.stripeWebhookEvents ||= [];
    this.state.authSessions ||= [];
    this.state.metadata ||= { createdAt: nowIso(), updatedAt: nowIso() };

    let migrated = false;

    // Migration: remove follows referencing deleted agents
    const agentIds = new Set(this.state.agents.map(a => a.id));
    const beforeFollows = this.state.follows.length;
    this.state.follows = this.state.follows.filter(
      (f) => !(f.followeeKind === 'agent' && !agentIds.has(f.followeeId)) &&
             !(f.followerKind === 'agent' && !agentIds.has(f.followerId))
    );
    if (this.state.follows.length !== beforeFollows) migrated = true;

    if (migrated) this.save();

    for (const agent of this.state.agents) {
      this.enrichAgentDefaults(agent);
    }
    for (const user of this.state.users) {
      if (!user.passwordHash) {
        user.passwordHash = hashPassword(user.apiKey);
      }
    }
    // Migrate follows to unified actor model
    for (const f of this.state.follows) {
      if (!f.followerKind) {
        f.followerKind = 'agent'; f.followerId = f.followerAgentId;
        f.followeeKind = 'agent'; f.followeeId = f.followeeAgentId;
      }
    }
    // Migrate content to unified author model
    for (const c of this.state.contents) {
      if (!c.authorKind) {
        c.authorKind = 'agent';
        c.authorId = c.authorAgentId;
      }
    }
    // Migrate reactions to unified actor model
    for (const r of this.state.reactions) {
      if (!r.actorKind) { r.actorKind = 'agent'; r.actorId = r.agentId; }
    }
    // Migrate comments to unified actor model
    for (const c of this.state.comments) {
      if (!c.actorKind) { c.actorKind = 'agent'; c.actorId = c.agentId; }
    }
    // Migrate old comments into contents with parentId
    if (this.state.comments.length > 0) {
      for (const c of this.state.comments) {
        const alreadyMigrated = this.state.contents.some((x) => x._migratedFromComment === c.id);
        if (alreadyMigrated) continue;
        this.state.contents.push({
          id: newId('content'),
          _migratedFromComment: c.id,
          authorKind: c.actorKind || 'agent',
          authorId: c.actorId,
          authorAgentId: c.actorKind === 'agent' ? c.actorId : null,
          parentId: c.contentId,
          repostOfId: null,
          title: '',
          text: c.text || '',
          mediaType: 'text',
          mediaUrl: '',
          price: 0,
          isFree: true,
          tags: [],
          createdAt: c.createdAt || nowIso(),
          viewCount: 0
        });
      }
      this.state.comments = [];
      migrated = true;
    }
    // Ensure subscriptionFee, bio, and avatarUrl exist on all users
    for (const user of this.state.users) {
      if (user.subscriptionFee === undefined) user.subscriptionFee = 0;
      if (user.bio === undefined) user.bio = '';
      user.avatarUrl ||= '';
    }
    for (const agent of this.state.agents) {
      if (agent.subscriptionFee === undefined) agent.subscriptionFee = 0;
      agent.avatarUrl ||= '';
      // Migration: update old phaseMaxSteps defaults + merge self_research into browse/external_search
      const pms = agent.runConfig?.phaseMaxSteps;
      if (pms) {
        if (pms.research !== undefined) {
          pms.external_search = pms.external_search || (pms.research === 5 ? 15 : pms.research);
          delete pms.research;
        }
        if (pms.create === 5) pms.create = 10;
        // Migration: remove self_research, distribute its steps to browse and external_search
        if (pms.self_research !== undefined) {
          const bonus = Math.floor((pms.self_research || 0) / 2);
          pms.browse = (pms.browse || 25) + bonus;
          pms.external_search = (pms.external_search || 15) + Math.ceil((pms.self_research || 0) / 2);
          delete pms.self_research;
          migrated = true;
        }
      }
      // Migration: remap old external source IDs to current source IDs
      const OLD_TO_NEW = {
        google: 'bbc-news', youtube: 'techcrunch', x: 'mastodon',
        reddit: 'reddit', wikipedia: 'wikipedia', 'hacker news': 'hackernews',
        arxiv: 'arxiv', github: 'github-trending', 'stack overflow': 'stackoverflow', medium: 'dev-to'
      };
      const srcs = agent.preferences?.externalSearchSources;
      if (Array.isArray(srcs)) {
        const remapped = srcs.map(s => {
          const key = typeof s === 'string' ? s.toLowerCase() : '';
          return OLD_TO_NEW[key] || key;
        }).filter(Boolean);
        const unique = [...new Set(remapped)];
        if (JSON.stringify(unique) !== JSON.stringify(srcs)) {
          agent.preferences.externalSearchSources = unique;
          migrated = true;
        }
      }
    }
    // Ensure parentId/repostOfId fields exist on all contents
    for (const c of this.state.contents) {
      if (c.parentId === undefined) c.parentId = null;
      if (c.repostOfId === undefined) c.repostOfId = null;
      // Migration: populate media[] from legacy mediaUrl/mediaType
      if (!Array.isArray(c.media)) {
        c.media = (c.mediaUrl && c.mediaType && c.mediaType !== 'text')
          ? [{ type: c.mediaType, url: c.mediaUrl, prompt: '', generationMode: 'text-to-image' }]
          : [];
      }
      // Migration: backfill summary
      if (!c.summary) {
        c.summary = (c.title || '').slice(0, 80) || (c.text || '').slice(0, 80) || '(no text)';
      }
    }
    this.save();
  }

  save() {
    this.state.metadata.updatedAt = nowIso();
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  enrichAgentDefaults(agent) {
    if (!agent.name) agent.name = 'Agent ' + agent.id.slice(-6);
    if (!agent.bio && agent.bio !== '') agent.bio = '';
    if (!agent.activenessLevel) agent.activenessLevel = 'medium';
    agent.preferences ||= defaultAgentPreferences();
    agent.runConfig ||= defaultAgentRunConfig();
  }

  createUser({ name, userType = 'human', initialCredits = 100, password = '', subscriptionFee = 0, bio = '' }) {
    if (this.getUserByName(name)) {
      throw new Error(`Username "${name}" is already taken.`);
    }
    const user = {
      id: newId('user'),
      name,
      bio: String(bio || ''),
      avatarUrl: '',
      userType,
      apiKey: newId('key'),
      passwordHash: hashPassword(password || newId('pw')),
      credits: Number(initialCredits),
      subscriptionFee: Number(subscriptionFee),
      createdAt: nowIso()
    };
    this.state.users.push(user);
    this.save();
    return user;
  }

  getUser(userId) {
    return this.state.users.find((u) => u.id === userId);
  }

  updateUser(userId, patch) {
    const user = this.getUser(userId);
    if (!user) return null;
    if (patch.bio !== undefined) user.bio = String(patch.bio || '');
    if (patch.name !== undefined) user.name = String(patch.name);
    if (patch.avatarUrl !== undefined) user.avatarUrl = String(patch.avatarUrl || '');
    this.save();
    return user;
  }

  getUserByName(name) {
    const lower = String(name || '').toLowerCase();
    return this.state.users.find((u) => u.name.toLowerCase() === lower);
  }

  getUserByApiKey(apiKey) {
    return this.state.users.find((u) => u.apiKey === apiKey);
  }

  verifyUserPassword(userId, password) {
    const user = this.getUser(userId);
    if (!user) return false;
    return verifyPassword(password, user.passwordHash);
  }

  createAuthSession(userId, ttlHours = 24 * 7) {
    const user = this.getUser(userId);
    if (!user) throw new Error('User not found.');
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
    const session = {
      id: newId('sess'),
      token: newId('token'),
      userId,
      createdAt: nowIso(),
      expiresAt
    };
    this.state.authSessions.push(session);
    if (this.state.authSessions.length > 5000) {
      this.state.authSessions = this.state.authSessions.slice(-5000);
    }
    this.save();
    return session;
  }

  getUserBySessionToken(token) {
    const session = this.state.authSessions.find((s) => s.token === token);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
    return this.getUser(session.userId) || null;
  }

  revokeSession(token) {
    const before = this.state.authSessions.length;
    this.state.authSessions = this.state.authSessions.filter((s) => s.token !== token);
    if (this.state.authSessions.length !== before) this.save();
  }

  createAgent({ ownerUserId, name, bio = '', activenessLevel = 'medium', intelligenceLevel = 'dumb', preferences, runConfig }) {
    const intervalMinutes = this.getActivenessConfig(activenessLevel).intervalMinutes;
    const now = Date.now();
    const agent = {
      id: newId('agent'),
      ownerUserId,
      name,
      bio,
      avatarUrl: '',
      activenessLevel,
      intelligenceLevel,
      intervalMinutes,
      subscriptionFee: 0,
      enabled: true,
      preferences: { ...defaultAgentPreferences(), ...preferences },
      runConfig: { ...defaultAgentRunConfig(), ...runConfig },
      createdAt: nowIso(),
      lastActionAt: null,
      nextActionAt: new Date(now + intervalMinutes * 60 * 1000).toISOString()
    };
    this.state.agents.push(agent);
    // Owner automatically follows their new agent
    this._followDirect({ followerKind: 'user', followerId: ownerUserId, followeeKind: 'agent', followeeId: agent.id });
    this.save();
    return agent;
  }

  updateAgent(agentId, patch) {
    const agent = this.state.agents.find((a) => a.id === agentId);
    if (!agent) return null;

    // Strip undefined values so partial patches don't overwrite existing fields
    const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = { ...agent, ...cleanPatch };
    if (patch.activenessLevel) {
      const intervalMinutes = this.getActivenessConfig(patch.activenessLevel).intervalMinutes;
      next.intervalMinutes = intervalMinutes;
      if (!patch.nextActionAt) {
        next.nextActionAt = new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString();
      }
    }
    if (patch.preferences) {
      next.preferences = { ...agent.preferences, ...patch.preferences };
    }
    if (patch.runConfig) {
      next.runConfig = { ...agent.runConfig, ...patch.runConfig };
    }

    Object.assign(agent, next);
    this.enrichAgentDefaults(agent);
    this.save();
    return agent;
  }

  createContent({ authorKind = 'agent', authorId, authorAgentId, title = '', text = '', mediaType = 'text', mediaUrl = '', media = [], tags = [], parentId = null, repostOfId = null }) {
    // Support legacy authorAgentId param
    const resolvedKind = authorKind;
    const resolvedId = authorId || authorAgentId;
    const summary = (title || '').slice(0, 80) || (text || '').slice(0, 80) || '(no text)';
    const content = {
      id: newId('content'),
      authorKind: resolvedKind,
      authorId: resolvedId,
      authorAgentId: resolvedKind === 'agent' ? resolvedId : null, // backward compat
      parentId: parentId || null,
      repostOfId: repostOfId || null,
      title,
      text,
      summary,
      mediaType,
      mediaUrl,
      media: Array.isArray(media) ? media : [],
      tags,
      createdAt: nowIso(),
      viewCount: 0
    };
    this.state.contents.push(content);
    this.save();
    return content;
  }

  getOwnedAgents(userId) {
    return this.state.agents.filter((a) => a.ownerUserId === userId);
  }

  getAgent(agentId) {
    return this.state.agents.find((a) => a.id === agentId);
  }

  deleteAgent(agentId, ownerUserId) {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error('Agent not found.');
    if (agent.ownerUserId !== ownerUserId) throw new Error('Not the owner of this agent.');
    this.state.agents = this.state.agents.filter((a) => a.id !== agentId);
    this.state.follows = this.state.follows.filter(
      (f) => !(f.followeeKind === 'agent' && f.followeeId === agentId) &&
             !(f.followerKind === 'agent' && f.followerId === agentId)
    );
    this.save();
    return agent;
  }

  getAgentFavorites(agentId) {
    return this.getActorReactions('agent', agentId, 'favorite');
  }

  getAgentLiked(agentId) {
    return this.getActorReactions('agent', agentId, 'like');
  }

  // ── External Favorites ──

  addExternalFavorite(agentId, { title, summary, url, source, tags }) {
    if (!url) throw new Error('url is required.');
    // Deduplicate by URL
    const existing = this.state.externalFavorites.find(f => f.agentId === agentId && f.url === url);
    if (existing) return existing;
    const item = {
      id: newId('extfav'),
      agentId,
      title: (title || '').slice(0, 300),
      summary: (summary || '').slice(0, 1000),
      url,
      source: source || '',
      tags: tags || [],
      createdAt: nowIso()
    };
    this.state.externalFavorites.push(item);
    this.save();
    return item;
  }

  removeExternalFavorite(agentId, itemId) {
    const before = this.state.externalFavorites.length;
    this.state.externalFavorites = this.state.externalFavorites.filter(
      f => !(f.agentId === agentId && f.id === itemId)
    );
    if (this.state.externalFavorites.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  getExternalFavorites(agentId, { page = 1, perPage = 20 } = {}) {
    const all = this.state.externalFavorites
      .filter(f => f.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const total = all.length;
    const totalPages = Math.ceil(total / perPage) || 1;
    const paged = all.slice((page - 1) * perPage, page * perPage);
    return { items: paged, page, perPage, total, totalPages };
  }

  getAgentPublished(agentId) {
    return this.state.contents.filter((c) => c.authorKind === 'agent' && c.authorId === agentId && !c.parentId && !c.repostOfId);
  }

  getUserPublished(userId) {
    return this.state.contents.filter((c) => c.authorKind === 'user' && c.authorId === userId && !c.parentId && !c.repostOfId);
  }

  getUserAllContent(userId) {
    return this.state.contents
      .filter((c) => c.authorKind === 'user' && c.authorId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  deleteContent(contentId, actorKind, actorId) {
    const content = this.state.contents.find((c) => c.id === contentId);
    if (!content) throw new Error('Content not found.');
    if (content.authorKind !== actorKind || content.authorId !== actorId) {
      throw new Error('Not the author of this content.');
    }
    // Recursively collect all descendant ids
    const toDelete = new Set();
    const collect = (id) => {
      toDelete.add(id);
      for (const child of this.state.contents.filter((c) => c.parentId === id)) {
        collect(child.id);
      }
    };
    collect(contentId);
    this.state.contents = this.state.contents.filter((c) => !toDelete.has(c.id));
    // Clean up reactions referencing deleted content
    this.state.reactions = this.state.reactions.filter((r) => !toDelete.has(r.contentId));
    // Clean up view history
    this.state.viewHistory = this.state.viewHistory.filter(
      (v) => !(v.targetKind === 'content' && toDelete.has(v.targetId))
    );
    this.save();
  }

  listFeed() {
    return this.state.contents
      .filter((c) => !c.parentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getPersonalizedFeed({ followerKind, followerId }) {
    const following = this.state.follows.filter(
      (f) => f.followerKind === followerKind && f.followerId === followerId
    );
    const followedSet = new Set(following.map((f) => `${f.followeeKind}:${f.followeeId}`));
    return this.state.contents
      .filter((c) => !c.parentId && followedSet.has(`${c.authorKind}:${c.authorId}`))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getChildren(contentId) {
    return this.state.contents
      .filter((c) => c.parentId === contentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // Get the ancestor chain from a post up to the root
  getAncestors(contentId) {
    const ancestors = [];
    let current = this.state.contents.find((c) => c.id === contentId);
    while (current?.parentId) {
      const parent = this.state.contents.find((c) => c.id === current.parentId);
      if (!parent) break;
      ancestors.unshift(parent);
      current = parent;
    }
    return ancestors;
  }

  search({ query = '', type = 'all' }) {
    const raw = query.trim();
    const isTagSearch = raw.startsWith('#') && raw.length > 1;
    const tagName = isTagSearch ? raw.slice(1).toLowerCase() : '';
    const q = raw.toLowerCase();
    const results = { agents: [], users: [], contents: [] };

    // Tag searches only return content (not people)
    if (!isTagSearch && (type === 'all' || type === 'agents')) {
      results.agents = this.state.agents.filter((a) => {
        return !q || a.name.toLowerCase().includes(q) || (a.bio || '').toLowerCase().includes(q);
      });
    }

    if (!isTagSearch && (type === 'all' || type === 'users')) {
      results.users = this.state.users.filter((u) => {
        return !q || u.name.toLowerCase().includes(q);
      }).map((u) => ({ id: u.id, name: u.name, userType: u.userType, credits: u.credits, avatarUrl: u.avatarUrl || '', createdAt: u.createdAt }));
    }

    if (type === 'all' || type === 'contents') {
      results.contents = this.state.contents.filter((c) => {
        if (c.parentId) return false; // exclude replies from search
        if (isTagSearch) {
          return (c.tags || []).some(t => t.toLowerCase() === tagName);
        }
        const title = (c.title || '').toLowerCase();
        const body = (c.text || '').toLowerCase();
        const tags = (c.tags || []).join(' ').toLowerCase();
        return !q || title.includes(q) || body.includes(q) || tags.includes(q);
      }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    return results;
  }

  // Internal: write a follow record without saving (caller must save)
  _followDirect({ followerKind, followerId, followeeKind, followeeId }) {
    const exists = this.state.follows.find(
      (f) => f.followerKind === followerKind && f.followerId === followerId &&
             f.followeeKind === followeeKind && f.followeeId === followeeId
    );
    if (!exists) {
      this.state.follows.push({
        id: newId('follow'),
        followerKind, followerId,
        followeeKind, followeeId,
        createdAt: nowIso(),
        lastChargedAt: null
      });
    }
  }

  setSubscriptionFee(kind, id, fee) {
    const numFee = Math.max(0, Number(fee || 0));
    if (kind === 'user') {
      const user = this.getUser(id);
      if (!user) throw new Error('User not found.');
      user.subscriptionFee = numFee;
    } else {
      const agent = this.getAgent(id);
      if (!agent) throw new Error('Agent not found.');
      agent.subscriptionFee = numFee;
    }
    this.save();
  }

  follow({ followerKind = 'agent', followerId, followeeKind = 'agent', followeeId }) {
    if (followerKind === followeeKind && followerId === followeeId) {
      throw new Error('Cannot follow yourself.');
    }

    // Charge first month's subscription fee if followee has one
    const followee = followeeKind === 'user' ? this.getUser(followeeId) : this.getAgent(followeeId);
    if (followee && followee.subscriptionFee > 0) {
      const alreadyFollowing = this.isFollowing({ followerKind, followerId, followeeKind, followeeId });
      if (!alreadyFollowing) {
        // Resolve payer: for agents, charge the owner user
        let payer;
        if (followerKind === 'agent') {
          const agent = this.getAgent(followerId);
          payer = agent ? this.getUser(agent.ownerUserId) : null;
        } else {
          payer = this.getUser(followerId);
        }
        if (!payer) throw new Error('Follower (or owner) not found.');
        // Resolve payee: for agents, credit the owner user
        let payee;
        if (followeeKind === 'agent') {
          const agent = this.getAgent(followeeId);
          payee = agent ? this.getUser(agent.ownerUserId) : null;
        } else {
          payee = this.getUser(followeeId);
        }
        // Skip fee if owner follows their own agent (payer is payee)
        const skipFee = payee && payer.id === payee.id;
        if (!skipFee) {
          if (payer.credits < followee.subscriptionFee) {
            throw new Error(`Insufficient credits. Following ${followee.name || 'this user'} costs ${followee.subscriptionFee} cr/month.`);
          }
          payer.credits -= followee.subscriptionFee;
          if (payee) payee.credits += followee.subscriptionFee;
          this.state.transfers.push({
            id: newId('tx'),
            type: 'subscription',
            fromKind: followerKind,
            fromId: followerId,
            toKind: followeeKind,
            toId: followeeId,
            amount: followee.subscriptionFee,
            createdAt: nowIso()
          });
        }
      }
    }

    this._followDirect({ followerKind, followerId, followeeKind, followeeId });
    // Mark first charge date
    const follow = this.state.follows.find(
      (f) => f.followerKind === followerKind && f.followerId === followerId &&
             f.followeeKind === followeeKind && f.followeeId === followeeId
    );
    if (follow && !follow.lastChargedAt && followee?.subscriptionFee > 0) {
      follow.lastChargedAt = nowIso();
    }
    this.save();
  }

  /**
   * Process monthly subscription charges for all active follows.
   * Charges followers whose lastChargedAt is more than 30 days ago.
   * Auto-unfollows if the payer has insufficient credits.
   */
  chargeMonthlySubscriptions() {
    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const toRemove = [];

    for (const f of this.state.follows) {
      if (!f.lastChargedAt) continue;
      const elapsed = now - new Date(f.lastChargedAt).getTime();
      if (elapsed < THIRTY_DAYS) continue;

      const followee = f.followeeKind === 'user' ? this.getUser(f.followeeId) : this.getAgent(f.followeeId);
      if (!followee || !followee.subscriptionFee || followee.subscriptionFee <= 0) continue;

      // Resolve payer
      let payer;
      if (f.followerKind === 'agent') {
        const agent = this.getAgent(f.followerId);
        payer = agent ? this.getUser(agent.ownerUserId) : null;
      } else {
        payer = this.getUser(f.followerId);
      }
      if (!payer) { toRemove.push(f.id); continue; }

      if (payer.credits < followee.subscriptionFee) {
        // Auto-unfollow on insufficient credits
        toRemove.push(f.id);
        continue;
      }

      // Resolve payee
      let payee;
      if (f.followeeKind === 'agent') {
        const agent = this.getAgent(f.followeeId);
        payee = agent ? this.getUser(agent.ownerUserId) : null;
      } else {
        payee = this.getUser(f.followeeId);
      }

      // Skip fee if owner follows their own agent
      if (payee && payer.id === payee.id) {
        f.lastChargedAt = nowIso();
        continue;
      }

      payer.credits -= followee.subscriptionFee;
      if (payee) payee.credits += followee.subscriptionFee;
      f.lastChargedAt = nowIso();
      this.state.transfers.push({
        id: newId('tx'),
        type: 'subscription_renewal',
        fromKind: f.followerKind,
        fromId: f.followerId,
        toKind: f.followeeKind,
        toId: f.followeeId,
        amount: followee.subscriptionFee,
        createdAt: nowIso()
      });
    }

    if (toRemove.length > 0) {
      const removeSet = new Set(toRemove);
      this.state.follows = this.state.follows.filter(f => !removeSet.has(f.id));
    }
    this.save();
    return { charged: this.state.follows.length, removed: toRemove.length };
  }

  unfollow({ followerKind = 'agent', followerId, followeeKind = 'agent', followeeId }) {
    const before = this.state.follows.length;
    this.state.follows = this.state.follows.filter(
      (f) => !(f.followerKind === followerKind && f.followerId === followerId &&
               f.followeeKind === followeeKind && f.followeeId === followeeId)
    );
    if (this.state.follows.length !== before) this.save();
  }

  isFollowing({ followerKind, followerId, followeeKind, followeeId }) {
    return !!this.state.follows.find(
      (f) => f.followerKind === followerKind && f.followerId === followerId &&
             f.followeeKind === followeeKind && f.followeeId === followeeId
    );
  }

  getActorFollowers(followeeKind, followeeId) {
    return this.state.follows
      .filter((f) => f.followeeKind === followeeKind && f.followeeId === followeeId)
      .map((f) => {
        if (f.followerKind === 'agent') return { kind: 'agent', ...this.getAgent(f.followerId) };
        if (f.followerKind === 'user') {
          const u = this.getUser(f.followerId);
          return u ? { kind: 'user', id: u.id, name: u.name, userType: u.userType, avatarUrl: u.avatarUrl || '' } : null;
        }
        return null;
      })
      .filter(Boolean);
  }

  getActorFollowing(followerKind, followerId) {
    return this.state.follows
      .filter((f) => f.followerKind === followerKind && f.followerId === followerId)
      .map((f) => {
        if (f.followeeKind === 'agent') return { kind: 'agent', ...this.getAgent(f.followeeId) };
        if (f.followeeKind === 'user') {
          const u = this.getUser(f.followeeId);
          return u ? { kind: 'user', id: u.id, name: u.name, userType: u.userType, avatarUrl: u.avatarUrl || '' } : null;
        }
        return null;
      })
      .filter(Boolean);
  }

  // Keep legacy name for server.js compat
  getAgentFollowers(agentId) { return this.getActorFollowers('agent', agentId); }
  getAgentFollowing(agentId) { return this.getActorFollowing('agent', agentId); }

  getActorStats(kind, id) {
    const posts = this.state.contents.filter((c) => c.authorKind === kind && c.authorId === id && !c.parentId).length;
    const followers = this.state.follows.filter((f) => f.followeeKind === kind && f.followeeId === id).length;
    const following = this.state.follows.filter((f) => f.followerKind === kind && f.followerId === id).length;
    const totalLikes = this.state.reactions.filter(
      (r) => r.type === 'like' && this.state.contents.some((c) => c.id === r.contentId && c.authorKind === kind && c.authorId === id)
    ).length;
    const agents = kind === 'user' ? this.state.agents.filter((a) => a.ownerUserId === id).length : undefined;
    return { posts, followers, following, totalLikes, ...(agents !== undefined ? { agents } : {}) };
  }

  // Keep legacy name
  getAgentStats(agentId) { return this.getActorStats('agent', agentId); }

  react({ actorKind = 'agent', actorId, agentId, contentId, type }) {
    const resolvedKind = actorKind;
    const resolvedId = actorId || agentId;
    const valid = new Set(['like', 'dislike', 'favorite']);
    if (!valid.has(type)) throw new Error('Invalid reaction type.');

    this.state.reactions = this.state.reactions.filter(
      (r) => !(r.actorKind === resolvedKind && r.actorId === resolvedId && r.contentId === contentId && r.type === type)
    );
    this.state.reactions.push({
      id: newId('reaction'),
      actorKind: resolvedKind,
      actorId: resolvedId,
      agentId: resolvedKind === 'agent' ? resolvedId : null, // backward compat
      contentId,
      type,
      createdAt: nowIso()
    });
    this.save();
  }

  unreact({ actorKind = 'agent', actorId, agentId, contentId, type }) {
    const resolvedKind = actorKind;
    const resolvedId = actorId || agentId;
    const valid = new Set(['like', 'dislike', 'favorite']);
    if (!valid.has(type)) throw new Error('Invalid reaction type.');
    const before = this.state.reactions.length;
    this.state.reactions = this.state.reactions.filter(
      (r) => !(r.actorKind === resolvedKind && r.actorId === resolvedId && r.contentId === contentId && r.type === type)
    );
    if (this.state.reactions.length !== before) this.save();
  }

  recordView({ actorKind, actorId, targetKind, targetId }) {
    // Deduplicate: remove existing view of same target, re-add as most recent
    this.state.viewHistory = this.state.viewHistory.filter(
      (v) => !(v.actorKind === actorKind && v.actorId === actorId && v.targetKind === targetKind && v.targetId === targetId)
    );
    this.state.viewHistory.push({
      id: newId('view'),
      actorKind,
      actorId,
      targetKind,
      targetId,
      createdAt: nowIso()
    });
    // Increment content viewCount
    if (targetKind === 'content') {
      const content = this.state.contents.find((c) => c.id === targetId);
      if (content) content.viewCount = (content.viewCount || 0) + 1;
    }
    this.save();
  }

  getActorReactions(actorKind, actorId, type) {
    const reactions = this.state.reactions
      .filter((r) => {
        const matchActor = (r.actorKind === actorKind && r.actorId === actorId) ||
          (actorKind === 'agent' && r.agentId === actorId);
        return matchActor && r.type === type;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const contentIds = reactions.map((r) => r.contentId);
    const contentMap = new Map(this.state.contents.map((c) => [c.id, c]));
    return contentIds.map((id) => contentMap.get(id)).filter(Boolean);
  }

  getActorViewHistory(actorKind, actorId, targetKind) {
    const views = this.state.viewHistory
      .filter((v) => v.actorKind === actorKind && v.actorId === actorId && v.targetKind === targetKind)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return views.map((v) => {
      if (v.targetKind === 'content') return this.state.contents.find((c) => c.id === v.targetId);
      if (v.targetKind === 'agent') return this.getAgent(v.targetId);
      if (v.targetKind === 'user') return this.getUser(v.targetId);
      return null;
    }).filter(Boolean);
  }

  // Legacy comment() now creates a content with parentId
  comment({ actorKind = 'agent', actorId, agentId, contentId, text }) {
    return this.createContent({
      authorKind: actorKind,
      authorId: actorId || agentId,
      parentId: contentId,
      text,
    });
  }

  addCreditsToUser(userId, amount, meta = {}) {
    const user = this.getUser(userId);
    if (!user) throw new Error('User not found.');
    user.credits += Number(amount) * CREDITS_PER_DOLLAR;
    this.state.transfers.push({
      id: newId('tx'),
      type: 'topup',
      fromKind: 'stripe',
      fromId: 'stripe',
      toKind: 'user',
      toId: userId,
      amount: Number(amount),
      meta,
      createdAt: nowIso()
    });
    this.save();
    return user;
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

    const owner = this.getUser(agent.ownerUserId);
    if (!owner) throw new Error('Agent owner not found.');

    const fee = this.calculateRunCost(agent);
    if (owner.credits < fee) {
      agent.enabled = false;
      this.save();
      return { charged: 0, disabled: true, reason: 'insufficient_owner_credits' };
    }

    owner.credits -= fee;
    this.state.tenantCharges.push({
      id: newId('tenant'),
      agentId,
      amount: fee,
      reason,
      createdAt: nowIso()
    });
    this.save();

    return { charged: fee, disabled: false };
  }

  /**
   * Calculate the cost of a single run based on intelligence level and total max steps.
   * At 50 total steps: dumb=5cr, not_so_smart=25cr, mediocre=100cr, smart=200cr.
   */
  calculateRunCost(agent) {
    const costPerStepTable = { dumb: 0.1, not_so_smart: 0.5, mediocre: 2.0, smart: 4.0 };
    const costPerStep = costPerStepTable[agent.intelligenceLevel] || costPerStepTable.dumb;
    const phaseSteps = agent.runConfig?.phaseMaxSteps || {};
    const totalSteps = (phaseSteps.browse || 20) + (phaseSteps.external_search || 20) + (phaseSteps.create || 10);
    return Math.round(costPerStep * totalSteps);
  }

  /**
   * Get total credits charged for an agent in the current calendar month.
   */
  getMonthlyIncurredCost(agentId) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    let total = 0;
    for (const charge of this.state.tenantCharges) {
      if (charge.agentId === agentId && charge.createdAt >= monthStart) {
        total += charge.amount;
      }
    }
    return total;
  }

  /**
   * Get paginated cost/run history for a single agent.
   * Joins agentRunLogs with tenantCharges by matching timestamps.
   */
  getAgentCostRuns(agentId, { page = 1, perPage = 20 } = {}) {
    // Build a map of charges keyed by approximate time for correlation
    const charges = this.state.tenantCharges
      .filter(c => c.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const runs = this.state.agentRunLogs
      .filter(l => l.agentId === agentId)
      .sort((a, b) => (b.startedAt || b.createdAt).localeCompare(a.startedAt || a.createdAt));

    // Match each run to the closest charge (charge happens right before run starts)
    const usedCharges = new Set();
    const entries = runs.map(run => {
      const runStart = new Date(run.startedAt || run.createdAt).getTime();
      // Find the charge closest to (and just before) run start, within 5 min
      let bestCharge = null;
      let bestDiff = Infinity;
      for (const c of charges) {
        if (usedCharges.has(c.id)) continue;
        const ct = new Date(c.createdAt).getTime();
        const diff = runStart - ct;
        if (diff >= 0 && diff < 300_000 && diff < bestDiff) {
          bestDiff = diff;
          bestCharge = c;
        }
      }
      if (bestCharge) usedCharges.add(bestCharge.id);

      const durationMs = run.finishedAt && run.startedAt
        ? new Date(run.finishedAt) - new Date(run.startedAt) : null;

      return {
        id: run.id,
        agentId: run.agentId,
        startedAt: run.startedAt || run.createdAt,
        finishedAt: run.finishedAt || null,
        durationMs,
        stepsExecuted: run.stepsExecuted || 0,
        cost: bestCharge ? bestCharge.amount : 0,
        reason: bestCharge ? bestCharge.reason : 'unknown'
      };
    });

    const total = entries.length;
    const totalPages = Math.ceil(total / perPage);
    const paged = entries.slice((page - 1) * perPage, page * perPage);
    const totalCost = charges.reduce((s, c) => s + c.amount, 0);

    return { runs: paged, page, perPage, total, totalPages, totalCost };
  }

  /**
   * Get paginated cost/run history across all agents owned by a user.
   * Includes both agent run costs and subscription charges.
   */
  getUserCostRuns(userId, { page = 1, perPage = 20 } = {}) {
    const ownedAgents = this.getOwnedAgents(userId);
    const ownedAgentIds = new Set(ownedAgents.map(a => a.id));
    const agentNames = {};
    for (const a of ownedAgents) agentNames[a.id] = a.name;

    const charges = this.state.tenantCharges
      .filter(c => ownedAgentIds.has(c.agentId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const runs = this.state.agentRunLogs
      .filter(l => ownedAgentIds.has(l.agentId))
      .sort((a, b) => (b.startedAt || b.createdAt).localeCompare(a.startedAt || a.createdAt));

    const usedCharges = new Set();
    const entries = runs.map(run => {
      const runStart = new Date(run.startedAt || run.createdAt).getTime();
      let bestCharge = null;
      let bestDiff = Infinity;
      for (const c of charges) {
        if (usedCharges.has(c.id)) continue;
        if (c.agentId !== run.agentId) continue;
        const ct = new Date(c.createdAt).getTime();
        const diff = runStart - ct;
        if (diff >= 0 && diff < 300_000 && diff < bestDiff) {
          bestDiff = diff;
          bestCharge = c;
        }
      }
      if (bestCharge) usedCharges.add(bestCharge.id);

      const durationMs = run.finishedAt && run.startedAt
        ? new Date(run.finishedAt) - new Date(run.startedAt) : null;

      return {
        id: run.id,
        type: 'run',
        agentId: run.agentId,
        agentName: agentNames[run.agentId] || run.agentId,
        startedAt: run.startedAt || run.createdAt,
        finishedAt: run.finishedAt || null,
        durationMs,
        stepsExecuted: run.stepsExecuted || 0,
        cost: bestCharge ? bestCharge.amount : 0,
        reason: bestCharge ? bestCharge.reason : 'unknown'
      };
    });

    // Include subscription charges (paid by this user or their agents)
    const subTransfers = this.state.transfers.filter(t =>
      (t.type === 'subscription' || t.type === 'subscription_renewal') &&
      (t.fromId === userId || (t.fromKind === 'agent' && ownedAgentIds.has(t.fromId)))
    );
    for (const t of subTransfers) {
      const followee = t.toKind === 'user' ? this.getUser(t.toId) : this.getAgent(t.toId);
      const followerName = t.fromKind === 'agent' ? (agentNames[t.fromId] || t.fromId) : 'You';
      entries.push({
        id: t.id,
        type: 'subscription',
        agentId: t.fromId,
        agentName: followerName,
        startedAt: t.createdAt,
        finishedAt: null,
        durationMs: null,
        stepsExecuted: 0,
        cost: t.amount,
        reason: t.type === 'subscription_renewal' ? 'subscription_renewal' : 'subscription',
        detail: `→ ${followee?.name || t.toId}`
      });
    }

    // Sort all entries by date desc
    entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    const total = entries.length;
    const totalPages = Math.ceil(total / perPage);
    const paged = entries.slice((page - 1) * perPage, page * perPage);
    const runCost = charges.reduce((s, c) => s + c.amount, 0);
    const subCost = subTransfers.reduce((s, t) => s + t.amount, 0);

    return { runs: paged, page, perPage, total, totalPages, totalCost: runCost + subCost };
  }

  recordAgentRunLog(runLog) {
    this.state.agentRunLogs.push({
      id: newId('run'),
      createdAt: nowIso(),
      ...runLog
    });
    if (this.state.agentRunLogs.length > 3000) {
      this.state.agentRunLogs = this.state.agentRunLogs.slice(-3000);
    }
    this.save();
  }

  searchByName(query) {
    const q = String(query || '').toLowerCase().trim();
    const results = [];
    for (const u of this.state.users) {
      if (!q || u.name.toLowerCase().includes(q)) {
        results.push({ kind: 'user', id: u.id, name: u.name, avatarUrl: u.avatarUrl || '' });
      }
      if (results.length >= 10) return results;
    }
    for (const a of this.state.agents) {
      if (!q || a.name.toLowerCase().includes(q)) {
        results.push({ kind: 'agent', id: a.id, name: a.name, avatarUrl: a.avatarUrl || '' });
      }
      if (results.length >= 10) return results;
    }
    return results;
  }

  getAllNames() {
    const results = [];
    for (const u of this.state.users) {
      results.push({ kind: 'user', id: u.id, name: u.name, avatarUrl: u.avatarUrl || '' });
    }
    for (const a of this.state.agents) {
      results.push({ kind: 'agent', id: a.id, name: a.name, avatarUrl: a.avatarUrl || '' });
    }
    return results;
  }

  listAgentRunLogs(agentId, limit = 20) {
    return this.state.agentRunLogs
      .filter((log) => log.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Number(limit));
  }

  createPendingStripeTopup({ externalUserId, amount, currency = 'usd', paymentIntentId, provider = 'stripe' }) {
    const pending = {
      id: newId('topup'),
      externalUserId,
      amount: Number(amount),
      currency,
      paymentIntentId,
      provider,
      status: 'pending',
      createdAt: nowIso(),
      creditedAt: null
    };
    this.state.pendingStripeTopups.push(pending);
    this.save();
    return pending;
  }

  getPendingTopupByPaymentIntent(paymentIntentId) {
    return this.state.pendingStripeTopups.find((t) => t.paymentIntentId === paymentIntentId);
  }

  markTopupCredited({ paymentIntentId, stripeEventId, amountMinor, currency }) {
    if (this.state.stripeWebhookEvents.includes(stripeEventId)) {
      return { alreadyProcessed: true };
    }

    const pending = this.getPendingTopupByPaymentIntent(paymentIntentId);
    if (!pending) {
      this.state.stripeWebhookEvents.push(stripeEventId);
      if (this.state.stripeWebhookEvents.length > 5000) {
        this.state.stripeWebhookEvents = this.state.stripeWebhookEvents.slice(-5000);
      }
      this.save();
      return { ignored: true, reason: 'pending_topup_not_found' };
    }

    if (pending.status === 'credited') {
      this.state.stripeWebhookEvents.push(stripeEventId);
      if (this.state.stripeWebhookEvents.length > 5000) {
        this.state.stripeWebhookEvents = this.state.stripeWebhookEvents.slice(-5000);
      }
      this.save();
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

    user.credits += Number(pending.amount) * CREDITS_PER_DOLLAR;
    pending.status = 'credited';
    pending.creditedAt = nowIso();

    this.state.transfers.push({
      id: newId('tx'),
      type: 'topup',
      fromKind: 'stripe',
      fromId: paymentIntentId,
      toKind: 'user',
      toId: user.id,
      amount: Number(pending.amount),
      meta: { stripeEventId },
      createdAt: nowIso()
    });

    this.state.stripeWebhookEvents.push(stripeEventId);
    if (this.state.stripeWebhookEvents.length > 5000) {
      this.state.stripeWebhookEvents = this.state.stripeWebhookEvents.slice(-5000);
    }
    this.save();
    return { credited: true, user };
  }

  ensureAgentRunJobs() {
    const now = Date.now();
    for (const agent of this.state.agents) {
      const key = `agent_run:${agent.id}`;
      let job = this.state.jobs.find((j) => j.key === key);
      if (!job) {
        job = {
          id: newId('job'),
          key,
          type: 'agent_run',
          agentId: agent.id,
          status: agent.enabled ? 'queued' : 'paused',
          dueAt: agent.nextActionAt || new Date(now + agent.intervalMinutes * 60 * 1000).toISOString(),
          attempts: 0,
          maxAttempts: 5,
          lockedUntil: null,
          lockedBy: null,
          lastRunAt: null,
          lastError: null,
          createdAt: nowIso(),
          updatedAt: nowIso()
        };
        this.state.jobs.push(job);
        continue;
      }

      if (!agent.enabled) {
        job.status = 'paused';
        job.lockedUntil = null;
        job.lockedBy = null;
      } else {
        if (job.status === 'paused') job.status = 'queued';
        if (!job.dueAt) {
          job.dueAt = agent.nextActionAt || new Date(now + agent.intervalMinutes * 60 * 1000).toISOString();
        }
      }
      job.updatedAt = nowIso();
    }
    this.save();
  }

  claimDueJobs({ workerId, limit = 5, lockMs = 90_000, excludeAgentIds = [] }) {
    const now = Date.now();
    const excludeSet = new Set(excludeAgentIds);
    const claimed = [];
    for (const job of this.state.jobs) {
      if (claimed.length >= limit) break;
      if (excludeSet.has(job.agentId)) continue;
      const statusAllowed = job.status === 'queued' || job.status === 'failed';
      const due = new Date(job.dueAt || 0).getTime() <= now;
      const unlocked = !job.lockedUntil || new Date(job.lockedUntil).getTime() <= now;
      if (!statusAllowed || !due || !unlocked) continue;

      job.status = 'running';
      job.attempts = Number(job.attempts || 0) + 1;
      job.lockedBy = workerId;
      job.lockedUntil = new Date(now + lockMs).toISOString();
      job.updatedAt = nowIso();
      claimed.push({ ...job });
    }
    if (claimed.length) this.save();
    return claimed;
  }

  completeJob(jobId, { nextDueAt, status = 'queued' } = {}) {
    const job = this.state.jobs.find((j) => j.id === jobId);
    if (!job) return null;
    job.status = status;
    job.attempts = 0;
    job.lastRunAt = nowIso();
    job.lastError = null;
    job.lockedBy = null;
    job.lockedUntil = null;
    if (nextDueAt) job.dueAt = nextDueAt;
    job.updatedAt = nowIso();
    this.save();
    return job;
  }

  failJob(jobId, error, { retryInMs = 30_000 } = {}) {
    const job = this.state.jobs.find((j) => j.id === jobId);
    if (!job) return null;
    const exhausted = Number(job.attempts || 0) >= Number(job.maxAttempts || 5);
    job.status = exhausted ? 'failed' : 'queued';
    job.lastError = String(error || 'unknown_error');
    job.lockedBy = null;
    job.lockedUntil = null;
    job.dueAt = new Date(Date.now() + (exhausted ? 5 * 60_000 : retryInMs)).toISOString();
    job.updatedAt = nowIso();
    this.save();
    return job;
  }
}

export const db = new JsonDB(DB_FILE);
export { nowIso, newId };
