output "service_name" {
  description = "ECS service name."
  value       = aws_ecs_service.this.name
}

output "service_arn" {
  description = "ECS service ARN."
  value       = aws_ecs_service.this.id
}

output "cluster_name" {
  description = "ECS cluster name (for CloudWatch dimensions)."
  value       = local.cluster_name
}

output "task_definition_arn" {
  description = "Current task definition revision."
  value       = aws_ecs_task_definition.this.arn
}

output "image" {
  description = "Image reference the task definition runs."
  value       = local.image
}

output "ecr_repository_url" {
  description = "ECR repository to push images to (null when image_repository_url was supplied)."
  value       = one(aws_ecr_repository.this[*].repository_url)
}

output "security_group_id" {
  description = "Security group of the tasks; reference it from databases and VPC endpoints."
  value       = aws_security_group.this.id
}

output "execution_role_arn" {
  description = "Execution role ARN; the only principal that should read this service's secrets."
  value       = aws_iam_role.execution.arn
}

output "log_group_name" {
  description = "CloudWatch Logs group of the service."
  value       = aws_cloudwatch_log_group.this.name
}

output "target_group_arn" {
  description = "ALB target group ARN (null without an ALB attachment)."
  value       = one(aws_lb_target_group.alb[*].arn)
}

output "target_group_arn_suffix" {
  description = "ALB target group ARN suffix for CloudWatch dimensions (null without an ALB attachment)."
  value       = one(aws_lb_target_group.alb[*].arn_suffix)
}
