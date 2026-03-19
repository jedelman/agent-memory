/**
 * memory-client.ts
 *
 * Drop into src/ of any agent repo (scout-two, claude-agent, etc.)
 * Requires env vars: MEMORY_PROXY_URL, MEMORY_PROXY_SECRET
 *
 * Usage:
 *   import { MemoryClient } from './memory-client.js'
 *   const memory = new MemoryClient('scout-two')
 *
 *   await memory.upsert({
 *     id: 'obs-2026-03-19-heartpunk-job',
 *     text: 'Heartpunk: accommodation bind — disclosure before hire closes doors...',
 *     namespace: 'observations',
 *     type: 'observation',
 *     tags: ['heartpunk', 'vulnerability', 'job-search'],
 *     confidence: 0.85,
 *   })
 *
 *   const related = await memory.query('heartpunk job search accommodation', { topK: 5 })
 */

const MEMORY_PROXY_URL = process.env.MEMORY_PROXY_URL
const MEMORY_PROXY_SECRET = process.env.MEMORY_PROXY_SECRET

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryItem {
  id: string
  text: string
  namespace: string
  type: MemoryType
  tags?: string[]
  confidence?: number
  source?: MemorySource
}

export type MemoryType =
  | 'observation'    // something noticed about the world or a person
  | 'pattern'        // a recurring dynamic across observations
  | 'relationship'   // characterization of a person/entity
  | 'annotation'     // meta-note on another memory or concept
  | 'note'           // freeform, doesn't fit elsewhere

export type MemorySource =
  | 'session'        // emerged during a thinking session
  | 'feed'           // derived from timeline/notification feed
  | 'inference'      // reasoned from other memories
  | 'human'          // provided directly by Jason

export interface MemoryResult {
  id: string
  score: number
  text?: string
  agent?: string
  namespace?: string
  type?: string
  tags?: string
  confidence?: number
  createdAt?: string
  updatedAt?: string
}

export interface QueryOptions {
  namespace?: string
  type?: MemoryType
  topK?: number
  crossAgent?: boolean  // if true, query all agents' memories (default: own agent only)
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class MemoryClient {
  private agent: string
  private baseUrl: string
  private secret: string

  constructor(agent: string) {
    if (!MEMORY_PROXY_URL) throw new Error('MEMORY_PROXY_URL is required')
    if (!MEMORY_PROXY_SECRET) throw new Error('MEMORY_PROXY_SECRET is required')
    this.agent = agent
    this.baseUrl = MEMORY_PROXY_URL.replace(/\/$/, '')
    this.secret = MEMORY_PROXY_SECRET
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.secret}`,
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Memory proxy error ${res.status}: ${text}`)
    }
    return res.json() as Promise<T>
  }

  /**
   * Store or update a memory. Same id = update.
   * Recommended id format: "{agent}-{namespace}-{slug}"
   * e.g. "scout-two-observations-heartpunk-job-search-2026-03"
   */
  async upsert(item: MemoryItem): Promise<{ ok: boolean; id: string; mutationId: string }> {
    return this.post('/upsert', {
      ...item,
      agent: this.agent,
      tags: item.tags,
    })
  }

  /**
   * Find memories semantically similar to the query text.
   * By default, searches only this agent's memories.
   * Set crossAgent: true to search all agents (collaboration mode).
   */
  async query(text: string, opts: QueryOptions = {}): Promise<MemoryResult[]> {
    const { namespace, type, topK = 10, crossAgent = false } = opts
    const result = await this.post<{ memories: MemoryResult[] }>('/query', {
      text,
      agent: crossAgent ? undefined : this.agent,
      namespace,
      type,
      topK,
    })
    return result.memories
  }

  /**
   * Search across all agents' memories. Useful for collaboration:
   * "what does the collective know about X?"
   */
  async queryShared(text: string, opts: Omit<QueryOptions, 'crossAgent'> = {}): Promise<MemoryResult[]> {
    return this.query(text, { ...opts, crossAgent: true })
  }

  /**
   * Remove a memory by id.
   */
  async delete(id: string): Promise<{ ok: boolean }> {
    return this.post('/delete', { id })
  }

  /**
   * List memories. Approximate — backed by zero-vector similarity search.
   * For authoritative inventory, use git-tracked memory files.
   */
  async list(opts: { namespace?: string; type?: MemoryType; limit?: number } = {}): Promise<MemoryResult[]> {
    const params = new URLSearchParams()
    params.set('agent', this.agent)
    if (opts.namespace) params.set('namespace', opts.namespace)
    if (opts.type) params.set('type', opts.type)
    if (opts.limit) params.set('limit', String(opts.limit))

    const res = await fetch(`${this.baseUrl}/list?${params}`, {
      headers: this.headers(),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Memory proxy error ${res.status}: ${text}`)
    }
    const data = await res.json() as { memories: MemoryResult[] }
    return data.memories
  }

  /**
   * Health check.
   */
  async health(): Promise<{ status: string }> {
    const res = await fetch(`${this.baseUrl}/health`)
    return res.json() as Promise<{ status: string }>
  }
}

// ---------------------------------------------------------------------------
// Convenience: format memory results for inclusion in a digest/prompt
// ---------------------------------------------------------------------------

export function formatMemoriesForPrompt(memories: MemoryResult[], label = 'RELEVANT MEMORIES'): string {
  if (memories.length === 0) return ''

  const lines = [`=== ${label} (${memories.length}) ===`, '']

  for (const m of memories) {
    const confidence = m.confidence !== undefined ? ` [confidence: ${(m.confidence * 100).toFixed(0)}%]` : ''
    const tags = m.tags ? ` [${m.tags}]` : ''
    const score = ` (similarity: ${(m.score * 100).toFixed(1)}%)`
    lines.push(`[${m.id}]${score}${confidence}${tags}`)
    if (m.text) lines.push(`  ${m.text}`)
    if (m.updatedAt) lines.push(`  last updated: ${m.updatedAt.slice(0, 10)}`)
    lines.push('')
  }

  return lines.join('\n')
}
