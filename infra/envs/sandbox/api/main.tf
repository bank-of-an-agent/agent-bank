# Sandbox API account: public REST API, x402 facilitator, principal console and the ledger
# (PostgreSQL 16). Everything internet-facing lives here, and nothing here can sign:
#
#   * Public ALB (HTTPS only, WAF) -> api / facilitator / console on Fargate in private subnets.
#   * Ledger Postgres in isolated database subnets, reachable only from api and facilitator.
#   * The co-signer is reached only through an interface endpoint to the co-signer account's
#     PrivateLink service (privatelink.tf). There is no peering or shared routing.
#   * /internal/* is blocked at the ALB and offered to the indexer account only, through a
#     PrivateLink service of its own (privatelink.tf).
#   * Approvals and admin actions are appended to the WORM audit archive in the co-signer account.

data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  environment  = "sandbox"
  account_role = "api"
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

  cosigner_enabled     = var.cosigner_endpoint_service_name != null
  audit_export_enabled = var.audit_log_bucket_arn != null
  internal_api_enabled = var.indexer_account_id != null

  ports = {
    api         = 8080
    facilitator = 8083
    console     = 3000
  }

  common_environment = {
    NODE_ENV  = "production"
    APP_ENV   = local.environment
    CHAIN_ID  = tostring(var.chain_id)
    LOG_LEVEL = "info"
  }

  # --- Secrets: containers only, values are set out-of-band (see infra/README.md). ---
  secret_descriptions = {
    DATABASE_URL               = "Ledger PostgreSQL URL for the application role (sslmode=verify-full). Never the RDS master credentials."
    COSIGNER_SHARED_SECRET     = "HMAC key for requests to the co-signer. Must equal agent-bank-sandbox/cosigner/COSIGNER_SHARED_SECRET in the co-signer account."
    PIMLICO_API_KEY            = "Pimlico bundler/paymaster API key (Base Sepolia project)."
    WEBHOOK_SIGNING_KEY        = "HMAC key used to sign outbound webhooks."
    FACILITATOR_RELAYER_KEY    = "Private key of the x402 facilitator's settlement relayer. TESTNET ONLY: a Base Sepolia gas wallet that never holds real value."
    SCREENING_API_KEY          = "Wallet-risk and sanctions screening provider API key."
    KYB_API_KEY                = "KYC/KYB vendor API key."
    CHAIN_RPC_URL              = "Base Sepolia JSON-RPC URL (embeds the RPC provider's API key)."
    INTERNAL_API_SHARED_SECRET = "HMAC key authenticating the indexer's /internal/* calls. Must equal agent-bank-sandbox/indexer/INTERNAL_API_SHARED_SECRET."
    CONSOLE_SESSION_SECRET     = "Key the console uses to sign and encrypt session cookies."
  }

  # Least privilege: each service's execution role can read only the secrets listed here.
  service_secrets = {
    api         = ["DATABASE_URL", "COSIGNER_SHARED_SECRET", "PIMLICO_API_KEY", "WEBHOOK_SIGNING_KEY", "SCREENING_API_KEY", "KYB_API_KEY", "CHAIN_RPC_URL", "INTERNAL_API_SHARED_SECRET"]
    facilitator = ["DATABASE_URL", "FACILITATOR_RELAYER_KEY", "SCREENING_API_KEY", "CHAIN_RPC_URL"]
    console     = ["CONSOLE_SESSION_SECRET"]
  }

  service_secret_arns = {
    for service, names in local.service_secrets : service => { for name in names : name => module.secrets.secret_arns[name] }
  }

  execution_role_arns = {
    api         = module.api.execution_role_arn
    facilitator = module.facilitator.execution_role_arn
    console     = module.console.execution_role_arn
  }

  secret_readers = {
    for secret in keys(local.secret_descriptions) : secret => [
      for service, names in local.service_secrets : local.execution_role_arns[service] if contains(names, secret)
    ]
  }
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

# --- Secrets ------------------------------------------------------------------------------------------------

module "secrets" {
  source = "../../../modules/secrets"

  name_prefix             = "${local.prefix}/${local.account_role}"
  recovery_window_in_days = 7
  secrets                 = { for name, description in local.secret_descriptions : name => { description = description } }
  readers                 = local.secret_readers
}

# --- Ledger database ------------------------------------------------------------------------------------------

module "ledger_db" {
  source = "../../../modules/postgres"

  identifier                          = "${local.prefix}-ledger"
  vpc_id                              = module.network.vpc_id
  subnet_ids                          = module.network.database_subnet_ids
  allowed_security_group_ids          = [module.api.security_group_id, module.facilitator.security_group_id]
  instance_class                      = var.db_instance_class
  multi_az                            = var.db_multi_az
  backup_retention_period             = var.db_backup_retention_days
  deletion_protection                 = var.db_deletion_protection
  iam_database_authentication_enabled = var.db_iam_auth_enabled
  log_retention_days                  = var.log_retention_days
}

# --- Monitoring -------------------------------------------------------------------------------------------------

module "observability" {
  source = "../../../modules/observability"

  name                  = local.name
  alarm_email_addresses = var.alarm_email_addresses

  api_alb = {
    load_balancer_arn_suffix     = aws_lb.public.arn_suffix
    target_group_arn_suffix      = module.api.target_group_arn_suffix
    error_rate_threshold_percent = 1
  }

  webhook_dead_letter_alarm_enabled = true

  ecs_services = {
    for service, module_outputs in {
      api         = module.api.service_name
      facilitator = module.facilitator.service_name
      console     = module.console.service_name
    } :
    service => {
      cluster_name      = aws_ecs_cluster.this.name
      service_name      = module_outputs
      min_running_tasks = max(var.service_capacity[service].min, 1)
    }
  }

  rds_instance_identifiers = [module.ledger_db.instance_identifier]
}
