#!/usr/bin/env bash
# One-command deploy for the Audio Learning Companion.
#
# Prerequisites (see DEPLOYMENT.md):
#   - AWS CLI configured (personal account, NOT Isengard), region us-east-1
#   - Bedrock model access granted for Claude 3.5 Haiku + Sonnet
#   - CDK bootstrapped:  npx cdk bootstrap
#   - ALLOWED_EMAILS env var set (comma-separated allowlist)
#   - ALERT_EMAIL env var set (for budget/alarm notifications)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="AudioCompanionStack"

: "${ALLOWED_EMAILS:?Set ALLOWED_EMAILS to a comma-separated allowlist, e.g. you@example.com}"
: "${ALERT_EMAIL:?Set ALERT_EMAIL to receive budget/alarm notifications}"

echo "==> [1/5] Deploying infrastructure (CDK)…"
cd "${ROOT}/infrastructure"
if [[ ! -d ".venv-infra" ]]; then
  python3.11 -m venv .venv-infra
fi
# shellcheck disable=SC1091
source .venv-infra/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
[[ -d node_modules ]] || npm install

# WAF defaults on. Set ENABLE_WAF=false for solo/debug deploys to skip the ~$9/mo
# WAF standing cost (re-enable before sharing the URL).
ENABLE_WAF="${ENABLE_WAF:-true}"

npx cdk deploy "${STACK}" \
  --require-approval never \
  -c enableWaf="${ENABLE_WAF}" \
  --parameters AlertEmail="${ALERT_EMAIL}" \
  --parameters AllowedEmails="${ALLOWED_EMAILS}" \
  --outputs-file "${ROOT}/outputs.json"
deactivate

echo "==> [2/5] Writing frontend environment from stack outputs…"
"${ROOT}/scripts/populate-env.sh"

echo "==> [3/5] Building the frontend…"
cd "${ROOT}/frontend"
npm install
npm run build

echo "==> [4/5] Uploading the frontend to S3…"
FRONTEND_BUCKET="$(python3 -c "import json;print(json.load(open('${ROOT}/outputs.json'))['${STACK}']['FrontendBucketName'])")"
aws s3 sync dist/ "s3://${FRONTEND_BUCKET}" --delete

echo "==> [5/5] Invalidating the CloudFront cache…"
DIST_ID="$(python3 -c "import json;print(json.load(open('${ROOT}/outputs.json'))['${STACK}']['DistributionId'])")"
aws cloudfront create-invalidation --distribution-id "${DIST_ID}" --paths "/*" >/dev/null

CF_URL="$(python3 -c "import json;print(json.load(open('${ROOT}/outputs.json'))['${STACK}']['CloudFrontUrl'])")"
echo
echo "Deploy complete."
echo "  App URL: ${CF_URL}"
echo
echo "Remaining manual steps (see DEPLOYMENT.md):"
echo "  1. Store your Tavily API key in Secrets Manager (TavilySecretArn output)."
echo "  2. Deploy the AgentCore agent, then redeploy with -c agentRuntimeArn=<arn>."
