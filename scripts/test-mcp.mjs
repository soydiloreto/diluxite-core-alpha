#!/usr/bin/env node
/**
 * MCP smoke test — initialises a Streamable HTTP session against
 * http://localhost:3030/mcp using the token in /tmp/mcp.token, then
 * calls every tool the server advertises and prints (a) latency and
 * (b) a short preview of the result. Exits non-zero if any tool fails.
 */
import { readFileSync } from 'node:fs';

const URL = process.env.MCP_URL ?? 'http://localhost:3030/mcp';
const TOKEN = (process.env.MCP_TOKEN ?? readFileSync('/tmp/mcp.token', 'utf8')).trim();

let sessionId = '';
let rpcId = 0;

async function rpc(method, params, expectSession = true) {
  const isNotification = method.startsWith('notifications/');
  rpcId += 1;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${TOKEN}`,
  };
  if (expectSession && sessionId) headers['Mcp-Session-Id'] = sessionId;

  const t0 = performance.now();
  const res = await fetch(URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      // Notifications don't carry an id (and must not expect a response).
      ...(isNotification ? {} : { id: rpcId }),
      method,
      params,
    }),
  });
  const elapsed = performance.now() - t0;

  if (res.status === 202 || isNotification) return { elapsed, body: null };
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!sessionId) sessionId = res.headers.get('mcp-session-id') ?? '';

  const ct = res.headers.get('content-type') ?? '';
  const text = await res.text();
  let body;
  if (ct.includes('text/event-stream')) {
    // Pick the first `data:` line that parses as JSON.
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        try {
          body = JSON.parse(line.slice(5).trim());
          break;
        } catch {
          /* keep looking */
        }
      }
    }
  } else {
    body = JSON.parse(text);
  }
  if (body && body.error) throw new Error(`${method} -> error ${body.error.code}: ${body.error.message}`);
  return { elapsed, body };
}

async function callTool(name, args = {}) {
  const { elapsed, body } = await rpc('tools/call', { name, arguments: args });
  const out = body?.result?.content?.[0]?.text ?? '(no text content)';
  const preview = out.replace(/\s+/g, ' ').slice(0, 140);
  return { elapsed, preview, length: out.length };
}

const results = [];
let failed = 0;

async function expect(label, fn) {
  process.stdout.write(`  • ${label.padEnd(38, ' ')} `);
  try {
    const r = await fn();
    const ms = r.elapsed.toFixed(1);
    console.log(`OK  ${ms.padStart(7)}ms  ${r.preview ?? ''}`);
    results.push({ label, ok: true, ms: +ms, preview: r.preview });
  } catch (e) {
    failed++;
    console.log(`FAIL  ${e.message}`);
    results.push({ label, ok: false, error: e.message });
  }
}

// ───── 1. Handshake ─────────────────────────────────────────────────────
console.log(`\nMCP test against ${URL}`);
console.log('━'.repeat(80));
await expect('initialize', async () => {
  const { elapsed, body } = await rpc(
    'initialize',
    {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'diluxite-mcp-smoketest', version: '0.1.0' },
      capabilities: {},
    },
    false,
  );
  return { elapsed, preview: `session=${sessionId || '∅'} server=${body?.result?.serverInfo?.name ?? '?'}` };
});
await rpc('notifications/initialized', {});

// ───── 2. List tools ────────────────────────────────────────────────────
let tools = [];
await expect('tools/list', async () => {
  const { elapsed, body } = await rpc('tools/list', {});
  tools = body?.result?.tools ?? [];
  return { elapsed, preview: `${tools.length} tools: ${tools.map((t) => t.name).join(', ')}` };
});

// ───── 3. Call each tool with realistic args ────────────────────────────
console.log('━'.repeat(80));

// Capture a workspace + a note id we can reuse downstream.
let spaceId = '';
let noteId = '';

await expect('list_spaces', async () => {
  const r = await callTool('list_spaces');
  // "- My space (id: <uuid>)" → grab the first uuid.
  const m = /id:\s*([0-9a-f-]{36})/i.exec(r.preview);
  if (m) spaceId = m[1];
  return r;
});

await expect('list_notes (default space)', async () => {
  const r = await callTool('list_notes');
  const m = /id:\s*([0-9a-f-]{36})/i.exec(r.preview);
  if (m) noteId = m[1];
  return r;
});

await expect('recent_notes (limit=5)', () => callTool('recent_notes', { limit: 5 }));
await expect('list_tags', () => callTool('list_tags'));
await expect('search_memory "Hexagonal Architecture"', () =>
  callTool('search_memory', { query: 'Hexagonal Architecture', topK: 3 }),
);
await expect('search_memory "postgres connection pooling"', () =>
  callTool('search_memory', { query: 'postgres connection pooling', topK: 3 }),
);
await expect('search_by_tag "architecture"', () => callTool('search_by_tag', { tag: 'architecture' }));
await expect('read_note (first note)', () => callTool('read_note', { id: noteId }));
await expect('backlinks_of (first note)', () => callTool('backlinks_of', { id: noteId }));
await expect('write_note (new)', () =>
  callTool('write_note', {
    title: `MCP smoketest ${new Date().toISOString().slice(11, 19)}`,
    content: '# Smoketest\nThis note was created by `scripts/test-mcp.mjs`.\n\n#smoketest [[Diluxite]]',
  }),
);
await expect('append_to_note (first note)', () =>
  callTool('append_to_note', { id: noteId, content: '\n<!-- mcp smoketest appended -->' }),
);

// ───── 4. Negative checks ────────────────────────────────────────────────
console.log('━'.repeat(80));
console.log('Negative checks:');
await expect('read_note (bogus id) → "Not found."', async () => {
  const r = await callTool('read_note', { id: '00000000-0000-0000-0000-000000000000' });
  if (!/not found/i.test(r.preview)) throw new Error(`unexpected: ${r.preview}`);
  return r;
});
await expect('search_by_tag (unknown) → "No notes…"', async () => {
  const r = await callTool('search_by_tag', { tag: 'this-tag-does-not-exist' });
  if (!/no notes/i.test(r.preview)) throw new Error(`unexpected: ${r.preview}`);
  return r;
});

// ───── Summary ──────────────────────────────────────────────────────────
console.log('━'.repeat(80));
const okCount = results.filter((r) => r.ok).length;
const total = results.length;
console.log(`Summary: ${okCount}/${total} passed`);
const latencies = results.filter((r) => r.ok).map((r) => r.ms);
if (latencies.length) {
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const max = latencies[latencies.length - 1];
  console.log(`Latency p50=${p50}ms  p95=${p95}ms  max=${max}ms`);
}

process.exit(failed > 0 ? 1 : 0);
