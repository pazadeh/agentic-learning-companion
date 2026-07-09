#!/usr/bin/env bash
# Full cleanup of all Audio Learning Companion AWS resources.
# Empties the S3 buckets (including any versioned objects) then destroys the stack.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="AudioCompanionStack"

echo "This will PERMANENTLY DELETE all ${STACK} resources and data."
read -r -p "Type 'destroy' to confirm: " CONFIRM
if [[ "${CONFIRM}" != "destroy" ]]; then
  echo "Aborted."
  exit 1
fi

empty_bucket() {
  local key="$1"
  local bucket
  bucket="$(python3 -c "import json;print(json.load(open('${ROOT}/outputs.json'))['${STACK}'].get('${key}',''))" 2>/dev/null || true)"
  if [[ -n "${bucket}" ]]; then
    echo "==> Emptying s3://${bucket}…"
    aws s3 rm "s3://${bucket}" --recursive || true
  fi
}

if [[ -f "${ROOT}/outputs.json" ]]; then
  empty_bucket FrontendBucketName
  empty_bucket AudioBucketName
fi

echo "==> Destroying the stack…"
cd "${ROOT}/infrastructure"
if [[ -d ".venv-infra" ]]; then
  # shellcheck disable=SC1091
  source .venv-infra/bin/activate
fi
npx cdk destroy "${STACK}" --force

rm -f "${ROOT}/outputs.json"
echo "Teardown complete. Verify in the AWS console that nothing remains."
