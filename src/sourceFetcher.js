// Generic fetcher/normalizer/cache for all source types
// Strategy-based: API → RSS → Google site-search → scrape

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
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'dc:date');
    const author = extractTag(block, 'dc:creator') || extractTag(block, 'author');
    items.push({
      title: stripCdata(title),
      url: stripCdata(link),
      snippet: stripHtml(stripCdata(description)).slice(0, 200),
      publishedAt: pubDate ? pubDate.trim() : undefined,
      author: author ? stripCdata(author) : undefined
    });
  }
  // Also handle Atom <entry> format
  if (items.length === 0) {
    const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    while ((match = entryRegex.exec(xml)) !== null) {
      const block = match[1];
      const title = extractTag(block, 'title');
      const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      const link = linkMatch ? linkMatch[1] : '';
      const summary = extractTag(block, 'summary') || extractTag(block, 'content');
      const updated = extractTag(block, 'updated') || extractTag(block, 'published');
      const authorBlock = extractTag(block, 'author');
      const authorName = authorBlock ? extractTag(authorBlock, 'name') : '';
      items.push({
        title: stripCdata(title),
        url: link,
        snippet: stripHtml(stripCdata(summary)).slice(0, 200),
        publishedAt: updated ? updated.trim() : undefined,
        author: authorName || undefined
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

  let items;
  if (cfg.resultPath === 'root') {
    items = Array.isArray(data) ? data : [data];
  } else if (cfg.resultPath) {
    items = getByPath(data, cfg.resultPath);
    if (items && !Array.isArray(items)) {
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
    return items.slice(0, limit).map(item => ({
      source: source.id,
      title: item.title || item.name || source.name + ' result',
      snippet: (item.description || item.snippet || item.summary || '').toString().slice(0, 200),
      url: item.url || item.link || item.html_url || '',
      ...(source.dataType === 'structured' ? { rawData: item } : {})
    }));
  }

  return items.slice(0, limit).map(item => {
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

// ── TMDB handler ────────────────────────────────────

function buildTmdbUrl(source, query, limit) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) throw new Error('TMDB_API_KEY not set');
  return `${source.search.endpoint}?query=${encodeURIComponent(query)}&api_key=${apiKey}`;
}

// ── YouTube handler ─────────────────────────────────

function buildYouTubeUrl(source, query, limit) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error('YOUTUBE_API_KEY not set');
  const url = buildSearchUrl(source, query, limit);
  return `${url}&key=${apiKey}`;
}

// ── Unsplash handler ────────────────────────────────

function getUnsplashHeaders() {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) throw new Error('UNSPLASH_ACCESS_KEY not set');
  return { Authorization: `Client-ID ${key}` };
}

// ── Pexels handler ──────────────────────────────────

function getPexelsHeaders() {
  const key = process.env.PEXELS_API_KEY;
  if (!key) throw new Error('PEXELS_API_KEY not set');
  return { Authorization: key };
}

// ── Giphy handler ───────────────────────────────────

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
    url: item.url || '',
    author: item.author || undefined,
    publishedAt: item.publishedAt || undefined
  }));
}

// ── API fetcher ─────────────────────────────────────

export async function fetchApiSource(source, query, limit = 5) {
  const cfg = source.search;
  if (!cfg?.endpoint) throw new Error(`Source "${source.id}" has no search API.`);

  if (source.responseFormat === 'graphql' || source.id === 'anilist') {
    return fetchAniList(source, query, limit);
  }

  if (source.id === 'open-meteo' || source.id === 'open-meteo-forecast') {
    return [{
      source: source.id,
      title: `Weather data for ${query}`,
      snippet: 'Open-Meteo provides free weather forecast data.',
      url: 'https://open-meteo.com'
    }];
  }

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

  if (source.id === 'arxiv') {
    const xml = await res.text();
    return parseArxivEntries(xml, source.id, limit);
  }

  const json = await res.json();
  return normalizeResults(source, json, limit);
}

// ── DuckDuckGo HTML search (used for web search + site-search) ──

function parseDdgResults(html, sourceId, limit) {
  const results = [];
  const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [];
  let sn;
  while ((sn = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtml(sn[1]).slice(0, 200));
  }
  let m;
  let i = 0;
  while ((m = linkRegex.exec(html)) !== null && results.length < limit) {
    let url = m[1];
    const title = stripHtml(m[2]);
    // DDG wraps URLs in redirect links — extract the actual URL
    const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
    // Skip ad links and empty titles
    if (url.startsWith('http') && !url.includes('duckduckgo.com/y.js') && title.length > 0) {
      results.push({ source: sourceId, title, snippet: snippets[i] || '', url });
    }
    i++;
  }
  return results;
}

async function ddgSearch(query, sourceId, limit = 5) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html'
    }
  }, 10000);
  if (!res.ok) throw new Error(`Web search failed: ${res.status}`);
  const html = await res.text();
  const results = parseDdgResults(html, sourceId, limit);
  if (results.length === 0) throw new Error('Web search returned no parseable results');
  return results;
}

async function googleSiteSearch(source, query, limit = 5) {
  if (!source.siteUrl) throw new Error('No siteUrl for site search');
  const domain = new URL(source.siteUrl).hostname;
  return ddgSearch(`${query} site:${domain}`, source.id, limit);
}

// ── Web scrape (direct fetch of source homepage/search) ──

async function scrapeSourcePage(source, query, limit = 5) {
  if (!source.siteUrl) throw new Error('No siteUrl for scraping');
  // Try the source's own search page if it has a common pattern
  const searchPatterns = [
    `${source.siteUrl}/search?q=${encodeURIComponent(query)}`,
    `${source.siteUrl}/search?query=${encodeURIComponent(query)}`,
    `${source.siteUrl}/?s=${encodeURIComponent(query)}`
  ];
  for (const searchUrl of searchPatterns) {
    try {
      const res = await fetchWithTimeout(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html'
        }
      }, 8000);
      if (!res.ok) continue;
      const html = await res.text();
      const items = extractLinksFromHtml(html, source, limit);
      if (items.length > 0) return items;
    } catch { /* try next pattern */ }
  }
  throw new Error(`Scraping failed for ${source.id}`);
}

function extractLinksFromHtml(html, source, limit) {
  const results = [];
  const domain = new URL(source.siteUrl).hostname;
  // Look for article-like links: <a> with <h2> or <h3> children
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<(?:h[1-4])[^>]*>([\s\S]*?)<\/(?:h[1-4])>/gi;
  let m;
  while ((m = linkRegex.exec(html)) !== null && results.length < limit) {
    let url = m[1];
    const title = stripHtml(m[2]).trim();
    if (!title || title.length < 5) continue;
    // Resolve relative URLs
    if (url.startsWith('/')) url = new URL(url, source.siteUrl).href;
    else if (!url.startsWith('http')) continue;
    // Only include links from the same domain
    try {
      if (!new URL(url).hostname.includes(domain.replace(/^www\./, ''))) continue;
    } catch { continue; }
    results.push({ source: source.id, title, snippet: '', url });
  }
  return results;
}

// ── Google general web search ──

async function googleWebSearch(query, limit = 5) {
  return ddgSearch(query, 'google', limit);
}

// ── Dynamic RSS: supports {query} placeholder in feedUrl ──

async function fetchDynamicRss(source, query, limit = 5) {
  const feedUrl = source.rss?.feedUrl;
  if (!feedUrl) throw new Error(`Source "${source.id}" has no RSS feed.`);
  // Replace {query} placeholder if present
  const resolvedUrl = feedUrl.includes('{query}')
    ? feedUrl.replace('{query}', encodeURIComponent(query || ''))
    : feedUrl;
  if (resolvedUrl.includes('{query}')) throw new Error('RSS feed requires a query');
  const res = await fetchWithTimeout(resolvedUrl, {
    headers: { 'User-Agent': 'SoupPlatform/1.0' }
  });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();
  let items = parseRssItems(xml);
  // If the feed URL was NOT dynamic, filter by query client-side
  if (!feedUrl.includes('{query}') && query) {
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
    url: item.url || '',
    author: item.author || undefined,
    publishedAt: item.publishedAt || undefined
  }));
}

// ══════════════════════════════════════════════════════
// ── Strategy-based unified fetchers ─────────────────
// ══════════════════════════════════════════════════════

/**
 * Search a single source using the best available strategy.
 * Priority: Native API → RSS+filter → Google site-search → scrape
 * Special: google source does general web search
 */
export async function searchWithStrategy(source, query, limit = 5) {
  // Special: Google general web search
  if (source.id === 'google') {
    return googleWebSearch(query, limit);
  }
  const errors = [];

  // Strategy 1: Native search API (skip pseudo-configs like google_web_search)
  if (source.search && source.search._type !== 'google_web_search') {
    try {
      return await fetchApiSource(source, query, limit);
    } catch (err) {
      errors.push(`API: ${err.message}`);
    }
  }

  // Strategy 2: RSS feed + query filter (supports {query} placeholder in feedUrl)
  if (source.rss) {
    try {
      const hasDynamic = source.rss.feedUrl?.includes('{query}');
      return hasDynamic
        ? await fetchDynamicRss(source, query, limit)
        : await fetchRssSource(source, query, limit);
    } catch (err) {
      errors.push(`RSS: ${err.message}`);
    }
  }

  // Strategy 3: Google site-search
  if (source.siteUrl) {
    try {
      return await googleSiteSearch(source, query, limit);
    } catch (err) {
      errors.push(`Google: ${err.message}`);
    }
  }

  // Strategy 4: Direct scrape of source search page
  if (source.siteUrl) {
    try {
      return await scrapeSourcePage(source, query, limit);
    } catch (err) {
      errors.push(`Scrape: ${err.message}`);
    }
  }

  throw new Error(`All strategies failed for ${source.id}: ${errors.join('; ')}`);
}

/**
 * Get latest content from a source (no query).
 * Priority: RSS → API latest → scrape homepage
 */
export async function listUpdatesWithStrategy(source, limit = 10) {
  // Google source doesn't support list_updates (it's a search engine, not a content source)
  if (source.id === 'google') {
    throw new Error('Google Search does not support list_updates. Use search instead.');
  }
  const errors = [];

  // Strategy 1: RSS feed (skip dynamic feeds that need a query)
  if (source.rss && !source.rss.feedUrl?.includes('{query}')) {
    try {
      return await fetchRssSource(source, '', limit);
    } catch (err) {
      errors.push(`RSS: ${err.message}`);
    }
  }

  // Strategy 2: API with empty query (some APIs return latest)
  if (source.search && source.search._type !== 'google_web_search') {
    try {
      return await fetchApiSource(source, '', limit);
    } catch (err) {
      errors.push(`API: ${err.message}`);
    }
  }

  // Strategy 3: Google "site:" search for "latest" or trending content
  if (source.siteUrl) {
    try {
      return await googleSiteSearch(source, 'latest OR trending OR new', limit);
    } catch (err) {
      errors.push(`Google: ${err.message}`);
    }
  }

  throw new Error(`All strategies failed for ${source.id}: ${errors.join('; ')}`);
}

/**
 * Fetch a single URL and return a rich NormalizedItem.
 * Replaces the old read_article inline handler.
 */
export async function fetchByUrl(url, knownSource = null) {
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'SoupPlatform/1.0',
      Accept: 'text/html,application/json,text/plain'
    }
  }, 10000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const contentType = res.headers.get('content-type') || '';
  let content;
  let images = [];
  let title = '';

  if (contentType.includes('json')) {
    const json = await res.json();
    content = JSON.stringify(json).slice(0, 2000);
    title = json.title || json.name || '';
  } else {
    const html = await res.text();

    // Extract page title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    title = titleMatch ? stripHtml(titleMatch[1]).slice(0, 200) : '';

    // Extract images
    const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?/gi;
    let imgMatch;
    const baseUrl = new URL(url);
    while ((imgMatch = imgRegex.exec(html)) !== null && images.length < 5) {
      let imgSrc = imgMatch[1];
      const imgAlt = imgMatch[2] || '';
      if (imgSrc.startsWith('data:') || /\b(icon|logo|avatar|pixel|tracking|badge|button)\b/i.test(imgSrc)) continue;
      if (imgSrc.startsWith('//')) imgSrc = baseUrl.protocol + imgSrc;
      else if (imgSrc.startsWith('/')) imgSrc = baseUrl.origin + imgSrc;
      else if (!imgSrc.startsWith('http')) continue;
      images.push({ url: imgSrc, alt: imgAlt });
    }

    // Strip HTML for readable text
    content = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                  .replace(/<style[\s\S]*?<\/style>/gi, '')
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 2000);
  }

  return {
    source: knownSource?.id || 'web',
    title: title || url,
    snippet: content.slice(0, 200),
    url,
    content,
    images: images.length ? images : undefined,
    metadata: knownSource ? { sourceName: knownSource.name, category: knownSource.category } : undefined
  };
}

// ── In-memory cache (5 min TTL, 2000 entries) ───────

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX = 2000;

function withCache(key, fn) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return Promise.resolve(cached.data);
  }
  return fn().then(data => {
    cache.set(key, { data, ts: Date.now() });
    if (cache.size > CACHE_MAX) {
      const now = Date.now();
      for (const [k, v] of cache) {
        if (now - v.ts > CACHE_TTL) cache.delete(k);
      }
    }
    return data;
  });
}

// Legacy fetchSource — now uses strategy chain internally
export async function fetchSource(source, query, limit = 5) {
  const cacheKey = `${source.id}:${query}:${limit}`;
  return withCache(cacheKey, () =>
    query ? searchWithStrategy(source, query, limit) : listUpdatesWithStrategy(source, limit)
  );
}

export { getByPath };
