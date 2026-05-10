# AGENTS — единый контекст для LLM-агентов в репо `astra`

> Этот файл — единый источник правды для всех LLM-агентов, работающих с этим репо
> (Claude Code, Codex, Cursor). Симлинки `codex.md` и `.cursorrules` указывают сюда.
> Читай этот файл целиком до того, как редактировать код.

## Контекст

**Проект:** Astra — персональный AI-ассистент Дария (Telegram-бот) для управления операциями
двух игровых студий (AstroCat, Highground). Делает digest, briefing, pre-meeting reports,
работает со Slack/Gmail/Calendar/ClickUp/Drive, ведёт vault knowledge base.

**Github:** `DariyDar/astra` (private). Production deploy: GitHub Actions → `~/personal-assistant/` на сервере clawdbot@91.98.194.94.

## Архитектура

| Папка | Назначение |
|-------|------------|
| `src/bot/` | grammY entry, message routing, telegram handlers |
| `src/worker/` | background jobs (digest, pre-meeting, drive-tree cron) |
| `src/brain/` | LLM orchestration, callClaude wrapper, investigation subagents |
| `src/skills/` | skill engine (briefing, clockify, pre-meeting, lisbon) |
| `src/kb/` | knowledge registry (102 YAML files: people, projects, channels, processes) |
| `src/mcp/` | MCP server implementations (astra-memory, astra-briefing) |
| `src/integrations/` | Slack/Gmail/Calendar/ClickUp/Notion/Drive clients |
| `src/db/` | Drizzle schema + migrations |
| `src/digest/` | daily digest assembly |
| `src/channels/`, `src/notifications/`, `src/telegram/` | message I/O |
| `vault/` | Obsidian markdown KB (synced via Syncthing, **gitignored**) |
| `agent/` | Claude Code identity bundle for server migration (см. ниже) |

## Запуск

| Command | Эффект |
|---------|--------|
| `pnpm tsx src/bot/index.ts` | Dev: бот с long-poll |
| `pnpm tsx src/worker/index.ts` | Dev: worker (cron jobs) |
| `pnpm build` (`tsc`) | Build TypeScript → `dist/` |
| `pnpm db:generate` | Drizzle: generate migration |
| `pnpm db:migrate` | Drizzle: apply migrations |
| `docker compose up -d` | Поднять postgres + redis (только инфра) |

**Production:** PM2 через `ecosystem.config.cjs` (astra-bot + astra-worker), `cwd=/home/clawdbot/personal-assistant`, deploy через GitHub Actions push в main.

## Правила

> Источник: `~/.claude/projects/c--Users-dimsh-Downloads-Personal-Assistant/memory/MEMORY.md`

- Общение с пользователем — **на русском**. Код, коммиты, PR — **на английском**.
- Astra **не угадывает** — всегда задаёт уточняющий вопрос если не уверена.
- **Никогда не auto-merge сущности** в KB — всегда показываем пользователю на approval.
- **NO write actions** на server / Drive / external APIs без явного разрешения пользователя.
- **NEVER use Gemini** — всё через `callClaude()` (Max subscription).
- MCP-запросы должны быть **точными** — фильтруй на уровне MCP/API, не отправляй всё в LLM.
- Не раздувай system prompt без обсуждения с пользователем.
- Sensitive Drive files (HR, financials) **никогда** не перемещай в shared project folders.

## Команды (тестирование/качество)

| Command | Эффект |
|---------|--------|
| `pnpm tsc --noEmit` | Type check |
| `pnpm test` | (если настроено — vitest) |
| `npx prettier --write <files>` | Format |

> Сейчас в проекте нет test runner setup в `package.json` — используем `tsc` для типов.

## ENV vars (имена, без значений — см. `.env.example`)

**Database:** `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL`
**Cache:** `REDIS_PASSWORD`, `REDIS_URL`
**Crypto:** `ENCRYPTION_KEY` (32-byte hex)
**Telegram:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`
**Slack AC:** `SLACK_AC_BOT_TOKEN`, `SLACK_AC_APP_TOKEN`, `SLACK_AC_USER_TOKEN`, `SLACK_AC_ADMIN_USER_ID`, `SLACK_AC_TEAM_ID`
**Slack HG:** `SLACK_HG_BOT_TOKEN`, `SLACK_HG_APP_TOKEN`, `SLACK_HG_USER_TOKEN`, `SLACK_HG_ADMIN_USER_ID`, `SLACK_HG_TEAM_ID`
**Google:** `GOOGLE_*` (OAuth, см. `.env.example`)
**ClickUp:** `CLICKUP_API_TOKEN`
**Notion:** `NOTION_TOKEN` (опционально)
**LLM:** `ANTHROPIC_API_KEY` (или Claude Max subscription через `claude` CLI)

## Server Migration (см. `agent/` папку)

Локальная Claude Code-сессия мигрирует на сервер как **angel-agent инстанс** под именем `astra`. Идентичность (persona, settings, hooks, MCP, memory) лежит в `agent/`. Подробности в `plans/drifting-prancing-parrot.md` (создаётся отдельно, не в репо).

Production astra-bot (PM2 jobs `astra-bot` + `astra-worker`) **продолжает работать** — мигрирует только «brain», обрабатывающий входящие Telegram-сообщения.

## Где править этот файл

Правь `AGENTS.md`. Симлинки `codex.md`, `.cursorrules` подхватят автоматически. `CLAUDE.md` создаётся отдельно (если будет нужен Claude Code-специфичный context).
