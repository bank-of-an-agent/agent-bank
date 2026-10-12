variable "name" {
  description = "Base name for the key alias, trail and alarms, e.g. \"agent-bank-sandbox-cosigner\"."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,40}$", var.name))
    error_message = "name must be 3-41 characters of lowercase letters, digits and hyphens."
  }
}

variable "signer_role_arn" {
  description = "IAM role of the co-signer ECS task. It is the ONLY principal that may call kms:Sign and kms:GetPublicKey on the key."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/.+$", var.signer_role_arn)) && !strcontains(var.signer_role_arn, "*")
    error_message = "signer_role_arn must be a single, concrete IAM role ARN (no wildcards)."
  }
}

variable "key_admin_role_arns" {
  description = "Roles that administer the key (key policy, tags, aliases) but can never use it to sign, disable it or delete it. Must include the role Terraform runs as, or KMS rejects the policy (lockout safety check)."
  type        = list(string)

  validation {
    condition     = length(var.key_admin_role_arns) > 0 && alltrue([for arn in var.key_admin_role_arns : can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/.+$", arn))])
    error_message = "key_admin_role_arns must be a non-empty list of IAM role ARNs."
  }
}

variable "break_glass_role_arn" {
  description = "The only role that may disable the key or schedule its deletion, and only from an MFA-authenticated session. It can never sign."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/.+$", var.break_glass_role_arn)) && !strcontains(var.break_glass_role_arn, "*")
    error_message = "break_glass_role_arn must be a single, concrete IAM role ARN."
  }
}

variable "allowed_kms_vpc_endpoint_ids" {
  description = "KMS interface VPC endpoint IDs the co-signer reaches KMS through. When set, Sign/GetPublicKey from anywhere else is denied, so exfiltrated task credentials are useless outside the co-signer VPC."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for id in var.allowed_kms_vpc_endpoint_ids : can(regex("^vpce-[0-9a-f]+$", id))])
    error_message = "allowed_kms_vpc_endpoint_ids must contain VPC endpoint IDs."
  }
}

variable "deletion_window_in_days" {
  description = "Waiting period if break-glass schedules deletion (cancellable during the window)."
  type        = number
  default     = 30

  validation {
    condition     = var.deletion_window_in_days >= 7 && var.deletion_window_in_days <= 30
    error_message = "deletion_window_in_days must be between 7 and 30."
  }
}

# --- Key-usage audit trail --------------------------------------------------------------------

variable "trail_name" {
  description = "Name of the dedicated CloudTrail trail that records every call against the key. Callers compute the trail ARN from it to authorise delivery into the audit bucket."
  type        = string
}

variable "trail_s3_bucket_name" {
  description = "S3 bucket (Object Lock, e.g. the audit-log module) that receives the trail. Its policy must allow this trail."
  type        = string
}

variable "trail_s3_key_prefix" {
  description = "Key prefix for trail deliveries."
  type        = string
  default     = "cloudtrail"
}

variable "trail_kms_key_arn" {
  description = "KMS key CloudTrail uses to encrypt log files (the audit bucket's CMK)."
  type        = string
}

variable "trail_cloudwatch_retention_days" {
  description = "Retention of the trail's CloudWatch Logs copy used for real-time metric filters."
  type        = number
  default     = 365
}

variable "s3_data_event_arn_prefixes" {
  description = "Optional S3 object ARN prefixes (e.g. \"arn:aws:s3:::bucket/cosigner/\") whose object-level data events are also recorded. Never include the trail's own prefix."
  type        = list(string)
  default     = []
}

variable "alarm_sns_topic_arn" {
  description = "SNS topic for key-misuse alarms (unexpected signer, key policy or state changes)."
  type        = string
}

variable "tags" {
  description = "Extra tags for every resource."
  type        = map(string)
  default     = {}
}
