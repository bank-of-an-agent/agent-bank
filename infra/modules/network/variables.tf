variable "name" {
  description = "Name prefix for every resource in this VPC, e.g. \"agent-bank-sandbox-cosigner\"."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,40}$", var.name))
    error_message = "name must be 3-41 characters of lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "cidr_block" {
  description = "IPv4 CIDR of the VPC (/16 to /18). Subnets are carved deterministically: private subnets use the first three /20s (for a /16), public subnets 10.x.48-50.0/24 and database subnets 10.x.64-66.0/24."
  type        = string

  validation {
    condition     = can(cidrnetmask(var.cidr_block)) && can(regex("/(16|17|18)$", var.cidr_block))
    error_message = "cidr_block must be a valid IPv4 CIDR with a prefix length of /16, /17 or /18."
  }
}

variable "availability_zone_ids" {
  description = "Explicit AZ IDs such as [\"use1-az1\", \"use1-az2\"]. AZ IDs (not names) are used because AZ names map to different physical zones in each AWS account, and a PrivateLink consumer can only use zones where the provider's NLB lives. Null selects the first az_count zone IDs in sorted order, which lines up across accounts."
  type        = list(string)
  default     = null

  validation {
    condition     = var.availability_zone_ids == null ? true : (length(var.availability_zone_ids) >= 2 && length(var.availability_zone_ids) <= 3)
    error_message = "availability_zone_ids must contain 2 or 3 zone IDs."
  }
}

variable "az_count" {
  description = "Number of availability zones to span when availability_zone_ids is null."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "create_public_subnets" {
  description = "Create public subnets and an internet gateway. Set false for accounts that must have no path to the internet (the co-signer)."
  type        = bool
  default     = true
}

variable "enable_nat_gateway" {
  description = "Create NAT gateway(s) so private subnets can reach the internet (chain RPC, bundler, vendor APIs). Requires create_public_subnets."
  type        = bool
  default     = true
}

variable "single_nat_gateway" {
  description = "Use one shared NAT gateway instead of one per AZ. Cheaper; acceptable for sandbox, not for production."
  type        = bool
  default     = false
}

variable "interface_endpoint_services" {
  description = "AWS services to expose through interface VPC endpoints with private DNS, as the suffix after com.amazonaws.<region>. (e.g. \"kms\", \"secretsmanager\", \"ecr.api\", \"ecr.dkr\", \"logs\"). These let workloads reach AWS APIs without internet egress."
  type        = list(string)
  default     = ["ecr.api", "ecr.dkr", "kms", "logs", "secretsmanager"]

  validation {
    condition     = alltrue([for s in var.interface_endpoint_services : can(regex("^[a-z0-9][a-z0-9.-]*$", s))])
    error_message = "Each interface endpoint service must be a service suffix such as \"ecr.api\" or \"secretsmanager\"."
  }
}

variable "enable_s3_gateway_endpoint" {
  description = "Create an S3 gateway endpoint on the private and database route tables (free; needed for ECR image layers without NAT)."
  type        = bool
  default     = true
}

variable "s3_gateway_endpoint_policy" {
  description = "Optional JSON policy for the S3 gateway endpoint. Null allows full access. The co-signer account passes a policy that only allows the ECR layer bucket and its audit bucket (data exfiltration control)."
  type        = string
  default     = null
}

variable "enable_flow_logs" {
  description = "Send VPC flow logs (ALL traffic) to an encrypted CloudWatch Logs group."
  type        = bool
  default     = true
}

variable "flow_logs_retention_days" {
  description = "Retention for the VPC flow log group."
  type        = number
  default     = 90

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.flow_logs_retention_days)
    error_message = "flow_logs_retention_days must be a retention period supported by CloudWatch Logs."
  }
}

variable "tags" {
  description = "Extra tags for every resource (the provider's default_tags already carry project, environment and account_role)."
  type        = map(string)
  default     = {}
}
