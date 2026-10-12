"""Audio Learning Companion — single CDK stack.

Provisions every AWS resource for the app: encryption (KMS), secrets, DynamoDB,
S3, Cognito (MFA + email allowlist), Lambdas, API Gateway (Cognito-authorized,
throttled), WAF, CloudFront (OAI + security headers), budget, and alarms.

Security posture is enforced here: buckets block all public access, tables are
encrypted, Lambda env vars are KMS-encrypted, IAM is scoped to specific ARNs, and
every API route requires a valid Cognito JWT.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from aws_cdk import (
    CfnOutput,
    CfnParameter,
    Duration,
    RemovalPolicy,
    Stack,
    Tags,
    aws_apigateway as apigw,
    aws_budgets as budgets,
    aws_bedrockagentcore as agentcore,
    aws_cloudfront as cloudfront,
    aws_cloudfront_origins as origins,
    aws_cloudwatch as cloudwatch,
    aws_cognito as cognito,
    aws_dynamodb as dynamodb,
    aws_iam as iam,
    aws_kms as kms,
    aws_lambda as _lambda,
    aws_s3 as s3,
    aws_secretsmanager as secretsmanager,
    aws_wafv2 as wafv2,
)
from constructs import Construct

# Repo root = two levels up from this file (stacks/ -> infrastructure/ -> root).
ROOT = Path(__file__).resolve().parents[2]
SECURITY_SRC = ROOT / "agentcore" / "security"
LAYER_BUILD = ROOT / "infrastructure" / "build" / "security_layer"


def _build_security_layer() -> str:
    """Assemble the shared `security` package into a Lambda-layer directory.

    Runs at synth time (pure Python, no Docker) by copying ``agentcore/security``
    into ``build/security_layer/python/security`` — the layout AWS Lambda expects
    for a Python layer. Returns the path to pass to ``LayerVersion``.
    """
    target_pkg = LAYER_BUILD / "python" / "security"
    if LAYER_BUILD.exists():
        shutil.rmtree(LAYER_BUILD)
    target_pkg.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        SECURITY_SRC,
        target_pkg,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    return str(LAYER_BUILD)


class AudioCompanionStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        agent_runtime_arn = self.node.try_get_context("agentRuntimeArn") or ""

        # WAF is on by default; disable for solo/debug deploys with `-c enableWaf=false`
        # to avoid the ~$9/month standing cost. Re-enable before sharing the URL.
        waf_ctx = self.node.try_get_context("enableWaf")
        if isinstance(waf_ctx, bool):
            enable_waf = waf_ctx
        elif isinstance(waf_ctx, str):
            enable_waf = waf_ctx.strip().lower() not in ("false", "0", "no", "off")
        else:
            enable_waf = True

        alert_email = CfnParameter(
            self,
            "AlertEmail",
            type="String",
            default="",
            description="Email address for budget and alarm notifications.",
        )

        # Email allowlist for sign-up, enforced by the Cognito pre-signup Lambda.
        # Modeled as a CfnParameter (not an env var) so it persists across deploys
        # that don't re-supply it — preventing the allowlist from being emptied.
        allowed_emails_param = CfnParameter(
            self,
            "AllowedEmails",
            type="String",
            default="",
            description="Comma-separated email allowlist for sign-up.",
        )

        # ----------------------------------------------------------------- #
        # Encryption key
        # ----------------------------------------------------------------- #
        key = kms.Key(
            self,
            "AppKey",
            description="Audio Learning Companion — Lambda env var encryption",
            enable_key_rotation=True,
            removal_policy=RemovalPolicy.DESTROY,
        )

        # ----------------------------------------------------------------- #
        # Secrets
        # ----------------------------------------------------------------- #
        tavily_secret = secretsmanager.Secret(
            self,
            "TavilyApiKey",
            secret_name="audio-companion/tavily-api-key",
            description="Tavily web search API key (populate after deploy)",
        )

        # ----------------------------------------------------------------- #
        # DynamoDB tables
        # ----------------------------------------------------------------- #
        profiles_table = dynamodb.Table(
            self,
            "ProfilesTable",
            partition_key=dynamodb.Attribute(name="pk", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="sk", type=dynamodb.AttributeType.STRING),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption=dynamodb.TableEncryption.AWS_MANAGED,
            point_in_time_recovery_specification=dynamodb.PointInTimeRecoverySpecification(
                point_in_time_recovery_enabled=True
            ),
            time_to_live_attribute="ttl",
            removal_policy=RemovalPolicy.DESTROY,
        )

        lectures_table = dynamodb.Table(
            self,
            "LecturesTable",
            partition_key=dynamodb.Attribute(name="pk", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="sk", type=dynamodb.AttributeType.STRING),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption=dynamodb.TableEncryption.AWS_MANAGED,
            point_in_time_recovery_specification=dynamodb.PointInTimeRecoverySpecification(
                point_in_time_recovery_enabled=True
            ),
            removal_policy=RemovalPolicy.DESTROY,
        )
        lectures_table.add_global_secondary_index(
            index_name="GSI1",
            partition_key=dynamodb.Attribute(name="pk", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="createdAt", type=dynamodb.AttributeType.STRING),
        )

        # Durable multi-part lecture series: summaries (pk=USER#id, sk=SERIES#id)
        # and ordered episodes (pk=SERIES#id, sk=EPISODE#nn). No TTL.
        series_table = dynamodb.Table(
            self,
            "SeriesTable",
            partition_key=dynamodb.Attribute(name="pk", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="sk", type=dynamodb.AttributeType.STRING),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption=dynamodb.TableEncryption.AWS_MANAGED,
            point_in_time_recovery_specification=dynamodb.PointInTimeRecoverySpecification(
                point_in_time_recovery_enabled=True
            ),
            removal_policy=RemovalPolicy.DESTROY,
        )

        jobs_table = dynamodb.Table(
            self,
            "JobsTable",
            partition_key=dynamodb.Attribute(name="jobId", type=dynamodb.AttributeType.STRING),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption=dynamodb.TableEncryption.AWS_MANAGED,
            time_to_live_attribute="ttl",
            removal_policy=RemovalPolicy.DESTROY,
        )

        rate_limits_table = dynamodb.Table(
            self,
            "RateLimitsTable",
            partition_key=dynamodb.Attribute(name="pk", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="sk", type=dynamodb.AttributeType.STRING),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption=dynamodb.TableEncryption.AWS_MANAGED,
            time_to_live_attribute="ttl",
            removal_policy=RemovalPolicy.DESTROY,
        )

        # ----------------------------------------------------------------- #
        # AgentCore Memory — long-term learner memory across sessions
        # ----------------------------------------------------------------- #
        # A managed semantic strategy extracts prior topics/facts. Behavioral
        # preferences live in the structured profile engine so reset/disable controls
        # have deterministic semantics.
        # Namespaces are per-user via the {actorId} placeholder (actorId = user id),
        # so one user can never retrieve another user's memories.
        memory = agentcore.Memory(
            self,
            "AgentMemory",
            memory_name="AudioCompanionMemory",
            description="Long-term learner memory for prior topics and semantic facts.",
            expiration_duration=Duration.days(90),
            memory_strategies=[
                agentcore.ManagedMemoryStrategy(
                    agentcore.MemoryStrategyType.SEMANTIC,
                    strategy_name="semantic_facts",
                    namespaces=["users/{actorId}/facts"],
                ),
            ],
        )

        # ----------------------------------------------------------------- #
        # S3 buckets (block ALL public access)
        # ----------------------------------------------------------------- #
        block_public = s3.BlockPublicAccess(
            block_public_acls=True,
            block_public_policy=True,
            ignore_public_acls=True,
            restrict_public_buckets=True,
        )

        audio_bucket = s3.Bucket(
            self,
            "AudioBucket",
            block_public_access=block_public,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
            lifecycle_rules=[
                s3.LifecycleRule(abort_incomplete_multipart_upload_after=Duration.days(7))
            ],
        )

        frontend_bucket = s3.Bucket(
            self,
            "FrontendBucket",
            block_public_access=block_public,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
        )

        # ----------------------------------------------------------------- #
        # Lambda layer (shared security package)
        # ----------------------------------------------------------------- #
        security_layer = _lambda.LayerVersion(
            self,
            "SecurityLayer",
            code=_lambda.Code.from_asset(_build_security_layer()),
            compatible_runtimes=[_lambda.Runtime.PYTHON_3_11],
            description="Shared input validation, content filter, rate limiter, audit logger",
        )

        # ----------------------------------------------------------------- #
        # Pre-Sign-up Lambda (email allowlist)
        # ----------------------------------------------------------------- #
        pre_signup_fn = _lambda.Function(
            self,
            "PreSignupFn",
            runtime=_lambda.Runtime.PYTHON_3_11,
            handler="handler.handler",
            code=_lambda.Code.from_asset(str(ROOT / "lambdas" / "cognito_pre_signup")),
            timeout=Duration.seconds(10),
            memory_size=128,
            environment={"ALLOWED_EMAILS": allowed_emails_param.value_as_string},
            environment_encryption=key,
        )

        # ----------------------------------------------------------------- #
        # Cognito User Pool (MFA required, email verification, allowlist)
        # ----------------------------------------------------------------- #
        user_pool = cognito.UserPool(
            self,
            "UserPool",
            self_sign_up_enabled=True,  # gated by the pre-signup allowlist Lambda
            sign_in_aliases=cognito.SignInAliases(email=True),
            auto_verify=cognito.AutoVerifiedAttrs(email=True),
            standard_attributes=cognito.StandardAttributes(
                email=cognito.StandardAttribute(required=True, mutable=False)
            ),
            password_policy=cognito.PasswordPolicy(
                min_length=14,
                require_lowercase=True,
                require_uppercase=True,
                require_digits=True,
                require_symbols=True,
            ),
            mfa=cognito.Mfa.REQUIRED,
            mfa_second_factor=cognito.MfaSecondFactor(otp=True, sms=False),
            account_recovery=cognito.AccountRecovery.EMAIL_ONLY,
            lambda_triggers=cognito.UserPoolTriggers(pre_sign_up=pre_signup_fn),
            removal_policy=RemovalPolicy.DESTROY,
        )

        user_pool_client = user_pool.add_client(
            "WebClient",
            generate_secret=False,
            auth_flows=cognito.AuthFlow(user_srp=True, user_password=False, admin_user_password=False),
            id_token_validity=Duration.hours(1),
            access_token_validity=Duration.hours(1),
            refresh_token_validity=Duration.days(7),
            prevent_user_existence_errors=True,
        )

        # ----------------------------------------------------------------- #
        # CloudFront (created before API so we can pin CORS to its domain)
        # ----------------------------------------------------------------- #
        web_acl = self._build_waf() if enable_waf else None

        response_headers_policy = self._build_response_headers_policy()

        oai = cloudfront.OriginAccessIdentity(self, "FrontendOAI")
        frontend_bucket.grant_read(oai)

        distribution = cloudfront.Distribution(
            self,
            "Distribution",
            default_root_object="index.html",
            web_acl_id=web_acl.attr_arn if web_acl else None,
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_identity(
                    frontend_bucket, origin_access_identity=oai
                ),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cache_policy=cloudfront.CachePolicy.CACHING_OPTIMIZED,
                response_headers_policy=response_headers_policy,
            ),
            error_responses=[
                cloudfront.ErrorResponse(
                    http_status=403,
                    response_http_status=200,
                    response_page_path="/index.html",
                    ttl=Duration.seconds(0),
                ),
                cloudfront.ErrorResponse(
                    http_status=404,
                    response_http_status=200,
                    response_page_path="/index.html",
                    ttl=Duration.seconds(0),
                ),
            ],
        )

        cloudfront_origin = f"https://{distribution.distribution_domain_name}"

        # ----------------------------------------------------------------- #
        # Backend Lambdas
        # ----------------------------------------------------------------- #
        async_job_function_name = "audio-companion-async-job"
        async_job_fn = _lambda.Function(
            self,
            "AsyncJobFn",
            function_name=async_job_function_name,
            runtime=_lambda.Runtime.PYTHON_3_11,
            handler="handler.handler",
            code=_lambda.Code.from_asset(str(ROOT / "lambdas" / "async_job")),
            timeout=Duration.minutes(15),
            memory_size=512,
            layers=[security_layer],
            environment={
                "JOBS_TABLE": jobs_table.table_name,
                "PROFILES_TABLE": profiles_table.table_name,
                "LECTURES_TABLE": lectures_table.table_name,
                "SERIES_TABLE": series_table.table_name,
                "RATE_LIMITS_TABLE": rate_limits_table.table_name,
                "AGENT_RUNTIME_ARN": agent_runtime_arn,
                "CORS_ALLOW_ORIGIN": cloudfront_origin,
            },
            environment_encryption=key,
        )

        presign_fn = _lambda.Function(
            self,
            "PresignAudioFn",
            runtime=_lambda.Runtime.PYTHON_3_11,
            handler="handler.handler",
            code=_lambda.Code.from_asset(str(ROOT / "lambdas" / "presign_audio")),
            timeout=Duration.seconds(15),
            memory_size=256,
            layers=[security_layer],
            environment={
                "AUDIO_BUCKET": audio_bucket.bucket_name,
                "CORS_ALLOW_ORIGIN": cloudfront_origin,
            },
            environment_encryption=key,
        )

        # IAM — scoped grants only
        jobs_table.grant_read_write_data(async_job_fn)
        profiles_table.grant_read_write_data(async_job_fn)
        rate_limits_table.grant_read_write_data(async_job_fn)
        # The worker lists history and deterministically upserts AgentCore results.
        # This makes DynamoDB—not a device's local cache—the cross-device source of truth.
        lectures_table.grant_read_write_data(async_job_fn)
        # Series coordinator state (transactions use Put/Update/Delete on both tables).
        series_table.grant_read_write_data(async_job_fn)
        # CDK's DynamoDB read/write grant does not include TransactWriteItems.
        # Series creation and every state transition atomically update both tables.
        async_job_fn.add_to_role_policy(
            iam.PolicyStatement(
                actions=["dynamodb:TransactWriteItems"],
                resources=[
                    jobs_table.table_arn,
                    profiles_table.table_arn,
                    lectures_table.table_arn,
                    series_table.table_arn,
                ],
            )
        )
        # Self async-invoke. Reference the ARN by its fixed name (not fn.function_arn)
        # so the role's policy doesn't create a circular dependency on the function.
        async_job_fn.add_to_role_policy(
            iam.PolicyStatement(
                actions=["lambda:InvokeFunction"],
                resources=[
                    f"arn:aws:lambda:{self.region}:{self.account}:function:{async_job_function_name}"
                ],
            )
        )
        audio_bucket.grant_read(presign_fn)

        # Bedrock AgentCore invoke — must cover the runtime AND its endpoint
        # sub-resource, since invocation targets
        # .../runtime/<id>/runtime-endpoint/DEFAULT.
        if agent_runtime_arn:
            runtime_resources = [
                agent_runtime_arn,
                f"{agent_runtime_arn}/runtime-endpoint/*",
            ]
        else:
            runtime_resources = [
                f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:runtime/*"
            ]
        async_job_fn.add_to_role_policy(
            iam.PolicyStatement(
                actions=["bedrock-agentcore:InvokeAgentRuntime"],
                resources=runtime_resources,
            )
        )

        # ----------------------------------------------------------------- #
        # API Gateway (Cognito authorizer, throttled, CORS to CloudFront)
        # ----------------------------------------------------------------- #
        api = apigw.RestApi(
            self,
            "Api",
            rest_api_name="audio-companion-api",
            deploy_options=apigw.StageOptions(
                stage_name="prod",
                throttling_rate_limit=10,
                throttling_burst_limit=20,
                logging_level=apigw.MethodLoggingLevel.ERROR,
                metrics_enabled=True,
            ),
            default_cors_preflight_options=apigw.CorsOptions(
                allow_origins=[cloudfront_origin, "http://localhost:5173"],
                allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
                allow_headers=["Authorization", "Content-Type"],
                max_age=Duration.hours(1),
            ),
        )

        authorizer = apigw.CognitoUserPoolsAuthorizer(
            self, "ApiAuthorizer", cognito_user_pools=[user_pool]
        )
        auth_opts = {
            "authorizer": authorizer,
            "authorization_type": apigw.AuthorizationType.COGNITO,
        }

        job_integration = apigw.LambdaIntegration(async_job_fn)
        presign_integration = apigw.LambdaIntegration(presign_fn)

        jobs = api.root.add_resource("jobs")
        jobs.add_resource("start").add_method("POST", job_integration, **auth_opts)
        job_id_res = jobs.add_resource("{jobId}")
        job_id_res.add_resource("status").add_method("GET", job_integration, **auth_opts)
        job_id_res.add_resource("result").add_method("GET", job_integration, **auth_opts)

        # Cloud-synced explicit profile and inspectable/resettable inferences.
        profile = api.root.add_resource("profile")
        profile.add_method("GET", job_integration, **auth_opts)
        profile.add_method("PUT", job_integration, **auth_opts)
        profile.add_resource("inferences").add_method("GET", job_integration, **auth_opts)
        profile.get_resource("inferences").add_method("DELETE", job_integration, **auth_opts)

        # Lecture history — lists the caller's saved lectures across devices.
        lectures = api.root.add_resource("lectures")
        lectures.add_method("GET", job_integration, **auth_opts)
        (
            lectures.add_resource("{lectureId}")
            .add_resource("playback")
            .add_method("POST", job_integration, **auth_opts)
        )

        # Multi-part lecture series — same Lambda, Cognito-protected.
        series_res = api.root.add_resource("series")
        series_res.add_method("GET", job_integration, **auth_opts)
        series_res.add_resource("drafts").add_method("POST", job_integration, **auth_opts)
        series_id_res = series_res.add_resource("{seriesId}")
        series_id_res.add_method("GET", job_integration, **auth_opts)
        series_id_res.add_resource("plan").add_method("POST", job_integration, **auth_opts)
        series_id_res.add_resource("approve").add_method("POST", job_integration, **auth_opts)
        (
            series_id_res.add_resource("episodes")
            .add_resource("{episodeId}")
            .add_resource("retry")
            .add_method("POST", job_integration, **auth_opts)
        )

        audio = api.root.add_resource("audio")
        audio.add_resource("refresh").add_method("POST", presign_integration, **auth_opts)

        # Attach CORS headers to gateway-level error responses (e.g. the Cognito
        # authorizer's 401/403) so the browser can read the status instead of
        # surfacing an opaque "network error".
        for resp_id, resp_type in (
            ("Default4xxCors", apigw.ResponseType.DEFAULT_4_XX),
            ("Default5xxCors", apigw.ResponseType.DEFAULT_5_XX),
        ):
            api.add_gateway_response(
                resp_id,
                type=resp_type,
                response_headers={
                    "Access-Control-Allow-Origin": f"'{cloudfront_origin}'",
                    "Access-Control-Allow-Headers": "'Authorization,Content-Type'",
                    "Access-Control-Allow-Methods": "'GET,POST,PUT,DELETE,OPTIONS'",
                },
            )

        # ----------------------------------------------------------------- #
        # Budget + alarms
        # ----------------------------------------------------------------- #
        self._build_budget(alert_email.value_as_string)
        self._build_alarms(async_job_fn, presign_fn, api)

        # ----------------------------------------------------------------- #
        # Tags
        # ----------------------------------------------------------------- #
        Tags.of(self).add("Project", "AudioLearningCompanion")
        Tags.of(self).add("Environment", "prod")

        # ----------------------------------------------------------------- #
        # Outputs
        # ----------------------------------------------------------------- #
        CfnOutput(self, "ApiUrl", value=api.url)
        CfnOutput(self, "UserPoolId", value=user_pool.user_pool_id)
        CfnOutput(self, "UserPoolClientId", value=user_pool_client.user_pool_client_id)
        CfnOutput(self, "Region", value=self.region)
        CfnOutput(self, "CloudFrontUrl", value=cloudfront_origin)
        CfnOutput(self, "FrontendBucketName", value=frontend_bucket.bucket_name)
        CfnOutput(self, "AudioBucketName", value=audio_bucket.bucket_name)
        CfnOutput(self, "DistributionId", value=distribution.distribution_id)
        CfnOutput(self, "TavilySecretArn", value=tavily_secret.secret_arn)
        CfnOutput(self, "ProfilesTableName", value=profiles_table.table_name)
        CfnOutput(self, "LecturesTableName", value=lectures_table.table_name)
        CfnOutput(self, "JobsTableName", value=jobs_table.table_name)
        CfnOutput(self, "SeriesTableName", value=series_table.table_name)
        CfnOutput(self, "RateLimitsTableName", value=rate_limits_table.table_name)
        CfnOutput(self, "MemoryId", value=memory.memory_id)
        CfnOutput(self, "MemoryArn", value=memory.memory_arn)

    # --------------------------------------------------------------------- #
    # Helpers
    # --------------------------------------------------------------------- #
    def _build_waf(self) -> wafv2.CfnWebACL:
        def managed(name: str, vendor_name: str, rule_name: str, priority: int):
            return wafv2.CfnWebACL.RuleProperty(
                name=name,
                priority=priority,
                override_action=wafv2.CfnWebACL.OverrideActionProperty(none={}),
                statement=wafv2.CfnWebACL.StatementProperty(
                    managed_rule_group_statement=wafv2.CfnWebACL.ManagedRuleGroupStatementProperty(
                        vendor_name=vendor_name, name=rule_name
                    )
                ),
                visibility_config=wafv2.CfnWebACL.VisibilityConfigProperty(
                    sampled_requests_enabled=True,
                    cloud_watch_metrics_enabled=True,
                    metric_name=name,
                ),
            )

        rate_rule = wafv2.CfnWebACL.RuleProperty(
            name="RateLimit",
            priority=10,
            action=wafv2.CfnWebACL.RuleActionProperty(block={}),
            statement=wafv2.CfnWebACL.StatementProperty(
                rate_based_statement=wafv2.CfnWebACL.RateBasedStatementProperty(
                    limit=200, aggregate_key_type="IP"
                )
            ),
            visibility_config=wafv2.CfnWebACL.VisibilityConfigProperty(
                sampled_requests_enabled=True,
                cloud_watch_metrics_enabled=True,
                metric_name="RateLimit",
            ),
        )

        return wafv2.CfnWebACL(
            self,
            "WebAcl",
            default_action=wafv2.CfnWebACL.DefaultActionProperty(allow={}),
            scope="CLOUDFRONT",
            visibility_config=wafv2.CfnWebACL.VisibilityConfigProperty(
                sampled_requests_enabled=True,
                cloud_watch_metrics_enabled=True,
                metric_name="AudioCompanionWebAcl",
            ),
            rules=[
                managed("CommonRuleSet", "AWS", "AWSManagedRulesCommonRuleSet", 1),
                managed("KnownBadInputs", "AWS", "AWSManagedRulesKnownBadInputsRuleSet", 2),
                managed("SqlInjection", "AWS", "AWSManagedRulesSQLiRuleSet", 3),
                rate_rule,
            ],
        )

    def _build_response_headers_policy(self) -> cloudfront.ResponseHeadersPolicy:
        csp = (
            "default-src 'self'; "
            "connect-src 'self' https://*.amazonaws.com; "
            "img-src 'self' data:; "
            "style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; "
            "media-src 'self' blob: https://*.amazonaws.com;"
        )
        return cloudfront.ResponseHeadersPolicy(
            self,
            "SecurityHeaders",
            security_headers_behavior=cloudfront.ResponseSecurityHeadersBehavior(
                content_security_policy=cloudfront.ResponseHeadersContentSecurityPolicy(
                    content_security_policy=csp, override=True
                ),
                strict_transport_security=cloudfront.ResponseHeadersStrictTransportSecurity(
                    access_control_max_age=Duration.seconds(63072000),
                    include_subdomains=True,
                    preload=True,
                    override=True,
                ),
                content_type_options=cloudfront.ResponseHeadersContentTypeOptions(override=True),
                frame_options=cloudfront.ResponseHeadersFrameOptions(
                    frame_option=cloudfront.HeadersFrameOption.DENY, override=True
                ),
                referrer_policy=cloudfront.ResponseHeadersReferrerPolicy(
                    referrer_policy=cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
                    override=True,
                ),
            ),
            custom_headers_behavior=cloudfront.ResponseCustomHeadersBehavior(
                custom_headers=[
                    cloudfront.ResponseCustomHeader(
                        header="Permissions-Policy",
                        value="microphone=(self), geolocation=()",
                        override=True,
                    )
                ]
            ),
        )

    def _build_budget(self, subscriber_email: str) -> None:
        notifications = [
            budgets.CfnBudget.NotificationWithSubscribersProperty(
                notification=budgets.CfnBudget.NotificationProperty(
                    comparison_operator="GREATER_THAN",
                    notification_type="ACTUAL",
                    threshold=30,
                    threshold_type="ABSOLUTE_VALUE",
                ),
                subscribers=[
                    budgets.CfnBudget.SubscriberProperty(
                        address=subscriber_email, subscription_type="EMAIL"
                    )
                ],
            ),
            budgets.CfnBudget.NotificationWithSubscribersProperty(
                notification=budgets.CfnBudget.NotificationProperty(
                    comparison_operator="GREATER_THAN",
                    notification_type="FORECASTED",
                    threshold=100,
                    threshold_type="ABSOLUTE_VALUE",
                ),
                subscribers=[
                    budgets.CfnBudget.SubscriberProperty(
                        address=subscriber_email, subscription_type="EMAIL"
                    )
                ],
            ),
        ]
        budgets.CfnBudget(
            self,
            "MonthlyBudget",
            budget=budgets.CfnBudget.BudgetDataProperty(
                budget_type="COST",
                time_unit="MONTHLY",
                budget_limit=budgets.CfnBudget.SpendProperty(amount=100, unit="USD"),
            ),
            notifications_with_subscribers=notifications,
        )

    def _build_alarms(
        self,
        async_job_fn: _lambda.Function,
        presign_fn: _lambda.Function,
        api: apigw.RestApi,
    ) -> None:
        cloudwatch.Alarm(
            self,
            "AsyncJobErrorsAlarm",
            metric=async_job_fn.metric_errors(period=Duration.minutes(5)),
            threshold=10,
            evaluation_periods=1,
            comparison_operator=cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treat_missing_data=cloudwatch.TreatMissingData.NOT_BREACHING,
        )
        cloudwatch.Alarm(
            self,
            "PresignErrorsAlarm",
            metric=presign_fn.metric_errors(period=Duration.minutes(5)),
            threshold=10,
            evaluation_periods=1,
            comparison_operator=cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treat_missing_data=cloudwatch.TreatMissingData.NOT_BREACHING,
        )
        cloudwatch.Alarm(
            self,
            "Api4xxAlarm",
            metric=api.metric_client_error(period=Duration.minutes(5)),
            threshold=50,
            evaluation_periods=1,
            comparison_operator=cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treat_missing_data=cloudwatch.TreatMissingData.NOT_BREACHING,
        )
