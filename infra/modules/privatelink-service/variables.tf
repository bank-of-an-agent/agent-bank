variable "name" {
  description = "Name for the NLB, target group and endpoint service, e.g. \"agent-bank-sandbox-cosigner\". Max 28 characters (NLB/target group name limit is 32 including suffixes)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,26}[a-z0-9]$", var.name))
    error_message = "name must be 3-28 characters of lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen."
  }
}

variable "vpc_id" {
  description = "VPC that hosts the NLB and its targets."
  type        = string
}

variable "vpc_cidr_block" {
  description = "VPC CIDR; the NLB security group may only send traffic (forwarded requests and health checks) into this range."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnets for the internal NLB, one per AZ. Consumers can only create endpoints in AZs covered here."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "Use at least two subnets in different AZs."
  }
}

variable "target_port" {
  description = "Container port of the ECS tasks registered in the target group."
  type        = number

  validation {
    condition     = var.target_port >= 1 && var.target_port <= 65535
    error_message = "target_port must be a valid TCP port."
  }
}

variable "listener_port" {
  description = "Port consumers connect to. Null uses 443 when certificate_arn is set and target_port otherwise."
  type        = number
  default     = null
}

variable "certificate_arn" {
  description = "Optional ACM certificate ARN. When set the listener terminates TLS (TLS 1.2+); otherwise it is a TCP pass-through and the application must authenticate every request (the co-signer verifies an HMAC with COSIGNER_SHARED_SECRET)."
  type        = string
  default     = null
}

variable "ssl_policy" {
  description = "TLS policy for the listener when certificate_arn is set."
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

variable "health_check_path" {
  description = "HTTP path the NLB uses to health-check targets."
  type        = string
  default     = "/healthz"
}

variable "allowed_principal_arns" {
  description = "IAM principals (account roots or roles in the consumer account) allowed to create interface endpoints to this service, e.g. [\"arn:aws:iam::111122223333:root\"]."
  type        = list(string)

  validation {
    condition     = length(var.allowed_principal_arns) > 0 && alltrue([for arn in var.allowed_principal_arns : can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:(root|role/.+)$", arn))])
    error_message = "allowed_principal_arns must be a non-empty list of IAM account-root or role ARNs."
  }
}

variable "acceptance_required" {
  description = "Require this account to explicitly accept each endpoint connection (see accepted_endpoint_ids). Defence in depth on top of allowed_principal_arns."
  type        = bool
  default     = true
}

variable "accepted_endpoint_ids" {
  description = "Consumer VPC endpoint IDs (vpce-...) to accept. Populated after the consumer account creates its endpoint."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for id in var.accepted_endpoint_ids : can(regex("^vpce-[0-9a-f]+$", id))])
    error_message = "accepted_endpoint_ids must contain VPC endpoint IDs such as vpce-0123456789abcdef0."
  }
}

variable "deletion_protection" {
  description = "Enable NLB deletion protection."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Extra tags for every resource."
  type        = map(string)
  default     = {}
}
