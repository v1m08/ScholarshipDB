#!/usr/bin/env bash
# Take over when the re-scrape finishes: grade and copy its results, then read the websites
# named in IRS filings (data/registry/funder-sites.json), copy to S3, and optionally power off.
#   SHUTDOWN_WHEN_DONE=1 nohup ./run-funders.sh > funders.log 2>&1 &
set -uo pipefail
cd "$(dirname "$0")"
BUCKET="${RAW_BUCKET:-scholarship-raw-pages}"

# Wait for a re-scrape that is still running, then stop its script before it powers the server off.
if pgrep -f "node rescrape.mjs" > /dev/null; then
  while pgrep -f "node rescrape.mjs" > /dev/null; do sleep 15; done
  pkill -f run-rescrape.sh || true
  pkill -f audit-quality.mjs || true
  sleep 2
  mkdir -p ../data/records
  node --max-old-space-size=3000 ../scripts/audit-quality.mjs > ../data/records/audit-after.log 2>&1 || echo "Audit failed"
  aws s3 sync ../data/raw "s3://${BUCKET}/raw" --only-show-errors && echo "Synced re-scrape results"
  aws s3 sync ../data/records "s3://${BUCKET}/records" --only-show-errors --exclude "*" --include "audit*" --include "rescrape.jsonl"
  [ -f rescrape.log ] && aws s3 cp rescrape.log "s3://${BUCKET}/records/rescrape.log" --only-show-errors
fi

node scrape-foundations.mjs --list funder-sites.json --job funder-pages --pages "${PAGES:-25}" --concurrency "${CONCURRENCY:-12}"
status=$?
aws s3 sync ../data/raw "s3://${BUCKET}/raw" --only-show-errors && echo "Synced data/raw to s3://${BUCKET}/raw"

if [ "${SHUTDOWN_WHEN_DONE:-0}" = "1" ]; then
  echo "Finished with status ${status}; powering off."
  sudo shutdown -h now
fi
exit $status
