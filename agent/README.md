# `agent/` — Astra identity bundle for server migration

Эта папка — **препак для развёртывания Astra как angel-agent инстанса** на сервере `clawdbot@91.98.194.94`. Тёма копирует содержимое в `/home/clawdbot/projects/angel-agent/agents/astra/` и запускает стандартный flow из `docs/how-to-add-agent.md`.

## Что внутри

| Файл/папка | Куда мапится в angel-agent | Зачем |
|------------|----------------------------|-------|
| `CLAUDE.md` | `agents/astra/CLAUDE.md` | system prompt (persona, правила, инструменты) |
| `.env.example` | `agents/astra/.env.example` → копируется в `.env` и заполняется | конфиг daemon (PORT, TELEGRAM_BOT_TOKEN, AGENT_NAME) |
| `mcp.md` | reference for setup | список MCP-серверов для подключения через `claude mcp add` |
| `telegram.md` | reference for setup | routing rules, voice STT, allowed users, bot |
| `agents/` | копировать в `~/.claude/agents/` (для clawdbot user) | мои sub-агенты (planner, code-reviewer, gsd-*, и т.д.) |
| `hooks/` | копировать в `~/.claude/hooks/` | GSD статусные хуки |
| `memory/` | копировать в `~/.claude/projects/<slug>/memory/` где slug = path-based hash для папки `personal-assistant` на сервере | моя накопленная память (24 файла: MEMORY.md + feedback/project/reference) |

`memory/` **в .gitignore** — копируется отдельно через `scp` или ручной transfer (там может быть приватная инфо).

## Шаги для Тёмы

См. `MIGRATION.md` на сервере (`/home/clawdbot/projects/astra-migration/MIGRATION.md`) — там полный handoff с чек-листом.

Краткий summary:

```bash
# 1. Standard angel-agent flow
cd /home/clawdbot/projects/angel-agent
cp -r agents/_template agents/astra
# (BUT: replace agents/astra/CLAUDE.md with our CLAUDE.md from this bundle)
cp /home/clawdbot/personal-assistant/agent/CLAUDE.md agents/astra/CLAUDE.md
cp /home/clawdbot/personal-assistant/agent/.env.example agents/astra/.env.example
cp agents/astra/.env.example agents/astra/.env
chmod 600 agents/astra/.env
$EDITOR agents/astra/.env  # paste TELEGRAM_BOT_TOKEN from ~/personal-assistant/.env

# 2. State dir
sudo mkdir -p /var/lib/angel-agent/astra
sudo chown clawdbot /var/lib/angel-agent/astra
chmod 700 /var/lib/angel-agent/astra

# 3. Install (auto-generates DAEMON_TOKEN)
./install.sh

# 4. Identity for Claude Code (clawdbot user shares Claude subscription)
cp -r /home/clawdbot/personal-assistant/agent/agents/* ~/.claude/agents/
cp /home/clawdbot/personal-assistant/agent/hooks/* ~/.claude/hooks/

# 5. Memory snapshot (Дарий пришлёт tarball через scp)
mkdir -p ~/.claude/projects/<slug>/memory/
cp /tmp/astra-memory-snapshot/* ~/.claude/projects/<slug>/memory/
# slug определи: ls ~/.claude/projects/ | grep personal

# 6. КРИТИЧНО: выключить long-poll старого astra-bot перед стартом daemon
# Дарий сделает PR в personal-assistant/src/bot/index.ts (см. MIGRATION.md)
# После merge → GitHub Actions deploy → pm2 reload astra-bot

# 7. systemd units (см. docs/systemd.md)
# astra-daemon.service, astra-ttyd.service, astra-auth-watch.service
sudo systemctl enable --now astra-daemon astra-ttyd astra-auth-watch

# 8. Первый /login через ваш watchdog
# 9. MCP setup внутри tmux pane astra (см. agent/mcp.md)
```

## Verify

После запуска Дарий пишет в @AstraAssistant_bot — если CLI отвечает на русском с упоминанием memory (digest, registry, lisbon) → миграция успешна.

Если что-то сломалось — лог в `/var/log/astra-daemon.log` или `journalctl -u astra-daemon -f`.
