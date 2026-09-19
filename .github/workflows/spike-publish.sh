#!/usr/bin/env bash
# Commit the tee'd step logs back to the spike branch for external reading.
set -uo pipefail
group="$1"
cd "$GITHUB_WORKSPACE"
git config user.name "spike-bot"
git config user.email "spike@example.invalid"
mkdir -p "spike-results/$group"
cp -v /tmp/spike-out/* "spike-results/$group/" || true
git add spike-results || true
if git diff --cached --quiet; then
  echo "nothing to publish"
  exit 0
fi
git commit -m "spike results: $group (run $GITHUB_RUN_ID)"
for attempt in 1 2 3 4 5; do
  if git pull --rebase "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" spike/1.1-linux; then
    if git push "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "HEAD:spike/1.1-linux"; then
      exit 0
    fi
  fi
  sleep $((attempt * 10))
done
echo "publish failed after retries"
exit 1
