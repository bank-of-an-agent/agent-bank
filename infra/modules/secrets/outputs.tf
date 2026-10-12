output "secret_arns" {
  description = "Secret key -> secret ARN, ready to pass to the ecs-service module's secrets input."
  value       = { for key, secret in aws_secretsmanager_secret.this : key => secret.arn }
}

output "secret_names" {
  description = "Secret key -> secret name (for `aws secretsmanager put-secret-value --secret-id`)."
  value       = { for key, secret in aws_secretsmanager_secret.this : key => secret.name }
}

output "kms_key_arn" {
  description = "CMK encrypting the secrets; consumers' execution roles need kms:Decrypt via Secrets Manager."
  value       = aws_kms_key.this.arn
}
