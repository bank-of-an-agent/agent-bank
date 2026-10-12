# Alarms, an encrypted SNS topic and a dashboard for one account. Alarms live in the account
# that owns the metrics, so a compromise of one account cannot silence another's alarms.
#
# Custom metric contract (published by the apps, e.g. via CloudWatch Embedded Metric Format,
# which works through the Logs VPC endpoint without extra permissions):
#   AgentBank/Cosigner        DecisionLatency (Milliseconds), Requests (Count), Errors (Count)
#   AgentBank/Reconciliation  UnmatchedEvents (Count)
#   AgentBank/Indexer         BlockLag (Count, blocks behind chain head)
#   AgentBank/Webhooks        DeadLetteredDeliveries (Count)
# with exactly the dimensions in var.custom_metric_dimensions (none by default).

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  region     = data.aws_region.current.region
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  alarm_actions = [aws_sns_topic.alarms.arn]

  # ["Name", "Value", ...] form used by dashboard metric arrays.
  custom_dimension_list = flatten([for key in sort(keys(var.custom_metric_dimensions)) : [key, var.custom_metric_dimensions[key]]])
}

# --- Notification topic --------------------------------------------------------------------------

data "aws_iam_policy_document" "sns_kms" {
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  # CloudWatch cannot publish to topics encrypted with the AWS-managed SNS key, hence a CMK.
  statement {
    sid       = "CloudWatchAlarmsPublish"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_kms_key" "sns" {
  description             = "${var.name} alarm notifications"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.sns_kms.json

  tags = var.tags
}

resource "aws_kms_alias" "sns" {
  name          = "alias/${var.name}-alarms"
  target_key_id = aws_kms_key.sns.key_id
}

resource "aws_sns_topic" "alarms" {
  name              = "${var.name}-alarms"
  kms_master_key_id = aws_kms_key.sns.arn

  tags = var.tags
}

resource "aws_sns_topic_subscription" "email" {
  for_each = toset(var.alarm_email_addresses)

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.value
}

# --- API ---------------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "api_5xx_rate" {
  count = var.api_alb != null ? 1 : 0

  alarm_name          = "${var.name}-api-5xx-rate"
  alarm_description   = "API target 5xx responses above ${var.api_alb.error_rate_threshold_percent}% of requests in 3 of the last 5 minutes."
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.api_alb.error_rate_threshold_percent
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  metric_query {
    id          = "rate"
    expression  = "IF(requests > 0, 100 * FILL(errors, 0) / requests, 0)"
    label       = "API 5xx rate (%)"
    return_data = true
  }

  metric_query {
    id = "requests"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 60
      stat        = "Sum"
      dimensions = {
        LoadBalancer = var.api_alb.load_balancer_arn_suffix
        TargetGroup  = var.api_alb.target_group_arn_suffix
      }
    }
  }

  metric_query {
    id = "errors"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 60
      stat        = "Sum"
      dimensions = {
        LoadBalancer = var.api_alb.load_balancer_arn_suffix
        TargetGroup  = var.api_alb.target_group_arn_suffix
      }
    }
  }

  tags = var.tags
}

# --- Co-signer SLO: p99 < 300 ms, 99.9% availability, fail closed ------------------------------------

resource "aws_cloudwatch_metric_alarm" "cosigner_p99_latency" {
  count = var.cosigner != null ? 1 : 0

  alarm_name                            = "${var.name}-cosigner-p99-latency"
  alarm_description                     = "Co-signer p99 decision latency above ${var.cosigner.p99_latency_threshold_ms} ms in 3 of the last 5 minutes (SLO: p99 < 300 ms)."
  namespace                             = "AgentBank/Cosigner"
  metric_name                           = "DecisionLatency"
  dimensions                            = var.custom_metric_dimensions
  extended_statistic                    = "p99"
  period                                = 60
  evaluation_periods                    = 5
  datapoints_to_alarm                   = 3
  threshold                             = var.cosigner.p99_latency_threshold_ms
  comparison_operator                   = "GreaterThanThreshold"
  treat_missing_data                    = "notBreaching"
  evaluate_low_sample_count_percentiles = "evaluate"
  alarm_actions                         = local.alarm_actions
  ok_actions                            = local.alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "cosigner_availability" {
  count = var.cosigner != null ? 1 : 0

  alarm_name          = "${var.name}-cosigner-availability"
  alarm_description   = "Co-signer successful-decision ratio below ${var.cosigner.availability_target_percent}% (SLO: 99.9% monthly). Policy denials are successes; Errors counts failures to decide, which the API treats as a refusal (fail closed)."
  comparison_operator = "LessThanThreshold"
  threshold           = var.cosigner.availability_target_percent
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  metric_query {
    id          = "availability"
    expression  = "IF(requests > 0, 100 * (1 - FILL(errors, 0) / requests), 100)"
    label       = "Co-signer availability (%)"
    return_data = true
  }

  metric_query {
    id = "requests"

    metric {
      namespace   = "AgentBank/Cosigner"
      metric_name = "Requests"
      dimensions  = var.custom_metric_dimensions
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id = "errors"

    metric {
      namespace   = "AgentBank/Cosigner"
      metric_name = "Errors"
      dimensions  = var.custom_metric_dimensions
      period      = 300
      stat        = "Sum"
    }
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "cosigner_healthy_targets" {
  count = var.cosigner != null ? 1 : 0

  alarm_name          = "${var.name}-cosigner-healthy-targets"
  alarm_description   = "Fewer than ${var.cosigner.min_healthy_targets} healthy co-signer task(s) behind the PrivateLink NLB. Payments are refused while the co-signer is unavailable."
  namespace           = "AWS/NetworkELB"
  metric_name         = "HealthyHostCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  threshold           = var.cosigner.min_healthy_targets
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  dimensions = {
    LoadBalancer = var.cosigner.nlb_arn_suffix
    TargetGroup  = var.cosigner.target_group_arn_suffix
  }

  tags = var.tags
}

# --- Ledger integrity ------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "reconciliation_unmatched" {
  count = var.reconciliation_alarm_enabled ? 1 : 0

  alarm_name          = "${var.name}-reconciliation-unmatched-events"
  alarm_description   = "An on-chain movement did not match a ledger entry within the reconciliation window; it was posted to sys:suspense and the agent's sessions paused. Follow the reconciliation-mismatch runbook."
  namespace           = "AgentBank/Reconciliation"
  metric_name         = "UnmatchedEvents"
  dimensions          = var.custom_metric_dimensions
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "indexer_lag" {
  count = var.indexer_lag_threshold_blocks != null ? 1 : 0

  alarm_name          = "${var.name}-indexer-lag"
  alarm_description   = "Indexer more than ${coalesce(var.indexer_lag_threshold_blocks, 0)} blocks behind the chain head for 3 minutes, or not reporting. Reconciliation cannot meet its window."
  namespace           = "AgentBank/Indexer"
  metric_name         = "BlockLag"
  dimensions          = var.custom_metric_dimensions
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = coalesce(var.indexer_lag_threshold_blocks, 0)
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "webhook_dead_letters" {
  count = var.webhook_dead_letter_alarm_enabled ? 1 : 0

  alarm_name          = "${var.name}-webhook-dead-letters"
  alarm_description   = "A webhook delivery exhausted its retries (72h) and was dead-lettered."
  namespace           = "AgentBank/Webhooks"
  metric_name         = "DeadLetteredDeliveries"
  dimensions          = var.custom_metric_dimensions
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  tags = var.tags
}

# --- Platform ----------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "ecs_running_tasks" {
  for_each = var.ecs_services

  alarm_name          = "${var.name}-${each.key}-running-tasks"
  alarm_description   = "${each.value.service_name} has fewer than ${each.value.min_running_tasks} running task(s), or Container Insights stopped reporting."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = each.value.min_running_tasks
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  dimensions = {
    ClusterName = each.value.cluster_name
    ServiceName = each.value.service_name
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  for_each = toset(var.rds_instance_identifiers)

  alarm_name          = "${var.name}-${each.value}-cpu"
  alarm_description   = "RDS ${each.value} CPU above 80% for 10 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  dimensions = {
    DBInstanceIdentifier = each.value
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_free_storage" {
  for_each = toset(var.rds_instance_identifiers)

  alarm_name          = "${var.name}-${each.value}-free-storage"
  alarm_description   = "RDS ${each.value} free storage below ${floor(var.rds_free_storage_threshold_bytes / 1073741824)} GiB."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.rds_free_storage_threshold_bytes
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  dimensions = {
    DBInstanceIdentifier = each.value
  }

  tags = var.tags
}

# --- Dashboard -----------------------------------------------------------------------------------------

locals {
  alarm_arns = concat(
    aws_cloudwatch_metric_alarm.api_5xx_rate[*].arn,
    aws_cloudwatch_metric_alarm.cosigner_p99_latency[*].arn,
    aws_cloudwatch_metric_alarm.cosigner_availability[*].arn,
    aws_cloudwatch_metric_alarm.cosigner_healthy_targets[*].arn,
    aws_cloudwatch_metric_alarm.reconciliation_unmatched[*].arn,
    aws_cloudwatch_metric_alarm.indexer_lag[*].arn,
    aws_cloudwatch_metric_alarm.webhook_dead_letters[*].arn,
    [for alarm in aws_cloudwatch_metric_alarm.ecs_running_tasks : alarm.arn],
    [for alarm in aws_cloudwatch_metric_alarm.rds_cpu : alarm.arn],
    [for alarm in aws_cloudwatch_metric_alarm.rds_free_storage : alarm.arn],
  )

  widget_defaults = { region = local.region, view = "timeSeries", stacked = false, period = 60 }

  # Each widget is encoded on its own so that the conditional lists below are all list(string).
  widgets = concat(
    [jsonencode({
      type       = "alarm"
      width      = 24
      height     = 4
      properties = { title = "Alarm status", alarms = local.alarm_arns }
    })],
    var.api_alb == null ? [] : [jsonencode({
      type   = "metric"
      width  = 12
      height = 6
      properties = merge(local.widget_defaults, {
        title = "API requests, 5xx and p99 latency"
        metrics = [
          ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.api_alb.load_balancer_arn_suffix, "TargetGroup", var.api_alb.target_group_arn_suffix, { stat = "Sum" }],
          ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", var.api_alb.load_balancer_arn_suffix, "TargetGroup", var.api_alb.target_group_arn_suffix, { stat = "Sum" }],
          ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", var.api_alb.load_balancer_arn_suffix, "TargetGroup", var.api_alb.target_group_arn_suffix, { stat = "p99", yAxis = "right" }],
        ]
      })
    })],
    var.cosigner == null ? [] : [
      jsonencode({
        type   = "metric"
        width  = 12
        height = 6
        properties = merge(local.widget_defaults, {
          title = "Co-signer decision latency (ms)"
          metrics = [
            concat(["AgentBank/Cosigner", "DecisionLatency"], local.custom_dimension_list, [{ stat = "p50" }]),
            concat(["AgentBank/Cosigner", "DecisionLatency"], local.custom_dimension_list, [{ stat = "p99" }]),
          ]
          annotations = { horizontal = [{ label = "SLO p99", value = var.cosigner.p99_latency_threshold_ms }] }
        })
      }),
      jsonencode({
        type   = "metric"
        width  = 12
        height = 6
        properties = merge(local.widget_defaults, {
          title = "Co-signer requests, errors, healthy targets"
          metrics = [
            concat(["AgentBank/Cosigner", "Requests"], local.custom_dimension_list, [{ stat = "Sum" }]),
            concat(["AgentBank/Cosigner", "Errors"], local.custom_dimension_list, [{ stat = "Sum" }]),
            ["AWS/NetworkELB", "HealthyHostCount", "LoadBalancer", var.cosigner.nlb_arn_suffix, "TargetGroup", var.cosigner.target_group_arn_suffix, { stat = "Minimum", yAxis = "right" }],
          ]
        })
      }),
    ],
    !var.reconciliation_alarm_enabled && var.indexer_lag_threshold_blocks == null ? [] : [jsonencode({
      type   = "metric"
      width  = 12
      height = 6
      properties = merge(local.widget_defaults, {
        title = "Reconciliation unmatched events and indexer lag"
        metrics = [
          concat(["AgentBank/Reconciliation", "UnmatchedEvents"], local.custom_dimension_list, [{ stat = "Sum" }]),
          concat(["AgentBank/Indexer", "BlockLag"], local.custom_dimension_list, [{ stat = "Maximum", yAxis = "right" }]),
        ]
      })
    })],
    !var.webhook_dead_letter_alarm_enabled ? [] : [jsonencode({
      type   = "metric"
      width  = 12
      height = 6
      properties = merge(local.widget_defaults, {
        title   = "Dead-lettered webhook deliveries"
        metrics = [concat(["AgentBank/Webhooks", "DeadLetteredDeliveries"], local.custom_dimension_list, [{ stat = "Sum" }])]
      })
    })],
    length(var.ecs_services) == 0 ? [] : [jsonencode({
      type   = "metric"
      width  = 12
      height = 6
      properties = merge(local.widget_defaults, {
        title   = "ECS CPU utilisation (%)"
        metrics = [for key in sort(keys(var.ecs_services)) : ["AWS/ECS", "CPUUtilization", "ClusterName", var.ecs_services[key].cluster_name, "ServiceName", var.ecs_services[key].service_name, { stat = "Average" }]]
      })
    })],
    length(var.rds_instance_identifiers) == 0 ? [] : [jsonencode({
      type   = "metric"
      width  = 12
      height = 6
      properties = merge(local.widget_defaults, {
        title = "RDS CPU (%) and connections"
        # concat(...) flattens exactly one level, keeping each metric array intact.
        metrics = concat([for id in var.rds_instance_identifiers : [["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", id], ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", id, { yAxis = "right" }]]]...)
      })
    })],
  )
}

resource "aws_cloudwatch_dashboard" "this" {
  count = var.create_dashboard ? 1 : 0

  dashboard_name = var.name
  dashboard_body = "{\"widgets\":[${join(",", local.widgets)}]}"
}
