variable "name" {
  description = "Service name used for the ECS service, task family, log group, ECR repository and IAM role, e.g. \"agent-bank-sandbox-api\"."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.name))
    error_message = "name must be 3-32 characters of lowercase letters, digits and hyphens (target group names are limited to 32 characters)."
  }
}

variable "container_name" {
  description = "Container name inside the task definition (short, e.g. \"api\")."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,30}$", var.container_name))
    error_message = "container_name must be 1-31 lowercase letters, digits or hyphens."
  }
}

variable "cluster_arn" {
  description = "ARN of the ECS cluster to run in."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:cluster/.+$", var.cluster_arn))
    error_message = "cluster_arn must be an ECS cluster ARN."
  }
}

variable "vpc_id" {
  description = "VPC of the service."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnets for the tasks (no public IPs are ever assigned)."
  type        = list(string)
}

# --- Image ---------------------------------------------------------------------------------

variable "image_tag" {
  description = "Image tag (an immutable git SHA or release tag) or digest (\"sha256:...\"). \"latest\" is rejected: every deploy must name an exact build."
  type        = string

  validation {
    condition     = can(regex("^(sha256:[a-f0-9]{64}|[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$", var.image_tag)) && var.image_tag != "latest"
    error_message = "image_tag must be a valid tag or sha256 digest and must not be \"latest\"."
  }
}

variable "image_repository_url" {
  description = "Use an existing ECR repository (<account>.dkr.ecr.<region>.amazonaws.com/<name>). Null creates a dedicated repository named after the service (immutable tags, scan on push)."
  type        = string
  default     = null

  validation {
    condition     = var.image_repository_url == null ? true : can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com(\\.cn)?/.+$", var.image_repository_url))
    error_message = "image_repository_url must be an ECR repository URL."
  }
}

# --- Task ----------------------------------------------------------------------------------

variable "container_port" {
  description = "Port the application listens on (also exported to the container as PORT)."
  type        = number
}

variable "cpu" {
  description = "Fargate task CPU units."
  type        = number
  default     = 512

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096, 8192, 16384], var.cpu)
    error_message = "cpu must be a Fargate CPU size: 256, 512, 1024, 2048, 4096, 8192 or 16384."
  }
}

variable "memory" {
  description = "Fargate task memory (MiB); must be a valid combination with cpu."
  type        = number
  default     = 1024
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64. Must match the architecture the image was built for."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
}

variable "environment" {
  description = "Non-secret environment variables. PORT and HEALTHCHECK_PATH are set by the module."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Environment variable name -> Secrets Manager secret ARN (optionally with a :json-key:: suffix). Values are injected by ECS at start; they never appear in the task definition or state."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for arn in values(var.secrets) : can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:.+$", arn))])
    error_message = "Every secrets value must be a Secrets Manager secret ARN."
  }
}

variable "secret_kms_key_arns" {
  description = "KMS keys that encrypt the referenced secrets; the execution role may decrypt with them only via Secrets Manager."
  type        = list(string)
  default     = []
}

variable "task_role_arn" {
  description = "Least-privilege IAM role for the application itself, created by the caller. Null runs the task with no AWS credentials at all."
  type        = string
  default     = null
}

variable "container_user" {
  description = "uid:gid the container runs as; enforced by ECS even if the image changes. 65532 is distroless' nonroot user."
  type        = string
  default     = "65532:65532"
}

variable "readonly_root_filesystem" {
  description = "Mount the container root filesystem read-only. Scratch space comes from writable_paths."
  type        = bool
  default     = true
}

variable "writable_paths" {
  description = "Container paths that get an ephemeral writable volume when the root filesystem is read-only (e.g. /tmp, /app/.next/cache)."
  type        = list(string)
  default     = ["/tmp"]
}

variable "health_check_path" {
  description = "HTTP path used by the container health check, the ALB target group and exported as HEALTHCHECK_PATH."
  type        = string
  default     = "/healthz"
}

variable "health_check_command" {
  description = "Container health check command. The default runs the probe baked into the image by the root Dockerfile."
  type        = list(string)
  default     = ["CMD", "/nodejs/bin/node", "/usr/local/lib/agentbank/healthcheck.cjs"]
}

variable "health_check_start_period" {
  description = "Seconds of grace before failed container health checks count."
  type        = number
  default     = 30
}

variable "stop_timeout" {
  description = "Seconds between SIGTERM and SIGKILL when a task stops (graceful drain)."
  type        = number
  default     = 30

  validation {
    condition     = var.stop_timeout >= 2 && var.stop_timeout <= 120
    error_message = "stop_timeout must be between 2 and 120 seconds."
  }
}

# --- Capacity ------------------------------------------------------------------------------

variable "min_capacity" {
  description = "Minimum running tasks (also the initial desired count). Application Auto Scaling enforces it, so raising it scales out on apply."
  type        = number
  default     = 2

  validation {
    condition     = var.min_capacity >= 0
    error_message = "min_capacity must be >= 0."
  }
}

variable "max_capacity" {
  description = "Maximum running tasks. Target-tracking scaling policies are created only when max_capacity > min_capacity."
  type        = number
  default     = 4
}

variable "cpu_target_utilization" {
  description = "Average CPU utilisation (%) that the target-tracking policy maintains."
  type        = number
  default     = 60
}

variable "memory_target_utilization" {
  description = "Average memory utilisation (%) that the target-tracking policy maintains."
  type        = number
  default     = 75
}

variable "deployment_minimum_healthy_percent" {
  description = "Lower bound of running tasks during a deployment, as a percentage of desired. Use 0 for singleton workers that must never run twice."
  type        = number
  default     = 100
}

variable "deployment_maximum_percent" {
  description = "Upper bound of running tasks during a deployment, as a percentage of desired. Use 100 for singleton workers."
  type        = number
  default     = 200
}

variable "health_check_grace_period_seconds" {
  description = "Seconds the scheduler ignores load balancer health checks after a task starts (only used when the service is behind a load balancer)."
  type        = number
  default     = 60
}

# --- Networking & load balancing -------------------------------------------------------------

variable "alb" {
  description = "Attach to an ALB listener: the module creates a target group and a listener rule matching host_headers and/or path_patterns."
  type = object({
    listener_arn      = string
    security_group_id = string
    priority          = number
    host_headers      = optional(list(string), [])
    path_patterns     = optional(list(string), [])
  })
  default = null
}

variable "additional_target_groups" {
  description = "Existing target groups (e.g. a PrivateLink NLB) to register the tasks with; source_security_group_id is allowed in on container_port."
  type = list(object({
    target_group_arn         = string
    source_security_group_id = string
  }))
  default = []
}

variable "ingress_security_group_ids" {
  description = "Other security groups allowed to reach the tasks on container_port (e.g. a VPC endpoint's security group)."
  type        = list(string)
  default     = []
}

variable "egress_rules" {
  description = "Security group egress rules for the tasks. The default allows all outbound IPv4 traffic; the co-signer narrows it to the VPC endpoints."
  type = list(object({
    description                  = string
    ip_protocol                  = optional(string, "tcp")
    from_port                    = optional(number)
    to_port                      = optional(number)
    cidr_ipv4                    = optional(string)
    prefix_list_id               = optional(string)
    referenced_security_group_id = optional(string)
  }))
  default = [{
    description = "All outbound IPv4"
    ip_protocol = "-1"
    cidr_ipv4   = "0.0.0.0/0"
  }]
}

# --- Logging ---------------------------------------------------------------------------------

variable "log_retention_days" {
  description = "Retention of the service's CloudWatch Logs group."
  type        = number
  default     = 90

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a retention period supported by CloudWatch Logs."
  }
}

variable "tags" {
  description = "Extra tags for every resource."
  type        = map(string)
  default     = {}
}
