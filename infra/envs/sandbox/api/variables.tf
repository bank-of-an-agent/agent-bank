# --- Account & provider ---------------------------------------------------------------------------

variable "account_id" {
  description = "AWS account ID of the sandbox API account (the provider refuses any other account)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
  }
}

variable "region" {
  description = "AWS region. Must match the co-signer and indexer accounts (PrivateLink is regional)."
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
  description = "EVM chain ID for every service in this account. Only Base Sepolia (84532) is allowed."
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

# --- Workloads ----------------------------------------------------------------------------------------

variable "image_tag" {
  description = "Image tag (immutable git SHA) or sha256 digest deployed for api, facilitator and console, each from its own ECR repository in this account."
  type        = string
}

variable "service_capacity" {
  description = "Fargate size and task-count bounds per service. min is also the initial task count; use 0 only while bootstrapping before images are pushed."
  type = map(object({
    cpu    = number
    memory = number
    min    = number
    max    = number
  }))
  default = {
    api         = { cpu = 512, memory = 1024, min = 2, max = 6 }
    facilitator = { cpu = 512, memory = 1024, min = 2, max = 4 }
    console     = { cpu = 512, memory = 1024, min = 1, max = 2 }
  }

  validation {
    condition     = length(setsubtract(["api", "facilitator", "console"], keys(var.service_capacity))) == 0
    error_message = "service_capacity must define api, facilitator and console."
  }
}

# --- Public edge ---------------------------------------------------------------------------------------

variable "api_hostname" {
  description = "Public hostname of the REST API, e.g. api.sandbox.example.com."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.api_hostname))
    error_message = "api_hostname must be a lowercase DNS name."
  }
}

variable "facilitator_hostname" {
  description = "Public hostname of the x402 facilitator (verify/settle), e.g. x402.sandbox.example.com."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.facilitator_hostname))
    error_message = "facilitator_hostname must be a lowercase DNS name."
  }
}

variable "console_hostname" {
  description = "Public hostname of the principal console, e.g. console.sandbox.example.com."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.console_hostname))
    error_message = "console_hostname must be a lowercase DNS name."
  }
}

variable "alb_certificate_arn" {
  description = "ACM certificate (in this account and region) covering the three hostnames. The ALB only serves HTTPS; port 80 redirects."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:acm:[a-z0-9-]+:[0-9]{12}:certificate/.+$", var.alb_certificate_arn))
    error_message = "alb_certificate_arn must be an ACM certificate ARN."
  }
}

variable "route53_zone_id" {
  description = "Optional public hosted zone ID; when set, alias records for the three hostnames are created."
  type        = string
  default     = null
}

variable "enable_waf" {
  description = "Attach an AWS WAF web ACL (AWS managed common, known-bad-inputs and IP-reputation rules plus a per-IP rate limit) to the ALB."
  type        = bool
  default     = true
}

variable "waf_rate_limit_per_5_minutes" {
  description = "Requests per source IP per 5 minutes before WAF blocks it."
  type        = number
  default     = 2000

  validation {
    condition     = var.waf_rate_limit_per_5_minutes >= 10
    error_message = "waf_rate_limit_per_5_minutes must be at least 10 (AWS minimum)."
  }
}

variable "alb_deletion_protection" {
  description = "Enable deletion protection on the public ALB."
  type        = bool
  default     = true
}

# --- Networking ---------------------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR of the API VPC."
  type        = string
  default     = "10.10.0.0/16"
}

variable "availability_zone_ids" {
  description = "AZ IDs for subnets. Must overlap the co-signer account's AZ IDs. Null picks the first two IDs in sorted order (same rule as the co-signer root)."
  type        = list(string)
  default     = null
}

variable "single_nat_gateway" {
  description = "One shared NAT gateway (cheaper, sandbox) instead of one per AZ."
  type        = bool
  default     = true
}

# --- Cross-account wiring (outputs of the other roots) ---------------------------------------------------

variable "cosigner_endpoint_service_name" {
  description = "Output cosigner_endpoint_service_name of envs/sandbox/cosigner. Null skips the endpoint: the API then has no co-signer and must refuse every payment (fail closed)."
  type        = string
  default     = null

  validation {
    condition     = var.cosigner_endpoint_service_name == null ? true : can(regex("^com\\.amazonaws\\.vpce\\.[a-z0-9-]+\\.vpce-svc-[0-9a-f]+$", var.cosigner_endpoint_service_name))
    error_message = "cosigner_endpoint_service_name must look like com.amazonaws.vpce.<region>.vpce-svc-<id>."
  }
}

variable "cosigner_endpoint_port" {
  description = "Output cosigner_endpoint_port of envs/sandbox/cosigner."
  type        = number
  default     = 8081
}

variable "cosigner_url_scheme" {
  description = "http for the TCP pass-through listener (requests HMAC-authenticated), https once the co-signer NLB terminates TLS."
  type        = string
  default     = "http"

  validation {
    condition     = contains(["http", "https"], var.cosigner_url_scheme)
    error_message = "cosigner_url_scheme must be http or https."
  }
}

variable "audit_log_bucket_arn" {
  description = "Output audit_log_bucket_arn of envs/sandbox/cosigner (Object Lock archive the API appends approvals/admin actions to). Null disables audit export permissions."
  type        = string
  default     = null
}

variable "audit_log_kms_key_arn" {
  description = "Output audit_log_kms_key_arn of envs/sandbox/cosigner. Required together with audit_log_bucket_arn."
  type        = string
  default     = null
}

variable "indexer_account_id" {
  description = "AWS account ID of the sandbox indexer account. When set, the API's /internal/* routes are exposed to that account only, through a PrivateLink endpoint service."
  type        = string
  default     = null

  validation {
    condition     = var.indexer_account_id == null ? true : can(regex("^[0-9]{12}$", var.indexer_account_id))
    error_message = "indexer_account_id must be a 12-digit AWS account ID."
  }
}

variable "accepted_indexer_endpoint_ids" {
  description = "VPC endpoint IDs created by the indexer account (output api_internal_vpc_endpoint_id of envs/sandbox/indexer) to accept. Second-pass input."
  type        = list(string)
  default     = []
}

# --- Ledger database -------------------------------------------------------------------------------------

variable "db_instance_class" {
  description = "RDS instance class for the ledger database."
  type        = string
  default     = "db.t4g.medium"
}

variable "db_multi_az" {
  description = "Multi-AZ standby for the ledger database (always true in production)."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Automated backup / point-in-time-recovery window in days."
  type        = number
  default     = 14
}

variable "db_deletion_protection" {
  description = "Deletion protection for the ledger database."
  type        = bool
  default     = true
}

variable "db_iam_auth_enabled" {
  description = "Enable IAM database authentication on the ledger database."
  type        = bool
  default     = false
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
