import {
  hybridSearch,
  findEntityByName,
  findEntitiesByType,
  getRelationsFor,
} from './kb-facade.js'
import type { EntityType, ChunkSource } from './types.js'
import { loadProjectCard, loadSection, formatProjectCard } from './registry/reader.js'
import { getKnowledgeMap } from './registry/knowledge-map-builder.js'
import { loadDiscoveryReport } from './registry/entity-discovery.js'

// ── Tool definitions ──

export const kbSearchTool = {
  name: 'kb_search',
  description: `Search the Knowledge Base — a persistent store of indexed data from Slack, Gmail, Calendar, ClickUp, Drive, and Notion. Use this for questions about past events, conversations, documents, or tasks. Returns matching text chunks with source citations.

Unlike briefing (which fetches live data), kb_search queries pre-indexed historical data with semantic + keyword hybrid search. Best for: "what did X say about Y?", "find documents about Z", "what happened with project W last month?".`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string' as const,
        description: 'Search query — natural language question or keywords',
      },
      source: {
        type: 'string' as const,
        enum: ['slack', 'gmail', 'calendar', 'clickup', 'drive', 'notion'],
        description: 'Filter by source (optional)',
      },
      person: {
        type: 'string' as const,
        description: 'Filter by person name — resolved via entity aliases (optional)',
      },
      project: {
        type: 'string' as const,
        description: 'Filter by project name — resolved via entity aliases (optional)',
      },
      period: {
        type: 'string' as const,
        description: 'Time period: "last_week", "last_month", "last_3_months", or ISO range "2026-01-01/2026-01-20" (optional)',
      },
      limit: {
        type: 'number' as const,
        description: 'Max results (default 10, max 30)',
        default: 10,
      },
    },
    required: ['query'],
  },
}

export const kbEntitiesTool = {
  name: 'kb_entities',
  description: `Look up entities (people, projects, clients, companies) in the Knowledge Base entity graph. Returns entity details and their relations (who works on what project, who manages whom).

Use for: "who works on Level One?", "what projects does Семён work on?", "show me all projects".`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: {
        type: 'string' as const,
        description: 'Entity name to look up (cross-language, alias-aware)',
      },
      type: {
        type: 'string' as const,
        enum: ['person', 'project', 'channel', 'client', 'company', 'process'],
        description: 'Filter entities by type (optional)',
      },
    },
  },
}

// ── Tool handlers ──

function parsePeriodToRange(period: string): { after?: Date; before?: Date } {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  if (period === 'last_week') {
    return { after: new Date(todayStart.getTime() - 7 * 86400_000), before: now }
  }
  if (period === 'last_month') {
    return { after: new Date(todayStart.getTime() - 30 * 86400_000), before: now }
  }
  if (period === 'last_3_months') {
    return { after: new Date(todayStart.getTime() - 90 * 86400_000), before: now }
  }
  if (period.includes('/')) {
    const [from, to] = period.split('/')
    return { after: new Date(from), before: new Date(to) }
  }
  return {}
}

export async function handleKBSearch(
  args: Record<string, unknown>,
): Promise<string> {
  const query = args.query as string
  if (!query) return JSON.stringify({ error: 'query is required' })

  const rawLimit = Math.max(1, Math.min((args.limit as number) ?? 10, 30))
  const periodRange = args.period ? parsePeriodToRange(args.period as string) : {}

  const results = await hybridSearch(query, {
    source: args.source as ChunkSource | undefined,
    person: args.person as string | undefined,
    project: args.project as string | undefined,
    after: periodRange.after,
    before: periodRange.before,
    limit: rawLimit,
  })

  return JSON.stringify({
    query,
    results: results.map((r) => ({
      text: r.text.length > 500 ? r.text.slice(0, 500) + '…' : r.text,
      source: r.source,
      source_id: r.sourceId,
      date: r.sourceDate?.toISOString() ?? null,
      score: Math.round(r.score * 1000) / 1000,
      metadata: r.metadata,
    })),
    total: results.length,
  }, null, 0)
}

export async function handleKBEntities(
  args: Record<string, unknown>,
): Promise<string> {
  // If name is provided, look up specific entity
  if (args.name) {
    const entity = await findEntityByName(args.name as string)
    if (!entity) {
      return JSON.stringify({ error: `Entity not found: "${args.name}"`, suggestions: 'Try a different name or check kb_entities without a name to see available entities.' })
    }

    const relations = await getRelationsFor(entity.id)

    return JSON.stringify({
      entity: {
        id: entity.id,
        type: entity.type,
        name: entity.name,
        company: entity.company,
      },
      relations: relations.map((r) => ({
        relation: r.relation,
        role: r.role,
        status: r.status,
        from: { name: r.fromName, type: r.fromType },
        to: { name: r.toName, type: r.toType },
      })),
    }, null, 0)
  }

  // If type is provided, list entities of that type
  if (args.type) {
    const entities = await findEntitiesByType(args.type as EntityType)
    return JSON.stringify({
      type: args.type,
      entities: entities.map((e) => ({
        id: e.id,
        name: e.name,
        company: e.company,
      })),
      total: entities.length,
    }, null, 0)
  }

  return JSON.stringify({ error: 'Provide either "name" or "type" parameter' })
}

// ── kb_registry tool ──

export const kbRegistryTool = {
  name: 'kb_registry',
  description: `Navigate the organizational Knowledge Registry — structured YAML catalog of all projects, people, documents, channels, and processes.

Without arguments: returns the full knowledge map (table of contents).
With project="X": returns the full project card — team, Slack channels, Drive docs with URLs, ClickUp lists, Notion pages, current status.
With section="X": returns a specific section of the registry.

Use this FIRST when you need to identify which tools/sources to query for a specific project or topic.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      project: {
        type: 'string' as const,
        description: 'Project name or alias to look up (fuzzy-matched). Returns full project card.',
      },
      section: {
        type: 'string' as const,
        enum: ['people', 'processes', 'drive', 'clickup', 'wiki', 'channels', 'health'],
        description: 'Registry section to browse. "health" shows data freshness and registry gaps.',
      },
    },
  },
}

export function handleKBRegistry(args: Record<string, unknown>): string {
  // Project card
  if (args.project) {
    const card = loadProjectCard(args.project as string)
    if (!card) {
      return JSON.stringify({
        error: `Project not found: "${args.project}"`,
        hint: 'Try a different name or alias. Call kb_registry() without arguments to see all projects.',
      })
    }
    return formatProjectCard(card)
  }

  // Section
  if (args.section) {
    if (args.section === 'health') {
      return formatHealthReport()
    }
    return loadSection(args.section as string)
  }

  // No arguments → full knowledge map
  return getKnowledgeMap()
}

function formatHealthReport(): string {
  const report = loadDiscoveryReport()
  if (!report) {
    return '## Registry Health\n\nNo discovery report available yet. Report is generated during nightly ingestion (22:00 UTC).'
  }

  const lines = [
    `## Registry Health Report`,
    `Generated: ${report.generated_at}`,
    '',
  ]

  if (report.stale_projects.length > 0) {
    lines.push(`### Stale Project Statuses (${report.stale_projects.length})`)
    for (const p of report.stale_projects) {
      lines.push(`- **${p.name}**: last updated ${p.last_updated} (${p.days_stale} days ago)`)
    }
    lines.push('')
  }

  if (report.unknown_slack_users.length > 0) {
    lines.push(`### Unknown Slack Users (${report.unknown_slack_users.length})`)
    lines.push(`People in Slack not found in the YAML people registry:`)
    for (const u of report.unknown_slack_users.slice(0, 20)) {
      lines.push(`- ${u.name} (${u.workspace})`)
    }
    if (report.unknown_slack_users.length > 20) {
      lines.push(`- ... and ${report.unknown_slack_users.length - 20} more`)
    }
    lines.push('')
  }

  if (report.unknown_channels.length > 0) {
    lines.push(`### Uncatalogued Slack Channels (${report.unknown_channels.length})`)
    for (const ch of report.unknown_channels.slice(0, 20)) {
      lines.push(`- #${ch.name} (${ch.workspace}, ${ch.members} members)`)
    }
    if (report.unknown_channels.length > 20) {
      lines.push(`- ... and ${report.unknown_channels.length - 20} more`)
    }
    lines.push('')
  }

  if (report.unknown_clickup_lists.length > 0) {
    lines.push(`### Unknown ClickUp Lists (${report.unknown_clickup_lists.length})`)
    for (const l of report.unknown_clickup_lists) {
      lines.push(`- ${l.name} (space: ${l.space})`)
    }
    lines.push('')
  }

  const total = report.stale_projects.length + report.unknown_slack_users.length +
    report.unknown_channels.length + report.unknown_clickup_lists.length
  if (total === 0) {
    lines.push('All data is fresh and all entities are registered. No gaps detected.')
  }

  return lines.join('\n')
}
