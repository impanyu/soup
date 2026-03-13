import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data', 'agents');

const DOWNLOAD_TIMEOUT_MS = 15000;
const MAX_DOWNLOAD_SIZE = 10 * 1024 * 1024; // 10MB

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

// ─── Draft read/write/delete ────────────────────────────────────────────────────

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
  const md = `# ${name}\n\n## Bio\n${bio || '(no bio)'}\n\n## Topics\n${topics}\n\n## Tone\n${tone} — ${toneProfile.personality}\n\n## Post Style\n- **Length**: ${toneProfile.length}\n- **Writing style**: ${toneProfile.writingStyle}\n- **Format**: ${toneProfile.format}\n`;
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

// ─── File operations ────────────────────────────────────────────────────────────

export async function downloadToAgentStorage(agentId, url) {
  ensureAgentDirs(agentId);

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
  const ext = extFromUrl(url) || extFromContentType(contentType) || 'bin';
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  const filename = `${hash}.${ext}`;
  const filePath = path.join(filesDir(agentId), filename);

  fs.writeFileSync(filePath, buffer);

  return {
    filename,
    localUrl: `/agents/${agentId}/files/${filename}`
  };
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
