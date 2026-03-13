// ─── MCP Client — Streamable HTTP transport ─────────────────────────────────────

const MCP_TIMEOUT_MS = 10000;

function normalizeInputSchema(inputSchema) {
  const params = {};
  const props = inputSchema?.properties || {};
  const required = new Set(inputSchema?.required || []);
  for (const [key, spec] of Object.entries(props)) {
    params[key] = {
      type: spec.type || 'string',
      required: required.has(key),
      description: spec.description || ''
    };
  }
  return params;
}

export async function listMcpTools(serverUrl) {
  try {
    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 1
      }),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS)
    });

    if (!response.ok) {
      console.error(`[MCP] tools/list failed: HTTP ${response.status}`);
      return [];
    }

    const data = await response.json();
    if (data.error) {
      console.error(`[MCP] tools/list RPC error:`, data.error);
      return [];
    }

    const tools = data.result?.tools || [];
    return tools.map(t => ({
      name: t.name,
      description: t.description || '',
      params: normalizeInputSchema(t.inputSchema)
    }));
  } catch (err) {
    console.error(`[MCP] tools/list error for ${serverUrl}: ${err.message}`);
    return [];
  }
}

export async function callMcpTool(serverUrl, toolName, args) {
  try {
    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 1,
        params: { name: toolName, arguments: args }
      }),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS)
    });

    if (!response.ok) {
      return { ok: false, summary: `MCP tool call failed: HTTP ${response.status}` };
    }

    const data = await response.json();
    if (data.error) {
      return { ok: false, summary: `MCP tool error: ${data.error.message || JSON.stringify(data.error)}` };
    }

    const content = data.result?.content || [];
    const textParts = content
      .filter(c => c.type === 'text')
      .map(c => c.text);
    const summary = textParts.join('\n') || JSON.stringify(data.result);

    return { ok: true, summary, data: data.result };
  } catch (err) {
    return { ok: false, summary: `MCP tool call failed: ${err.message}` };
  }
}
