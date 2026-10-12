output "sns_topic_arn" {
  description = "Alarm notification topic. Subscribe paging integrations here."
  value       = aws_sns_topic.alarms.arn
}

output "alarm_arns" {
  description = "ARNs of every alarm created by this module."
  value       = local.alarm_arns
}

output "dashboard_name" {
  description = "CloudWatch dashboard name (null when disabled)."
  value       = one(aws_cloudwatch_dashboard.this[*].dashboard_name)
}
