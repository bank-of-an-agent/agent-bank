# One Fargate service: ECR repository (optional), encrypted log group, execution role scoped to
# exactly the image, log group and secrets it needs, task definition, service, security group,
# optional ALB target group + listener rule, and Application Auto Scaling.
#
# Hard-coded on purpose:
#   * enable_execute_command = false: ECS Exec would give a human an interactive process next to
#     the task role's credentials (for the co-signer, that means kms:Sign). Use logs and metrics.
#   * assign_public_ip = false: tasks only ever run in private subnets.

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  region       = data.aws_region.current.region
  account_id   = data.aws_caller_identity.current.account_id
  partition    = data.aws_partition.current.partition
  cluster_name = element(split("/", var.cluster_arn), 1)

  create_repository = var.image_repository_url == null
  repository_url    = local.create_repository ? one(aws_ecr_repository.this[*].repository_url) : var.image_repository_url
  external_repo = local.create_repository ? null : regex(
    "^(?P<account>[0-9]{12})\\.dkr\\.ecr\\.(?P<region>[a-z0-9-]+)\\.amazonaws\\.com(?:\\.cn)?/(?P<name>.+)$",
    var.image_repository_url,
  )
  repository_arn = local.create_repository ? one(aws_ecr_repository.this[*].arn) : "arn:${local.partition}:ecr:${local.external_repo.region}:${local.external_repo.account}:repository/${local.external_repo.name}"
  image          = "${local.repository_url}${startswith(var.image_tag, "sha256:") ? "@" : ":"}${var.image_tag}"

  log_group_name = "/ecs/${var.name}"

  environment = merge(var.environment, {
    PORT             = tostring(var.container_port)
    HEALTHCHECK_PATH = var.health_check_path
  })

  # IAM needs the bare secret ARN (first 7 ARN fields), without any :json-key:stage:version suffix.
  secret_arns = distinct([for arn in values(var.secrets) : join(":", slice(split(":", arn), 0, 7))])

  writable_volumes = { for index, path in var.writable_paths : "scratch-${index}" => path }

  load_balanced       = var.alb != null || length(var.additional_target_groups) > 0
  autoscaling_enabled = var.max_capacity > var.min_capacity
}

# --- Image repository ---------------------------------------------------------------------------

resource "aws_ecr_repository" "this" {
  count = local.create_repository ? 1 : 0

  name                 = var.name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
  }

  tags = var.tags
}

resource "aws_ecr_lifecycle_policy" "this" {
  count = local.create_repository ? 1 : 0

  repository = aws_ecr_repository.this[0].name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 7 days"
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 7 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the 200 most recent images"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 200 }
        action       = { type = "expire" }
      },
    ]
  })
}

# --- Logs ------------------------------------------------------------------------------------

data "aws_iam_policy_document" "logs_kms" {
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  statement {
    sid       = "CloudWatchLogsUseForThisLogGroup"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${local.region}.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:${local.log_group_name}"]
    }
  }
}

resource "aws_kms_key" "logs" {
  description             = "${var.name} application logs"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.logs_kms.json

  tags = var.tags
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${var.name}-logs"
  target_key_id = aws_kms_key.logs.key_id
}

resource "aws_cloudwatch_log_group" "this" {
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn

  tags = var.tags
}

# --- Execution role (used by the ECS agent, not by the application) -----------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:ecs:${local.region}:${local.account_id}:*"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-exec"
  description        = "ECS execution role for ${var.name}: pull image, write logs, read its own secrets"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = var.tags
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid       = "EcrAuthorization"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "PullServiceImage"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [local.repository_arn]
  }

  statement {
    sid       = "WriteServiceLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }

  dynamic "statement" {
    for_each = length(local.secret_arns) > 0 ? [1] : []

    content {
      sid       = "ReadServiceSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.secret_arns
    }
  }

  dynamic "statement" {
    for_each = length(var.secret_kms_key_arns) > 0 ? [1] : []

    content {
      sid       = "DecryptSecretsViaSecretsManager"
      actions   = ["kms:Decrypt"]
      resources = var.secret_kms_key_arns

      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["secretsmanager.${local.region}.amazonaws.com"]
      }
    }
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "ecs-execution"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# --- Network ---------------------------------------------------------------------------------

resource "aws_security_group" "this" {
  name        = "${var.name}-tasks"
  description = "ECS tasks of ${var.name}"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, { Name = "${var.name}-tasks" })
}

resource "aws_vpc_security_group_ingress_rule" "from_alb" {
  count = var.alb != null ? 1 : 0

  security_group_id            = aws_security_group.this.id
  description                  = "From the ALB"
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
  referenced_security_group_id = var.alb.security_group_id
}

resource "aws_vpc_security_group_ingress_rule" "from_target_groups" {
  for_each = { for index, target in var.additional_target_groups : tostring(index) => target }

  security_group_id            = aws_security_group.this.id
  description                  = "From load balancer ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
  referenced_security_group_id = each.value.source_security_group_id
}

resource "aws_vpc_security_group_ingress_rule" "from_security_groups" {
  for_each = { for index, group in var.ingress_security_group_ids : tostring(index) => group }

  security_group_id            = aws_security_group.this.id
  description                  = "From allowed security group ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
  referenced_security_group_id = each.value
}

resource "aws_vpc_security_group_egress_rule" "this" {
  for_each = { for index, rule in var.egress_rules : tostring(index) => rule }

  security_group_id            = aws_security_group.this.id
  description                  = each.value.description
  ip_protocol                  = each.value.ip_protocol
  from_port                    = each.value.ip_protocol == "-1" ? null : each.value.from_port
  to_port                      = each.value.ip_protocol == "-1" ? null : each.value.to_port
  cidr_ipv4                    = each.value.cidr_ipv4
  prefix_list_id               = each.value.prefix_list_id
  referenced_security_group_id = each.value.referenced_security_group_id
}

# --- Task definition -------------------------------------------------------------------------

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = var.task_role_arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  dynamic "volume" {
    for_each = local.writable_volumes

    content {
      name = volume.key
    }
  }

  container_definitions = jsonencode([
    {
      name      = var.container_name
      image     = local.image
      essential = true
      user      = var.container_user

      portMappings = [{
        name          = "http"
        containerPort = var.container_port
        hostPort      = var.container_port
        protocol      = "tcp"
        appProtocol   = "http"
      }]

      # Sorted so that plans stay stable.
      environment = [for key in sort(keys(local.environment)) : { name = key, value = local.environment[key] }]
      secrets     = [for key in sort(keys(var.secrets)) : { name = key, valueFrom = var.secrets[key] }]

      readonlyRootFilesystem = var.readonly_root_filesystem
      mountPoints            = [for volume, path in local.writable_volumes : { sourceVolume = volume, containerPath = path, readOnly = false }]

      linuxParameters = {
        initProcessEnabled = true # PID 1 init forwards SIGTERM to Node and reaps zombies
        capabilities       = { drop = ["ALL"] }
      }

      ulimits = [{ name = "nofile", softLimit = 65536, hardLimit = 65536 }]

      healthCheck = {
        command     = var.health_check_command
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = var.health_check_start_period
      }

      stopTimeout = var.stop_timeout

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.this.name
          awslogs-region        = local.region
          awslogs-stream-prefix = var.container_name
          mode                  = "non-blocking"
          max-buffer-size       = "25m"
        }
      }
    }
  ])

  tags = var.tags

  lifecycle {
    precondition {
      condition     = var.max_capacity >= var.min_capacity
      error_message = "max_capacity must be greater than or equal to min_capacity."
    }

    precondition {
      condition     = var.alb == null ? true : (length(var.alb.host_headers) + length(var.alb.path_patterns) > 0)
      error_message = "alb needs at least one host_headers or path_patterns entry."
    }
  }
}

# --- Optional ALB attachment ---------------------------------------------------------------------

resource "aws_lb_target_group" "alb" {
  count = var.alb != null ? 1 : 0

  name                 = var.name
  port                 = var.container_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = "30"

  health_check {
    enabled             = true
    path                = var.health_check_path
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = var.tags
}

resource "aws_lb_listener_rule" "alb" {
  count = var.alb != null ? 1 : 0

  listener_arn = var.alb.listener_arn
  priority     = var.alb.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.alb[0].arn
  }

  dynamic "condition" {
    for_each = length(var.alb.host_headers) > 0 ? [var.alb.host_headers] : []

    content {
      host_header {
        values = condition.value
      }
    }
  }

  dynamic "condition" {
    for_each = length(var.alb.path_patterns) > 0 ? [var.alb.path_patterns] : []

    content {
      path_pattern {
        values = condition.value
      }
    }
  }

  tags = var.tags
}

# --- Service -------------------------------------------------------------------------------------

resource "aws_ecs_service" "this" {
  name                               = var.name
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.this.arn
  desired_count                      = var.min_capacity
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  deployment_minimum_healthy_percent = var.deployment_minimum_healthy_percent
  deployment_maximum_percent         = var.deployment_maximum_percent
  health_check_grace_period_seconds  = local.load_balanced ? var.health_check_grace_period_seconds : null
  enable_execute_command             = false
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"
  availability_zone_rebalancing      = "ENABLED"
  wait_for_steady_state              = false

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.this.id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = aws_lb_target_group.alb[*].arn

    content {
      target_group_arn = load_balancer.value
      container_name   = var.container_name
      container_port   = var.container_port
    }
  }

  dynamic "load_balancer" {
    for_each = var.additional_target_groups

    content {
      target_group_arn = load_balancer.value.target_group_arn
      container_name   = var.container_name
      container_port   = var.container_port
    }
  }

  tags = var.tags

  # Capacity is owned by Application Auto Scaling (min/max below) after creation.
  lifecycle {
    ignore_changes = [desired_count]
  }

  # A target group must be attached to a listener before a service can register with it.
  depends_on = [aws_lb_listener_rule.alb, aws_iam_role_policy.execution]
}

# --- Capacity ------------------------------------------------------------------------------------

# Always registered so that min/max are the single source of truth for task count, even for
# services that do not autoscale (min == max).
resource "aws_appautoscaling_target" "this" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${local.cluster_name}/${aws_ecs_service.this.name}"
  min_capacity       = var.min_capacity
  max_capacity       = var.max_capacity

  tags = var.tags
}

resource "aws_appautoscaling_policy" "cpu" {
  count = local.autoscaling_enabled ? 1 : 0

  name               = "${var.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  resource_id        = aws_appautoscaling_target.this.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.cpu_target_utilization
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "memory" {
  count = local.autoscaling_enabled ? 1 : 0

  name               = "${var.name}-memory"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  resource_id        = aws_appautoscaling_target.this.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.memory_target_utilization
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
  }
}
