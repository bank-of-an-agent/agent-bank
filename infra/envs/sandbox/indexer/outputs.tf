output "chain_id" {
  description = "Chain the indexer follows (always Base Sepolia)."
  value       = var.chain_id
}

output "api_internal_vpc_endpoint_id" {
  description = "Interface endpoint to the API's internal service. Input accepted_indexer_endpoint_ids of envs/sandbox/api (second pass)."
  value       = one(aws_vpc_endpoint.api_internal[*].id)
}

output "ecr_repository_url" {
  description = "Push indexer images here (built with --build-arg APP=indexer)."
  value       = module.indexer.ecr_repository_url
}

output "indexer_db_address" {
  description = "Hostname of the indexer database (for DATABASE_URL)."
  value       = module.indexer_db.address
}

output "indexer_db_master_secret_arn" {
  description = "RDS-managed master credentials (break-glass only)."
  value       = module.indexer_db.master_user_secret_arn
}

output "secret_names" {
  description = "Secrets Manager secrets whose values operators must set out-of-band."
  value       = module.secrets.secret_names
}

output "alarm_topic_arn" {
  description = "SNS topic for this account's alarms (reconciliation mismatch, indexer lag)."
  value       = module.observability.sns_topic_arn
}

output "nat_public_ips" {
  description = "Egress IPs to allowlist with the RPC provider."
  value       = module.network.nat_public_ips
}
