variable "identifier" {
  description = "RDS instance identifier, e.g. \"agent-bank-sandbox-ledger\"."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,61}[a-z0-9]$", var.identifier)) && !strcontains(var.identifier, "--")
    error_message = "identifier must be 2-63 lowercase letters, digits or single hyphens, starting with a letter."
  }
}

variable "vpc_id" {
  description = "VPC of the database."
  type        = string
}

variable "subnet_ids" {
  description = "Isolated database subnets (at least two AZs)."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "RDS needs subnets in at least two AZs."
  }
}

variable "allowed_security_group_ids" {
  description = "Security groups (e.g. ECS service task groups) allowed to connect on the Postgres port."
  type        = list(string)
  default     = []
}

variable "engine_version" {
  description = "PostgreSQL engine version. A major version (\"16\") tracks the latest minor with auto minor upgrades."
  type        = string
  default     = "16"

  validation {
    condition     = can(regex("^16(\\.[0-9]+)?$", var.engine_version))
    error_message = "The ledger is specified on PostgreSQL 16; engine_version must be \"16\" or \"16.x\"."
  }
}

variable "instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "allocated_storage" {
  description = "Initial gp3 storage in GiB."
  type        = number
  default     = 20
}

variable "max_allocated_storage" {
  description = "Storage autoscaling ceiling in GiB."
  type        = number
  default     = 100
}

variable "multi_az" {
  description = "Run a synchronous standby in a second AZ. Required for production."
  type        = bool
  default     = false
}

variable "db_name" {
  description = "Initial database name."
  type        = string
  default     = "agentbank"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{0,62}$", var.db_name))
    error_message = "db_name must start with a letter and contain only lowercase letters, digits and underscores."
  }
}

variable "master_username" {
  description = "Master (administrative) user. Its password is generated and rotated by RDS in Secrets Manager; applications should use their own least-privilege roles."
  type        = string
  default     = "agentbank_admin"
}

variable "iam_database_authentication_enabled" {
  description = "Allow IAM database authentication (rds-db:connect) in addition to passwords."
  type        = bool
  default     = false
}

variable "backup_retention_period" {
  description = "Days of automated backups; point-in-time recovery is possible anywhere inside this window."
  type        = number
  default     = 14

  validation {
    condition     = var.backup_retention_period >= 7 && var.backup_retention_period <= 35
    error_message = "backup_retention_period must be between 7 and 35 days (a ledger must always be restorable)."
  }
}

variable "backup_window" {
  description = "Daily backup window (UTC)."
  type        = string
  default     = "03:00-04:00"
}

variable "maintenance_window" {
  description = "Weekly maintenance window (UTC); must not overlap the backup window."
  type        = string
  default     = "sun:04:30-sun:05:30"
}

variable "deletion_protection" {
  description = "Block deletion of the instance."
  type        = bool
  default     = true
}

variable "apply_immediately" {
  description = "Apply modifications immediately instead of in the maintenance window."
  type        = bool
  default     = false
}

variable "performance_insights_retention_period" {
  description = "Performance Insights retention in days (7 is free)."
  type        = number
  default     = 7
}

variable "monitoring_interval" {
  description = "Enhanced Monitoring interval in seconds (0 disables it)."
  type        = number
  default     = 60

  validation {
    condition     = contains([0, 1, 5, 10, 15, 30, 60], var.monitoring_interval)
    error_message = "monitoring_interval must be one of 0, 1, 5, 10, 15, 30, 60."
  }
}

variable "log_min_duration_statement_ms" {
  description = "Log statements slower than this many milliseconds (-1 disables). Statement text may contain data, so keep this high."
  type        = number
  default     = 1000
}

variable "log_retention_days" {
  description = "Retention of the exported PostgreSQL logs in CloudWatch."
  type        = number
  default     = 90
}

variable "tags" {
  description = "Extra tags for every resource."
  type        = map(string)
  default     = {}
}
