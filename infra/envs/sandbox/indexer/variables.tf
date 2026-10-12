# --- Account & provider ---------------------------------------------------------------------------

variable "account_id" {
  description = "AWS account ID of the sandbox INDEXER account (the provider refuses any other account)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
  }
}

variable "region" {
  description = "AWS region. Must match the API account (PrivateLink is regional)."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$", var.region))
    error_message = "region must be an AWS region name such as us-east-1."
  }
}

variable "deploy_role_name" {
  description = "IAM role in this account that OpenTofu assumes (pre-created by the account baseline)."
  type        = string
  default     = "agent-bank-deployer"
}

variable "assume_role_external_id" {
  description = "Optional external ID required by the deploy role's trust policy."
  type        = string
  default     = null
}

# --- Chain guard --------------------------------------------------------------------------------------

variable "chain_id" {
  description = "EVM chain ID the indexer follows. Only Base Sepolia (84532) is allowed."
  type        = number
  default     = 84532

  validation {
    condition     = var.chain_id != 8453
    error_message = "Base mainnet (chain ID 8453) is forbidden. Mainnet stays locked until the Phase 5 gate (legal sign-off, closed audits, verified exit tool, human present) and is never configured from these sandbox modules."
  }

  validation {
    condition     = var.chain_id == 84532
    error_message = "Only Base Sepolia (chain ID 84532) is supported."
  }
}

# --- Workload ---------------------------------------------------------------------------------------

variable "image_tag" {
  description = "Indexer image tag (immutable git SHA) or sha256 digest in this account's ECR repository."
  type        = string
}

variable "indexer_cpu" {
  description = "Fargate CPU units for the indexer task."
  type        = number
  default     = 1024
}

variable "indexer_memory" {
  description = "Fargate memory (MiB) for the indexer task."
  type        = number
  default     = 2048
}

variable "indexer_enabled" {
  description = "Run the indexer (exactly one task: it is a single writer). Set false only while bootstrapping before the first image push."
  type        = bool
  default     = true
}

variable "indexer_lag_threshold_blocks" {
  description = "Alarm when the indexer is more than this many blocks behind the head for 3 minutes (the reconciliation window defaults to 20 blocks)."
  type        = number
  default     = 20
}

# --- Networking ---------------------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR of the indexer VPC."
  type        = string
  default     = "10.30.0.0/16"
}

variable "availability_zone_ids" {
  description = "AZ IDs for subnets. Must overlap the API account's AZ IDs. Null picks the first two IDs in sorted order (same rule as the other roots)."
  type        = list(string)
  default     = null
}

variable "single_nat_gateway" {
  description = "One shared NAT gateway (cheaper, sandbox) instead of one per AZ. NAT is needed to reach the Base Sepolia RPC provider."
  type        = bool
  default     = true
}

variable "api_internal_endpoint_service_name" {
  description = "Output internal_api_endpoint_service_name of envs/sandbox/api. Null skips the endpoint (the indexer then cannot post reconciliation results)."
  type        = string
  default     = null

  validation {
    condition     = var.api_internal_endpoint_service_name == null ? true : can(regex("^com\\.amazonaws\\.vpce\\.[a-z0-9-]+\\.vpce-svc-[0-9a-f]+$", var.api_internal_endpoint_service_name))
    error_message = "api_internal_endpoint_service_name must look like com.amazonaws.vpce.<region>.vpce-svc-<id>."
  }
}

variable "api_internal_endpoint_port" {
  description = "Output internal_api_endpoint_port of envs/sandbox/api."
  type        = number
  default     = 8080
}

# --- Indexer database ----------------------------------------------------------------------------------------

variable "db_instance_class" {
  description = "RDS instance class for the indexer's own PostgreSQL (indexed chain events and reconciliation state)."
  type        = string
  default     = "db.t4g.small"
}

variable "db_multi_az" {
  description = "Multi-AZ standby for the indexer database."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Automated backup / point-in-time-recovery window in days."
  type        = number
  default     = 7
}

variable "db_deletion_protection" {
  description = "Deletion protection for the indexer database."
  type        = bool
  default     = true
}

# --- Operations ------------------------------------------------------------------------------------------

variable "alarm_email_addresses" {
  description = "Emails subscribed to this account's alarm topic."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "Retention for application, database and VPC flow logs."
  type        = number
  default     = 90
}
