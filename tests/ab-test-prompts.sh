#!/usr/bin/env bash
#
# A/B/C test: Compare 3 system prompt variants for MCP tool usage efficiency.
#
# Runs 10 questions × 3 variants = 30 Claude CLI calls.
# Collects: response text, input/output/cache tokens, cost, num_turns.
# Output: results/variant-{a,b,c}/ with per-question JSON files + summary.
#
# Usage: bash tests/ab-test-prompts.sh
# Must run on the server where MCP servers are configured (.env loaded).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$PROJECT_DIR/tests/ab-results"
MCP_CONFIG="$PROJECT_DIR/tests/ab-mcp-config.json"

# Load .env for MCP server credentials
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

# ── Generate MCP config (same as bot does at startup) ──

SLACK_SERVER="$PROJECT_DIR/src/mcp/slack-server.js"
NODE_BIN=$(which node 2>/dev/null || echo "/usr/local/bin/node")
UVX_BIN=$(which uvx 2>/dev/null || echo "$HOME/.local/bin/uvx")

# Use SLACK_USER_TOKEN if available, else SLACK_BOT_TOKEN
SLACK_TOKEN="${SLACK_USER_TOKEN:-${SLACK_BOT_TOKEN:-}}"

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
    }
  }
}
MCPEOF

echo "MCP config written to $MCP_CONFIG"

# ── Common system prompt prefix (shared by all variants) ──

read -r -d '' PROMPT_PREFIX << 'PREFIXEOF' || true
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
The user is Dariy, a Senior PM. His Google accounts:
- dariy@astrocat.co (primary work — Calendar, Gmail, Drive by default)
- dimshats@gmail.com (personal)
- dshatskikh@highground.games (secondary work)

PREFIXEOF

# ── Variant A: Philosophy + always ask to go deeper ──

read -r -d '' VARIANT_A << 'AEOF' || true
## Integration tools
You have access to external service tools via MCP (ClickUp, Slack, Gmail, Google Calendar, Google Drive). All tools are read-only.

**CRITICAL — how to use tools:**
- ALWAYS call the actual tool for real-time data. NEVER answer from conversation history about what's in Slack/ClickUp/Gmail/Calendar. Previous tool failures do NOT mean the tool is broken now — always retry.
- If a tool call fails, retry once with corrected parameters. If still failing, tell the user which specific service is unavailable.
- Never fabricate data — if results are empty, say so explicitly.
- For Slack: pass channel name directly (e.g. "ohbibi-mwcf-project") — the server resolves it to an ID automatically. No need to call slack_list_channels first.

**Query philosophy — surgical precision, not data dumps:**
Think before calling a tool. Decide exactly what data you need to answer the question, then request only that — with the narrowest parameters possible. You have a limited number of tool turns, and each turn's results accumulate in your context, so every unnecessary byte costs tokens and money.

Good approach: understand what's needed → make targeted queries → summarize → offer to go deeper.
Bad approach: grab everything available → sift through massive results hoping to find something useful.

**Examples — good vs bad:**

"Расскажи что нового в канале ohbibi-mwcf-project"
- GOOD: slack_get_channel_history("ohbibi-mwcf-project", limit=20) → summarize key topics → offer to open specific threads
- BAD: slack_list_channels → slack_get_channel_history(limit=100) → slack_get_thread_replies for every thread → overwhelm context

"Какие дедлайны горят на этой неделе?"
- GOOD: searchTasks with due date filter for this week only
- BAD: searchTasks with no filters → fetch every task → read every document

"Есть ли письмо от Кости?"
- GOOD: search_gmail_messages(query="from:kostya") → show subject lines → read specific email if asked
- BAD: search_gmail_messages(query="is:unread", limit=50) → read each message body → search for Kostya in results

"Что у меня сегодня?"
- GOOD: list_calendar_events for today + search_gmail_messages("is:unread", limit=5) + searchTasks(due today) — parallel, small limits
- BAD: fetch entire week of calendar + 50 emails + all tasks + all Slack channels

**After showing results, always offer to go deeper:**
"Хочешь подробнее по какому-то из пунктов?" / "Открыть тред X?" / "Показать полный текст письма?"
This lets the user guide the depth instead of you guessing.
AEOF

# ── Variant B: Strict per-tool rules ──

read -r -d '' VARIANT_B << 'BEOF' || true
## Integration tools
You have access to external service tools via MCP (ClickUp, Slack, Gmail, Google Calendar, Google Drive). All tools are read-only.

**CRITICAL — how to use tools:**
- ALWAYS call the actual tool for real-time data. NEVER answer from conversation history. Previous tool failures do NOT mean the tool is broken now — always retry.
- If a tool call fails, retry once with corrected parameters. If still failing, tell the user which specific service is unavailable.
- Never fabricate data — if results are empty, say so explicitly.

**Slack rules:**
1. NEVER call slack_list_channels — pass channel name directly to other tools (auto-resolved to ID)
2. First call: slack_get_channel_history with limit=20
3. Summarize what you found and ask the user if they want details on specific threads
4. Only call slack_get_thread_replies if the user asks about a specific thread
5. NEVER read all threads in a channel in one go

**ClickUp rules:**
1. Always use the narrowest search query possible (keywords, due date filters)
2. First: show task list (name, status, assignee, due date) — do NOT fetch task details
3. Only call getTaskById when user asks about a specific task
4. NEVER fetch all tasks and then all documents — pick one or the other based on the question

**Gmail rules:**
1. Use precise search parameters: sender, date range, keywords, is:unread
2. First: show search results (subject, from, date) — do NOT read message bodies
3. Only call get_gmail_message when user asks to read a specific email

**Google Calendar rules:**
1. Query only the date range the user asks about (today = today, this week = this week)
2. Format: time, title, attendees — keep it compact

**Google Drive rules:**
1. Search by name/keywords first — show file list
2. Only call get_drive_file_content when user asks to read a specific document

**Multi-source queries ("что нового?", "что у меня сегодня?"):**
- Call sources in parallel but with small limits: 5-10 items per source
- Show organized summary grouped by source
- Ask if user wants to dig deeper into any section
BEOF

# ── Variant C: Philosophy + autonomous (ask only if expensive) ──

read -r -d '' VARIANT_C << 'CEOF' || true
## Integration tools
You have access to external service tools via MCP (ClickUp, Slack, Gmail, Google Calendar, Google Drive). All tools are read-only.

**CRITICAL — how to use tools:**
- ALWAYS call the actual tool for real-time data. NEVER answer from conversation history about what's in Slack/ClickUp/Gmail/Calendar. Previous tool failures do NOT mean the tool is broken now — always retry.
- If a tool call fails, retry once with corrected parameters. If still failing, tell the user which specific service is unavailable.
- Never fabricate data — if results are empty, say so explicitly.
- For Slack: pass channel name directly (e.g. "ohbibi-mwcf-project") — the server resolves it to an ID automatically. No need to call slack_list_channels first.

**Query philosophy — be lean and autonomous:**
Think before calling a tool. Decide exactly what data you need, then request only that — with the narrowest parameters possible. You have a limited number of tool turns, and each turn's results accumulate in your context, so every unnecessary byte costs tokens and money.

Your goal: deliver a complete answer with minimal tool calls. Don't ask the user to clarify or confirm before searching — just find the answer efficiently. Only ask the user BEFORE proceeding if the task would require 3+ tool calls across multiple services (e.g. "update my context on everything").

Good approach: understand what's needed → make 1-2 targeted queries → deliver complete answer.
Bad approach: grab everything available → sift through massive results hoping to find something useful.

**Examples — good vs bad:**

"Расскажи что нового в канале ohbibi-mwcf-project"
- GOOD: slack_get_channel_history("ohbibi-mwcf-project", limit=20) → summarize key topics with enough detail to be useful
- BAD: slack_list_channels → slack_get_channel_history(limit=100) → slack_get_thread_replies for every thread

"Какие дедлайны горят на этой неделе?"
- GOOD: searchTasks with due date filter for this week → deliver the answer
- BAD: searchTasks with no filters → fetch every task → read every document

"Есть ли письмо от Кости?"
- GOOD: search_gmail_messages(query="from:kostya") → show results with enough context (subject, date, preview)
- BAD: search_gmail_messages(query="is:unread", limit=50) → read each message body → search for Kostya in results

"Что у меня сегодня?"
- GOOD: list_calendar_events for today + search_gmail_messages("is:unread", limit=5) + searchTasks(due today) — parallel, small limits, merged answer
- BAD: fetch entire week of calendar + 50 emails + all tasks + all Slack channels
CEOF

# ── 10 test questions ──

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

# ── Run tests ──

run_variant() {
  local variant_name="$1"
  local system_prompt="$2"
  local variant_dir="$RESULTS_DIR/variant-$variant_name"

  mkdir -p "$variant_dir"

  echo ""
  echo "════════════════════════════════════════════════════"
  echo "  Running Variant $variant_name (${#QUESTIONS[@]} questions)"
  echo "════════════════════════════════════════════════════"

  local total_input=0
  local total_output=0
  local total_cache=0
  local total_cost=0
  local total_turns=0

  for i in "${!QUESTIONS[@]}"; do
    local q="${QUESTIONS[$i]}"
    local idx=$((i + 1))
    local outfile="$variant_dir/q$(printf '%02d' $idx).json"

    echo ""
    echo "  [$variant_name] Q$idx: $q"
    echo -n "  Running... "

    # Run Claude CLI with MCP config, capture full JSON output
    local start_ts=$(date +%s)
    local raw_output
    raw_output=$(echo "$q" | claude \
      --print \
      --no-session-persistence \
      --model sonnet \
      --output-format json \
      --system-prompt "$system_prompt" \
      --mcp-config "$MCP_CONFIG" \
      --permission-mode bypassPermissions \
      --max-turns 6 \
      2>/dev/null) || true
    local end_ts=$(date +%s)
    local elapsed=$((end_ts - start_ts))

    # Parse metrics from JSON
    local input_tokens output_tokens cache_tokens cost_usd num_turns result_text subtype is_error

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

    # Save full result
    cat > "$outfile" << QEOF
{
  "variant": "$variant_name",
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

    # Save response text separately for quality review
    echo "$result_text" > "$variant_dir/q$(printf '%02d' $idx)-response.txt"

    # Accumulate totals
    total_input=$(python3 -c "print($total_input + $input_tokens)")
    total_output=$(python3 -c "print($total_output + $output_tokens)")
    total_cache=$(python3 -c "print($total_cache + $cache_tokens)")
    total_cost=$(python3 -c "print(round($total_cost + $cost_usd, 4))")
    total_turns=$(python3 -c "print($total_turns + $num_turns)")

    echo "done (${elapsed}s, turns=$num_turns, cost=\$$cost_usd, in=$input_tokens, out=$output_tokens, cache=$cache_tokens)"

    # Small delay between requests to avoid rate limiting
    sleep 2
  done

  # Write variant summary
  cat > "$variant_dir/summary.json" << SEOF
{
  "variant": "$variant_name",
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
  echo "  Variant $variant_name Summary:"
  echo "    Total cost:    \$$total_cost"
  echo "    Avg cost/q:    \$$(python3 -c "print(round($total_cost / ${#QUESTIONS[@]}, 4))")"
  echo "    Total turns:   $total_turns"
  echo "    Avg turns/q:   $(python3 -c "print(round($total_turns / ${#QUESTIONS[@]}, 1))")"
  echo "    Input tokens:  $total_input"
  echo "    Output tokens: $total_output"
  echo "    Cache tokens:  $total_cache"
  echo "  ──────────────────────────────────────────"
}

# ── Main ──

rm -rf "$RESULTS_DIR"
mkdir -p "$RESULTS_DIR"

echo "Starting A/B/C prompt test ($(date))"
echo "Questions: ${#QUESTIONS[@]}"
echo "Variants: A (philosophy+ask), B (strict rules), C (philosophy+autonomous)"
echo ""

run_variant "a" "$PROMPT_PREFIX"$'\n'"$VARIANT_A"
run_variant "b" "$PROMPT_PREFIX"$'\n'"$VARIANT_B"
run_variant "c" "$PROMPT_PREFIX"$'\n'"$VARIANT_C"

# ── Final comparison table ──

echo ""
echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║                    COMPARISON TABLE                            ║"
echo "╠══════════════════════════════════════════════════════════════════╣"

printf "║ %-10s │ %-10s │ %-10s │ %-8s │ %-8s ║\n" "Variant" "Cost" "Avg Cost" "Turns" "Avg Trns"
echo "║────────────┼────────────┼────────────┼──────────┼──────────║"

for v in a b c; do
  summary="$RESULTS_DIR/variant-$v/summary.json"
  if [[ -f "$summary" ]]; then
    total_cost=$(python3 -c "import json; d=json.load(open('$summary')); print(f'\${d[\"total_cost_usd\"]:.4f}')")
    avg_cost=$(python3 -c "import json; d=json.load(open('$summary')); print(f'\${d[\"avg_cost_per_question\"]:.4f}')")
    total_turns=$(python3 -c "import json; d=json.load(open('$summary')); print(d['total_turns'])")
    avg_turns=$(python3 -c "import json; d=json.load(open('$summary')); print(d['avg_turns_per_question'])")
    printf "║ %-10s │ %-10s │ %-10s │ %-8s │ %-8s ║\n" "$v" "$total_cost" "$avg_cost" "$total_turns" "$avg_turns"
  fi
done

echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""
echo "Response texts saved in: $RESULTS_DIR/variant-{a,b,c}/q*-response.txt"
echo "Done at $(date)"
