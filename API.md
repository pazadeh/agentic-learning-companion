# API Reference

The browser calls the API Gateway `ApiUrl` directly. Every endpoint requires a valid
Amazon Cognito **ID token** in the `Authorization` header; API Gateway derives the
caller identity from the token's `sub` claim. The service never accepts a user id in
request JSON.

```http
Authorization: <Cognito ID token>
Content-Type: application/json
```

Responses set `Cache-Control: no-store`. Browser access is CORS-restricted to the
deployed CloudFront origin and the local Vite development origin.

## Lecture jobs

### `POST /jobs/start`

Starts an asynchronous lecture run.

```json
{
  "message": "Give me a 10-minute practical introduction to Raft",
  "action": "lecture"
}
```

`message` is required and limited to 2,000 characters. `action` is `lecture`,
`design`, or `chat`. A design turn additionally carries a bounded `design_context`:

```json
{
  "message": "I want a practical introduction",
  "action": "design",
  "design_context": {
    "request": "Help me understand Kubernetes",
    "answer": "I want a practical introduction",
    "brief": { "topic": "Kubernetes", "durationMinutes": 15 },
    "history": [{ "role": "user", "content": "Kubernetes" }],
    "turn": 2
  }
}
```

A completed design job returns `result.design` with `message`, validated `brief`,
`readyForConfirmation`, and either one `question` containing 2–5 choices or `null`.
Design jobs never return a lecture or invoke research/audio generation. The frontend
starts a separate `action=lecture` job only after explicit confirmation and sends the
validated `lecture_brief` alongside the human-readable prompt. AgentCore carries that
brief structurally through research and writing, rather than relying on the orchestrator
to reconstruct confirmed choices from prose.

```json
{
  "job_id": "uuid",
  "status": "pending"
}
```

Returns `202 Accepted`. The Lambda persists the job, invokes itself asynchronously,
resolves personalization, and calls AgentCore.

### `GET /jobs/{jobId}/status`

```json
{
  "job_id": "uuid",
  "status": "pending | processing | completed | failed",
  "stage": "queued | preparing | validating | recalling | profiling | researching | writing | synthesizing | uploading | saving | finalizing | completed",
  "progress": 44,
  "stage_message": "Research complete",
  "stage_detail": "Selected 12 sources from 27 results",
  "updated_at": 1791810000
}
```

The caller must own the job. Job rows expire after 24 hours. Progress values are
operation landmarks, not elapsed-time predictions: profile 25, research 30–44, writing
45–69, Nova/Polly synthesis 70–88, upload 90–93, save 94–95, and finalization 98–100.
`stageSeq` is internal and prevents delayed stage writes from moving progress backward.

### `GET /jobs/{jobId}/result`

Before completion, returns the same status shape. After completion:

```json
{
  "job_id": "uuid",
  "status": "completed",
  "progress": 100,
  "result": {
    "response": "Your lecture is ready.",
    "lecture": {
      "lectureId": "uuid",
      "title": "Raft: Practical Foundations",
      "topic": "Raft",
      "s3Key": "audio/{userId}/{lectureId}/lecture.wav",
      "audioProvider": "nova-sonic",
      "audioFormat": "wav",
      "durationMinutes": 10,
      "createdAt": "ISO-8601",
      "personalizationUsed": {
        "learningStyle": {
          "value": "practical",
          "source": "current_request | explicit | inferred | default",
          "confidencePercent": 100
        }
      }
    }
  }
}
```

The worker deterministically upserts returned lecture metadata before marking the
job complete, so history does not depend on an LLM tool call or device-local storage.

## Lecture library and playback

### `GET /lectures`

Lists up to 200 saved lectures newest-first for the signed-in user.

```json
{
  "lectures": [{
    "lectureId": "uuid",
    "title": "...",
    "topic": "...",
    "s3Key": "audio/{userId}/{lectureId}/lecture.wav",
    "audioProvider": "nova-sonic",
    "audioFormat": "wav",
    "durationMinutes": 10,
    "createdAt": "ISO-8601",
    "listenedSeconds": 420,
    "completionPercent": 70,
    "resumePositionSeconds": 390,
    "lastListenedAt": "ISO-8601",
    "personalizationUsed": {}
  }]
}
```

S3 URLs are deliberately not stored. Call `/audio/refresh` when playback begins.
The list exposes `transcriptAvailable` but never includes transcript text.

### `GET /lectures/{lectureId}`

Returns one lecture owned by the signed-in user, including `script` for explicit offline
saving. Missing and other-user records both return `404`; malformed IDs return `400`.
Legacy lectures return `script: null` and `transcriptAvailable: false` so their audio can
still be saved without fabricating text.

```json
{
  "lectureId": "uuid",
  "title": "...",
  "s3Key": "audio/{userId}/{lectureId}/lecture.wav",
  "audioFormat": "wav",
  "script": "Full generated spoken transcript...",
  "transcriptAvailable": true
}
```

### `POST /lectures/{lectureId}/playback`

Records cumulative media time genuinely consumed in one playback session. Seek
distance is not included. The client sends a heartbeat every ~20 seconds and flushes
on pause, completion, source change, and unmount.

```json
{
  "playbackSessionId": "uuid",
  "sequence": 3,
  "playedSeconds": 60.25,
  "positionSeconds": 105.0,
  "mediaDurationSeconds": 600.0,
  "playbackRate": 1.25,
  "eventType": "heartbeat | pause | ended",
  "occurredAt": "ISO-8601"
}
```

`playedSeconds` is cumulative within the session. `(playbackSessionId, sequence)`
makes delivery idempotent. The backend validates event time, clamps impossible
deltas, verifies lecture ownership, and atomically updates the session checkpoint
and lecture aggregate. A repeated or stale sequence returns:

```json
{ "accepted": false, "duplicate": true }
```

Accepted updates include the current listening aggregate and completion percentage.

### `POST /audio/refresh`

```json
{ "s3_key": "audio/{userId}/{lectureId}/lecture.wav" }
```

Returns a one-hour presigned S3 GET URL. The key must be the canonical WAV or legacy
MP3 lecture object under the caller's own `audio/{userId}/{lectureId}/` prefix.

## Learner profile

Explicit profile state is separate from behavioral inference. Explicit values always
win over inferred values; instructions in the current request win over both.

### `GET /profile`

Returns explicit values and their revision from one strongly consistent snapshot,
plus a derived inference view and lifetime playback statistics.

```json
{
  "explicit": {
    "profession": "Software engineer",
    "expertiseAreas": ["distributed systems"],
    "learningGoals": ["Understand consensus"],
    "learningStyle": "examples | theory | practical",
    "preferredDuration": 15,
    "knowledgeLevels": { "Raft": "intermediate" },
    "behavioralPersonalizationEnabled": true
  },
  "inferred": {
    "enabled": true,
    "topicInterests": [{
      "topic": "distributed systems",
      "confidencePercent": 72,
      "sampleCount": 4,
      "lastObservedAt": "ISO-8601"
    }],
    "preferredDuration": {
      "value": 15,
      "confidencePercent": 74,
      "sampleCount": 4
    }
  },
  "stats": {
    "lecturesCompleted": 4,
    "totalListeningSeconds": 3120
  },
  "revision": 3,
  "hasExplicitProfile": true
}
```

Behavioral traits need at least three samples and 70% confidence before they affect
generation. Evidence decays over time.

### `PUT /profile`

Writes only user-authored fields. Send the revision returned by `GET /profile`:

```json
{
  "profession": "Software engineer",
  "expertiseAreas": ["distributed systems"],
  "learningGoals": ["Understand consensus"],
  "learningStyle": "practical",
  "preferredDuration": 20,
  "knowledgeLevels": {},
  "behavioralPersonalizationEnabled": true,
  "revision": 3
}
```

Returns the same shape as `GET /profile` with an incremented revision. A stale
revision returns `409 conflict`; clients must reload rather than overwrite newer
cross-device changes. Enabling or disabling behavioral personalization advances the
active inference generation so opted-out activity can never become future evidence.

### `GET /profile/inferences`

Returns only the inferred-profile object. This is an explainable view over durable
lecture and playback records; AgentCore Memory is not the preference source of truth.

### `DELETE /profile/inferences`

Resets learned preferences without deleting factual history or playback progress.
The backend atomically advances `inferenceGeneration`; delayed or in-flight playback
can only land in an older generation and remains excluded.

```json
{ "ok": true, "resetAt": "ISO-8601" }
```

## Lecture series

### `POST /series/drafts`

Creates a durable draft and asynchronously plans 2–8 episodes.

```json
{
  "message": "Teach me distributed systems in four 20-minute lectures",
  "episodeCount": 4,
  "durationMinutes": 20
}
```

`episodeCount` and `durationMinutes` are optional; when present they must be 2–8 and
1–30 respectively. Returns `202` with a `SeriesDetail` in `planning` state.

### `GET /series`

Returns up to 100 summaries for the caller, newest-first.

### `GET /series/{seriesId}`

Returns the owned summary, editable plan, and episode states. Series states are:

```text
planning → ready_for_approval → generating → completed
    │                               │
    └────────→ failed               └────────→ attention → generating
```

Episode states are `planned`, `queued`, `processing`, `completed`, and `failed`.
While lifecycle status remains `processing`, `stage`, `stageMessage`, `stageDetail`, and
`progress` expose the active job's real research/writing/audio step. The response marks
failed or stale work as `retryable`.

### `POST /series/{seriesId}/plan`

Replaces an unapproved plan using optimistic concurrency:

```json
{ "revision": 1, "plan": { "title": "...", "description": "...", "episodes": [] } }
```

Plan bounds: 2–8 episodes; title ≤200 characters; summary ≤1,000; description
≤2,000; duration 1–30 minutes. Returns `409` if the revision or state changed.

### `POST /series/{seriesId}/approve`

```json
{ "revision": 2 }
```

Freezes the current plan and queues episode 1. Episodes generate sequentially and
become playable individually. Planner redeliveries are fenced with a claim token;
episode completion and queueing the next episode happen in one DynamoDB transaction.

### `POST /series/{seriesId}/episodes/{episodeId}/retry`

Retries only a failed episode or one stalled beyond the worker timeout. Completed
episodes remain available and later planned episodes remain unchanged.

## Errors

Typical responses:

| Status | Code | Meaning |
|---:|---|---|
| 400 | `invalid_input` | Malformed JSON, identifier, bounds, or profile/playback value. |
| 401 | API Gateway response | Missing, invalid, or expired Cognito token. |
| 403 | `forbidden` / `content_blocked` | Cross-user access or blocked generation topic. |
| 404 | `not_found` | Owned resource does not exist (other users' resources are not disclosed). |
| 409 | `conflict` / `invalid_state` | Stale revision or invalid series transition. |
| 429 | `rate_limited` | Per-user action budget exhausted. |
| 500 | `internal_error` | Unexpected service error; inspect metadata-only CloudWatch logs. |

Do not log request bodies, lecture scripts, search queries, Cognito tokens, or presigned
URLs. Audit events use a strict metadata allowlist.
