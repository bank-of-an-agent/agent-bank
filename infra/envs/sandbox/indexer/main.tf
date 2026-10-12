# Sandbox INDEXER account: chain indexer + reconciliation worker.
#
#   * Reads Base Sepolia through an RPC provider (egress via NAT) into its own PostgreSQL.
#   * Reconciles chain movements against the ledger through the API's /internal/* routes,
#     reached only via the API account's PrivateLink service: no ledger credentials ever leave
#     the API account.
#   * Owns the reconciliation alarm (UnmatchedEvents > 0) and the indexer-lag alarm, so a
#     compromise of the API account cannot silence them.
#   * Exactly one task: the indexer is a single writer, deployments stop the old task first.

data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  environment  = "sandbox"
  account_role = "indexer"
  prefix       = "agent-bank-${local.environment}"
  name         = "${local.prefix}-${local.account_role}"

  partition = data.aws_partition.current.partition
  region    = data.aws_region.current.region

  deployer_role_arn = "arn:aws:iam::${var.account_id}:role/${var.deploy_role_name}"

  default_tags = {
    project      = "agent-bank"
    environment  = local.environment
    account_role = local.account_role
    chain_id     = tostring(var.chain_id)
    managed_by   = "opentofu"
  }

  container_port       = 8082
  internal_api_enabled = var.api_internal_endpoint_service_name != null
  task_count           = var.indexer_enabled ? 1 : 0
}

# --- Network & cluster -----------------------------------------------------------------------------------

module "network" {
  source = "../../../modules/network"

  name                        = local.name
  cidr_block                  = var.vpc_cidr
  availability_zone_ids       = var.availability_zone_ids
  az_count                    = 2
  create_public_subnets       = true
  enable_nat_gateway          = true
  single_nat_gateway          = var.single_nat_gateway
  interface_endpoint_services = ["ecr.api", "ecr.dkr", "logs", "secretsmanager"]
  flow_logs_retention_days    = var.log_retention_days
}

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# --- Secrets & database ------------------------------------------------------------------------------------

module "secrets" {
  source = "../../../modules/secrets"

  name_prefix             = "${local.prefix}/${local.account_role}"
  recovery_window_in_days = 7

  secrets = {
    DATABASE_URL = {
      description = "Indexer PostgreSQL URL (indexed chain events, reconciliation state) for the application role, sslmode=verify-full."
    }
    CHAIN_RPC_URL = {
      description = "Base Sepolia JSON-RPC URL (embeds the RPC provider's API key)."
    }
    INTERNAL_API_SHARED_SECRET = {
      description = "HMAC key for calls to the API's /internal/* routes. Must equal agent-bank-sandbox/api/INTERNAL_API_SHARED_SECRET."
    }
  }

  readers = {
    DATABASE_URL               = [module.indexer.execution_role_arn]
    CHAIN_RPC_URL              = [module.indexer.execution_role_arn]
    INTERNAL_API_SHARED_SECRET = [module.indexer.execution_role_arn]
  }
}

module "indexer_db" {
  source = "../../../modules/postgres"

  identifier                 = "${local.prefix}-indexer"
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.database_subnet_ids
  allowed_security_group_ids = [module.indexer.security_group_id]
  instance_class             = var.db_instance_class
  multi_az                   = var.db_multi_az
  backup_retention_period    = var.db_backup_retention_days
  deletion_protection        = var.db_deletion_protection
  log_retention_days         = var.log_retention_days
}

# --- Consumer: indexer -> API /internal/* ---------------------------------------------------------------------

resource "aws_security_group" "api_internal_endpoint" {
  count = local.internal_api_enabled ? 1 : 0

  name        = "${local.name}-api-internal-endpoint"
  description = "Interface endpoint to the API's internal PrivateLink service; only the indexer may use it"
  vpc_id      = module.network.vpc_id

  tags = { Name = "${local.name}-api-internal-endpoint" }
}

resource "aws_vpc_security_group_ingress_rule" "api_internal_endpoint_from_indexer" {
  count = local.internal_api_enabled ? 1 : 0

  security_group_id            = aws_security_group.api_internal_endpoint[0].id
  description                  = "Reconciliation calls from the indexer tasks"
  ip_protocol                  = "tcp"
  from_port                    = var.api_internal_endpoint_port
  to_port                      = var.api_internal_endpoint_port
  referenced_security_group_id = module.indexer.security_group_id
}

resource "aws_vpc_endpoint" "api_internal" {
  count = local.internal_api_enabled ? 1 : 0

  vpc_id              = module.network.vpc_id
  service_name        = var.api_internal_endpoint_service_name
  vpc_endpoint_type   = "Interface"
  subnet_ids          = module.network.private_subnet_ids
  security_group_ids  = [aws_security_group.api_internal_endpoint[0].id]
  private_dns_enabled = false

  tags = { Name = "${local.name}-to-api-internal" }
}

# --- Indexer service ----------------------------------------------------------------------------------------------

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

resource "aws_iam_role" "indexer_task" {
  name               = "${local.name}-task"
  description        = "Indexer application: publish indexer and reconciliation metrics"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "indexer_task" {
  statement {
    sid       = "PublishMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["AgentBank/Indexer", "AgentBank/Reconciliation"]
    }
  }
}

resource "aws_iam_role_policy" "indexer_task" {
  name   = "indexer"
  role   = aws_iam_role.indexer_task.id
  policy = data.aws_iam_policy_document.indexer_task.json
}

module "indexer" {
  source = "../../../modules/ecs-service"

  name           = local.name
  container_name = "indexer"
  cluster_arn    = aws_ecs_cluster.this.arn
  vpc_id         = module.network.vpc_id
  subnet_ids     = module.network.private_subnet_ids

  image_tag      = var.image_tag
  container_port = local.container_port
  cpu            = var.indexer_cpu
  memory         = var.indexer_memory
  task_role_arn  = aws_iam_role.indexer_task.arn

  # Single writer: never two tasks at once (old task stops before the new one starts).
  min_capacity                       = local.task_count
  max_capacity                       = local.task_count
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  health_check_start_period          = 120

  environment = merge(
    {
      NODE_ENV                  = "production"
      APP_ENV                   = local.environment
      CHAIN_ID                  = tostring(var.chain_id)
      AWS_REGION                = local.region
      LOG_LEVEL                 = "info"
      RECONCILIATION_WINDOW     = "20"
      METRICS_NAMESPACE         = "AgentBank/Indexer"
      RECONCILIATION_METRICS_NS = "AgentBank/Reconciliation"
    },
    local.internal_api_enabled ? {
      API_INTERNAL_URL = "http://${aws_vpc_endpoint.api_internal[0].dns_entry[0].dns_name}:${var.api_internal_endpoint_port}"
    } : {},
  )

  secrets             = module.secrets.secret_arns
  secret_kms_key_arns = [module.secrets.kms_key_arn]

  log_retention_days = var.log_retention_days
}

# --- Monitoring ------------------------------------------------------------------------------------------------

module "observability" {
  source = "../../../modules/observability"

  name                  = local.name
  alarm_email_addresses = var.alarm_email_addresses

  reconciliation_alarm_enabled = true
  indexer_lag_threshold_blocks = var.indexer_lag_threshold_blocks

  ecs_services = {
    indexer = {
      cluster_name      = aws_ecs_cluster.this.name
      service_name      = module.indexer.service_name
      min_running_tasks = 1
    }
  }

  rds_instance_identifiers = [module.indexer_db.instance_identifier]
}
