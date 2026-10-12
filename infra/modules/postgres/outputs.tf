output "instance_identifier" {
  description = "RDS instance identifier (CloudWatch dimension DBInstanceIdentifier)."
  value       = aws_db_instance.this.identifier
}

output "instance_arn" {
  description = "RDS instance ARN."
  value       = aws_db_instance.this.arn
}

output "resource_id" {
  description = "RDS resource ID, used in rds-db:connect IAM policies."
  value       = aws_db_instance.this.resource_id
}

output "address" {
  description = "Hostname of the instance."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "Postgres port."
  value       = aws_db_instance.this.port
}

output "db_name" {
  description = "Initial database name."
  value       = aws_db_instance.this.db_name
}

output "security_group_id" {
  description = "Database security group."
  value       = aws_security_group.this.id
}

output "master_user_secret_arn" {
  description = "Secrets Manager secret holding the RDS-managed master credentials (break-glass use only)."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "kms_key_arn" {
  description = "CMK encrypting storage, snapshots, Performance Insights and the master user secret."
  value       = aws_kms_key.this.arn
}
