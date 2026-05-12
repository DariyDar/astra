# Environment flags

Опциональные ENV-переменные, меняющие поведение процессов.

## `DISABLE_TELEGRAM_POLLING`

- **Values:** `1` to disable, anything else (or unset) to keep default polling
- **Effect:** `TelegramAdapter.start()` returns immediately, skipping `bot.start()` (long-poll) and middleware registration. The `Bot` instance is still created and remains available for outgoing messages via `bot.api.sendMessage` (used by cron jobs: digest, pre-meeting, drive-tree).
- **Why:** when an external process owns the incoming-message brain (e.g. angel-agent runtime on the server handling Telegram → tmux + Claude Code), this process must NOT compete for `getUpdates` — only one consumer per bot token is allowed by Telegram, otherwise both lose messages with HTTP 409.
- **Where to set:** `~/personal-assistant/.env` on the production server. Restart PM2 (`pm2 reload astra-bot`) after change.

## See also

- [`agent/`](../agent/) — identity bundle for angel-agent instance migration
- [`AGENTS.md`](../AGENTS.md) — single source of truth for LLM agents
