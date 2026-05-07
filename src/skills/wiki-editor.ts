import type { Skill } from './types.js'
import { loadPromptCached } from '../kb/vault-loader.js'

/**
 * Wiki Editor — read/edit/create articles in the Company Wiki on Google Drive
 * (consumed by wiki.kinemon.com via Drive sync).
 *
 * The skill enriches the system prompt with the styleguide + workflow rules
 * from vault/instructions-for-llm/skill-wiki-editor.md. Actual reads/writes
 * are performed by the MCP tools wiki_find / wiki_read / wiki_write /
 * wiki_list_folder, registered in src/mcp/briefing/server.ts.
 *
 * Confirmation flow (read → diff → confirm → write) is enforced by the
 * instruction prompt, not by code — the tools themselves do exactly what
 * they are asked.
 */
const wikiEditorSkill: Skill = {
  name: 'wiki-editor',
  description: 'Read, edit and create articles in Company Wiki (Google Drive). Enforces single styleguide and read→diff→confirm→write workflow.',

  triggers: [
    // Editing existing
    'обнови вики', 'обнови статью', 'обнови вики-статью', 'обнови wiki',
    'отредактируй вики', 'отредактируй статью', 'правь вики',
    'перепиши вики', 'перепиши статью',
    'добавь в вики', 'добавь в статью',
    'почини вики', 'почини статью',
    // Creating
    'создай вики', 'создай статью', 'создай wiki', 'создай страницу вики',
    'заведи статью', 'заведи вики',
    'оформи в вики', 'оформи статью',
    // Reading / structure
    'покажи вики', 'найди в вики', 'wiki article', 'wiki edit',
    // Project documentation context
    'проектная документация', 'проектная вики',
  ],

  async preProcess(ctx) {
    return {
      prompt: ctx.message.text,
      systemPromptExtra: loadPromptCached('instructions-for-llm/skill-wiki-editor.md'),
    }
  },
}

export default wikiEditorSkill
