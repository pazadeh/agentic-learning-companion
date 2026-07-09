#!/usr/bin/env python3
"""CDK application entry point for the Audio Learning Companion."""
import os

import aws_cdk as cdk

from stacks.audio_companion_stack import AudioCompanionStack

app = cdk.App()

# WAF for CloudFront and the whole stack must live in us-east-1.
AudioCompanionStack(
    app,
    "AudioCompanionStack",
    env=cdk.Environment(
        account=os.environ.get("CDK_DEFAULT_ACCOUNT"),
        region="us-east-1",
    ),
)

app.synth()
