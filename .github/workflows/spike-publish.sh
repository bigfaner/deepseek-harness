#!/usr/bin/env bash
# Upload the tee'd step logs to spike-results/ via the contents API
# (checkout@v4 leaves a detached HEAD, so a plain pull/push loop is fragile).
set -uo pipefail
group="$1"
api="https://api.github.com/repos/${GITHUB_REPOSITORY}/contents"
auth="Authorization: Bearer ${GITHUB_TOKEN}"
for file in /tmp/spike-out/*; do
  [ -f "$file" ] || continue
  name="$(basename "$file")"
  path="spike-results/${group}/${name}"
  body=$(python3 - "$file" "$path" <<'PY'
import base64, json, os, sys
content = base64.b64encode(open(sys.argv[1], 'rb').read()).decode()
print(json.dumps({
    'message': f"spike results: {os.environ.get('GITHUB_RUN_ID', '')} {sys.argv[2]}",
    'content': content,
    'branch': 'spike/1.1-linux',
}))
PY
  )
  for attempt in 1 2 3 4 5; do
    existing=$(curl -sf -H "$auth" "$api/$path?ref=spike/1.1-linux" || true)
    if [ -n "$existing" ]; then
      sha=$(printf '%s' "$existing" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])')
      body=$(printf '%s' "$body" | python3 -c "import json,sys; d=json.load(sys.stdin); d['sha']=sys.argv[1]; print(json.dumps(d))" "$sha")
    fi
    if curl -sf -X PUT -H "$auth" -H 'Accept: application/vnd.github+json' -d "$body" "$api/$path" >/dev/null; then
      echo "published $path"
      break
    fi
    echo "retry $attempt for $path"
    sleep $((attempt * 5))
  done
done
echo done
