#!/usr/bin/env bash
#
# Variant E test: Production setup (Variant D prompt + briefing MCP server).
# Runs the same 10 questions as previous A/B/C/D tests for direct comparison.
# The briefing server should reduce turns and cost significantly.
#
# Usage: bash tests/ab-test-with-briefing.sh
# Must run on the server where MCP servers are configured (.env loaded).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$PROJECT_DIR/tests/ab-results/variant-e"
MCP_CONFIG="$PROJECT_DIR/tests/ab-mcp-config-e.json"

# Load .env for MCP server credentials
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

# ── Generate MCP config (raw tools + briefing server) ──

SLACK_SERVER="$PROJECT_DIR/src/mcp/slack-server.js"
BRIEFING_SERVER="$PROJECT_DIR/src/mcp/briefing-server.ts"
NODE_BIN=$(which node 2>/dev/null || echo "/usr/local/bin/node")
UVX_BIN=$(which uvx 2>/dev/null || echo "$HOME/.local/bin/uvx")
TSX_BIN=$(which tsx 2>/dev/null || echo "$PROJECT_DIR/node_modules/.bin/tsx")
SLACK_TOKEN="${SLACK_USER_TOKEN:-${SLACK_BOT_TOKEN:-}}"

# Build briefing env JSON fragment
BRIEFING_ENV="{"
if [[ -n "$SLACK_TOKEN" ]] && [[ -n "${SLACK_TEAM_ID:-}" ]]; then
  BRIEFING_ENV="$BRIEFING_ENV\"SLACK_USER_TOKEN\": \"$SLACK_TOKEN\", \"SLACK_TEAM_ID\": \"${SLACK_TEAM_ID}\""
fi
if [[ -n "${CLICKUP_API_KEY:-}" ]] && [[ -n "${CLICKUP_TEAM_ID:-}" ]]; then
  [[ "$BRIEFING_ENV" != "{" ]] && BRIEFING_ENV="$BRIEFING_ENV, "
  BRIEFING_ENV="$BRIEFING_ENV\"CLICKUP_API_KEY\": \"${CLICKUP_API_KEY}\", \"CLICKUP_TEAM_ID\": \"${CLICKUP_TEAM_ID}\""
fi
BRIEFING_ENV="$BRIEFING_ENV}"

cat > "$MCP_CONFIG" << MCPEOF
{
  "mcpServers": {
    "slack": {
      "type": "stdio",
      "command": "$NODE_BIN",
      "args": ["$SLACK_SERVER"],
      "env": {
        "SLACK_BOT_TOKEN": "$SLACK_TOKEN",
        "SLACK_TEAM_ID": "${SLACK_TEAM_ID:-}"
      }
    },
    "google-workspace": {
      "type": "stdio",
      "command": "$UVX_BIN",
      "args": ["workspace-mcp", "--read-only", "--tools", "gmail", "drive", "calendar"],
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "${GOOGLE_OAUTH_CLIENT_ID:-}",
        "GOOGLE_OAUTH_CLIENT_SECRET": "${GOOGLE_OAUTH_CLIENT_SECRET:-}"
      }
    },
    "clickup": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@hauptsache.net/clickup-mcp@latest"],
      "env": {
        "CLICKUP_API_KEY": "${CLICKUP_API_KEY:-}",
        "CLICKUP_TEAM_ID": "${CLICKUP_TEAM_ID:-}",
        "CLICKUP_MCP_MODE": "read"
      }
    },
    "astra-briefing": {
      "type": "stdio",
      "command": "$TSX_BIN",
      "args": ["$BRIEFING_SERVER"],
      "env": $BRIEFING_ENV
    }
  }
}
MCPEOF

echo "MCP config written to $MCP_CONFIG"

# ── System prompt: current production (Variant D + briefing guidance) ──

read -r -d '' SYSTEM_PROMPT << 'SEOF' || true
You are Astra, a personal project management assistant. You help a senior PM manage daily routines: tasks, deadlines, meetings, emails, and team coordination. You are concise, proactive, and action-oriented.

You are NOT a coding assistant, developer tool, or general AI. You are a PM's right hand — think of yourself as a smart executive assistant who deeply understands project management.

Language: The user is writing in Russian. Always respond in the same language (ru).

Tone: Friendly but professional. Brief answers — no walls of text.

Honesty: If you don't know something, say so. Never make things up.

Response format:
- Keep responses concise — 1-3 sentences for simple questions
- Use structured format only when listing multiple items
- Use standard Markdown for formatting: **bold**, *italic*, bullet lists (- item)
- Do NOT use # headers — use **bold text** instead for section labels

## User context
The user is Dariy (Дарий), a Senior PM. His Google accounts:
- dariy@astrocat.co (primary work account — use for Calendar, Gmail, Drive by default) — AUTHORIZED
- dimshats@gmail.com (personal) — NOT YET AUTHORIZED for Gmail/Calendar/Drive
- dshatskikh@highground.games (secondary work) — NOT YET AUTHORIZED for Gmail/Calendar/Drive
When searching emails/calendar/drive, only query dariy@astrocat.co. Do NOT attempt to query unauthorized accounts — it wastes tool turns on OAuth errors.

## Integration tools
You have access to external service tools via MCP. All tools are read-only.

**CRITICAL — how to use tools:**
- ALWAYS call the actual tool for real-time data. NEVER answer from conversation history about what's in Slack/ClickUp/Gmail/Calendar. Previous tool failures do NOT mean the tool is broken now — always retry.
- If a tool call fails, retry once with corrected parameters. If still failing, tell the user which specific service is unavailable.
- Never fabricate data — if results are empty, say so explicitly.

**Prefer `briefing` tool for multi-source queries:**
You have a special tool called `briefing` that queries multiple sources (Slack, Gmail, Calendar, ClickUp) in ONE call. It returns compact, pre-filtered results. Use it instead of calling each service separately.

When to use `briefing`:
- "Что нового?" / "Что у меня сегодня?" → briefing(sources=["calendar","gmail","slack","clickup"], query_type="recent", period="today")
- "Есть непрочитанные?" → briefing(sources=["gmail"], query_type="unread", period="today")
- "Что было на этой неделе?" → briefing(sources=["slack","gmail","clickup"], query_type="digest", period="last_week")
- Specific Slack channels: briefing(sources=["slack"], slack_channels=["ohbibi-mwcf-project","stt-team"], period="last_week")

When to use `search_everywhere`:
- "Найди всё про Симфонию" → search_everywhere(search_term="Симфония")
- Any keyword search across all sources

When to use raw tools (slack_get_channel_history, search_gmail_messages, etc.):
- Follow-up questions that need deeper data: "открой тред X", "покажи полный текст письма"
- Queries that `briefing` can't express (specific thread replies, user profiles)

**For Slack raw tools:** pass channel name directly (e.g. "ohbibi-mwcf-project") — auto-resolved to ID.

**Query philosophy — be lean and autonomous:**
Think before calling a tool. Decide exactly what data you need, then request only that. Your goal: deliver a complete answer with minimal tool calls. Don't ask the user to clarify before searching — just find the answer efficiently.

**Bail early — MANDATORY:**
If after 2 tool calls you haven't found what the user asked about, STOP searching and respond with what you know. Say "не нашёл X в [sources checked]" and suggest where the user might look. Do NOT exhaust all turns — it's better to give a fast "not found" than to burn all turns and return nothing.

**When a source is unavailable:**
If a tool returns an error (401, 403, timeout), report it and offer alternatives.
SEOF

# ── 10 test questions (same as A/B/C/D test) ──

QUESTIONS=(
  "Что нового в канале ohbibi-mwcf-project?"
  "Расскажи подробно что обсуждали в stt-team на этой неделе"
  "Какие дедлайны горят на этой неделе?"
  "Есть непрочитанные письма?"
  "Что у меня сегодня по расписанию?"
  "Что нового по всем фронтам?"
  "Найди задачу про онбординг"
  "Кто последний писал в канале general?"
  "Обнови мой контекст по проекту Симфония"
  "Есть письмо от Кости?"
)

# ── Run test ──

rm -rf "$RESULTS_DIR"
mkdir -p "$RESULTS_DIR"

echo ""
echo "════════════════════════════════════════════════════"
echo "  Running Variant E — Production + Briefing (${#QUESTIONS[@]} questions)"
echo "════════════════════════════════════════════════════"

total_input=0
total_output=0
total_cache=0
total_cost=0
total_turns=0

for i in "${!QUESTIONS[@]}"; do
  q="${QUESTIONS[$i]}"
  idx=$((i + 1))
  outfile="$RESULTS_DIR/q$(printf '%02d' $idx).json"

  echo ""
  echo "  [e] Q$idx: $q"
  echo -n "  Running... "

  start_ts=$(date +%s)
  raw_output=$(echo "$q" | claude \
    --print \
    --no-session-persistence \
    --model sonnet \
    --output-format json \
    --system-prompt "$SYSTEM_PROMPT" \
    --mcp-config "$MCP_CONFIG" \
    --permission-mode bypassPermissions \
    --max-turns 8 \
    2>/dev/null) || true
  end_ts=$(date +%s)
  elapsed=$((end_ts - start_ts))

  if echo "$raw_output" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
    input_tokens=$(echo "$raw_output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('usage',{}).get('input_tokens',0))")
    output_tokens=$(echo "$raw_output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('usage',{}).get('output_tokens',0))")
    cache_tokens=$(echo "$raw_output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('usage',{}).get('cache_read_input_tokens',0))")
    cost_usd=$(echo "$raw_output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('total_cost_usd',0))")
    num_turns=$(echo "$raw_output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('num_turns',1))")
    result_text=$(echo "$raw_output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result','') or d.get('content','') or '')")
    subtype=$(echo "$raw_output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('subtype',''))")
    is_error=$(echo "$raw_output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('is_error',False))")
  else
    input_tokens=0; output_tokens=0; cache_tokens=0; cost_usd=0; num_turns=0
    result_text="PARSE_ERROR"; subtype="parse_error"; is_error="True"
  fi

  cat > "$outfile" << QEOF
{
  "variant": "e",
  "question_index": $idx,
  "question": $(python3 -c "import json; print(json.dumps('$q'))"),
  "input_tokens": $input_tokens,
  "output_tokens": $output_tokens,
  "cache_read_tokens": $cache_tokens,
  "cost_usd": $cost_usd,
  "num_turns": $num_turns,
  "elapsed_seconds": $elapsed,
  "subtype": "$subtype",
  "is_error": $is_error,
  "response_length": ${#result_text}
}
QEOF

  echo "$result_text" > "$RESULTS_DIR/q$(printf '%02d' $idx)-response.txt"

  total_input=$(python3 -c "print($total_input + $input_tokens)")
  total_output=$(python3 -c "print($total_output + $output_tokens)")
  total_cache=$(python3 -c "print($total_cache + $cache_tokens)")
  total_cost=$(python3 -c "print(round($total_cost + $cost_usd, 4))")
  total_turns=$(python3 -c "print($total_turns + $num_turns)")

  echo "done (${elapsed}s, turns=$num_turns, cost=\$$cost_usd, in=$input_tokens, out=$output_tokens, cache=$cache_tokens)"

  sleep 2
done

cat > "$RESULTS_DIR/summary.json" << SEOF
{
  "variant": "e",
  "questions_count": ${#QUESTIONS[@]},
  "total_input_tokens": $total_input,
  "total_output_tokens": $total_output,
  "total_cache_read_tokens": $total_cache,
  "total_cost_usd": $total_cost,
  "total_turns": $total_turns,
  "avg_cost_per_question": $(python3 -c "print(round($total_cost / ${#QUESTIONS[@]}, 4))"),
  "avg_turns_per_question": $(python3 -c "print(round($total_turns / ${#QUESTIONS[@]}, 1))")
}
SEOF

echo ""
echo "  ──────────────────────────────────────────"
echo "  Variant E (Production + Briefing) Summary:"
echo "    Total cost:    \$$total_cost"
echo "    Avg cost/q:    \$$(python3 -c "print(round($total_cost / ${#QUESTIONS[@]}, 4))")"
echo "    Total turns:   $total_turns"
echo "    Avg turns/q:   $(python3 -c "print(round($total_turns / ${#QUESTIONS[@]}, 1))")"
echo "    Input tokens:  $total_input"
echo "    Output tokens: $total_output"
echo "    Cache tokens:  $total_cache"
echo "  ──────────────────────────────────────────"
echo ""

# ── Comparison with previous variants ──
echo "╔════════════════════════════════════════════════════════════════════════╗"
echo "║                    FULL COMPARISON (A/B/C/D/E)                       ║"
echo "╠════════════════════════════════════════════════════════════════════════╣"
printf "║ %-12s │ %-10s │ %-10s │ %-8s │ %-8s │ %-6s ║\n" "Variant" "Cost" "Avg Cost" "Turns" "Avg Trns" "Fails"
echo "║──────────────┼────────────┼────────────┼──────────┼──────────┼────────║"

for v in a b c d e; do
  summary="$PROJECT_DIR/tests/ab-results/variant-$v/summary.json"
  if [[ -f "$summary" ]]; then
    total_cost_v=$(python3 -c "import json; d=json.load(open('$summary')); print(f'\${d[\"total_cost_usd\"]:.2f}')")
    avg_cost_v=$(python3 -c "import json; d=json.load(open('$summary')); print(f'\${d[\"avg_cost_per_question\"]:.4f}')")
    total_turns_v=$(python3 -c "import json; d=json.load(open('$summary')); print(d['total_turns'])")
    avg_turns_v=$(python3 -c "import json; d=json.load(open('$summary')); print(d['avg_turns_per_question'])")
    # Count failures (error_max_turns with empty response)
    fails=$(ls "$PROJECT_DIR/tests/ab-results/variant-$v"/q*-response.txt 2>/dev/null | while read f; do
      size=$(wc -c < "$f")
      [[ $size -le 2 ]] && echo "1"
    done | wc -l)
    printf "║ %-12s │ %-10s │ %-10s │ %-8s │ %-8s │ %-6s ║\n" "$v" "$total_cost_v" "$avg_cost_v" "$total_turns_v" "$avg_turns_v" "$fails"
  fi
done

echo "╚════════════════════════════════════════════════════════════════════════╝"
echo ""
echo "Done at $(date)"
