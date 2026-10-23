# Operations Runbook

Operational procedures for the Audio Learning Companion. Region is **us-east-1**.

## Add or remove a user from the allowlist

The allowlist is the CloudFormation `AllowedEmails` parameter, passed to the Cognito
pre-sign-up Lambda. Preserve the complete desired list on every deploy:

```bash
export ALLOWED_EMAILS="you@example.com,new-person@example.com"
export ALERT_EMAIL="you@example.com"
cd infrastructure && source .venv-infra/bin/activate
npx cdk deploy AudioCompanionStack \
  --parameters AlertEmail="$ALERT_EMAIL" \
  --parameters AllowedEmails="$ALLOWED_EMAILS" \
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
aws logs tail /aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT --follow
```

Filter audit events (JSON lines) by action, e.g. `job_complete`, `rate_limit`,
`agent_invoke`. Generation stages are stored on JobsTable (`stage`, `stageMessage`,
`stageDetail`, `progress`, `progressUpdatedAt`) and exposed by the status endpoint; they
are not emitted as user-content logs.

## Redeploy after a code change

Production is always deployed from `main`. Complete validation on `development`, merge
and push `main`, then check out `main` before invoking deployment commands;
`scripts/deploy.sh` rejects any other branch.

For contract changes shared by AgentCore and Lambda (new request fields, tools, or
response shapes), deploy in this order:

1. **AgentCore first** — new runtimes must remain backward-compatible with the current Lambda.
2. **CDK/Lambdas second** — pass the unchanged runtime ARN and preserve both CloudFormation parameters.
3. **Frontend last** — upload assets and invalidate CloudFront.

Component-specific shortcuts:

- **Frontend only**: `npm --prefix frontend run build` then
  `aws s3 sync frontend/dist s3://<FrontendBucket> --delete` and a CloudFront
  invalidation (`aws cloudfront create-invalidation --distribution-id <id> --paths "/*"`).
- **Infra / Lambdas**: `./scripts/deploy.sh` (re-runs the stack and frontend and
  preserves the currently configured AgentCore runtime ARN).
- **Agent**: redeploy from `agentcore/`; the runtime ARN stays the same unless you
  recreate it. Verify the runtime is `READY` before updating Lambda.

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

## Troubleshooting adaptive profiles and playback

- **Progress remains at Preparing (5%)**: verify AgentCore has `JOBS_TABLE` in its
  environment and its execution role has `dynamodb:UpdateItem` on that table. The
  CDK deployment needs both `agentRuntimeArn` and `agentRuntimeRoleArn` contexts;
  `scripts/deploy.sh` discovers both for existing deployments.
- **Progress skips a stage**: short operations can finish between the browser's two-second
  polls. This is expected; `stageSeq` still prevents regressions in the durable row.
- **Profile save returns `409 conflict`**: another device or a privacy/reset action
  advanced the revision. Reload Profile and reapply the intended edit; never retry the
  stale full payload blindly.
- **Listening progress does not move**: verify the browser sends
  `POST /lectures/{lectureId}/playback` after ~20 seconds, the Lambda has
  `PROFILES_TABLE` and `LECTURES_TABLE`, and its role can transact against both.
  Playback requests use cumulative media time and may be retried; duplicate sequences
  correctly return `accepted=false, duplicate=true`.
- **Learned preferences remain empty**: the feature requires behavioral
  personalization to be enabled, at least three substantially completed lectures, and
  ≥70% confidence. A reset or consent change intentionally starts a new inference
  generation while preserving lifetime listening statistics.
- **Unexpected personalization**: inspect the lecture's `personalizationUsed` map in
  LecturesTable. Sources are `current_request`, `explicit`, `inferred`, or `default`,
  in that precedence order. AgentCore Memory supplies semantic facts only.

## Troubleshooting guided lecture design

- **Design turn fails**: verify `DESIGN_MODEL_ID` is available to the AgentCore role.
  Design defaults to `PLANNER_MODEL_ID`; the live-account fallback is Sonnet 4.6.
- **No buttons appear**: a design response must contain 2–5 validated choices. Invalid
  question output is replaced with a safe goal question; inspect AgentCore logs if the
  fallback appears repeatedly.
- **Lecture starts too early**: only the final **Generate lecture** action may submit an
  `action=lecture` job. Design turns use `action=design` and the tool-free design agent.
- **Custom preference**: while AI turns remain, the composer sends typed text through the
  same refinement path as button values. After the third turn the brief is still editable
  directly (**Edit brief**); edits are validated client-side against the same contract the
  job Lambda enforces, so an edited brief is never rejected for shape.
- **Design or generation “disappeared”**: active work is stored per user in
  `localStorage` (`alc.create.<sub>`) and polling resumes on reload. The header shows a
  progress pill on every page. Clearing site data or **You → Clear data on this device**
  removes the local copy; the backend job still completes and the lecture appears in Library.

## Troubleshooting offline downloads

- **Save offline is disabled**: the browser reports offline; reconnect before fetching
  the owned transcript and audio.
- **Not enough storage**: Nova WAV uses about 2.9 MB per minute. Remove other offline
  copies from Library or free browser storage, then retry. The cloud lecture is unaffected.
- **Removed a download by mistake**: removal is deferred for a few seconds behind an
  **Undo** toast; after that only the local copy is gone and the lecture can be saved again.
- **Legacy lecture says audio only**: lectures created before deterministic transcript
  persistence have no matching text; the app never regenerates or fabricates one.
- **Saved lecture is missing after sign-in with another account**: downloads are scoped
  to the Cognito user ID by design and are not exposed across accounts on a shared browser.
- **Cold offline launch shows sign-in**: cached identity is accepted only while its ID
  token remains unexpired. Reconnect and sign in before the next offline period.

## Troubleshooting Nova Sonic narration

- **`ImportError` for `aws_sdk_bedrock_runtime`**: the AgentCore direct-code runtime
  must be `PYTHON_3_12` or newer and install the pinned `agentcore/requirements.txt`.
- **`AccessDeniedException` at synthesis**: the runtime role needs
  `bedrock:InvokeModel` on
  `arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-2-5-sonic`. The
  bidirectional API uses the normal `InvokeModel` IAM action.
- **Audio times out after about 55 seconds**: verify `agentcore/assets/nova_trigger.pcm`
  is in the deployment and do not remove the continuous silent input frames. Sonic is
  conversational and requires an active audio stream while producing narration.
- **A long lecture fails in one session**: keep `NOVA_SESSION_MAX_WORDS` at 900 or
  lower. That is about six minutes at 150 WPM, below the service's eight-minute
  connection limit. Each failed session is retried twice and discarded before the
  final WAV is published. `NOVA_TOTAL_TIMEOUT_SECONDS` defaults to 660 seconds, keeping
  all retries inside the Lambda/AgentCore synchronous invocation envelope.
- **Emergency quality/reliability rollback**: redeploy AgentCore with
  `NARRATION_PROVIDER=polly`. Existing WAV and MP3 history entries remain playable;
  no CDK or frontend rollback is required.
- **Large audio objects**: Nova output is 24 kHz mono PCM WAV (about 72 MB for 25
  minutes), compared with roughly 9 MB for Polly MP3. Monitor S3 storage and transfer
  if usage grows.

## Troubleshooting lecture series

- **Planning remains active**: inspect the `SERIES_PLAN` job in JobsTable and Lambda
  logs. Planner deliveries use a `claimToken`; a new delivery safely supersedes an old
  worker. To redeliver a known job after confirming the worker is no longer active:

  ```bash
  aws lambda invoke --function-name audio-companion-async-job \
    --invocation-type Event --cli-binary-format raw-in-base64-out \
    --payload '{"_worker":true,"job_id":"<job-id>"}' /tmp/series-redelivery.json
  ```

- **Series is `attention`**: completed episodes remain playable. Retry the failed
  episode in the UI; later episodes remain planned. Queued/processing episodes become
  retryable only after the active job's `progressUpdatedAt` heartbeat has been stale for
  the lease interval, so a healthy long narration cannot be replaced mid-session.
- **Duplicate/orphaned audio**: job/series transitions are fenced and transactional,
  but an infrastructure failure after S3 upload and before episode completion can leave
  an unreferenced WAV or MP3 object. Compare the user's S3 prefix with LecturesTable before deleting.

## Delete application data for a user (GDPR-style)

```bash
USER_ID=<cognito sub>

# Audio objects
aws s3 rm "s3://<AudioBucket>/audio/${USER_ID}/" --recursive

# Explicit profile and short-lived playback-session records
aws dynamodb query --table-name <ProfilesTable> \
  --key-condition-expression "pk = :p" \
  --expression-attribute-values "{\":p\":{\"S\":\"USER#${USER_ID}\"}}" \
  --query "Items[].sk.S" --output text | tr '\t' '\n' | while read -r SK; do
    [ -z "$SK" ] && continue
    aws dynamodb delete-item --table-name <ProfilesTable> \
      --key "{\"pk\":{\"S\":\"USER#${USER_ID}\"},\"sk\":{\"S\":\"${SK}\"}}"
  done

# Lectures (query then delete each LECTURE# item)
aws dynamodb query --table-name <LecturesTable> \
  --key-condition-expression "pk = :p" \
  --expression-attribute-values "{\":p\":{\"S\":\"USER#${USER_ID}\"}}" \
  --query "Items[].sk.S" --output text | tr '\t' '\n' | while read -r SK; do
    aws dynamodb delete-item --table-name <LecturesTable> \
      --key "{\"pk\":{\"S\":\"USER#${USER_ID}\"},\"sk\":{\"S\":\"${SK}\"}}"
  done

# Series summaries and their episode rows
aws dynamodb query --table-name <SeriesTable> \
  --key-condition-expression "pk = :p" \
  --expression-attribute-values "{\":p\":{\"S\":\"USER#${USER_ID}\"}}" \
  --query "Items[].seriesId.S" --output text | tr '\t' '\n' | while read -r SERIES_ID; do
    [ -z "$SERIES_ID" ] && continue
    aws dynamodb query --table-name <SeriesTable> \
      --key-condition-expression "pk = :p" \
      --expression-attribute-values "{\":p\":{\"S\":\"SERIES#${SERIES_ID}\"}}" \
      --query "Items[].sk.S" --output text | tr '\t' '\n' | while read -r SK; do
        [ -z "$SK" ] && continue
        aws dynamodb delete-item --table-name <SeriesTable> \
          --key "{\"pk\":{\"S\":\"SERIES#${SERIES_ID}\"},\"sk\":{\"S\":\"${SK}\"}}"
      done
    aws dynamodb delete-item --table-name <SeriesTable> \
      --key "{\"pk\":{\"S\":\"USER#${USER_ID}\"},\"sk\":{\"S\":\"SERIES#${SERIES_ID}\"}}"
  done

# AgentCore long-term semantic records
aws bedrock-agentcore list-memory-records --memory-id <MemoryId> \
  --namespace "users/${USER_ID}/facts" \
  --query "memoryRecordSummaries[].memoryRecordId" --output text | tr '\t' '\n' | while read -r RECORD_ID; do
    [ -z "$RECORD_ID" ] && continue
    aws bedrock-agentcore delete-memory-record --memory-id <MemoryId> \
      --memory-record-id "$RECORD_ID"
  done

# Per-user rate-limit buckets
aws dynamodb query --table-name <RateLimitsTable> \
  --key-condition-expression "pk = :p" \
  --expression-attribute-values "{\":p\":{\"S\":\"USER#${USER_ID}\"}}" \
  --query "Items[].sk.S" --output text | tr '\t' '\n' | while read -r SK; do
    [ -z "$SK" ] && continue
    aws dynamodb delete-item --table-name <RateLimitsTable> \
      --key "{\"pk\":{\"S\":\"USER#${USER_ID}\"},\"sk\":{\"S\":\"${SK}\"}}"
  done

# Job rows and their AgentCore short-term events (while job IDs still exist)
aws dynamodb scan --table-name <JobsTable> \
  --filter-expression "userId = :u" \
  --expression-attribute-values "{\":u\":{\"S\":\"${USER_ID}\"}}" \
  --query "Items[].jobId.S" --output text | tr '\t' '\n' | while read -r JOB_ID; do
    [ -z "$JOB_ID" ] && continue
    aws bedrock-agentcore list-events --memory-id <MemoryId> \
      --session-id "$JOB_ID" --actor-id "$USER_ID" \
      --query "events[].eventId" --output text | tr '\t' '\n' | while read -r EVENT_ID; do
        [ -z "$EVENT_ID" ] && continue
        aws bedrock-agentcore delete-event --memory-id <MemoryId> \
          --session-id "$JOB_ID" --actor-id "$USER_ID" --event-id "$EVENT_ID"
      done
    aws dynamodb delete-item --table-name <JobsTable> \
      --key "{\"jobId\":{\"S\":\"${JOB_ID}\"}}"
  done

# Finally, delete the Cognito user (see allowlist section).
```

If not manually deleted, jobs, rate-limit buckets, and playback-session checkpoints
expire automatically after 24 hours, 2 hours, and 7 days respectively. AgentCore
Memory uses the stack's 90-day retention; delete known events/records explicitly as
shown above when immediate erasure is required.

## Health checks

- CloudWatch alarms fire on: async job errors > 10 / 5 min, presign errors > 10 /
  5 min, API 4xx > 50 / 5 min.
- WAF blocks (CloudWatch metrics): `CommonRuleSet`, `KnownBadInputs`, `SqlInjection`,
  `RateLimit`.
