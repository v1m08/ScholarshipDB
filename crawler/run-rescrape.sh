#!/usr/bin/env bash
# The whole repair pass on the server: read saved pages again, grade everything, fetch again
# what was not scraped right, grade again, copy to S3, and optionally power off.
#   SHUTDOWN_WHEN_DONE=1 nohup ./run-rescrape.sh > rescrape.log 2>&1 &
set -uo pipefail
cd "$(dirname "$0")"
BUCKET="${RAW_BUCKET:-scholarship-raw-pages}"

node --max-old-space-size=3000 reread-saved.mjs
node --max-old-space-size=3000 ../scripts/audit-quality.mjs > ../data/records/audit-before.log 2>&1 && tail -n 8 ../data/records/audit-before.log
node rescrape.mjs --concurrency "${CONCURRENCY:-10}"
status=$?
node --max-old-space-size=3000 ../scripts/audit-quality.mjs > ../data/records/audit-after.log 2>&1

aws s3 sync ../data/raw "s3://${BUCKET}/raw" --only-show-errors && echo "Synced data/raw to s3://${BUCKET}/raw"
aws s3 sync ../data/records "s3://${BUCKET}/records" --only-show-errors --exclude "*" --include "audit*" --include "rescrape.jsonl"

if [ "${SHUTDOWN_WHEN_DONE:-0}" = "1" ]; then
  echo "Finished with status ${status}; powering off."
  sudo shutdown -h now
fi
exit $status
