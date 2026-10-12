variable "bucket_name" {
  description = "Globally unique bucket name, e.g. \"agent-bank-sandbox-audit-<account-id>\"."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name)) && !strcontains(var.bucket_name, "..")
    error_message = "bucket_name must be a valid S3 bucket name."
  }
}

variable "retention_days" {
  description = "Default Object Lock retention in COMPLIANCE mode. Nobody, including the account root user, can delete or overwrite an object version (or shorten its retention) until it expires, and the bucket cannot be deleted while such objects exist. Size this with counsel (e.g. 2555 days = 7 years for production)."
  type        = number

  validation {
    condition     = var.retention_days >= 1 && var.retention_days <= 36500
    error_message = "retention_days must be between 1 and 36500."
  }
}

variable "writers" {
  description = "Key prefix -> IAM role ARNs (wildcards allowed, other accounts allowed) that may PutObject under \"<prefix>/\". Writers can never read, overwrite or delete records. Example: { cosigner = [\"arn:aws:iam::111122223333:role/agent-bank-sandbox-cosigner-task\"] }."
  type        = map(list(string))
  default     = {}

  validation {
    condition = alltrue(flatten([
      for prefix, arns in var.writers : concat(
        [can(regex("^[a-z0-9][a-z0-9_-]*$", prefix))],
        [for arn in arns : can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/.+$", arn))],
      )
    ]))
    error_message = "writers keys must be simple prefixes (lowercase, digits, '-', '_') and values IAM role ARNs."
  }
}

variable "reader_role_arns" {
  description = "IAM role ARNs (auditors, investigation tooling) allowed to list and read every record."
  type        = list(string)
  default     = []
}

variable "cloudtrail_trail_arns" {
  description = "CloudTrail trail ARNs allowed to deliver logs into this bucket under cloudtrail_key_prefix (WORM storage for key-usage trails)."
  type        = list(string)
  default     = []
}

variable "cloudtrail_key_prefix" {
  description = "Key prefix used by CloudTrail deliveries."
  type        = string
  default     = "cloudtrail"
}

variable "archive_after_days" {
  description = "Transition objects to S3 Glacier Instant Retrieval after this many days (retention still applies)."
  type        = number
  default     = 90

  validation {
    condition     = var.archive_after_days >= 30
    error_message = "archive_after_days must be at least 30 (S3 minimum for this transition)."
  }
}

variable "tags" {
  description = "Extra tags for every resource."
  type        = map(string)
  default     = {}
}
