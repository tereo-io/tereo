#!/bin/sh
# Brings the database up to date: applies migrations, then runs the idempotent
# seed. Run once per deploy — compose's `migrate` service, a Kubernetes Job, or
# by hand — not on every replica's start. Runs from the package
# directory, where the image puts it.
set -e

# The OTel SDK isn't needed for this short-lived job.
export NODE_OPTIONS=""

echo "Running database migrations..." >&2
npx prisma migrate deploy

echo "Running database seed..." >&2
node dist/scripts/seed.js
