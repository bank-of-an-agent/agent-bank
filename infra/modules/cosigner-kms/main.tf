# The co-signer's signing key: an AWS KMS asymmetric secp256k1 key (ECC_SECG_P256K1, SIGN_VERIFY).
#
# AWS KMS keys are NON-EXPORTABLE by design: the private key is generated inside FIPS 140-3
# validated HSMs and there is no API that returns it. Nobody (no human, no service, not AWS
# operators) holds this signing material; it can only be *used*, through kms:Sign, by the
# principals the key policy allows.
#
# Key policy summary:
#   * kms:Sign / kms:GetPublicKey: ONLY the co-signer ECS task role, only ECDSA_SHA_256 over a
#     32-byte digest, only through the co-signer VPC's KMS interface endpoint. Explicit denies
#     enforce this even if an allow is added later.
#   * Administration (policy, tags, aliases): deployment role(s). They cannot sign.
#   * DisableKey / ScheduleKeyDeletion: break-glass role only, only with MFA.
#   * Grants are denied for everyone (a grant could delegate Sign).
#   * The account root can only read key metadata: no IAM policy can ever grant Sign.
#
# Note that the key alone can never move funds: on-chain, the co-signer signature is only
# valid together with a live, in-scope session-key signature (or the owner's signature).
#
# Usage logging: AWS KMS has no CloudTrail *data event* type; every KMS call (including Sign
# and GetPublicKey) is a *management* event. A dedicated trail therefore records all
# management events (KMS is not excluded), delivered to WORM storage and to CloudWatch Logs
# for real-time alarms.

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  region     = data.aws_region.current.region
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  account_root = "arn:${local.partition}:iam::${local.account_id}:root"
  trail_arn    = "arn:${local.partition}:cloudtrail:${local.region}:${local.account_id}:trail/${var.trail_name}"

  restrict_to_vpc_endpoints = length(var.allowed_kms_vpc_endpoint_ids) > 0
}

# --- Signing key ------------------------------------------------------------------------------------

data "aws_iam_policy_document" "key" {
  statement {
    sid = "KeyAdministrationWithoutUse"
    actions = [
      "kms:CancelKeyDeletion",
      "kms:CreateAlias",
      "kms:DeleteAlias",
      "kms:DescribeKey",
      "kms:EnableKey",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:ListAliases",
      "kms:ListGrants",
      "kms:ListKeyPolicies",
      "kms:ListResourceTags",
      "kms:PutKeyPolicy",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:UpdateAlias",
      "kms:UpdateKeyDescription",
    ]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = distinct(concat(var.key_admin_role_arns, [var.break_glass_role_arn]))
    }
  }

  statement {
    sid       = "AccountReadOnlyMetadata"
    actions   = ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetKeyRotationStatus", "kms:ListGrants", "kms:ListKeyPolicies", "kms:ListResourceTags"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = [local.account_root]
    }
  }

  statement {
    sid       = "CosignerGetPublicKey"
    actions   = ["kms:GetPublicKey"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = [var.signer_role_arn]
    }

    dynamic "condition" {
      for_each = local.restrict_to_vpc_endpoints ? [1] : []

      content {
        test     = "StringEquals"
        variable = "aws:SourceVpce"
        values   = var.allowed_kms_vpc_endpoint_ids
      }
    }
  }

  statement {
    sid       = "CosignerSignDigest"
    actions   = ["kms:Sign"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = [var.signer_role_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:SigningAlgorithm"
      values   = ["ECDSA_SHA_256"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:MessageType"
      values   = ["DIGEST"]
    }

    dynamic "condition" {
      for_each = local.restrict_to_vpc_endpoints ? [1] : []

      content {
        test     = "StringEquals"
        variable = "aws:SourceVpce"
        values   = var.allowed_kms_vpc_endpoint_ids
      }
    }
  }

  statement {
    sid       = "BreakGlassDisableOrDeleteWithMfa"
    actions   = ["kms:DisableKey", "kms:ScheduleKeyDeletion"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = [var.break_glass_role_arn]
    }

    condition {
      test     = "Bool"
      variable = "aws:MultiFactorAuthPresent"
      values   = ["true"]
    }
  }

  # ---- Explicit denies: these hold even if someone later adds an over-broad allow. ----

  statement {
    sid       = "DenySigningByAnyoneButCosigner"
    effect    = "Deny"
    actions   = ["kms:Sign", "kms:GetPublicKey"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [var.signer_role_arn]
    }
  }

  dynamic "statement" {
    for_each = local.restrict_to_vpc_endpoints ? [1] : []

    content {
      sid       = "DenySigningOutsideCosignerVpc"
      effect    = "Deny"
      actions   = ["kms:Sign", "kms:GetPublicKey"]
      resources = ["*"]

      principals {
        type        = "AWS"
        identifiers = ["*"]
      }

      condition {
        test     = "StringNotEquals"
        variable = "aws:SourceVpce"
        values   = var.allowed_kms_vpc_endpoint_ids
      }
    }
  }

  statement {
    sid       = "DenyDisableOrDeleteExceptBreakGlass"
    effect    = "Deny"
    actions   = ["kms:DisableKey", "kms:ScheduleKeyDeletion"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [var.break_glass_role_arn]
    }
  }

  statement {
    sid       = "DenyDisableOrDeleteWithoutMfa"
    effect    = "Deny"
    actions   = ["kms:DisableKey", "kms:ScheduleKeyDeletion"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "BoolIfExists"
      variable = "aws:MultiFactorAuthPresent"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyGrantsAndReplication"
    effect    = "Deny"
    actions   = ["kms:CreateGrant", "kms:ReplicateKey"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
  }
}

resource "aws_kms_key" "this" {
  description              = "${var.name} secp256k1 co-signing key (non-exportable; usable only by the co-signer task)"
  customer_master_key_spec = "ECC_SECG_P256K1"
  key_usage                = "SIGN_VERIFY"
  multi_region             = false
  deletion_window_in_days  = var.deletion_window_in_days
  # Automatic rotation is not supported for asymmetric keys; rotation is a runbook (new key,
  # register the new co-signer address on-chain via owner-signed module update, retire old).
  enable_key_rotation                = false
  bypass_policy_lockout_safety_check = false
  policy                             = data.aws_iam_policy_document.key.json

  tags = merge(var.tags, { data_classification = "signing-key" })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name}-signing"
  target_key_id = aws_kms_key.this.key_id
}

# --- Key-usage trail -----------------------------------------------------------------------------------

# Uses CloudWatch Logs' default encryption: KMS omits plaintexts, signatures and responses of
# cryptographic operations from CloudTrail records, so the log holds metadata only.
resource "aws_cloudwatch_log_group" "trail" {
  name              = "/cloudtrail/${var.trail_name}"
  retention_in_days = var.trail_cloudwatch_retention_days

  tags = var.tags
}

data "aws_iam_policy_document" "trail_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }
}

resource "aws_iam_role" "trail" {
  name               = "${var.name}-key-trail"
  description        = "Lets CloudTrail deliver the co-signer key-usage trail to CloudWatch Logs"
  assume_role_policy = data.aws_iam_policy_document.trail_assume.json

  tags = var.tags
}

data "aws_iam_policy_document" "trail_logs" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.trail.arn}:log-stream:*"]
  }
}

resource "aws_iam_role_policy" "trail" {
  name   = "deliver-to-cloudwatch-logs"
  role   = aws_iam_role.trail.id
  policy = data.aws_iam_policy_document.trail_logs.json
}

resource "aws_cloudtrail" "this" {
  name                          = var.trail_name
  s3_bucket_name                = var.trail_s3_bucket_name
  s3_key_prefix                 = var.trail_s3_key_prefix
  kms_key_id                    = var.trail_kms_key_arn
  enable_log_file_validation    = true
  include_global_service_events = true
  is_multi_region_trail         = true
  cloud_watch_logs_group_arn    = "${aws_cloudwatch_log_group.trail.arn}:*"
  cloud_watch_logs_role_arn     = aws_iam_role.trail.arn

  advanced_event_selector {
    name = "All management events including every AWS KMS call"

    field_selector {
      field  = "eventCategory"
      equals = ["Management"]
    }
  }

  dynamic "advanced_event_selector" {
    for_each = length(var.s3_data_event_arn_prefixes) > 0 ? [1] : []

    content {
      name = "Audit record object-level access"

      field_selector {
        field  = "eventCategory"
        equals = ["Data"]
      }

      field_selector {
        field  = "resources.type"
        equals = ["AWS::S3::Object"]
      }

      field_selector {
        field       = "resources.ARN"
        starts_with = var.s3_data_event_arn_prefixes
      }
    }
  }

  tags = var.tags

  depends_on = [aws_iam_role_policy.trail]
}

# --- Real-time alarms on key misuse --------------------------------------------------------------------

locals {
  metric_namespace = "AgentBank/Security"

  # Matches events for this key however the caller referenced it: resources[] carries the key
  # ARN for most KMS events, requestParameters.keyId whatever identifier the caller passed.
  # Keep patterns under CloudWatch's 1024-character limit (the largest is ~650 characters).
  key_match = join(" || ", concat(
    ["($.resources[0].ARN = \"${aws_kms_key.this.arn}\")"],
    [for id in [aws_kms_key.this.arn, aws_kms_key.this.key_id, aws_kms_alias.this.name] : "($.requestParameters.keyId = \"${id}\")"],
  ))

  key_alarm_filters = {
    CosignerKeyUnexpectedUse = {
      description = "kms:Sign or kms:GetPublicKey on the co-signer key by anyone other than the co-signer task role (successful or denied)."
      pattern     = "{ ($.eventSource = \"kms.amazonaws.com\") && (($.eventName = \"Sign\") || ($.eventName = \"GetPublicKey\")) && (${local.key_match}) && (($.userIdentity.type != \"AssumedRole\") || ($.userIdentity.sessionContext.sessionIssuer.arn != \"${var.signer_role_arn}\")) }"
    }
    CosignerKeyPolicyOrStateChange = {
      description = "Key policy, enablement, deletion schedule or grant change attempted on the co-signer key."
      pattern     = "{ ($.eventSource = \"kms.amazonaws.com\") && (($.eventName = \"PutKeyPolicy\") || ($.eventName = \"DisableKey\") || ($.eventName = \"EnableKey\") || ($.eventName = \"ScheduleKeyDeletion\") || ($.eventName = \"CancelKeyDeletion\") || ($.eventName = \"CreateGrant\")) && (${local.key_match}) }"
    }
    CosignerKeyAccessDenied = {
      description = "A call against the co-signer key was denied (probing or misconfiguration)."
      pattern     = "{ ($.eventSource = \"kms.amazonaws.com\") && ($.errorCode = \"AccessDenied*\") && (${local.key_match}) }"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "key" {
  for_each = local.key_alarm_filters

  name           = "${var.name}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.trail.name
  pattern        = each.value.pattern

  metric_transformation {
    namespace     = local.metric_namespace
    name          = each.key
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "key" {
  for_each = local.key_alarm_filters

  alarm_name          = "${var.name}-${each.key}"
  alarm_description   = each.value.description
  namespace           = local.metric_namespace
  metric_name         = each.key
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_sns_topic_arn]
  ok_actions          = [var.alarm_sns_topic_arn]

  tags = var.tags

  depends_on = [aws_cloudwatch_log_metric_filter.key]
}
