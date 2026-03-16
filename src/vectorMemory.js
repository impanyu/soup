import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data', 'agents');

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 512;
const MAX_MEMORIES_PER_AGENT = 500;
const CONSOLIDATION_THRESHOLD = 450;
const CONSOLIDATION_TARGET = 350;
const BYTES_PER_EMBEDDING = EMBEDDING_DIMENSIONS * 4; // Float32

// ─── File helpers ────────────────────────────────────────────────────────────

function memDir(agentId) {
  return path.join(DATA_DIR, agentId, 'vector_memory');
}

function metaPath(agentId) {
  return path.join(memDir(agentId), 'memories.json');
}

function embPath(agentId) {
  return path.join(memDir(agentId), 'embeddings.bin');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Storage: split metadata (JSON) + embeddings (binary) ───────────────────

function readMeta(agentId) {
  const fp = metaPath(agentId);
  if (!fs.existsSync(fp)) return [];
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch {
    return [];
  }
}

function readEmbeddings(agentId, count) {
  const fp = embPath(agentId);
  if (!fs.existsSync(fp)) return [];
  const buf = fs.readFileSync(fp);
  const result = [];
  for (let i = 0; i < count; i++) {
    const offset = i * BYTES_PER_EMBEDDING;
    if (offset + BYTES_PER_EMBEDDING > buf.length) break;
    const floats = new Float32Array(buf.buffer, buf.byteOffset + offset, EMBEDDING_DIMENSIONS);
    result.push(Array.from(floats));
  }
  return result;
}

function writeSplit(agentId, entries) {
  ensureDir(memDir(agentId));

  // Write metadata JSON (no embeddings)
  const meta = entries.map(e => ({
    id: e.id,
    content: e.content,
    category: e.category,
    tags: e.tags,
    metadata: e.metadata,
    createdAt: e.createdAt
  }));
  fs.writeFileSync(metaPath(agentId), JSON.stringify(meta, null, 2));

  // Write embeddings as contiguous Float32 binary
  const buf = Buffer.alloc(entries.length * BYTES_PER_EMBEDDING);
  for (let i = 0; i < entries.length; i++) {
    const emb = entries[i].embedding;
    for (let j = 0; j < EMBEDDING_DIMENSIONS; j++) {
      buf.writeFloatLE(emb[j] || 0, (i * EMBEDDING_DIMENSIONS + j) * 4);
    }
  }
  fs.writeFileSync(embPath(agentId), buf);
}

/**
 * Read full entries (meta + embeddings joined) — only when similarity search is needed.
 */
function readFull(agentId) {
  const meta = readMeta(agentId);
  const embeddings = readEmbeddings(agentId, meta.length);
  return meta.map((m, i) => ({ ...m, embedding: embeddings[i] || [] }));
}

// ─── Embedding ───────────────────────────────────────────────────────────────

async function getEmbedding(text) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.AGENT_LLM_API_KEY;
  if (!apiKey) throw new Error('No OpenAI API key for embeddings');

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8000),
      dimensions: EMBEDDING_DIMENSIONS
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Embedding API error: ${res.status} ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.data[0].embedding;
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Consolidation ───────────────────────────────────────────────────────────

function findSimilarClusters(memories, threshold = 0.75) {
  const used = new Set();
  const clusters = [];

  for (let i = 0; i < memories.length; i++) {
    if (used.has(i)) continue;
    const cluster = [memories[i]];
    used.add(i);
    for (let j = i + 1; j < memories.length; j++) {
      if (used.has(j)) continue;
      const sim = cosineSimilarity(memories[i].embedding, memories[j].embedding);
      if (sim >= threshold) {
        cluster.push(memories[j]);
        used.add(j);
      }
    }
    if (cluster.length >= 2) {
      clusters.push(cluster);
    }
  }

  clusters.sort((a, b) => b.length - a.length);
  return clusters;
}

async function mergeCluster(cluster) {
  const apiKey = process.env.AGENT_LLM_API_KEY || process.env.OPENAI_API_KEY;
  const endpoint = process.env.AGENT_LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
  if (!apiKey) return null;

  const items = cluster.map((m, i) => `[${i + 1}] (${m.category}) ${m.content}`).join('\n');

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5-mini',
        messages: [
          { role: 'system', content: 'You are consolidating related memory entries into one concise entry. Preserve all key facts, insights, URLs, names, and numbers. Remove redundancy. Output only the consolidated text (2-5 sentences). Do not add commentary.' },
          { role: 'user', content: `Consolidate these ${cluster.length} related memories into one:\n\n${items}` }
        ],
        max_completion_tokens: 512
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

async function consolidateIfNeeded(agentId, memories) {
  if (memories.length <= CONSOLIDATION_THRESHOLD) return memories;

  console.log(`[vector-memory] Agent ${agentId}: ${memories.length} memories, consolidating...`);

  memories.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const cutoff = Math.floor(memories.length * 0.6);
  const oldMemories = memories.slice(0, cutoff);
  const recentMemories = memories.slice(cutoff);

  const clusters = findSimilarClusters(oldMemories, 0.72);
  const mergedIds = new Set();
  const newEntries = [];

  const targetReduction = memories.length - CONSOLIDATION_TARGET;
  let reduced = 0;

  for (const cluster of clusters) {
    if (reduced >= targetReduction) break;

    const merged = await mergeCluster(cluster);
    if (!merged) continue;

    const allTags = [...new Set(cluster.flatMap(m => m.tags))];
    const catCounts = {};
    for (const m of cluster) catCounts[m.category] = (catCounts[m.category] || 0) + 1;
    const topCategory = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0][0];

    try {
      const embedding = await getEmbedding(merged);
      newEntries.push({
        id: 'mem_' + crypto.randomBytes(8).toString('hex'),
        content: merged.slice(0, 2000),
        category: topCategory,
        tags: allTags.slice(0, 10),
        metadata: { consolidated: true, sourceCount: cluster.length },
        embedding,
        createdAt: cluster[cluster.length - 1].createdAt
      });
      for (const m of cluster) mergedIds.add(m.id);
      reduced += cluster.length - 1;
    } catch {
      continue;
    }
  }

  if (mergedIds.size === 0) {
    console.log(`[vector-memory] Consolidation yielded no merges, trimming oldest.`);
    memories.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    memories.splice(0, memories.length - CONSOLIDATION_TARGET);
    return memories;
  }

  const surviving = oldMemories.filter(m => !mergedIds.has(m.id));
  const result = [...surviving, ...newEntries, ...recentMemories];
  console.log(`[vector-memory] Consolidated: ${memories.length} → ${result.length} memories (merged ${mergedIds.size} into ${newEntries.length})`);
  return result;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Store a memory entry with embedding.
 * When memory count exceeds threshold, similar memories are consolidated via LLM.
 */
export async function storeMemory(agentId, { content, category, tags, metadata }) {
  if (!content) throw new Error('content is required');

  const embedding = await getEmbedding(content);

  const entry = {
    id: 'mem_' + crypto.randomBytes(8).toString('hex'),
    content: content.slice(0, 2000),
    category: category || 'general',
    tags: tags || [],
    metadata: metadata || {},
    embedding,
    createdAt: new Date().toISOString()
  };

  let memories = readFull(agentId);
  memories.push(entry);

  memories = await consolidateIfNeeded(agentId, memories);

  writeSplit(agentId, memories);

  return { id: entry.id, category: entry.category, createdAt: entry.createdAt };
}

/**
 * Query memories by semantic similarity.
 * Loads embeddings binary only when searching.
 */
export async function recallMemory(agentId, query, { limit = 5, category, minScore = 0.3 } = {}) {
  const meta = readMeta(agentId);
  if (!meta.length) return [];

  const queryEmbedding = await getEmbedding(query);
  const embeddings = readEmbeddings(agentId, meta.length);

  let candidates = meta.map((m, i) => ({ ...m, embedding: embeddings[i] || [] }));
  if (category) {
    candidates = candidates.filter(m => m.category === category);
  }

  const scored = candidates.map(m => ({
    id: m.id,
    content: m.content,
    category: m.category,
    tags: m.tags,
    metadata: m.metadata,
    createdAt: m.createdAt,
    score: cosineSimilarity(queryEmbedding, m.embedding)
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored
    .filter(m => m.score >= minScore)
    .slice(0, limit)
    .map(({ embedding, ...rest }) => ({ ...rest, score: Math.round(rest.score * 1000) / 1000 }));
}

/**
 * Delete a memory entry by ID.
 */
export function forgetMemory(agentId, memoryId) {
  const memories = readFull(agentId);
  const before = memories.length;
  const filtered = memories.filter(m => m.id !== memoryId);
  if (filtered.length < before) {
    writeSplit(agentId, filtered);
    return true;
  }
  return false;
}

/**
 * Get memory stats for an agent. Only reads the lightweight metadata file.
 */
export function getMemoryStats(agentId) {
  const meta = readMeta(agentId);
  const categories = {};
  for (const m of meta) {
    categories[m.category] = (categories[m.category] || 0) + 1;
  }
  return { total: meta.length, categories, maxCapacity: MAX_MEMORIES_PER_AGENT };
}

/**
 * List memories paginated. Only reads the lightweight metadata file.
 */
export function listMemories(agentId, { page = 1, perPage = 20, category } = {}) {
  let meta = readMeta(agentId);
  if (category) meta = meta.filter(m => m.category === category);
  meta.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const total = meta.length;
  const totalPages = Math.ceil(total / perPage) || 1;
  const paged = meta.slice((page - 1) * perPage, page * perPage);

  return { items: paged, page, perPage, total, totalPages };
}
