# Sandbox CO-SIGNER account: the policy engine + KMS co-signer, isolated from the public API.
#
#   * VPC with private and database subnets only: no internet gateway, no NAT. AWS APIs are
#     reached through interface endpoints; S3 only for ECR layers and this account's audit prefix.
#   * secp256k1 signing key in KMS (non-exportable), usable only by the co-signer task role,
#     only through this VPC's KMS endpoint. No human principal can sign.
#   * The co-signer is reachable from exactly one place: an interface endpoint in the API
#     account, through a PrivateLink endpoint service that allowlists that account and requires
#     explicit acceptance.
#   * Audit archive (S3 Object Lock, compliance mode) and a key-usage CloudTrail trail.
#   * It fails closed: if it is down, the API cannot obtain co-signatures and payments stop.

data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  environment  = "sandbox"
  account_role = "cosigner"
  prefix       = "agent-bank-${local.environment}"
  name         = "${local.prefix}-${local.account_role}"

  partition = data.aws_partition.current.partition
  region    = data.aws_region.current.region

  # Built from variables (not data sources) because the provider configuration needs it.
  deployer_role_arn    = "arn:aws:iam::${var.account_id}:role/${var.deploy_role_name}"
  break_glass_role_arn = "arn:aws:iam::${var.account_id}:role/${var.break_glass_role_name}"

  default_tags = {
    project      = "agent-bank"
    environment  = local.environment
    account_role = local.account_role
    chain_id     = tostring(var.chain_id)
    managed_by   = "opentofu"
  }

  container_port = 8081

  audit_bucket_name     = "${local.prefix}-audit-${var.account_id}"
  api_audit_writer_arns = [for role in var.api_audit_writer_role_names : "arn:${local.partition}:iam::${var.api_account_id}:role/${role}"]

  # The trail ARN is derived from its name so the audit bucket policy can authorise it before
  # the trail exists (CloudTrail checks bucket access when the trail is created).
  key_trail_name = "${local.name}-key-usage"
  key_trail_arn  = "arn:${local.partition}:cloudtrail:${local.region}:${var.account_id}:trail/${local.key_trail_name}"
}

# --- Network ------------------------------------------------------------------------------------------

module "network" {
  source = "../../../modules/network"

  name                        = local.name
  cidr_block                  = var.vpc_cidr
  availability_zone_ids       = var.availability_zone_ids
  az_count                    = 2
  create_public_subnets       = false
  enable_nat_gateway          = false
  interface_endpoint_services = ["ecr.api", "ecr.dkr", "kms", "logs", "secretsmanager"]
  s3_gateway_endpoint_policy  = data.aws_iam_policy_document.s3_endpoint.json
  flow_logs_retention_days    = var.log_retention_days
}

# The only S3 access possible from inside the co-signer VPC: ECR image layers and the
# co-signer's own audit prefix. Anything else (e.g. exfiltration to an attacker's bucket) is
# denied at the endpoint, and there is no other route out.
data "aws_iam_policy_document" "s3_endpoint" {
  statement {
    sid       = "EcrImageLayers"
    actions   = ["s3:GetObject"]
    resources = ["arn:${local.partition}:s3:::prod-${local.region}-starport-layer-bucket/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }

  statement {
    sid       = "CosignerAuditRecords"
    actions   = ["s3:PutObject"]
    resources = ["arn:${local.partition}:s3:::${local.audit_bucket_name}/cosigner/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# --- Co-signer task role ---------------------------------------------------------------------------

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

resource "aws_iam_role" "cosigner_task" {
  name               = "${local.name}-task"
  description        = "Co-signer application: sign digests with the co-signing key, append audit records"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "cosigner_task" {
  statement {
    sid       = "SignWithCosignerKey"
    actions   = ["kms:Sign", "kms:GetPublicKey"]
    resources = [module.cosigner_kms.key_arn]
  }

  statement {
    sid       = "AppendAuditRecords"
    actions   = ["s3:PutObject"]
    resources = ["${module.audit_log.bucket_arn}/cosigner/*"]
  }

  statement {
    sid       = "EncryptAuditRecords"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [module.audit_log.kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${local.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "cosigner_task" {
  name   = "cosigner"
  role   = aws_iam_role.cosigner_task.id
  policy = data.aws_iam_policy_document.cosigner_task.json
}

# --- Signing key, audit archive, secrets ---------------------------------------------------------------

module "cosigner_kms" {
  source = "../../../modules/cosigner-kms"

  name                         = local.name
  signer_role_arn              = aws_iam_role.cosigner_task.arn
  key_admin_role_arns          = [local.deployer_role_arn]
  break_glass_role_arn         = local.break_glass_role_arn
  allowed_kms_vpc_endpoint_ids = [module.network.interface_endpoint_ids["kms"]]

  trail_name                 = local.key_trail_name
  trail_s3_bucket_name       = module.audit_log.bucket_name
  trail_kms_key_arn          = module.audit_log.kms_key_arn
  s3_data_event_arn_prefixes = ["${module.audit_log.bucket_arn}/cosigner/", "${module.audit_log.bucket_arn}/api/"]
  alarm_sns_topic_arn        = module.observability.sns_topic_arn
}

module "audit_log" {
  source = "../../../modules/audit-log"

  bucket_name    = local.audit_bucket_name
  retention_days = var.audit_log_retention_days

  writers = merge(
    { cosigner = [aws_iam_role.cosigner_task.arn] },
    length(local.api_audit_writer_arns) > 0 ? { api = local.api_audit_writer_arns } : {},
  )

  reader_role_arns      = [for role in var.audit_reader_role_names : "arn:${local.partition}:iam::${var.account_id}:role/${role}"]
  cloudtrail_trail_arns = [local.key_trail_arn]
}

module "secrets" {
  source = "../../../modules/secrets"

  name_prefix             = "${local.prefix}/${local.account_role}"
  recovery_window_in_days = 7

  secrets = {
    COSIGNER_SHARED_SECRET = {
      description = "HMAC key that authenticates every request from the API. Must equal agent-bank-sandbox/api/COSIGNER_SHARED_SECRET in the API account."
    }
  }

  readers = {
    COSIGNER_SHARED_SECRET = [module.cosigner.execution_role_arn]
  }
}

# --- PrivateLink exposure to the API account ------------------------------------------------------------

module "cosigner_endpoint_service" {
  source = "../../../modules/privatelink-service"

  name                   = local.name
  vpc_id                 = module.network.vpc_id
  vpc_cidr_block         = module.network.vpc_cidr_block
  subnet_ids             = module.network.private_subnet_ids
  target_port            = local.container_port
  certificate_arn        = var.cosigner_tls_certificate_arn
  allowed_principal_arns = ["arn:${local.partition}:iam::${var.api_account_id}:root"]
  acceptance_required    = true
  accepted_endpoint_ids  = var.accepted_api_endpoint_ids
}

# --- Co-signer service -----------------------------------------------------------------------------------

module "cosigner" {
  source = "../../../modules/ecs-service"

  name           = local.name
  container_name = "cosigner"
  cluster_arn    = aws_ecs_cluster.this.arn
  vpc_id         = module.network.vpc_id
  subnet_ids     = module.network.private_subnet_ids

  image_tag      = var.image_tag
  container_port = local.container_port
  cpu            = var.cosigner_cpu
  memory         = var.cosigner_memory
  min_capacity   = var.cosigner_min_count
  max_capacity   = var.cosigner_max_count
  task_role_arn  = aws_iam_role.cosigner_task.arn

  environment = {
    NODE_ENV          = "production"
    APP_ENV           = local.environment
    CHAIN_ID          = tostring(var.chain_id)
    AWS_REGION        = local.region
    KMS_KEY_ID        = module.cosigner_kms.key_arn
    AUDIT_LOG_BUCKET  = module.audit_log.bucket_name
    AUDIT_LOG_PREFIX  = "cosigner/"
    METRICS_NAMESPACE = "AgentBank/Cosigner"
    LOG_LEVEL         = "info"
  }

  secrets = {
    COSIGNER_SHARED_SECRET = module.secrets.secret_arns["COSIGNER_SHARED_SECRET"]
  }
  secret_kms_key_arns = [module.secrets.kms_key_arn]

  additional_target_groups = [{
    target_group_arn         = module.cosigner_endpoint_service.target_group_arn
    source_security_group_id = module.cosigner_endpoint_service.security_group_id
  }]

  # No internet route exists; egress is further limited to AWS endpoints only.
  egress_rules = [
    {
      description                  = "AWS APIs (KMS, Secrets Manager, ECR, Logs) via interface endpoints"
      from_port                    = 443
      to_port                      = 443
      referenced_security_group_id = module.network.interface_endpoint_security_group_id
    },
    {
      description    = "ECR image layers and audit records via the S3 gateway endpoint"
      from_port      = 443
      to_port        = 443
      prefix_list_id = module.network.s3_prefix_list_id
    },
  ]

  log_retention_days = var.log_retention_days
}

# --- Monitoring ------------------------------------------------------------------------------------------

module "observability" {
  source = "../../../modules/observability"

  name                  = local.name
  alarm_email_addresses = var.alarm_email_addresses

  cosigner = {
    nlb_arn_suffix              = module.cosigner_endpoint_service.nlb_arn_suffix
    target_group_arn_suffix     = module.cosigner_endpoint_service.target_group_arn_suffix
    p99_latency_threshold_ms    = 300
    availability_target_percent = 99.9
    min_healthy_targets         = max(var.cosigner_min_count, 1)
  }

  ecs_services = {
    cosigner = {
      cluster_name      = aws_ecs_cluster.this.name
      service_name      = module.cosigner.service_name
      min_running_tasks = max(var.cosigner_min_count, 1)
    }
  }
}
