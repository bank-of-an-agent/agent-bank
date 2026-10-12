output "chain_id" {
  description = "Chain every service in this account is configured for (always Base Sepolia)."
  value       = var.chain_id
}

output "alb_dns_name" {
  description = "Public ALB DNS name (CNAME/alias target for the three hostnames)."
  value       = aws_lb.public.dns_name
}

output "alb_zone_id" {
  description = "Route 53 zone ID of the ALB, for alias records."
  value       = aws_lb.public.zone_id
}

output "cosigner_vpc_endpoint_id" {
  description = "Interface endpoint to the co-signer. Input accepted_api_endpoint_ids of envs/sandbox/cosigner (second pass)."
  value       = one(aws_vpc_endpoint.cosigner[*].id)
}

output "internal_api_endpoint_service_name" {
  description = "PrivateLink service exposing /internal/* to the indexer account. Input api_internal_endpoint_service_name of envs/sandbox/indexer."
  value       = one(module.internal_api_endpoint_service[*].service_name)
}

output "internal_api_endpoint_port" {
  description = "Port of the internal API listener."
  value       = one(module.internal_api_endpoint_service[*].listener_port)
}

output "ecr_repository_urls" {
  description = "ECR repositories to push images to (built with --build-arg APP=<service>)."
  value = {
    api         = module.api.ecr_repository_url
    facilitator = module.facilitator.ecr_repository_url
    console     = module.console.ecr_repository_url
  }
}

output "ledger_db_address" {
  description = "Hostname of the ledger database (for DATABASE_URL)."
  value       = module.ledger_db.address
}

output "ledger_db_master_secret_arn" {
  description = "RDS-managed master credentials (break-glass only; create least-privilege application roles with it, then stop using it)."
  value       = module.ledger_db.master_user_secret_arn
}

output "secret_names" {
  description = "Secrets Manager secrets whose values operators must set out-of-band."
  value       = module.secrets.secret_names
}

output "alarm_topic_arn" {
  description = "SNS topic for this account's alarms."
  value       = module.observability.sns_topic_arn
}

output "nat_public_ips" {
  description = "Egress IPs to allowlist with vendors (RPC provider, Pimlico, KYB, screening)."
  value       = module.network.nat_public_ips
}

output "availability_zone_ids" {
  description = "AZ IDs used; must overlap the co-signer account's."
  value       = module.network.availability_zone_ids
}
