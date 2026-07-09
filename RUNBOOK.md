# Operations Runbook

Operational procedures for the Audio Learning Companion. Region is **us-east-1**.

## Add or remove a user from the allowlist

The allowlist is the `ALLOWED_EMAILS` environment variable on the Cognito
pre-sign-up Lambda. Update it and redeploy:

```bash
export ALLOWED_EMAILS="you@example.com,new-person@example.com"
export ALERT_EMAIL="you@example.com"
cd infrastructure && source .venv-infra/bin/activate
npx cdk deploy AudioCompanionStack --parameters AlertEmail="$ALERT_EMAIL" \
  --outputs-file ../outputs.json
```

Removing an email from the list prevents **new** sign-ups; to revoke an existing
user, also disable/delete them in the Cognito User Pool:

```bash
aws cognito-idp admin-disable-user --user-pool-id <POOL_ID> --username <email>
aws cognito-idp admin-delete-user  --user-pool-id <POOL_ID> --username <email>
```

## Check costs

- **Budget alerts**: a $30 actual-spend alert and a $100 forecasted alert email
  `ALERT_EMAIL` automatically.
- **Cost Explorer**: AWS console → Billing → Cost Explorer, filter by tag
  `Project = AudioLearningCompanion`.

## View logs

All Lambdas and the agent log to CloudWatch. Logs contain **metadata only** (never
message content). Useful groups:

```bash
aws logs tail /aws/lambda/<AsyncJobFn name> --follow
aws logs tail /aws/lambda/<PresignAudioFn name> --follow
```

Filter audit events (JSON lines) by action, e.g. `job_complete`, `rate_limit`,
`agent_invoke`.

## Redeploy after a code change

- **Frontend only**: `npm --prefix frontend run build` then
  `aws s3 sync frontend/dist s3://<FrontendBucket> --delete` and a CloudFront
  invalidation (`aws cloudfront create-invalidation --distribution-id <id> --paths "/*"`).
- **Infra / Lambdas**: `./scripts/deploy.sh` (re-runs everything safely).
- **Agent**: redeploy from `agentcore/`; the runtime ARN stays the same unless you
  recreate it.

## Emergency: disable the API

To immediately stop all backend processing without tearing down:

```bash
# Throttle the prod stage to zero (blocks all requests)
aws apigateway update-stage --rest-api-id <API_ID> --stage-name prod \
  --patch-operations \
    op=replace,path=/throttle/rateLimit,value=0 \
    op=replace,path=/throttle/burstLimit,value=0
```

Restore by setting `rateLimit=10` and `burstLimit=20`. You can also disable the
Cognito app client to block new sign-ins.

## Rotate the Tavily key

```bash
aws secretsmanager put-secret-value \
  --secret-id audio-companion/tavily-api-key \
  --secret-string '{"apiKey":"NEW_KEY"}'
```

The agent reads the secret fresh on cold start; restart/redeploy the agent to pick
it up immediately.

## Delete all data for a user (GDPR-style)

```bash
USER_ID=<cognito sub>

# Audio objects
aws s3 rm "s3://<AudioBucket>/audio/${USER_ID}/" --recursive

# Profile
aws dynamodb delete-item --table-name <ProfilesTable> \
  --key "{\"pk\":{\"S\":\"USER#${USER_ID}\"},\"sk\":{\"S\":\"PROFILE\"}}"

# Lectures (query then delete each LECTURE# item)
aws dynamodb query --table-name <LecturesTable> \
  --key-condition-expression "pk = :p" \
  --expression-attribute-values "{\":p\":{\"S\":\"USER#${USER_ID}\"}}" \
  --query "Items[].sk.S" --output text | tr '\t' '\n' | while read -r SK; do
    aws dynamodb delete-item --table-name <LecturesTable> \
      --key "{\"pk\":{\"S\":\"USER#${USER_ID}\"},\"sk\":{\"S\":\"${SK}\"}}"
  done

# Finally, delete the Cognito user (see allowlist section).
```

Jobs and rate-limit rows expire automatically via DynamoDB TTL (24h / 2h).

## Health checks

- CloudWatch alarms fire on: async job errors > 10 / 5 min, presign errors > 10 /
  5 min, API 4xx > 50 / 5 min.
- WAF blocks (CloudWatch metrics): `CommonRuleSet`, `KnownBadInputs`, `SqlInjection`,
  `RateLimit`.
