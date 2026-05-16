#!/usr/bin/env bash
set -uo pipefail

EXTENSION="$(cd "$(dirname "$0")/.." && pwd)/index.ts"
FIXTURES="$(dirname "$0")/fixtures"
PASS=0
FAIL=0
MODEL="${MODEL:-}"

GREEN=$'\033[0;32m'
RED=$'\033[0;31m'
NC=$'\033[0m'

pass() { echo -e "${GREEN}PASS${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}FAIL${NC} $1"; echo "     $2"; FAIL=$((FAIL + 1)); }

run() {
  local desc="$1"; shift
  pi --mode json -p "$@" \
    ${MODEL:+--model "$MODEL"} \
    --extension "$EXTENSION" \
    --tools alchemy_load,alchemy_query \
    2>/dev/null
}

# Extract the text content from the last tool result event
tool_result_text() {
  local output="$1"
  echo "$output" | grep '"type":"message_start"' | grep '"toolName":"alchemy_query"' | tail -1 |
    python3 -c "
import sys, json
line = sys.stdin.read().strip()
if line:
    ev = json.loads(line)
    for c in ev.get('message', {}).get('content', []):
        if c.get('type') == 'text':
            print(c['text'])
" 2>/dev/null
}

# Extract the final assistant text
assistant_text() {
  local output="$1"
  echo "$output" | python3 -c "
import sys, json
last = None
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        ev = json.loads(line)
        if ev.get('type') == 'message_end' and ev.get('message',{}).get('role') == 'assistant':
            last = ev['message']
    except: pass
if last:
    for c in last.get('content', []):
        if c.get('type') == 'text':
            print(c['text'])
" 2>/dev/null
}

contains() {
  local needle="$1"
  local haystack="$2"
  echo "$haystack" | grep -qF "$needle"
}

echo ""
echo "=== pi-alchemy e2e tests ==="
echo ""

# ─── Test 1: Load CSV and query ──────────────────────────────────────────
DESC="load CSV, query top cities"
OUT=$(run "$DESC" \
  "Load $FIXTURES/cities.csv as cities and query: SELECT city, pop FROM cities ORDER BY pop DESC LIMIT 2. Return only the raw data.")
DATA=$(tool_result_text "$OUT")
if contains "Tokyo" "$DATA" && contains "London" "$DATA"; then
  pass "$DESC"
else
  fail "$DESC" "tool result: $DATA"
fi

# ─── Test 2: Load JSON and query with filter ─────────────────────────────
DESC="load JSON, query filtered"
OUT=$(run "$DESC" \
  "Load $FIXTURES/products.json as products and query: SELECT product, price FROM products WHERE price > 10. Return only the raw data.")
DATA=$(tool_result_text "$OUT")
if contains "Gadget" "$DATA" && contains "24.99" "$DATA"; then
  pass "$DESC"
else
  fail "$DESC" "tool result: $DATA"
fi

# ─── Test 3: Join across loaded tables ───────────────────────────────────
DESC="load two tables and join"
OUT=$(run "$DESC" \
  "Load $FIXTURES/cities.csv as cities. Then load $FIXTURES/products.json as products. Then query: SELECT c.city, p.product FROM cities c CROSS JOIN products p LIMIT 2. Return only the raw data.")
DATA=$(tool_result_text "$OUT")
if contains "NYC" "$DATA" && contains "Widget" "$DATA"; then
  pass "$DESC"
else
  fail "$DESC" "tool result: $DATA"
fi

# ─── Test 4: CTE query ───────────────────────────────────────────────────
DESC="CTE query"
OUT=$(run "$DESC" \
  "Load $FIXTURES/cities.csv as cities and query: WITH top AS (SELECT city, pop FROM cities ORDER BY pop DESC LIMIT 1) SELECT city FROM top. Return only the raw data.")
DATA=$(tool_result_text "$OUT")
if contains "Tokyo" "$DATA"; then
  pass "$DESC"
else
  fail "$DESC" "tool result: $DATA"
fi

# ─── Summary ─────────────────────────────────────────────────────────────
echo ""
printf "Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}\n"
echo ""
[[ "$FAIL" -eq 0 ]]
