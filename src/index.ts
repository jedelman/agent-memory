/**
 * agent-memory — Cloudflare Worker
 *
 * A semantic memory proxy for AI agents. Accepts plain text, generates
 * embeddings via Workers AI, stores/queries via Vectorize.
 *
 * Agents never touch vectors directly — they think in text.
 *
 * Routes:
 *   POST /upsert   — store or update a memory
 *   POST /query    — find semantically similar memories
 *   POST /delete   — remove a memory by id
 *   GET  /list     — list memories (by namespace, optionally filtered)
 *   GET  /health   — liveness check
 */

export interface Env {
  MEMORY: Vectorize
  AI: Ai
  MEMORY_SECRET: string
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// VectorizeVectorMetadataValue = string | number | boolean | string[]
// No undefined allowed — we strip optional fields before storing.
type MetadataRecord = Record<string, string | number | boolean | string[]>

interface UpsertRequest {
  id: string
  text: string
  agent: string
  namespace: string
  type: string
  tags?: string[]
  confidence?: number
  source?: string
}

interface QueryRequest {
  text: string
  agent?: string
  namespace?: string
  type?: string
  topK?: number
  returnText?: boolean
}

interface DeleteRequest {
  id: string
}

interface ListRequest {
  agent?: string
  namespace?: string
  type?: string
  limit?: number
}

type MetadataFilter = Record<string, { $eq: string | number | boolean }>

// Convenience type for reading metadata back out
interface StoredMetadata {
  agent?: string
  namespace?: string
  text?: string
  type?: string
  createdAt?: string
  updatedAt?: string
  tags?: string
  confidence?: number
  source?: string
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function authorized(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  return token === env.MEMORY_SECRET
}

// ---------------------------------------------------------------------------
// Embed
// ---------------------------------------------------------------------------

async function embed(text: string, env: Env): Promise<number[]> {
  const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: [text],
  }) as { data: number[][] }
  return result.data[0]
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleUpsert(body: UpsertRequest, env: Env): Promise<Response> {
  const { id, text, agent, namespace, type, tags, confidence, source } = body

  if (!id || !text || !agent || !namespace || !type) {
    return json({ error: 'id, text, agent, namespace, and type are required' }, 400)
  }
  if (text.length > 8000) {
    return json({ error: 'text must be under 8000 characters' }, 400)
  }

  const vector = await embed(text, env)
  const now = new Date().toISOString()

  // Build metadata — no undefined values allowed by Vectorize
  const metadata: MetadataRecord = {
    agent,
    namespace,
    text,
    type,
    createdAt: now,
    updatedAt: now,
  }
  if (tags?.length) metadata.tags = tags.join(',')
  if (confidence !== undefined) metadata.confidence = confidence
  if (source) metadata.source = source

  const result = await env.MEMORY.upsert([{ id, values: vector, metadata }])

  return json({ ok: true, id, mutationId: result.mutationId })
}

async function handleQuery(body: QueryRequest, env: Env): Promise<Response> {
  const { text, agent, namespace, type, topK = 10, returnText = true } = body

  if (!text) return json({ error: 'text is required' }, 400)

  const vector = await embed(text, env)

  const filter: MetadataFilter = {}
  if (agent) filter.agent = { $eq: agent }
  if (namespace) filter.namespace = { $eq: namespace }
  if (type) filter.type = { $eq: type }

  const results = await env.MEMORY.query(vector, {
    topK: Math.min(topK, 50),
    returnMetadata: returnText ? 'all' : 'indexed',
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
  })

  const memories = results.matches.map(match => {
    const m = match.metadata as StoredMetadata | undefined
    return {
      id: match.id,
      score: match.score,
      ...(returnText ? { text: m?.text } : {}),
      agent: m?.agent,
      namespace: m?.namespace,
      type: m?.type,
      tags: m?.tags,
      confidence: m?.confidence,
      createdAt: m?.createdAt,
      updatedAt: m?.updatedAt,
    }
  })

  return json({ memories, count: memories.length })
}

async function handleDelete(body: DeleteRequest, env: Env): Promise<Response> {
  if (!body.id) return json({ error: 'id is required' }, 400)
  const result = await env.MEMORY.deleteByIds([body.id])
  return json({ ok: true, mutationId: result.mutationId })
}

async function handleList(params: ListRequest, env: Env): Promise<Response> {
  const { agent, namespace, type, limit = 50 } = params

  // Zero vector approximation — Vectorize is a similarity engine, not a DB.
  // For authoritative inventory, use git-tracked memory files.
  const zeroVector = new Array(768).fill(0) as number[]

  const filter: MetadataFilter = {}
  if (agent) filter.agent = { $eq: agent }
  if (namespace) filter.namespace = { $eq: namespace }
  if (type) filter.type = { $eq: type }

  const results = await env.MEMORY.query(zeroVector, {
    topK: Math.min(limit, 100),
    returnMetadata: 'all',
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
  })

  const memories = results.matches.map(match => {
    const m = match.metadata as StoredMetadata | undefined
    return {
      id: match.id,
      score: match.score,
      text: m?.text,
      agent: m?.agent,
      namespace: m?.namespace,
      type: m?.type,
      tags: m?.tags,
      confidence: m?.confidence,
      createdAt: m?.createdAt,
      updatedAt: m?.updatedAt,
    }
  })

  return json({ memories, count: memories.length })
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/health') {
      return json({ status: 'ok', service: 'agent-memory', version: '1.0.0' })
    }

    if (!authorized(request, env)) {
      return json({ error: 'unauthorized' }, 401)
    }

    const method = request.method.toUpperCase()

    try {
      if (method === 'POST' && path === '/upsert') {
        return handleUpsert(await request.json() as UpsertRequest, env)
      }
      if (method === 'POST' && path === '/query') {
        return handleQuery(await request.json() as QueryRequest, env)
      }
      if (method === 'POST' && path === '/delete') {
        return handleDelete(await request.json() as DeleteRequest, env)
      }
      if (method === 'GET' && path === '/list') {
        return handleList({
          agent: url.searchParams.get('agent') ?? undefined,
          namespace: url.searchParams.get('namespace') ?? undefined,
          type: url.searchParams.get('type') ?? undefined,
          limit: parseInt(url.searchParams.get('limit') ?? '50'),
        }, env)
      }
      return json({ error: 'not found' }, 404)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[agent-memory] ${method} ${path} error:`, message)
      return json({ error: 'internal error', detail: message }, 500)
    }
  }
} satisfies ExportedHandler<Env>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
