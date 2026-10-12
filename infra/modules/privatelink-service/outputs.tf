output "service_name" {
  description = "Endpoint service name (com.amazonaws.vpce.<region>.vpce-svc-...). Give this to the consumer account."
  value       = aws_vpc_endpoint_service.this.service_name
}

output "service_id" {
  description = "Endpoint service ID."
  value       = aws_vpc_endpoint_service.this.id
}

output "availability_zones" {
  description = "AZs in which consumers can create endpoints."
  value       = aws_vpc_endpoint_service.this.availability_zones
}

output "listener_port" {
  description = "Port consumers connect to."
  value       = local.listener_port
}

output "listener_protocol" {
  description = "TCP (pass-through) or TLS."
  value       = aws_lb_listener.this.protocol
}

output "nlb_arn" {
  description = "NLB ARN."
  value       = aws_lb.this.arn
}

output "nlb_arn_suffix" {
  description = "NLB ARN suffix for CloudWatch dimensions."
  value       = aws_lb.this.arn_suffix
}

output "target_group_arn" {
  description = "Target group ARN; register the ECS service with it."
  value       = aws_lb_target_group.this.arn
}

output "target_group_arn_suffix" {
  description = "Target group ARN suffix for CloudWatch dimensions."
  value       = aws_lb_target_group.this.arn_suffix
}

output "security_group_id" {
  description = "NLB security group; allow it as an ingress source on the target tasks."
  value       = aws_security_group.nlb.id
}
