variable "name_prefix" {
  description = "Path prefix for secret names, e.g. \"agent-bank/sandbox/api\" produces \"agent-bank/sandbox/api/DATABASE_URL\"."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9/_-]*[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix must contain lowercase letters, digits, '/', '_' and '-' only."
  }
}

variable "secrets" {
  description = "Secret containers to create, keyed by environment variable name (e.g. DATABASE_URL). Only the containers are managed here: values are written out-of-band (`aws secretsmanager put-secret-value`) so they never enter code, plans or state."
  type = map(object({
    description = string
  }))

  validation {
    condition     = alltrue([for name in keys(var.secrets) : can(regex("^[A-Z][A-Z0-9_]*$", name))])
    error_message = "Secret keys must be UPPER_SNAKE_CASE environment variable names."
  }
}

variable "readers" {
  description = "Secret key -> IAM role ARNs (wildcards allowed) that may call GetSecretValue. Every other principal, including administrators, is denied by a resource policy, so operators can write values but cannot read them back. Keys without an entry get no resource policy."
  type        = map(list(string))
  default     = {}

  validation {
    condition     = alltrue(flatten([for arns in values(var.readers) : [for arn in arns : can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/.+$", arn))]]))
    error_message = "readers must contain IAM role ARNs."
  }
}

variable "recovery_window_in_days" {
  description = "Days a deleted secret can be restored. 0 deletes immediately (never use 0 outside throwaway environments)."
  type        = number
  default     = 30

  validation {
    condition     = var.recovery_window_in_days == 0 || (var.recovery_window_in_days >= 7 && var.recovery_window_in_days <= 30)
    error_message = "recovery_window_in_days must be 0 or between 7 and 30."
  }
}

variable "tags" {
  description = "Extra tags for every resource."
  type        = map(string)
  default     = {}
}
