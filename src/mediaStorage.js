import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MEDIA_DIR = process.env.MEDIA_STORAGE_DIR || path.join(__dirname, '..', 'data', 'media');
const MAX_DOWNLOAD_SIZE = 10 * 1024 * 1024; // 10MB
const DOWNLOAD_TIMEOUT_MS = 15000;

export function ensureMediaDir() {
  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
  }
}

export function saveBuffer(buffer, ext) {
  ensureMediaDir();
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const cleanExt = ext.replace(/^\./, '');
  const filename = `${hash}.${cleanExt}`;
  const filePath = path.join(MEDIA_DIR, filename);

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, buffer);
  }

  return { storageKey: filename, localUrl: `/media/${filename}` };
}

export async function downloadImage(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { 'User-Agent': 'SoupMediaBot/1.0' }
  });

  if (!response.ok) {
    throw new Error(`Failed to download image: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) {
    throw new Error(`Invalid content type for image download: ${contentType}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length > MAX_DOWNLOAD_SIZE) {
    throw new Error(`Image too large: ${buffer.length} bytes (max ${MAX_DOWNLOAD_SIZE})`);
  }

  const ext = extFromContentType(contentType) || 'jpg';
  return saveBuffer(buffer, ext);
}

export async function downloadMedia(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { 'User-Agent': 'SoupMediaBot/1.0' }
  });

  if (!response.ok) {
    throw new Error(`Failed to download media: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
    throw new Error(`Invalid content type for media download: ${contentType}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length > MAX_DOWNLOAD_SIZE) {
    throw new Error(`Media too large: ${buffer.length} bytes (max ${MAX_DOWNLOAD_SIZE})`);
  }

  const isVideo = contentType.startsWith('video/');
  const ext = extFromContentType(contentType) || (isVideo ? 'mp4' : 'jpg');
  const stored = saveBuffer(buffer, ext);
  return { ...stored, type: isVideo ? 'video' : 'image' };
}

export async function downloadAiMedia(apiResult) {
  if (!apiResult?.url) {
    throw new Error('AI media result has no URL');
  }

  const response = await fetch(apiResult.url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { 'User-Agent': 'SoupMediaBot/1.0' }
  });

  if (!response.ok) {
    throw new Error(`Failed to download AI media: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length > MAX_DOWNLOAD_SIZE) {
    throw new Error(`AI media too large: ${buffer.length} bytes`);
  }

  const isVideo = apiResult.type === 'video' || contentType.startsWith('video/');
  const ext = extFromContentType(contentType) || (isVideo ? 'mp4' : 'jpg');
  return saveBuffer(buffer, ext);
}

export function getMediaLocalUrl(storageKey) {
  return `/media/${storageKey}`;
}

function extFromContentType(ct) {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov'
  };
  const base = (ct || '').split(';')[0].trim().toLowerCase();
  return map[base] || null;
}
