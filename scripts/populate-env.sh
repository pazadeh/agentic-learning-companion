#!/usr/bin/env bash
# Reads CDK stack outputs (outputs.json) and writes frontend/.env so the React
# app knows the API URL, Cognito User Pool, and client id.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUTS="${ROOT}/outputs.json"
ENV_FILE="${ROOT}/frontend/.env"
STACK="AudioCompanionStack"

if [[ ! -f "${OUTPUTS}" ]]; then
  echo "ERROR: ${OUTPUTS} not found. Run the CDK deploy step first." >&2
  exit 1
fi

# Extract a stack output value by key using the AWS CLI's bundled python/jq-less approach.
read_output() {
  local key="$1"
  python3 - "$OUTPUTS" "$STACK" "$key" <<'PY'
import json, sys
outputs_path, stack, key = sys.argv[1], sys.argv[2], sys.argv[3]
with open(outputs_path) as f:
    data = json.load(f)
print(data.get(stack, {}).get(key, ""))
PY
}

API_URL="$(read_output ApiUrl)"
USER_POOL_ID="$(read_output UserPoolId)"
USER_POOL_CLIENT_ID="$(read_output UserPoolClientId)"
REGION="$(read_output Region)"

if [[ -z "${API_URL}" || -z "${USER_POOL_ID}" || -z "${USER_POOL_CLIENT_ID}" ]]; then
  echo "ERROR: Missing one or more required outputs in ${OUTPUTS}." >&2
  exit 1
fi

cat > "${ENV_FILE}" <<EOF
VITE_API_URL=${API_URL}
VITE_USER_POOL_ID=${USER_POOL_ID}
VITE_USER_POOL_CLIENT_ID=${USER_POOL_CLIENT_ID}
VITE_AWS_REGION=${REGION:-us-east-1}
EOF

echo "Wrote ${ENV_FILE}:"
cat "${ENV_FILE}"
