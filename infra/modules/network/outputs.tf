output "vpc_id" {
  description = "VPC ID."
  value       = aws_vpc.this.id
}

output "vpc_cidr_block" {
  description = "VPC IPv4 CIDR."
  value       = aws_vpc.this.cidr_block
}

output "availability_zone_ids" {
  description = "AZ IDs the subnets were placed in (index-aligned with the subnet ID lists)."
  value       = local.az_ids
}

output "public_subnet_ids" {
  description = "Public subnet IDs (empty when create_public_subnets is false)."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet IDs for ECS tasks, NLBs and interface endpoints."
  value       = aws_subnet.private[*].id
}

output "database_subnet_ids" {
  description = "Isolated database subnet IDs."
  value       = aws_subnet.database[*].id
}

output "private_route_table_ids" {
  description = "Private route table IDs (one per AZ)."
  value       = aws_route_table.private[*].id
}

output "database_route_table_id" {
  description = "Database route table ID."
  value       = aws_route_table.database.id
}

output "nat_public_ips" {
  description = "Elastic IPs of the NAT gateways (allowlist these with vendors such as the RPC provider)."
  value       = aws_eip.nat[*].public_ip
}

output "interface_endpoint_ids" {
  description = "Map of service suffix (e.g. \"kms\") to interface VPC endpoint ID."
  value       = { for service, endpoint in aws_vpc_endpoint.interface : service => endpoint.id }
}

output "interface_endpoint_security_group_id" {
  description = "Security group attached to the interface endpoints (null when none are created)."
  value       = one(aws_security_group.endpoints[*].id)
}

output "s3_gateway_endpoint_id" {
  description = "S3 gateway endpoint ID (null when disabled)."
  value       = one(aws_vpc_endpoint.s3[*].id)
}

output "s3_prefix_list_id" {
  description = "Managed prefix list of S3 in this region, for security group egress rules toward the S3 gateway endpoint."
  value       = one(aws_vpc_endpoint.s3[*].prefix_list_id)
}

output "flow_log_group_name" {
  description = "CloudWatch Logs group receiving VPC flow logs (null when disabled)."
  value       = one(aws_cloudwatch_log_group.flow_logs[*].name)
}
