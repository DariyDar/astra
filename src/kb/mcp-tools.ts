import {
  loadProjectCard, loadSection, formatProjectCard, findCompanyProjects, getKnowledgeMap,
  updateProjectStatus, markPersonLeft, addTeamMember, removeTeamMember, addProjectToPerson,
  createVaultFile,
  type VaultUpdateResult,
} from './vault-reader.js'

// ── Tool definitions ──

export const kbRegistryTool = {
  name: 'kb_registry',
  description: `Navigate the organizational Knowledge Registry — structured catalog of all projects, people, documents, channels, and processes stored in the Obsidian vault.

Without arguments: returns the full knowledge map (table of contents).
With project="X": returns the full project card — team, Slack channels, Drive docs with URLs, ClickUp lists, Notion pages, current status. Also works with company/client names (e.g. "TP", "Tilting Point", "Ohbibi") — returns all projects for that company.
With section="X": returns a specific section of the registry.

Use this FIRST when you need to identify which tools/sources to query for a specific project or topic.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      project: {
        type: 'string' as const,
        description: 'Project name, alias, or company/client name (e.g. "TP", "Ohbibi"). Returns project card(s).',
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
  // Project card (also searches company/client names)
  if (args.project) {
    const card = loadProjectCard(args.project as string)
    if (card) return formatProjectCard(card)

    // Fallback: search by company/client name (e.g. "TP" → Tilting Point → all its projects)
    const companyResult = findCompanyProjects(args.project as string)
    if (companyResult && companyResult.projects.length > 0) {
      const lines = [`# ${companyResult.company} — Projects (${companyResult.projects.length})\n`]
      for (const p of companyResult.projects) {
        lines.push(formatProjectCard(p))
        lines.push('\n---\n')
      }
      return lines.join('\n')
    }

    return JSON.stringify({
      error: `Project or company not found: "${args.project}"`,
      hint: 'Try a different name or alias. Call kb_registry() without arguments to see all projects.',
    })
  }

  // Section
  if (args.section) {
    if (args.section === 'health') {
      return '## Registry Health\n\nHealth reporting is not yet implemented for the vault backend.'
    }
    return loadSection(args.section as string)
  }

  // No arguments → full knowledge map
  return getKnowledgeMap()
}

// ── vault_update tool ──

export const vaultUpdateTool = {
  name: 'vault_update',
  description: `Update the Knowledge Base vault — modify project statuses, team composition, and people records.

Actions:
- update_status: Update a project's current focus and milestones
- mark_left: Mark a person as fired/quit — removes from all projects, sets status: left
- add_member: Add a person to a project team (updates both project and person cards)
- remove_member: Remove a person from a project team
- create_file: Create a new vault file (person, project, process, or external_contact)

Use this when the user says information is outdated, someone was fired, team changed, project status needs updating, or a new entity needs to be added to the knowledge base.
After updating, confirm what was changed.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string' as const,
        enum: ['update_status', 'mark_left', 'add_member', 'remove_member', 'create_file'],
        description: 'Action to perform',
      },
      file_type: {
        type: 'string' as const,
        enum: ['person', 'project', 'process', 'external_contact'],
        description: 'Type of file to create (for create_file action)',
      },
      name: {
        type: 'string' as const,
        description: 'Display name for the new file (for create_file). Must be unique.',
      },
      data: {
        type: 'object' as const,
        description: 'Frontmatter data for create_file. For person: {company, status, role, display_name, aliases, note}. For project: {company, status, display_name, aliases, client, description}.',
      },
      project: {
        type: 'string' as const,
        description: 'Project name or alias (for update_status, add_member, remove_member)',
      },
      person: {
        type: 'string' as const,
        description: 'Person display_name — must match vault filename (for mark_left, add_member, remove_member)',
      },
      role: {
        type: 'string' as const,
        description: 'Role on the project (for add_member)',
      },
      focus: {
        type: 'string' as const,
        description: 'Current focus text in Russian (for update_status)',
      },
      milestones: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Recent milestones as "YYYY-MM-DD: description" strings (for update_status)',
      },
    },
    required: ['action'],
  },
}

export function handleVaultUpdate(args: Record<string, unknown>): string {
  const action = args.action as string
  let result: VaultUpdateResult

  switch (action) {
    case 'update_status': {
      if (!args.project || !args.focus) return JSON.stringify({ error: 'project and focus are required for update_status' })
      result = updateProjectStatus(args.project as string, args.focus as string, args.milestones as string[] | undefined)
      break
    }
    case 'mark_left': {
      if (!args.person) return JSON.stringify({ error: 'person is required for mark_left' })
      result = markPersonLeft(args.person as string)
      break
    }
    case 'add_member': {
      if (!args.project || !args.person || !args.role) return JSON.stringify({ error: 'project, person, and role are required for add_member' })
      result = addTeamMember(args.project as string, args.person as string, args.role as string)
      // Also add project to person's card
      const personResult = addProjectToPerson(args.person as string, args.project as string, args.role as string)
      result.changes.push(...personResult.changes.map(c => `Person card: ${c}`))
      break
    }
    case 'remove_member': {
      if (!args.project || !args.person) return JSON.stringify({ error: 'project and person are required for remove_member' })
      result = removeTeamMember(args.project as string, args.person as string)
      break
    }
    case 'create_file': {
      if (!args.file_type || !args.name) return JSON.stringify({ error: 'file_type and name are required for create_file' })
      const fileData = (args.data as Record<string, unknown>) ?? {}
      result = createVaultFile(
        args.file_type as 'person' | 'project' | 'process' | 'external_contact',
        args.name as string,
        fileData,
      )
      break
    }
    default:
      return JSON.stringify({ error: `Unknown action: ${action}` })
  }

  return JSON.stringify(result, null, 2)
}
