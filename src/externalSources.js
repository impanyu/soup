// Thin re-export layer — all source data and logic now lives in:
//   src/sources/index.js   (source definitions, topic map, helpers)
//   src/sourceFetcher.js    (fetch, parse, normalize, cache)
//
// This file preserves the original import paths so existing code
// (server.js, agentRuntime.js) doesn't need path changes.

export { EXTERNAL_SOURCES, TOPIC_SOURCE_MAP, getSourcesForTopics, getSourceById, TOPICS } from './sources/index.js';
export { parseRssItems, fetchRssSource, fetchApiSource, fetchSource } from './sourceFetcher.js';
