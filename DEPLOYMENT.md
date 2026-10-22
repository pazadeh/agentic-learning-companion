# Deployment Guide

This deploys the Audio Learning Companion to **your own** AWS account. Nothing is
deployed for you — you run the steps below with your credentials.

> Region is **us-east-1** throughout (WAF for CloudFront must live there).
>
> **Production branch policy:** deploy only from the repository's `main` branch.
> `scripts/deploy.sh` enforces this and refuses `development`, feature branches, and
> detached HEADs. Validate on `development`, merge to `main`, then deploy.

## 0. Prerequisites on your machine

- AWS CLI v2, configured for a **personal** AWS account (not Isengard/corporate)
- Node.js 20+ and npm
- Python 3.12 (`python3.12`) — required by the Nova bidirectional runtime SDK
- The repo cloned locally

Verify:

```bash
aws sts get-caller-identity   # confirms your account/profile
node --version && python3.12 --version
```

## 1. Bedrock model availability

AWS has retired the manual model-access page for serverless foundation models, but
actual invocation availability can still vary by account even when an inference profile
is listed as `ACTIVE`. Verify the selected models with a real invocation before rollout.
The evaluated defaults are Claude Sonnet/Haiku 5.5 plus Amazon Nova 2.5 Sonic; the
current live app account uses Sonnet 4.6 environment overrides because 5.5 invocation
returns an account-availability denial.

> Optional verification (us-east-1):
> ```bash
> aws bedrock list-inference-profiles --region us-east-1 \
>   --query "inferenceProfileSummaries[?contains(inferenceProfileId,'claude-sonnet-5-5') || contains(inferenceProfileId,'claude-haiku-5-5')].inferenceProfileId"
> ```
> Seeing those IDs confirms discoverability, not account invocation permission. Confirm
> Sonic separately:
> ```bash
> aws bedrock list-foundation-models --region us-east-1 \
>   --query "modelSummaries[?modelId=='amazon.nova-2-5-sonic'].modelId"
> ```
> Evaluated defaults are Sonnet 5.5 for orchestration/writing, Haiku 5.5 for planning,
> and Nova 2.5 Sonic with Tiffany for narration (override with
> `ORCHESTRATOR_MODEL_ID`, `LECTURE_MODEL_ID`, and `PLANNER_MODEL_ID`; narration
> overrides are `NARRATION_PROVIDER`, `NOVA_MODEL_ID`, and `NOVA_VOICE_ID`). The writer's
> calibrated `LECTURE_TARGET_FACTOR` defaults to `0.8`. See
> [experiments/lecture_model_eval/RESULTS_2026.md](./experiments/lecture_model_eval/RESULTS_2026.md).
>
> Note: a provider may still gate *first use* behind a one-time form. **Anthropic
> requires a one-time "use case details" (First-Time-Use) form per AWS account**
> before any Claude model can be invoked — even though model access is otherwise
> automatic. Submit it once via the Bedrock console (open the **Chat/Playground**,
> pick any Claude model, fill the short form) or the `PutUseCaseForModelAccess` API.
> After submitting, allow up to ~15 minutes. Until then, agent calls fail with
> `ResourceNotFoundException: Model use case details have not been submitted`.
>
> If a real 5.5 invocation returns an account-availability denial, deploy with
> `ORCHESTRATOR_MODEL_ID=us.anthropic.claude-sonnet-4-6`,
> `PLANNER_MODEL_ID=us.anthropic.claude-sonnet-4-6`,
> `DESIGN_MODEL_ID=us.anthropic.claude-sonnet-4-6`, and
> `LECTURE_MODEL_ID=us.anthropic.claude-sonnet-4-6`. This changes text generation only;
> Nova narration remains `amazon.nova-2-5-sonic`.

## 2. Get a Tavily API key

Sign up at [tavily.com](https://tavily.com) (free tier is fine) and copy your API
key. You will store it in Secrets Manager after the stack deploys (step 6).

## 3. Bootstrap CDK (once per account/region)

```bash
cd infrastructure
python3.12 -m venv .venv-infra && source .venv-infra/bin/activate
pip install -r requirements.txt
npm install            # installs the pinned CDK CLI locally
npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1
deactivate && cd ..
```

## 4. Set the allowlist and alert email

Only these emails will ever be able to register (enforced by the Cognito
pre-sign-up Lambda):

```bash
export ALLOWED_EMAILS="you@example.com,trusted@example.com"
export ALERT_EMAIL="you@example.com"
```

## 5. Deploy the stack and frontend

```bash
./scripts/deploy.sh
```

This deploys the AWS stack and browser application, writes `frontend/.env` from the
stack outputs, uploads the build to S3, and invalidates CloudFront. AgentCore is a
separate deployment in step 7. At the end the script prints your **App URL**. On
later redeploys it reads and preserves the current `AGENT_RUNTIME_ARN` from the Lambda
and discovers its execution role so CDK can retain the progress-update policy; set the
corresponding environment variables explicitly only when switching runtimes. The audio
bucket remains private but allows GET/HEAD CORS from the deployed CloudFront origin so
an authenticated browser can store a presigned audio Blob explicitly for offline use.

## 6. Store the Tavily key in Secrets Manager

Use the `TavilySecretArn` value printed in `outputs.json`:

```bash
aws secretsmanager put-secret-value \
  --secret-id audio-companion/tavily-api-key \
  --secret-string '{"apiKey":"YOUR_TAVILY_KEY"}' \
  --region us-east-1
```

## 7. Deploy the AgentCore agent

The conversational backend runs on Bedrock AgentCore. Deploy the agent from the
`agentcore/` directory using the AgentCore starter toolkit / CLI, providing these
environment variables to the runtime (names come from `outputs.json`):

- `PROFILES_TABLE`, `LECTURES_TABLE`, `JOBS_TABLE`, `AUDIO_BUCKET`
- `TAVILY_SECRET_NAME=audio-companion/tavily-api-key`
- `MEMORY_ID` (the `MemoryId` output — enables semantic recall of prior topics;
  omit to disable AgentCore Memory)
- `ORCHESTRATOR_MODEL_ID`, `PLANNER_MODEL_ID`, `DESIGN_MODEL_ID`,
  `LECTURE_MODEL_ID`, `LECTURE_TARGET_FACTOR` (optional text-model overrides)
- `NARRATION_PROVIDER=nova-sonic`, `NOVA_MODEL_ID=amazon.nova-2-5-sonic`,
  `NOVA_VOICE_ID=tiffany`, `NOVA_SESSION_MAX_WORDS=900`, and
  `NOVA_TOTAL_TIMEOUT_SECONDS=660`

The checked-in `.bedrock_agentcore.yaml` is deployment metadata and may reference a
previous AWS account/runtime. Before a first deploy in another account, run the AgentCore
configure flow for that account and verify `aws.account`, execution role, source bucket,
and runtime id. Then deploy with the environment values above, for example:

```bash
cd agentcore
AWS_PROFILE=<profile> agentcore deploy --agent audiocompanion \
  --env PROFILES_TABLE=<ProfilesTableName> \
  --env LECTURES_TABLE=<LecturesTableName> \
  --env JOBS_TABLE=<JobsTableName> \
  --env AUDIO_BUCKET=<AudioBucketName> \
  --env TAVILY_SECRET_NAME=audio-companion/tavily-api-key \
  --env MEMORY_ID=<MemoryId> \
  --env ORCHESTRATOR_MODEL_ID=us.anthropic.claude-sonnet-5-5 \
  --env PLANNER_MODEL_ID=us.anthropic.claude-haiku-5-5 \
  --env DESIGN_MODEL_ID=us.anthropic.claude-haiku-5-5 \
  --env LECTURE_MODEL_ID=us.anthropic.claude-sonnet-5-5 \
  --env LECTURE_TARGET_FACTOR=0.8 \
  --env NARRATION_PROVIDER=nova-sonic \
  --env NOVA_MODEL_ID=amazon.nova-2-5-sonic \
  --env NOVA_VOICE_ID=tiffany \
  --env NOVA_SESSION_MAX_WORDS=900 \
  --env NOVA_TOTAL_TIMEOUT_SECONDS=660 \
  --env RATE_LIMITS_TABLE=<RateLimitsTableName>
cd ..
```

The runtime uses direct-code **Python 3.12** because the pinned bidirectional SDK
requires Python 3.12 or newer. Its execution role needs: Bedrock `InvokeModel` on the
Sonnet 5.5 and Haiku 5.5 **inference profiles**, their underlying foundation models,
and `arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-2-5-sonic`; DynamoDB
read/write on Profiles and Lectures; narrowly scoped `dynamodb:UpdateItem` on Jobs
for live progress; `s3:PutObject` on the audio prefix; `polly:SynthesizeSpeech` for
explicit rollback; `secretsmanager:GetSecretValue` on the Tavily secret; and
the AgentCore Memory data-plane actions on the memory resource. Managed Memory is
used only for prior topics and semantic facts; behavioral preferences are resolved
from the revisioned profile and playback data in DynamoDB:

```json
{
  "Effect": "Allow",
  "Action": [
    "bedrock-agentcore:CreateEvent",
    "bedrock-agentcore:RetrieveMemoryRecords",
    "bedrock-agentcore:ListMemoryRecords"
  ],
  "Resource": "arn:aws:bedrock-agentcore:us-east-1:<acct>:memory/*"
}
```

Because the selected models use cross-region inference profiles, the Bedrock statement
must cover both profile ARNs and the foundation-model ARNs across destination regions:

```json
{
  "Effect": "Allow",
  "Action": "bedrock:InvokeModel",
  "Resource": [
    "arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic.claude-sonnet-5-5",
    "arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic.claude-haiku-5-5",
    "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5-5*",
    "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-5-5*",
    "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-2-5-sonic"
  ]
}
```

The model selection and reasoning settings were measured in Isengard; rerun the role
and writer evaluations before changing these defaults.

Once deployed, copy the agent **runtime ARN** and redeploy the stack so the job
Lambda can invoke it:

```bash
cd infrastructure && source .venv-infra/bin/activate
npx cdk deploy AudioCompanionStack \
  -c agentRuntimeArn="arn:aws:bedrock-agentcore:us-east-1:<acct>:runtime/<id>" \
  -c agentRuntimeRoleArn="arn:aws:iam::<acct>:role/<runtime-role>" \
  --parameters AlertEmail="$ALERT_EMAIL" \
  --parameters AllowedEmails="$ALLOWED_EMAILS" \
  --outputs-file ../outputs.json
deactivate && cd ..
```

## 8. First user setup

1. Open the App URL.
2. **Create account** with an allowlisted email → confirm via the emailed code.
3. Sign in with your email and password. The browser silently refreshes the session for
   up to 30 days unless you sign out or clear site data.
4. You're in.

## 9. Manual test checklist

- [ ] A non-allowlisted email is rejected during sign-up before a confirmation code is sent.
- [ ] Email/password sign-in succeeds without a second factor and survives reload through silent refresh.
- [ ] Ask "Teach me about black holes" → truthful stages advance through
      Personalize → Research → Write → Create audio → Save → audio plays.
- [ ] Research details show completed search angles/source counts; audio details show
      real Nova session progress rather than elapsed-time estimates.
- [ ] The new lecture key ends in `lecture.wav`; the browser plays it, while older
      `lecture.mp3` history entries still refresh and play.
- [ ] Playback controls work: play/pause, ±15s, speed 0.5×–2×, seek.
- [ ] The lecture appears in **History**; reopening it refreshes a fresh audio URL.
- [ ] Profile edits persist after signing in on a second device.
- [ ] Listening for at least 20 seconds updates History progress and Profile statistics.
- [ ] Learned preferences appear only after repeated completed lectures; explicit
      profile settings and instructions in the current request take priority.
- [ ] Disabling behavioral personalization hides learned preferences; resetting them
      preserves playback/history statistics but excludes earlier evidence.
- [ ] Visiting an audio URL after ~1 hour fails (presigned URL expired) — refresh works.
- [ ] Hitting the API without a token returns 401.
- [ ] Chat → **Series** → "Teach me *Thinking, Fast and Slow* in 4 × 30-minute
      lectures" → a draft appears under **Series**, then a 4-episode plan to review.
- [ ] Edit the plan (reorder, change a duration), save, then approve. Episodes
      generate one at a time and each becomes playable as soon as it completes. A
  processing episode becomes retryable only after its active job has stopped publishing
  progress for the stale-lease interval.

Lecture series add a `SeriesTable` (output `SeriesTableName`) used only by the job
Lambda. No new AgentCore permissions are needed: the runtime already writes the
Lectures table, which it uses to tag episode lectures with their series. **Redeploy
the AgentCore agent** too, since it now handles `request_type=series_plan`.

For an **existing deployment**, deploy the backward-compatible AgentCore update
first, then redeploy the CDK stack/Lambda and frontend. This avoids exposing the
Series UI while an older runtime still rejects planning requests. Fresh deployments
should continue to follow steps 5–7 because the AgentCore environment needs the
stack outputs.

Adaptive profiles reuse `ProfilesTable` and `LecturesTable`: explicit settings are
revisioned, short-lived playback-session checkpoints expire after seven days, and
durable listening aggregates stay with each lecture. The CDK stack grants the API
Lambda profile/lecture access and transaction permission; AgentCore only needs its
existing read/write access to Profiles and Lectures. Endpoint details are in
[API.md](./API.md).

## 9a. Automated smoke test (optional)

After deploying, run the baseline end-to-end check against the live API. It verifies
that unauthenticated access is rejected, an authenticated user can generate a lecture,
audio can be presigned, and cross-user audio access is forbidden. The adaptive-profile
and series flows currently remain in the manual checklist above.

Authenticate one of two ways:

**Easiest — paste an ID token**: sign into the app, copy
the ID token (browser devtools → Application → Local Storage → the
`...idToken` value), then:

```bash
SMOKE_ID_TOKEN="<paste-id-token>" \
SMOKE_EXPECT_AUDIO_SUFFIX=.wav \
SMOKE_TIMEOUT=900 \
python3 scripts/smoke_test.py
```

**Or — email/password** (uses Cognito SRP):

```bash
pip install -r scripts/requirements-smoke.txt
SMOKE_EMAIL="you@example.com" \
SMOKE_PASSWORD="..." \
python3 scripts/smoke_test.py
```

The script reads `outputs.json` for the API URL and Cognito IDs (override with
`SMOKE_API_URL` etc.). It exits non-zero if any check fails, downloads the beginning
of the presigned object, and validates its audio header. It generates a real lecture,
so it consumes a small amount of Bedrock/Nova usage.

## Regenerating the PWA icons

Placeholder icons (`frontend/public/icon-192.png`, `icon-512.png`) ship in the repo.
To regenerate or restyle them:

```bash
python3 scripts/generate_icons.py
```

## Teardown

```bash
./scripts/teardown.sh   # type 'destroy' to confirm
```

This empties both S3 buckets and destroys the stack. Delete the AgentCore agent and
the Tavily secret separately if you want a completely clean account.
