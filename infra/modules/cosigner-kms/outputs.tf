output "key_arn" {
  description = "ARN of the secp256k1 signing key (pass to the co-signer as KMS_KEY_ID)."
  value       = aws_kms_key.this.arn
}

output "key_id" {
  description = "Key ID of the signing key."
  value       = aws_kms_key.this.key_id
}

output "alias_name" {
  description = "Alias of the signing key."
  value       = aws_kms_alias.this.name
}

output "trail_arn" {
  description = "ARN of the key-usage CloudTrail trail."
  value       = aws_cloudtrail.this.arn
}

output "trail_log_group_name" {
  description = "CloudWatch Logs group with the trail's events (metric filters live here)."
  value       = aws_cloudwatch_log_group.trail.name
}

output "alarm_names" {
  description = "Names of the key-misuse alarms."
  value       = [for alarm in aws_cloudwatch_metric_alarm.key : alarm.alarm_name]
}
