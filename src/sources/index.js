// Aggregator: loads all JSON source files and exports unified EXTERNAL_SOURCES + maps + helpers

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { TOPICS } from './topics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadJsonFile(filename) {
  try {
    return JSON.parse(readFileSync(join(__dirname, filename), 'utf-8'));
  } catch (err) {
    console.error(`Failed to load source file ${filename}:`, err.message);
    return [];
  }
}

// Load all category JSON files
const SOURCE_FILES = [
  'news.json',
  'tech.json',
  'academic.json',
  'social.json',
  'finance.json',
  'science.json',
  'entertainment.json',
  'health.json',
  'sports.json',
  'lifestyle.json',
  'dev.json',
  'multimedia.json',
  'data-apis.json'
];

export const EXTERNAL_SOURCES = SOURCE_FILES.flatMap(loadJsonFile);

// Backfill rss/search fields for backward compatibility
for (const source of EXTERNAL_SOURCES) {
  if (!source.rss && source.responseFormat === 'xml' && !source.search) {
    // RSS-only source without explicit rss field
  }
  if (source.rss) {
    source.type = source.type || 'rss';
  }
  if (source.search) {
    source.type = source.type || 'api';
    // Backfill config for compatibility
    if (!source.config) {
      source.config = {
        endpoint: source.search.endpoint,
        searchParam: source.search.searchParam,
        resultPath: source.search.resultPath
      };
    }
  }
  if (!source.type) {
    source.type = source.rss ? 'rss' : 'api';
  }
}

// Auto-derive topic → source mapping
export const TOPIC_SOURCE_MAP = {};
for (const source of EXTERNAL_SOURCES) {
  for (const topic of source.topics) {
    (TOPIC_SOURCE_MAP[topic] ||= []).push(source.id);
  }
}

// Source lookup by ID
const SOURCE_BY_ID = new Map(EXTERNAL_SOURCES.map(s => [s.id, s]));

// ── Helpers ─────────────────────────────────────────

export function getSourcesForTopics(topicArray) {
  const ids = new Set();
  for (const topic of topicArray) {
    const sources = TOPIC_SOURCE_MAP[topic];
    if (sources) {
      for (const id of sources) ids.add(id);
    }
  }
  return [...ids];
}

export function getSourceById(id) {
  return SOURCE_BY_ID.get(id) || null;
}

export { TOPICS };
