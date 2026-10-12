# --- Account & provider ---------------------------------------------------------------------------

variable "account_id" {
  description = "AWS account ID of the sandbox CO-SIGNER account (the provider refuses any other account)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
  }
}

variable "region" {
  description = "AWS region. Must match the API account's region (PrivateLink is regional)."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$", var.region))
    error_message = "region must be an AWS region name such as us-east-1."
  }
}

variable "deploy_role_name" {
  description = "IAM role in this account that OpenTofu assumes (pre-created by the account baseline; assumable by CI only). It administers the signing key but can never sign with it."
  type        = string
  default     = "agent-bank-deployer"
}

variable "break_glass_role_name" {
  description = "Pre-existing IAM role (MFA-only, alarmed, used under the key-compromise runbook) that alone may disable or schedule deletion of the signing key."
  type        = string
  default     = "agent-bank-break-glass"
}

variable "assume_role_external_id" {
  description = "Optional external ID required by the deploy role's trust policy."
  type        = string
  default     = null
}

variable "api_account_id" {
  description = "AWS account ID of the sandbox API account: the only principal allowed to connect to the co-signer endpoint service and to append API audit records."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.api_account_id))
    error_message = "api_account_id must be a 12-digit AWS account ID."
  }
}

# --- Chain guard --------------------------------------------------------------------------------------

variable "chain_id" {
  description = "EVM chain ID the co-signer signs for. Only Base Sepolia (84532) is allowed."
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
  description = "Co-signer image tag (immutable git SHA) or sha256 digest in this account's ECR repository."
  type        = string
}

variable "cosigner_cpu" {
  description = "Fargate CPU units per co-signer task."
  type        = number
  default     = 512
}

variable "cosigner_memory" {
  description = "Fargate memory (MiB) per co-signer task."
  type        = number
  default     = 1024
}

variable "cosigner_min_count" {
  description = "Minimum running co-signer tasks (spread across AZs). Two or more for the 99.9% availability objective; 0 only while bootstrapping before the first image push."
  type        = number
  default     = 2
}

variable "cosigner_max_count" {
  description = "Maximum co-signer tasks under CPU/memory autoscaling."
  type        = number
  default     = 4
}

variable "cosigner_tls_certificate_arn" {
  description = "Optional ACM certificate (e.g. from ACM Private CA) to terminate TLS on the PrivateLink NLB. Without it the listener is TCP pass-through on 8081 and requests are authenticated with COSIGNER_SHARED_SECRET (HMAC). Required before production."
  type        = string
  default     = null
}

# --- Networking ---------------------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR of the co-signer VPC (no internet gateway, no NAT)."
  type        = string
  default     = "10.20.0.0/16"
}

variable "availability_zone_ids" {
  description = "AZ IDs for subnets (e.g. [\"use1-az1\", \"use1-az2\"]). Must be AZ IDs the API account also uses, or its endpoint cannot reach every NLB node. Null picks the first two IDs in sorted order, which matches the API root's default."
  type        = list(string)
  default     = null
}

variable "accepted_api_endpoint_ids" {
  description = "VPC endpoint IDs created by the API account (output cosigner_vpc_endpoint_id of envs/sandbox/api) to accept. Second-pass input; see infra/README.md."
  type        = list(string)
  default     = []
}

# --- Audit ---------------------------------------------------------------------------------------------

variable "api_audit_writer_role_names" {
  description = "Role names in the API account allowed to append records under api/ in the audit bucket. Must match the API root's task role name."
  type        = list(string)
  default     = ["agent-bank-sandbox-api-task"]
}

variable "audit_reader_role_names" {
  description = "Role names in this account (auditors, incident tooling) allowed to read the audit bucket."
  type        = list(string)
  default     = []
}

variable "audit_log_retention_days" {
  description = "Object Lock COMPLIANCE retention for audit records. Kept short in sandbox because nothing (not even the root user) can delete locked objects or the bucket before expiry. Production: set with counsel (e.g. 2555 days)."
  type        = number
  default     = 30
}

# --- Operations ------------------------------------------------------------------------------------------

variable "alarm_email_addresses" {
  description = "Emails subscribed to this account's alarm topic."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "Retention for application and VPC flow logs."
  type        = number
  default     = 90
}
