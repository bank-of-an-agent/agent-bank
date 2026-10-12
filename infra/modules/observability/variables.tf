variable "name" {
  description = "Prefix for the SNS topic, alarms and dashboard, e.g. \"agent-bank-sandbox-api\"."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,60}$", var.name))
    error_message = "name must be 3-61 lowercase letters, digits or hyphens."
  }
}

variable "alarm_email_addresses" {
  description = "Email addresses subscribed to the alarm topic (each must confirm the subscription). Wire PagerDuty/Opsgenie to the topic for paging."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for email in var.alarm_email_addresses : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", email))])
    error_message = "alarm_email_addresses must be valid email addresses."
  }
}

variable "custom_metric_dimensions" {
  description = "Dimensions the applications attach to their custom AgentBank/* metrics. Empty (the default) means the metrics are published without dimensions; each environment lives in its own account."
  type        = map(string)
  default     = {}
}

variable "api_alb" {
  description = "Public ALB in front of the REST API: alarm when target 5xx responses exceed error_rate_threshold_percent of requests."
  type = object({
    load_balancer_arn_suffix     = string
    target_group_arn_suffix      = string
    error_rate_threshold_percent = optional(number, 1)
  })
  default = null
}

variable "cosigner" {
  description = "Co-signer SLO alarms: p99 decision latency (AgentBank/Cosigner DecisionLatency, ms), availability from Requests/Errors, and healthy targets behind the PrivateLink NLB."
  type = object({
    nlb_arn_suffix              = string
    target_group_arn_suffix     = string
    p99_latency_threshold_ms    = optional(number, 300)
    availability_target_percent = optional(number, 99.9)
    min_healthy_targets         = optional(number, 1)
  })
  default = null
}

variable "reconciliation_alarm_enabled" {
  description = "Alarm on any AgentBank/Reconciliation UnmatchedEvents > 0 (an on-chain movement with no ledger entry)."
  type        = bool
  default     = false
}

variable "indexer_lag_threshold_blocks" {
  description = "Alarm when AgentBank/Indexer BlockLag (blocks behind chain head) stays above this for 3 minutes, or stops reporting. Null disables it. The default reconciliation window is 20 blocks."
  type        = number
  default     = null
}

variable "webhook_dead_letter_alarm_enabled" {
  description = "Alarm on any AgentBank/Webhooks DeadLetteredDeliveries > 0 (a webhook exhausted its 72h of retries)."
  type        = bool
  default     = false
}

variable "ecs_services" {
  description = "ECS services to watch (Container Insights RunningTaskCount below min_running_tasks, or missing)."
  type = map(object({
    cluster_name      = string
    service_name      = string
    min_running_tasks = optional(number, 1)
  }))
  default = {}
}

variable "rds_instance_identifiers" {
  description = "RDS instances to watch (CPU and free storage)."
  type        = list(string)
  default     = []
}

variable "rds_free_storage_threshold_bytes" {
  description = "Alarm when an RDS instance has less free storage than this."
  type        = number
  default     = 5368709120
}

variable "create_dashboard" {
  description = "Create a CloudWatch dashboard with alarm status and the key metrics."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Extra tags for every resource."
  type        = map(string)
  default     = {}
}
