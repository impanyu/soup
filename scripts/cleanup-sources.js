#!/usr/bin/env node
/**
 * Remove broken/defunct sources from JSON files.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcesDir = path.join(__dirname, '..', 'src', 'sources');

// Sources to remove — completely broken or defunct
const REMOVE_IDS = new Set([
  // Defunct
  'cohost',
  // Blog meta pages (not real content sources)
  'threads-meta',
  // Completely blocked (403 on RSS + Google + scrape)
  'spin-magazine', 'giant-bomb', 'entertainment-weekly', 'crunchyroll-news',
  'artstation-magazine', 'cgsociety',
  'physics-today', 'biology-letters', 'cell-press', 'bulletin-atomic-scientists',
  'cosmos-magazine', 'the-conversation-science', 'acs-news',
  'europeana-blog', 'edx-blog',
  'stanford-news', 'ssrn', 'researchgate', 'oecd',
  'investopedia', 'barrons', 'the-street', 'zacks', 'tipranks',
  'defi-pulse', 'forex-factory',
  'medlineplus', 'johns-hopkins-health', 'verywell-health', 'verywell-mind',
  'shape-magazine', 'goodrx-health',
  'tennis-world',
  'treehugger', 'serious-eats', 'the-spruce', 'better-homes-gardens',
  'travel-leisure', 'martha-stewart', 'real-simple', 'food52', 'mydomaine',
  'openai-blog', 'baeldung', 'sitepoint', 'toptal-blog', 'postman-blog',
  'playwright-blog', 'bun-blog',
  // Social platforms that block everything including Google search
  'lemon8',
]);

const sourceFiles = fs.readdirSync(sourcesDir).filter(f => f.endsWith('.json'));

let totalRemoved = 0;
for (const file of sourceFiles) {
  const filePath = path.join(sourcesDir, file);
  const sources = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const before = sources.length;
  const filtered = sources.filter(s => !REMOVE_IDS.has(s.id));
  const removed = before - filtered.length;
  if (removed > 0) {
    fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2) + '\n', 'utf8');
    console.log(`${file}: removed ${removed} source(s)`);
    totalRemoved += removed;
  }
}

console.log(`\nTotal removed: ${totalRemoved} source(s)`);
