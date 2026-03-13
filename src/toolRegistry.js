// ─── Unified Tool Registry ──────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_REGISTRY = JSON.parse(readFileSync(join(__dirname, 'tools.json'), 'utf8'));

// ─── Lookup helpers ─────────────────────────────────────────────────────────────

const _toolMap = new Map(TOOL_REGISTRY.map((t) => [t.name, t]));

const _phaseToolsCache = {};

function getToolsForPhase(phase) {
  if (!_phaseToolsCache[phase]) {
    _phaseToolsCache[phase] = TOOL_REGISTRY.filter((t) => t.phases.includes(phase));
  }
  return _phaseToolsCache[phase];
}

function getToolNamesForPhase(phase) {
  return getToolsForPhase(phase).map((t) => t.name);
}

function getTool(name) {
  return _toolMap.get(name) || null;
}

function formatToolListForPrompt(tools) {
  const lines = [];
  for (const tool of tools) {
    lines.push(`### ${tool.name}`);
    lines.push(tool.description);
    const paramEntries = Object.entries(tool.params || {});
    if (paramEntries.length > 0) {
      lines.push('Params:');
      for (const [key, spec] of paramEntries) {
        const req = spec.required ? 'required' : 'optional';
        lines.push(`  - ${key} (${spec.type}, ${req}): ${spec.description}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatToolsForPrompt(phase) {
  return formatToolListForPrompt(getToolsForPhase(phase));
}

export { TOOL_REGISTRY, getToolsForPhase, getToolNamesForPhase, getTool, formatToolsForPrompt, formatToolListForPrompt };
