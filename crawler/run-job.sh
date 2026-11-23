#!/usr/bin/env bash
# Run one crawl job on the server, copy its output to S3, and optionally power off.
#   ./run-job.sh survey-portals.mjs --concurrency 4
#   SHUTDOWN_WHEN_DONE=1 nohup ./run-job.sh survey-portals.mjs > job.log 2>&1 &
set -uo pipefail
cd "$(dirname "$0")"
BUCKET="${RAW_BUCKET:-scholarship-raw-pages}"

node "$@"
status=$?

aws s3 sync ../data/raw "s3://${BUCKET}/raw" --only-show-errors && echo "Synced data/raw to s3://${BUCKET}/raw"

if [ "${SHUTDOWN_WHEN_DONE:-0}" = "1" ]; then
  echo "Job finished with status ${status}; powering off."
  sudo shutdown -h now
fi
exit $status
