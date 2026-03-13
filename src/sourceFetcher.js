// Generic fetcher/normalizer/cache for all source types
// Replaces the per-source handlers in the old externalSources module

// ── Path traversal helper ───────────────────────────

function getByPath(obj, path) {
  if (!path || !obj) return undefined;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

// ── Template interpolation ──────────────────────────

function interpolate(template, item) {
  return template.replace(/\{([^}]+)\}/g, (_, path) => {
    const val = getByPath(item, path);
    if (val === undefined || val === null) return '';
    if (Array.isArray(val)) return val.join(', ');
    return String(val);
  });
}

// ── HTML/XML helpers ────────────────────────────────

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function stripCdata(str) {
  return str.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
}

// ── RSS parser ──────────────────────────────────────

export function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const description = extractTag(block, 'description');
    items.push({
      title: stripCdata(title),
      url: stripCdata(link),
      snippet: stripHtml(stripCdata(description)).slice(0, 200)
    });
  }
  // Also handle Atom <entry> format
  if (items.length === 0) {
    const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    while ((match = entryRegex.exec(xml)) !== null) {
      const block = match[1];
      const title = extractTag(block, 'title');
      // Atom uses <link href="..."/>
      const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      const link = linkMatch ? linkMatch[1] : '';
      const summary = extractTag(block, 'summary') || extractTag(block, 'content');
      items.push({
        title: stripCdata(title),
        url: link,
        snippet: stripHtml(stripCdata(summary)).slice(0, 200)
      });
    }
  }
  return items;
}

// ── Fetch with timeout ──────────────────────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── Generic URL builder ─────────────────────────────

export function buildSearchUrl(source, query, limit) {
  const cfg = source.search;
  if (!cfg?.endpoint) throw new Error(`Source "${source.id}" has no search API.`);

  // Special: ArXiv prefixes query
  if (source.id === 'arxiv') {
    const params = new URLSearchParams();
    params.set('search_query', `all:${query}`);
    params.set('start', '0');
    params.set('max_results', String(limit));
    return `${cfg.endpoint}?${params}`;
  }

  // Special: DOAJ appends query to path
  if (source.id === 'doaj') {
    const params = new URLSearchParams();
    if (cfg.limitParam) params.set(cfg.limitParam, String(limit));
    return `${cfg.endpoint}/${encodeURIComponent(query)}?${params}`;
  }

  // Special: REST Countries appends query to path
  if (source.id === 'rest-countries') {
    return `${cfg.endpoint}/${encodeURIComponent(query)}?fields=name,capital,population,region,flags`;
  }

  // Special: Numbers API returns plain text
  if (source.id === 'numbers-api') {
    return `${cfg.endpoint}/${encodeURIComponent(query)}/trivia?json`;
  }

  const params = new URLSearchParams();
  if (cfg.searchParam && query) {
    params.set(cfg.searchParam, query);
  }
  if (cfg.limitParam && limit) {
    params.set(cfg.limitParam, String(limit));
  }
  if (cfg.extraParams) {
    for (const [k, v] of Object.entries(cfg.extraParams)) {
      // Support ENV: prefix for API keys
      if (typeof v === 'string' && v.startsWith('ENV:')) {
        const envVal = process.env[v.slice(4)];
        if (envVal) params.set(k, envVal);
      } else {
        params.set(k, String(v));
      }
    }
  }
  return `${cfg.endpoint}?${params}`;
}

// ── Generic normalizer ──────────────────────────────

export function normalizeResults(source, data, limit) {
  const cfg = source.search || {};
  const norm = source.normalize;

  // Get items array from response
  let items;
  if (cfg.resultPath === 'root') {
    items = Array.isArray(data) ? data : [data];
  } else if (cfg.resultPath) {
    items = getByPath(data, cfg.resultPath);
    if (items && !Array.isArray(items)) {
      // For things like PubMed idlist where items are primitives
      if (typeof items === 'object') {
        items = Object.values(items);
      } else {
        items = [items];
      }
    }
  } else {
    items = Array.isArray(data) ? data : (data?.results || data?.items || data?.data || []);
  }

  if (!Array.isArray(items)) items = [];

  if (!norm) {
    // Generic fallback
    return items.slice(0, limit).map(item => ({
      source: source.id,
      title: item.title || item.name || source.name + ' result',
      snippet: (item.description || item.snippet || item.summary || '').toString().slice(0, 200),
      url: item.url || item.link || item.html_url || '',
      ...(source.dataType === 'structured' ? { rawData: item } : {})
    }));
  }

  return items.slice(0, limit).map(item => {
    // For PubMed-style where items are just IDs (strings/numbers)
    const isScalar = typeof item !== 'object';
    const context = isScalar ? { _item: item } : item;

    let title = '';
    if (norm.titlePath) title = getByPath(context, norm.titlePath) || '';
    else if (norm.titleTemplate) title = interpolate(norm.titleTemplate, context);
    title = stripHtml(String(title || source.name + ' result'));

    let snippet = '';
    if (norm.snippetPath) snippet = stripHtml(String(getByPath(context, norm.snippetPath) || '')).slice(0, 200);
    else if (norm.snippetTemplate) snippet = interpolate(norm.snippetTemplate, context).slice(0, 200);

    let url = '';
    if (norm.urlPath) url = getByPath(context, norm.urlPath) || '';
    else if (norm.urlTemplate) url = interpolate(norm.urlTemplate, context);

    return {
      source: source.id,
      title,
      snippet,
      url,
      ...(source.dataType === 'structured' ? { rawData: item } : {})
    };
  });
}

// ── ArXiv XML parser ────────────────────────────────

function parseArxivEntries(xml, sourceId, limit) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRegex.exec(xml)) !== null) {
    const block = m[1];
    entries.push({
      source: sourceId,
      title: extractTag(block, 'title').replace(/\s+/g, ' ').trim(),
      snippet: extractTag(block, 'summary').replace(/\s+/g, ' ').trim().slice(0, 200),
      url: extractTag(block, 'id')
    });
  }
  return entries.slice(0, limit);
}

// ── AniList GraphQL handler ─────────────────────────

async function fetchAniList(source, query, limit) {
  const gqlQuery = `query { Page(perPage: ${limit}) { media(search: "${query.replace(/"/g, '\\"')}", type: ANIME) { title { english romaji } siteUrl description } } }`;
  const res = await fetchWithTimeout(source.search.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'SoupPlatform/1.0' },
    body: JSON.stringify({ query: gqlQuery })
  });
  if (!res.ok) throw new Error(`AniList API failed: ${res.status}`);
  const data = await res.json();
  const media = data?.data?.Page?.media || [];
  return media.slice(0, limit).map(m => ({
    source: source.id,
    title: m.title?.english || m.title?.romaji || 'AniList result',
    snippet: stripHtml(m.description || '').slice(0, 200),
    url: m.siteUrl || ''
  }));
}

// ── TMDB handler (needs API key in query) ───────────

function buildTmdbUrl(source, query, limit) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) throw new Error('TMDB_API_KEY not set');
  return `${source.search.endpoint}?query=${encodeURIComponent(query)}&api_key=${apiKey}`;
}

// ── YouTube handler (needs API key in query) ────────

function buildYouTubeUrl(source, query, limit) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error('YOUTUBE_API_KEY not set');
  const url = buildSearchUrl(source, query, limit);
  return `${url}&key=${apiKey}`;
}

// ── Unsplash handler (needs auth header) ────────────

function getUnsplashHeaders() {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) throw new Error('UNSPLASH_ACCESS_KEY not set');
  return { Authorization: `Client-ID ${key}` };
}

// ── Pexels handler (needs auth header) ──────────────

function getPexelsHeaders() {
  const key = process.env.PEXELS_API_KEY;
  if (!key) throw new Error('PEXELS_API_KEY not set');
  return { Authorization: key };
}

// ── Giphy handler (needs API key in query) ──────────

function buildGiphyUrl(source, query, limit) {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) throw new Error('GIPHY_API_KEY not set');
  const url = buildSearchUrl(source, query, limit);
  return `${url}&api_key=${apiKey}`;
}

// ── Alpha Vantage handler ───────────────────────────

function buildAlphaVantageUrl(source, query, limit) {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) throw new Error('ALPHA_VANTAGE_API_KEY not set');
  const url = buildSearchUrl(source, query, limit);
  return `${url}&apikey=${apiKey}`;
}

// ── RSS fetcher ─────────────────────────────────────

export async function fetchRssSource(source, query, limit = 5) {
  const feedUrl = source.rss?.feedUrl;
  if (!feedUrl) throw new Error(`Source "${source.id}" has no RSS feed.`);
  const res = await fetchWithTimeout(feedUrl, {
    headers: { 'User-Agent': 'SoupPlatform/1.0' }
  });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();
  let items = parseRssItems(xml);
  if (query) {
    const q = query.toLowerCase();
    items = items.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.snippet || '').toLowerCase().includes(q)
    );
  }
  return items.slice(0, limit).map(item => ({
    source: source.id,
    title: item.title || source.name + ' article',
    snippet: item.snippet || '',
    url: item.url || ''
  }));
}

// ── API fetcher ─────────────────────────────────────

export async function fetchApiSource(source, query, limit = 5) {
  const cfg = source.search;
  if (!cfg?.endpoint) throw new Error(`Source "${source.id}" has no search API.`);

  // Special handlers for sources that need custom logic
  if (source.responseFormat === 'graphql' || source.id === 'anilist') {
    return fetchAniList(source, query, limit);
  }

  // Open-Meteo special case (no real search)
  if (source.id === 'open-meteo' || source.id === 'open-meteo-forecast') {
    return [{
      source: source.id,
      title: `Weather data for ${query}`,
      snippet: 'Open-Meteo provides free weather forecast data.',
      url: 'https://open-meteo.com'
    }];
  }

  // Build URL with special handlers for sources needing API keys
  let url;
  let extraHeaders = {};

  if (source.id === 'tmdb') {
    url = buildTmdbUrl(source, query, limit);
  } else if (source.id === 'youtube') {
    url = buildYouTubeUrl(source, query, limit);
  } else if (source.id === 'unsplash') {
    url = buildSearchUrl(source, query, limit);
    extraHeaders = getUnsplashHeaders();
  } else if (source.id === 'pexels') {
    url = buildSearchUrl(source, query, limit);
    extraHeaders = getPexelsHeaders();
  } else if (source.id === 'giphy') {
    url = buildGiphyUrl(source, query, limit);
  } else if (source.id === 'alpha-vantage') {
    url = buildAlphaVantageUrl(source, query, limit);
  } else {
    url = buildSearchUrl(source, query, limit);
  }

  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'SoupPlatform/1.0', Accept: 'application/json', ...extraHeaders }
  });
  if (!res.ok) throw new Error(`API fetch failed: ${res.status}`);

  // ArXiv returns XML even from search API
  if (source.id === 'arxiv') {
    const xml = await res.text();
    return parseArxivEntries(xml, source.id, limit);
  }

  const json = await res.json();
  return normalizeResults(source, json, limit);
}

// ── In-memory cache (5 min TTL, 2000 entries) ───────

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX = 2000;

export async function fetchSource(source, query, limit = 5) {
  const cacheKey = `${source.id}:${query}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  let data;
  // Prefer search API when query is provided, fall back to RSS
  if (query && (source.search || source.type === 'api')) {
    data = await fetchApiSource(source, query, limit);
  } else if (source.rss || source.type === 'rss') {
    data = await fetchRssSource(source, query, limit);
  } else {
    data = await fetchApiSource(source, query, limit);
  }

  cache.set(cacheKey, { data, ts: Date.now() });
  if (cache.size > CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.ts > CACHE_TTL) cache.delete(k);
    }
  }

  return data;
}

export { getByPath };
