# The three public services and their least-privilege task roles. Images come from per-service
# ECR repositories in this account, built from the root Dockerfile with --build-arg APP=<name>.

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:ecs:${local.region}:${var.account_id}:*"]
    }
  }
}

# --- REST API ------------------------------------------------------------------------------------------------

# Name must stay in sync with api_audit_writer_role_names in envs/sandbox/cosigner.
resource "aws_iam_role" "api_task" {
  name               = "${local.prefix}-api-task"
  description        = "REST API application: publish metrics, append audit records to the co-signer account's archive"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "api_task" {
  statement {
    sid       = "PublishMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["AgentBank/Api", "AgentBank/Webhooks"]
    }
  }

  dynamic "statement" {
    for_each = local.audit_export_enabled && var.audit_log_kms_key_arn != null ? [1] : []

    content {
      sid       = "AppendAuditRecords"
      actions   = ["s3:PutObject"]
      resources = ["${var.audit_log_bucket_arn}/api/*"]
    }
  }

  dynamic "statement" {
    for_each = local.audit_export_enabled && var.audit_log_kms_key_arn != null ? [1] : []

    content {
      sid       = "EncryptAuditRecords"
      actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
      resources = [var.audit_log_kms_key_arn]

      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["s3.${local.region}.amazonaws.com"]
      }
    }
  }
}

resource "aws_iam_role_policy" "api_task" {
  name   = "api"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.api_task.json

  lifecycle {
    precondition {
      condition     = (var.audit_log_bucket_arn == null) == (var.audit_log_kms_key_arn == null)
      error_message = "Set audit_log_bucket_arn and audit_log_kms_key_arn together (both are outputs of envs/sandbox/cosigner)."
    }
  }
}

module "api" {
  source = "../../../modules/ecs-service"

  name           = "${local.prefix}-api"
  container_name = "api"
  cluster_arn    = aws_ecs_cluster.this.arn
  vpc_id         = module.network.vpc_id
  subnet_ids     = module.network.private_subnet_ids

  image_tag      = var.image_tag
  container_port = local.ports.api
  cpu            = var.service_capacity["api"].cpu
  memory         = var.service_capacity["api"].memory
  min_capacity   = var.service_capacity["api"].min
  max_capacity   = var.service_capacity["api"].max
  task_role_arn  = aws_iam_role.api_task.arn

  environment = merge(
    local.common_environment,
    {
      AWS_REGION        = local.region
      PUBLIC_BASE_URL   = "https://${var.api_hostname}"
      METRICS_NAMESPACE = "AgentBank/Api"
      # Exactly one proxy hop (the ALB): rate limits key on the address the ALB saw, not on a
      # client-supplied X-Forwarded-For entry.
      TRUST_PROXY = "1"
    },
    # Absent COSIGNER_URL = no co-signer = every payment is refused (fail closed).
    local.cosigner_enabled ? {
      COSIGNER_URL = "${var.cosigner_url_scheme}://${aws_vpc_endpoint.cosigner[0].dns_entry[0].dns_name}:${var.cosigner_endpoint_port}"
    } : {},
    local.audit_export_enabled ? {
      AUDIT_LOG_BUCKET = element(split(":::", var.audit_log_bucket_arn), 1)
      AUDIT_LOG_PREFIX = "api/"
    } : {},
  )

  secrets             = local.service_secret_arns["api"]
  secret_kms_key_arns = [module.secrets.kms_key_arn]

  alb = {
    listener_arn      = aws_lb_listener.https.arn
    security_group_id = aws_security_group.alb.id
    priority          = 100
    host_headers      = [var.api_hostname]
  }

  # The indexer account reaches /internal/* through its own PrivateLink endpoint service.
  additional_target_groups = local.internal_api_enabled ? [{
    target_group_arn         = module.internal_api_endpoint_service[0].target_group_arn
    source_security_group_id = module.internal_api_endpoint_service[0].security_group_id
  }] : []

  log_retention_days = var.log_retention_days
}

# --- x402 facilitator ---------------------------------------------------------------------------------------

resource "aws_iam_role" "facilitator_task" {
  name               = "${local.prefix}-facilitator-task"
  description        = "x402 facilitator application: publish metrics"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "facilitator_task" {
  statement {
    sid       = "PublishMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["AgentBank/Facilitator"]
    }
  }
}

resource "aws_iam_role_policy" "facilitator_task" {
  name   = "facilitator"
  role   = aws_iam_role.facilitator_task.id
  policy = data.aws_iam_policy_document.facilitator_task.json
}

module "facilitator" {
  source = "../../../modules/ecs-service"

  name           = "${local.prefix}-facilitator"
  container_name = "facilitator"
  cluster_arn    = aws_ecs_cluster.this.arn
  vpc_id         = module.network.vpc_id
  subnet_ids     = module.network.private_subnet_ids

  image_tag      = var.image_tag
  container_port = local.ports.facilitator
  cpu            = var.service_capacity["facilitator"].cpu
  memory         = var.service_capacity["facilitator"].memory
  min_capacity   = var.service_capacity["facilitator"].min
  max_capacity   = var.service_capacity["facilitator"].max
  task_role_arn  = aws_iam_role.facilitator_task.arn

  environment = merge(local.common_environment, {
    AWS_REGION              = local.region
    PUBLIC_BASE_URL         = "https://${var.facilitator_hostname}"
    METRICS_NAMESPACE       = "AgentBank/Facilitator"
    X402_NETWORK            = "base-sepolia"
    TRUST_PROXY             = "1"
    FACILITATOR_PAYEE_MODE  = "registered"
    RELAYER_MIN_BALANCE_WEI = "1000000000000000"
  })

  secrets             = local.service_secret_arns["facilitator"]
  secret_kms_key_arns = [module.secrets.kms_key_arn]

  alb = {
    listener_arn      = aws_lb_listener.https.arn
    security_group_id = aws_security_group.alb.id
    priority          = 110
    host_headers      = [var.facilitator_hostname]
  }

  log_retention_days = var.log_retention_days
}

# --- Principal console (Next.js) ---------------------------------------------------------------------------

module "console" {
  source = "../../../modules/ecs-service"

  name           = "${local.prefix}-console"
  container_name = "console"
  cluster_arn    = aws_ecs_cluster.this.arn
  vpc_id         = module.network.vpc_id
  subnet_ids     = module.network.private_subnet_ids

  image_tag      = var.image_tag
  container_port = local.ports.console
  cpu            = var.service_capacity["console"].cpu
  memory         = var.service_capacity["console"].memory
  min_capacity   = var.service_capacity["console"].min
  max_capacity   = var.service_capacity["console"].max

  # No task role: the console talks to the public API like any other client and holds no AWS
  # credentials at all.
  task_role_arn = null

  environment = merge(local.common_environment, {
    HOSTNAME        = "0.0.0.0"
    API_BASE_URL    = "https://${var.api_hostname}"
    PUBLIC_BASE_URL = "https://${var.console_hostname}"
  })

  secrets             = local.service_secret_arns["console"]
  secret_kms_key_arns = [module.secrets.kms_key_arn]

  # Both paths are declared as VOLUMEs in the console image.
  writable_paths = ["/tmp", "/app/.next/cache"]

  alb = {
    listener_arn      = aws_lb_listener.https.arn
    security_group_id = aws_security_group.alb.id
    priority          = 120
    host_headers      = [var.console_hostname]
  }

  log_retention_days = var.log_retention_days
}
