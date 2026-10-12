output "bucket_name" {
  description = "Bucket name. Only resolves once the bucket policy, Object Lock and encryption are in place, so dependants (e.g. a CloudTrail trail) never see a half-configured bucket."
  value       = aws_s3_bucket.this.id

  depends_on = [
    aws_s3_bucket_policy.this,
    aws_s3_bucket_object_lock_configuration.this,
    aws_s3_bucket_server_side_encryption_configuration.this,
  ]
}

output "bucket_arn" {
  description = "Bucket ARN."
  value       = aws_s3_bucket.this.arn
}

output "kms_key_arn" {
  description = "CMK that encrypts every object; writers need kms:GenerateDataKey on it (granted via S3 only)."
  value       = aws_kms_key.this.arn

  depends_on = [aws_kms_key.this]
}

output "retention_days" {
  description = "Object Lock COMPLIANCE retention in days."
  value       = var.retention_days
}
