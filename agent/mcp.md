# MCP-серверы для Astra (angel-agent runtime)

Этот файл описывает, какие MCP-серверы должны быть подключены к Astra на сервере.
Подключение делается через `~/.mcp.json` (per-agent или global), либо через `claude mcp add` внутри tmux pane после первого `/login`.

## Обязательные (core toolkit)

| MCP | Назначение | Auth | Источник |
|-----|------------|------|----------|
| `reply` / `react` / `edit_message` / `download_attachment` | Telegram I/O | автоматически через angel-agent `plugin-mcp` | angel-agent runtime |

## Google Workspace

| MCP | Назначение | Auth |
|-----|------------|------|
| `claude_ai_Gmail` | чтение/отправка писем, inbox triage, digest enrichment | OAuth (`/login` через web flow) |
| `claude_ai_Google_Calendar` | события (Lisbon-sync, pre-meeting), расписание | OAuth |
| `claude_ai_Google_Drive` | чтение/запись файлов, drive-tree (`vault/_drive-tree.md`), Production Updates Tracker | OAuth |

OAuth-токены **НЕ переносятся** с локалки — Тёма выполняет `/login` для каждого MCP внутри tmux pane Astra. У сервера должен быть открыт browser-flow callback (или manual paste кода).

## Slack (два workspace)

| MCP | Назначение | Auth |
|-----|------------|------|
| `claude_ai_Slack-AC` | AstroCat Slack: каналы `cofounders-speakeasy`, `ac-production-updates`, `leads`, project channels | OAuth (Slack app install) |
| `claude_ai_Slack-HG` | Highground Slack | OAuth |

См. memory: `feedback_mcp_access.md` — на сервере доступ ко всем 3 workspace через единый OAuth flow.

## Astra-internal (из production astra-bot)

| MCP | Назначение | Источник |
|-----|------------|----------|
| `astra-memory` | внутренняя проектная память (Postgres-backed, не путать с `mempalace`) | `~/personal-assistant/src/mcp/memory/` |
| `astra-briefing` | data для briefing skill (project status, ClickUp, Slack) | `~/personal-assistant/src/mcp/briefing/` |

**Как подключить:** оба MCP запускаются как subprocess из репо `~/personal-assistant/`. В `.mcp.json` для Astra:
```json
{
  "mcpServers": {
    "astra-memory": {
      "command": "tsx",
      "args": ["/home/clawdbot/personal-assistant/src/mcp/memory/server.ts"],
      "env": {
        "DATABASE_URL": "<from ~/personal-assistant/.env>"
      }
    },
    "astra-briefing": { ... }
  }
}
```
**Тёма проверяет**: пути правильные (репо на сервере = `/home/clawdbot/personal-assistant/`, не `~/projects/`).

## Дополнительные

| MCP | Назначение | Auth |
|-----|------------|------|
| `clickup` | tasks AC + HG (shared workspace) | API key из `CLICKUP_API_TOKEN` |
| `notion` (опционально) | Notion docs | `NOTION_TOKEN` (если задан) |
| `mempalace` | semantic memory (angel-agent native) | автоматически из `MEMORY_PRIMARY=mempalace` в `.env` |

## После установки — verify

Внутри tmux pane Astra:

```
/mcp list
```

Ожидаем увидеть:
- `reply`, `react`, `edit_message`, `download_attachment` (от plugin-mcp)
- `claude_ai_Gmail`, `claude_ai_Google_Calendar`, `claude_ai_Google_Drive`
- `claude_ai_Slack-AC`, `claude_ai_Slack-HG`
- `astra-memory`, `astra-briefing`
- `clickup`
- `notion` (если включён)
- `mempalace` (от angel-agent module-memory)

Если что-то отсутствует — `claude mcp add <name> ...` или редактируем `.mcp.json` и `/restart`.
