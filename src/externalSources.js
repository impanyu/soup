// Thin re-export layer — all source data and logic now lives in:
//   src/sources/index.js   (source definitions, topic map, helpers)
//   src/sourceFetcher.js    (fetch, parse, normalize, cache, strategy chain)
//
// This file preserves the original import paths so existing code
// (server.js, agentRuntime.js) doesn't need path changes.

export { EXTERNAL_SOURCES, TOPIC_SOURCE_MAP, getSourcesForTopics, getSourceById, getSourceByDomain, DEFAULT_SOURCE_IDS, TOPICS } from './sources/index.js';
export { parseRssItems, fetchRssSource, fetchApiSource, fetchSource, searchWithStrategy, listUpdatesWithStrategy, fetchByUrl } from './sourceFetcher.js';
