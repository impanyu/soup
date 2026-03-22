import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data', 'agents');

const DOWNLOAD_TIMEOUT_MS = 15000;
const MAX_DOWNLOAD_SIZE = 10 * 1024 * 1024; // 10MB
const AGENT_STORAGE_QUOTA = 1 * 1024 * 1024 * 1024; // 1GB per agent

// ─── Directory helpers ──────────────────────────────────────────────────────────

function agentDir(agentId) {
  return path.join(DATA_DIR, agentId);
}

function filesDir(agentId) {
  return path.join(agentDir(agentId), 'files');
}

function draftsDir(agentId) {
  return path.join(agentDir(agentId), 'drafts');
}

function draftPath(agentId) {
  return path.join(draftsDir(agentId), 'draft.md');
}

export function ensureAgentDirs(agentId) {
  fs.mkdirSync(filesDir(agentId), { recursive: true });
  fs.mkdirSync(draftsDir(agentId), { recursive: true });
}

// ─── URL history (persists across runs) ─────────────────────────────────────

function urlHistoryPath(agentId) {
  return path.join(agentDir(agentId), 'url_history.json');
}

function loadUrlHistory(agentId) {
  const p = urlHistoryPath(agentId);
  if (!fs.existsSync(p)) return { fetched: {}, saved: {} };
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { fetched: {}, saved: {} }; }
}

function saveUrlHistory(agentId, history) {
  ensureAgentDirs(agentId);
  fs.writeFileSync(urlHistoryPath(agentId), JSON.stringify(history), 'utf8');
}

export function hasUrlBeenFetched(agentId, url) {
  return !!loadUrlHistory(agentId).fetched[url];
}

export function recordUrlFetched(agentId, url) {
  const history = loadUrlHistory(agentId);
  history.fetched[url] = new Date().toISOString();
  saveUrlHistory(agentId, history);
}

export function hasMediaBeenSaved(agentId, url) {
  return !!loadUrlHistory(agentId).saved[url];
}

export function recordMediaSaved(agentId, url) {
  const history = loadUrlHistory(agentId);
  history.saved[url] = new Date().toISOString();
  saveUrlHistory(agentId, history);
}

// ─── Draft list (persists across runs) ───────────────────────────────────────

function draftsListPath(agentId) {
  return path.join(draftsDir(agentId), 'drafts.json');
}

function loadDraftsList(agentId) {
  const p = draftsListPath(agentId);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function saveDraftsList(agentId, drafts) {
  ensureAgentDirs(agentId);
  fs.writeFileSync(draftsListPath(agentId), JSON.stringify(drafts, null, 2), 'utf8');
}

const MAX_DRAFTS = Number(process.env.MAX_DRAFTS_PER_AGENT) || 10;

export function createDraft(agentId, { title = '', text = '', tags = [], media = [] }) {
  let drafts = loadDraftsList(agentId);
  const id = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const draft = { id, title, text, tags, media, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  drafts.unshift(draft); // newest first
  if (drafts.length > MAX_DRAFTS) drafts = drafts.slice(0, MAX_DRAFTS);
  saveDraftsList(agentId, drafts);
  return draft;
}

export function getDraft(agentId, draftId) {
  return loadDraftsList(agentId).find(d => d.id === draftId) || null;
}

export function updateDraft(agentId, draftId, updates) {
  const drafts = loadDraftsList(agentId);
  const idx = drafts.findIndex(d => d.id === draftId);
  if (idx === -1) return null;
  if (updates.title !== undefined) drafts[idx].title = updates.title;
  if (updates.text !== undefined) drafts[idx].text = updates.text;
  if (updates.tags !== undefined) drafts[idx].tags = updates.tags;
  if (updates.media !== undefined) drafts[idx].media = updates.media;
  drafts[idx].updatedAt = new Date().toISOString();
  saveDraftsList(agentId, drafts);
  return drafts[idx];
}

export function deleteDraftById(agentId, draftId) {
  const drafts = loadDraftsList(agentId);
  const filtered = drafts.filter(d => d.id !== draftId);
  saveDraftsList(agentId, filtered);
  return filtered.length < drafts.length;
}

export function listDrafts(agentId, { page = 1, perPage = 10 } = {}) {
  const drafts = loadDraftsList(agentId); // already newest first
  const total = drafts.length;
  const totalPages = Math.ceil(total / perPage) || 1;
  const p = Math.max(1, Math.min(page, totalPages));
  const start = (p - 1) * perPage;
  return { drafts: drafts.slice(start, start + perPage), page: p, totalPages, totalItems: total };
}

export function searchDrafts(agentId, query) {
  const q = (query || '').toLowerCase();
  if (!q) return loadDraftsList(agentId);
  return loadDraftsList(agentId).filter(d =>
    (d.title || '').toLowerCase().includes(q) ||
    (d.text || '').toLowerCase().includes(q) ||
    (d.tags || []).some(t => t.toLowerCase().includes(q))
  );
}

export function getMostRecentDraft(agentId) {
  const drafts = loadDraftsList(agentId);
  return drafts.length > 0 ? drafts[0] : null;
}

// Legacy single-draft compat (used by old code paths)
export function writeDraft(agentId, markdown) {
  ensureAgentDirs(agentId);
  fs.writeFileSync(draftPath(agentId), markdown, 'utf8');
}

export function readDraft(agentId) {
  const p = draftPath(agentId);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

export function deleteDraft(agentId) {
  const p = draftPath(agentId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ─── Markdown draft format ──────────────────────────────────────────────────────

export function draftToMarkdown({ title, tags, text, media }) {
  const lines = [];
  lines.push('---');
  lines.push(`title: ${title || ''}`);
  lines.push(`tags: [${(tags || []).join(', ')}]`);
  lines.push('---');
  lines.push('');
  lines.push(text || '');

  if (Array.isArray(media) && media.length > 0) {
    lines.push('');
    lines.push('<!-- media -->');
    for (const item of media) {
      const caption = item.caption || item.prompt || '';
      const url = item.url || '';
      lines.push(`![${caption}](${url})`);
    }
    lines.push('<!-- /media -->');
  }

  return lines.join('\n');
}

export function parseDraft(markdown, agentId) {
  if (!markdown) return { title: '', tags: [], text: '', media: [] };

  let title = '';
  let tags = [];
  let bodyLines = [];
  const media = [];

  const content = markdown.trim();

  // Parse front matter
  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3);
    if (endIdx !== -1) {
      const frontMatter = content.slice(3, endIdx).trim();
      const rest = content.slice(endIdx + 3).trim();

      for (const line of frontMatter.split('\n')) {
        const titleMatch = line.match(/^title:\s*(.*)$/);
        if (titleMatch) {
          title = titleMatch[1].trim();
        }
        const tagsMatch = line.match(/^tags:\s*\[([^\]]*)\]$/);
        if (tagsMatch) {
          tags = tagsMatch[1].split(',').map((t) => t.trim()).filter(Boolean);
        }
      }

      // Parse body and media from rest
      const mediaStartIdx = rest.indexOf('<!-- media -->');
      const mediaEndIdx = rest.indexOf('<!-- /media -->');

      if (mediaStartIdx !== -1 && mediaEndIdx !== -1) {
        bodyLines = rest.slice(0, mediaStartIdx).trim().split('\n');
        const mediaBlock = rest.slice(mediaStartIdx + '<!-- media -->'.length, mediaEndIdx).trim();
        const mediaRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
        let match;
        while ((match = mediaRegex.exec(mediaBlock)) !== null) {
          const caption = match[1];
          const url = match[2];
          const isVideo = /\.(mp4|webm|mov)$/i.test(url) || /youtube|vimeo/i.test(url);
          media.push({
            type: isVideo ? 'video' : 'image',
            url,
            caption,
            origin: url.startsWith('/') ? 'local' : 'embedded'
          });
        }
      } else {
        bodyLines = rest.split('\n');
      }
    } else {
      bodyLines = content.split('\n');
    }
  } else {
    bodyLines = content.split('\n');
  }

  return {
    title,
    tags,
    text: bodyLines.join('\n').trim(),
    media
  };
}

// ─── File metadata sidecar ───────────────────────────────────────────────────────

function metadataPath(agentId) {
  return path.join(agentDir(agentId), 'files_metadata.json');
}

export function readFilesMetadata(agentId) {
  const p = metadataPath(agentId);
  if (!fs.existsSync(p)) return { version: 1, files: {} };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { version: data.version || 1, files: data.files || {} };
  } catch {
    return { version: 1, files: {} };
  }
}

function writeFilesMetadata(agentId, metadata) {
  ensureAgentDirs(agentId);
  fs.writeFileSync(metadataPath(agentId), JSON.stringify(metadata, null, 2), 'utf8');
}

export function recordFileMetadata(agentId, filename, { caption, sourceUrl } = {}) {
  const metadata = readFilesMetadata(agentId);
  const existing = metadata.files[filename] || {};
  metadata.files[filename] = {
    ...existing,
    caption: caption || existing.caption || '',
    sourceUrl: sourceUrl || existing.sourceUrl || '',
    savedAt: existing.savedAt || new Date().toISOString(),
    usedInPostIds: existing.usedInPostIds || []
  };
  writeFilesMetadata(agentId, metadata);
}

export function isFileUsedInPost(agentId, filename) {
  const metadata = readFilesMetadata(agentId);
  const entry = metadata.files[filename];
  return entry && entry.usedInPostIds && entry.usedInPostIds.length > 0;
}

export function markFileUsedInPost(agentId, filename, postId) {
  const metadata = readFilesMetadata(agentId);
  const entry = metadata.files[filename];
  if (!entry) {
    metadata.files[filename] = {
      caption: '',
      sourceUrl: '',
      savedAt: new Date().toISOString(),
      usedInPostIds: [postId]
    };
  } else {
    if (!entry.usedInPostIds) entry.usedInPostIds = [];
    if (!entry.usedInPostIds.includes(postId)) {
      entry.usedInPostIds.push(postId);
    }
  }
  writeFilesMetadata(agentId, metadata);
}

// ─── Agent memory ────────────────────────────────────────────────────────────────

export function readMemory(agentId) {
  const p = path.join(agentDir(agentId), 'memory.md');
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

export function writeMemory(agentId, content) {
  ensureAgentDirs(agentId);
  fs.writeFileSync(path.join(agentDir(agentId), 'memory.md'), content, 'utf8');
}

// ─── Agent characteristics ───────────────────────────────────────────────────────

export function writeCharacteristics(agentId, { name, bio, topics, tone, toneProfile }) {
  ensureAgentDirs(agentId);
  const md = `# ${name}\n\n## Bio\n${bio || '(no bio)'}\n\n## Topics\n${topics}\n\n## Tone\n${tone} — ${toneProfile.personality}\n\n## Post Style\n- **Length**: ${toneProfile.length}\n- **Writing style**: ${toneProfile.writingStyle}\n`;
  fs.writeFileSync(path.join(agentDir(agentId), 'characteristics.md'), md, 'utf8');
}

export function readCharacteristics(agentId) {
  const p = path.join(agentDir(agentId), 'characteristics.md');
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

// ─── Per-agent skill overrides ──────────────────────────────────────────────────

export function readSkill(agentId, phase) {
  const p = path.join(agentDir(agentId), 'skills', `${phase}.md`);
  if (!fs.existsSync(p)) return null;  // null = no override, fall back to global
  return fs.readFileSync(p, 'utf8');
}

export function writeSkill(agentId, phase, content) {
  const dir = path.join(agentDir(agentId), 'skills');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${phase}.md`), content, 'utf8');
}

export function deleteSkill(agentId, phase) {
  const p = path.join(agentDir(agentId), 'skills', `${phase}.md`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ─── MCP server storage ─────────────────────────────────────────────────────────

export function readMcpServers(agentId) {
  const p = path.join(agentDir(agentId), 'mcp-servers.json');
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

export function writeMcpServers(agentId, servers) {
  ensureAgentDirs(agentId);
  fs.writeFileSync(path.join(agentDir(agentId), 'mcp-servers.json'), JSON.stringify(servers, null, 2), 'utf8');
}

// ─── Storage quota ──────────────────────────────────────────────────────────────

/**
 * Calculate total size of an agent's files directory in bytes.
 */
function getStorageUsage(agentId) {
  const dir = filesDir(agentId);
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const filename of fs.readdirSync(dir)) {
    try {
      total += fs.statSync(path.join(dir, filename)).size;
    } catch { /* file may have been removed concurrently */ }
  }
  return total;
}

/**
 * Enforce storage quota by removing oldest files until under the limit.
 * Skips the file that was just written (protectedFilename).
 */
function enforceStorageQuota(agentId, protectedFilename) {
  const dir = filesDir(agentId);
  if (!fs.existsSync(dir)) return;

  let total = 0;
  const entries = [];
  for (const filename of fs.readdirSync(dir)) {
    try {
      const filePath = path.join(dir, filename);
      const stat = fs.statSync(filePath);
      total += stat.size;
      entries.push({ filename, filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch { /* skip */ }
  }

  if (total <= AGENT_STORAGE_QUOTA) return;

  // Sort oldest first (lowest mtime)
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

  for (const entry of entries) {
    if (total <= AGENT_STORAGE_QUOTA) break;
    if (entry.filename === protectedFilename) continue;
    try {
      fs.unlinkSync(entry.filePath);
      total -= entry.size;
      console.log(`[storage-quota] Removed ${entry.filename} from agent ${agentId} (freed ${entry.size} bytes)`);
    } catch { /* skip */ }
  }
}

export { getStorageUsage, AGENT_STORAGE_QUOTA };

// ─── File operations ────────────────────────────────────────────────────────────

export async function downloadToAgentStorage(agentId, url) {
  ensureAgentDirs(agentId);

  // Handle local /agents/{id}/files/{filename} paths — copy from disk
  const localPath = resolveAgentFilePath(url);
  if (localPath) {
    return copyFileToAgentStorage(agentId, localPath);
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { 'User-Agent': 'SoupAgentBot/1.0' }
  });

  if (!response.ok) {
    throw new Error(`Failed to download file: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length > MAX_DOWNLOAD_SIZE) {
    throw new Error(`File too large: ${buffer.length} bytes (max ${MAX_DOWNLOAD_SIZE})`);
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const ext = extFromUrl(url) || extFromContentType(contentType) || sniffExtFromBuffer(buffer);

  if (!ext) {
    throw new Error(`Unsupported file type (content-type: ${contentType}). Only image and video files are allowed.`);
  }

  const ALLOWED_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'mp4', 'webm', 'mov']);
  if (!ALLOWED_EXTS.has(ext)) {
    throw new Error(`Unsupported file extension ".${ext}" (content-type: ${contentType}). Only image and video files are allowed.`);
  }

  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  const filename = `${hash}.${ext}`;
  const filePath = path.join(filesDir(agentId), filename);

  fs.writeFileSync(filePath, buffer);
  enforceStorageQuota(agentId, filename);

  const typeMap = {
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', svg: 'image',
    mp4: 'video', webm: 'video', mov: 'video'
  };

  return {
    filename,
    localUrl: `/agents/${agentId}/files/${filename}`,
    size: buffer.length,
    mediaType: typeMap[ext] || 'other'
  };
}

export function copyFileToAgentStorage(targetAgentId, sourceFilePath) {
  ensureAgentDirs(targetAgentId);
  if (!fs.existsSync(sourceFilePath)) throw new Error(`Source file not found: ${sourceFilePath}`);
  const buffer = fs.readFileSync(sourceFilePath);
  const ext = path.extname(sourceFilePath).slice(1).toLowerCase() || 'bin';
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  const filename = `${hash}.${ext}`;
  const destPath = path.join(filesDir(targetAgentId), filename);
  fs.writeFileSync(destPath, buffer);
  enforceStorageQuota(targetAgentId, filename);
  const typeMap = {
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', svg: 'image',
    mp4: 'video', webm: 'video', mov: 'video',
    pdf: 'document', txt: 'document', md: 'document'
  };
  return {
    filename,
    localUrl: `/agents/${targetAgentId}/files/${filename}`,
    size: buffer.length,
    mediaType: typeMap[ext] || 'other'
  };
}

export function resolveAgentFilePath(localUrl) {
  // Convert /agents/{id}/files/{filename} to absolute disk path
  const match = localUrl.match(/^\/agents\/([^/]+)\/files\/([^/]+)$/);
  if (!match) return null;
  return path.join(filesDir(match[1]), path.basename(match[2]));
}

export function listAgentFiles(agentId) {
  const dir = filesDir(agentId);
  if (!fs.existsSync(dir)) return [];

  const metadata = readFilesMetadata(agentId);

  return fs.readdirSync(dir).map((filename) => {
    const filePath = path.join(dir, filename);
    const stat = fs.statSync(filePath);
    const ext = path.extname(filename).slice(1).toLowerCase();
    const typeMap = {
      jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', svg: 'image',
      mp4: 'video', webm: 'video', mov: 'video',
      pdf: 'document', txt: 'document', md: 'document'
    };
    const meta = metadata.files[filename] || {};
    const usedInPostIds = meta.usedInPostIds || [];
    return {
      filename,
      size: stat.size,
      type: typeMap[ext] || 'other',
      localUrl: `/agents/${agentId}/files/${filename}`,
      caption: meta.caption || '',
      savedAt: meta.savedAt || '',
      usedInPostIds,
      used: usedInPostIds.length > 0
    };
  });
}

export function getAgentFilePath(agentId, filename) {
  // Sanitize: only allow simple filenames (no path traversal)
  const safe = path.basename(filename);
  return path.join(filesDir(agentId), safe);
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).slice(1).toLowerCase();
    return ext || null;
  } catch {
    return null;
  }
}

function extFromContentType(ct) {
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'application/pdf': 'pdf', 'text/plain': 'txt'
  };
  const base = (ct || '').split(';')[0].trim().toLowerCase();
  return map[base] || null;
}

function sniffExtFromBuffer(buffer) {
  if (!buffer || buffer.length < 4) return null;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg';
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'gif';
  // WEBP: RIFF....WEBP
  if (buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'webp';
  // MP4/MOV: ....ftyp
  if (buffer.length >= 8 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) return 'mp4';
  return null;
}

