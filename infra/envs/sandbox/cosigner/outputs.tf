output "chain_id" {
  description = "Chain the co-signer is configured for (always Base Sepolia)."
  value       = var.chain_id
}

output "cosigner_endpoint_service_name" {
  description = "PrivateLink service name. Input cosigner_endpoint_service_name of envs/sandbox/api."
  value       = module.cosigner_endpoint_service.service_name
}

output "cosigner_endpoint_port" {
  description = "Port the API connects to through its interface endpoint."
  value       = module.cosigner_endpoint_service.listener_port
}

output "cosigner_endpoint_protocol" {
  description = "TCP (pass-through, HMAC-authenticated) or TLS."
  value       = module.cosigner_endpoint_service.listener_protocol
}

output "signing_key_arn" {
  description = "ARN of the non-exportable secp256k1 co-signing key."
  value       = module.cosigner_kms.key_arn
}

output "signing_key_alias" {
  description = "Alias of the co-signing key."
  value       = module.cosigner_kms.alias_name
}

output "key_usage_trail_arn" {
  description = "CloudTrail trail recording every call against the key."
  value       = module.cosigner_kms.trail_arn
}

output "audit_log_bucket_arn" {
  description = "Object Lock audit archive. Input audit_log_bucket_arn of envs/sandbox/api."
  value       = module.audit_log.bucket_arn
}

output "audit_log_kms_key_arn" {
  description = "CMK of the audit archive. Input audit_log_kms_key_arn of envs/sandbox/api."
  value       = module.audit_log.kms_key_arn
}

output "ecr_repository_url" {
  description = "Push co-signer images here (built with --build-arg APP=cosigner)."
  value       = module.cosigner.ecr_repository_url
}

output "secret_names" {
  description = "Secrets Manager secrets whose values operators must set out-of-band."
  value       = module.secrets.secret_names
}

output "alarm_topic_arn" {
  description = "SNS topic for this account's alarms."
  value       = module.observability.sns_topic_arn
}

output "availability_zone_ids" {
  description = "AZ IDs used; the API account must use the same ones."
  value       = module.network.availability_zone_ids
}
