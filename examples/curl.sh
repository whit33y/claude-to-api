#!/usr/bin/env bash
# Usage: API_TOKEN=... ./examples/curl.sh [base_url]
set -euo pipefail
BASE="${1:-http://127.0.0.1:8787}"
AUTH=(-H "Authorization: Bearer ${API_TOKEN:?set API_TOKEN}" -H "Content-Type: application/json")

echo "== health"; curl -fsS "$BASE/health"; echo

echo "== 1) simple question (JSON reply)"
SID=$(curl -fsS "${AUTH[@]}" "$BASE/v1/query" \
  -d '{"prompt":"Say hi and remember the word: pineapple"}' | tee /dev/stderr | jq -r .session_id)
echo

echo "== 2) continue the same conversation"
curl -fsS "${AUTH[@]}" "$BASE/v1/query" \
  -d "{\"prompt\":\"What word did I ask you to remember?\",\"session_id\":\"$SID\"}" | jq '{result, session_id, total_cost_usd}'

echo "== 3) streaming with read-only file tools (the tools .env.example allows)"
curl -N -sS "${AUTH[@]}" "$BASE/v1/query?stream=1" \
  -d '{"prompt":"List the files in this directory and summarize what is there in two sentences.","allowed_tools":["Read","Grep","Glob"]}'
