# Write-once archive for the hash-chained audit log (policy decisions, approvals,
# co-signatures, admin actions) and, optionally, CloudTrail key-usage logs.
#
#   * S3 Object Lock in COMPLIANCE mode: every object version is immutable for retention_days,
#     for every principal including the account root user.
#   * SSE-KMS with a dedicated CMK (bucket keys on); requests naming any other key are denied.
#   * Public access fully blocked, ACLs disabled, TLS required, deletes denied outright.
#   * Writers are per-prefix and may only PutObject; readers are explicit.

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  region     = data.aws_region.current.region
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  bucket_arn = "arn:${local.partition}:s3:::${var.bucket_name}"

  # Cross-account principals are granted at account level and pinned to role ARNs with
  # aws:PrincipalArn, so the roles do not have to exist yet (S3 and KMS reject policies naming
  # non-existent role principals).
  writer_accounts     = { for prefix, arns in var.writers : prefix => distinct([for arn in arns : "arn:${local.partition}:iam::${split(":", arn)[4]}:root"]) }
  all_writer_arns     = distinct(flatten(values(var.writers)))
  all_writer_accounts = distinct([for arn in local.all_writer_arns : "arn:${local.partition}:iam::${split(":", arn)[4]}:root"])
  reader_accounts     = distinct([for arn in var.reader_role_arns : "arn:${local.partition}:iam::${split(":", arn)[4]}:root"])
}

# --- Encryption key --------------------------------------------------------------------------------

data "aws_iam_policy_document" "kms" {
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  dynamic "statement" {
    for_each = length(local.all_writer_arns) > 0 ? [1] : []

    content {
      sid       = "WritersEncryptViaS3"
      actions   = ["kms:GenerateDataKey", "kms:Encrypt", "kms:Decrypt"]
      resources = ["*"]

      principals {
        type        = "AWS"
        identifiers = local.all_writer_accounts
      }

      condition {
        test     = "ArnLike"
        variable = "aws:PrincipalArn"
        values   = local.all_writer_arns
      }

      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["s3.${local.region}.amazonaws.com"]
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.reader_role_arns) > 0 ? [1] : []

    content {
      sid       = "ReadersDecryptViaS3"
      actions   = ["kms:Decrypt", "kms:DescribeKey"]
      resources = ["*"]

      principals {
        type        = "AWS"
        identifiers = local.reader_accounts
      }

      condition {
        test     = "ArnLike"
        variable = "aws:PrincipalArn"
        values   = var.reader_role_arns
      }

      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["s3.${local.region}.amazonaws.com"]
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.cloudtrail_trail_arns) > 0 ? [1] : []

    content {
      sid       = "CloudTrailEncryptLogs"
      actions   = ["kms:GenerateDataKey*"]
      resources = ["*"]

      principals {
        type        = "Service"
        identifiers = ["cloudtrail.amazonaws.com"]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:SourceArn"
        values   = var.cloudtrail_trail_arns
      }

      condition {
        test     = "StringLike"
        variable = "kms:EncryptionContext:aws:cloudtrail:arn"
        values   = ["arn:${local.partition}:cloudtrail:*:${local.account_id}:trail/*"]
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.cloudtrail_trail_arns) > 0 ? [1] : []

    content {
      sid       = "CloudTrailDescribeKey"
      actions   = ["kms:DescribeKey"]
      resources = ["*"]

      principals {
        type        = "Service"
        identifiers = ["cloudtrail.amazonaws.com"]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:SourceArn"
        values   = var.cloudtrail_trail_arns
      }
    }
  }
}

resource "aws_kms_key" "this" {
  description             = "Audit log archive ${var.bucket_name}"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json

  tags = var.tags
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.bucket_name}"
  target_key_id = aws_kms_key.this.key_id
}

# --- Bucket ------------------------------------------------------------------------------------------

resource "aws_s3_bucket" "this" {
  bucket              = var.bucket_name
  object_lock_enabled = true
  force_destroy       = false

  tags = var.tags
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.this.arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "archive"
    status = "Enabled"

    filter {}

    transition {
      days          = var.archive_after_days
      storage_class = "GLACIER_IR"
    }

    noncurrent_version_transition {
      noncurrent_days = var.archive_after_days
      storage_class   = "GLACIER_IR"
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

# Access rules that do not depend on any resource created here (rendered at plan time, which
# also makes them unit-testable; see tests/worm.tftest.hcl).
data "aws_iam_policy_document" "bucket_access" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.bucket_arn, "${local.bucket_arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Belt and braces on top of Object Lock: nobody deletes records or versions through the API.
  # Lifecycle transitions are performed by S3 itself and are unaffected.
  statement {
    sid       = "DenyDeletes"
    effect    = "Deny"
    actions   = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["${local.bucket_arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }

  dynamic "statement" {
    for_each = var.writers

    content {
      sid       = "WritersPut${replace(title(replace(statement.key, "_", "-")), "-", "")}"
      actions   = ["s3:PutObject"]
      resources = ["${local.bucket_arn}/${statement.key}/*"]

      principals {
        type        = "AWS"
        identifiers = local.writer_accounts[statement.key]
      }

      condition {
        test     = "ArnLike"
        variable = "aws:PrincipalArn"
        values   = statement.value
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.reader_role_arns) > 0 ? [1] : []

    content {
      sid       = "ReadersReadAll"
      actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectRetention", "s3:ListBucket", "s3:ListBucketVersions"]
      resources = [local.bucket_arn, "${local.bucket_arn}/*"]

      principals {
        type        = "AWS"
        identifiers = local.reader_accounts
      }

      condition {
        test     = "ArnLike"
        variable = "aws:PrincipalArn"
        values   = var.reader_role_arns
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.cloudtrail_trail_arns) > 0 ? [1] : []

    content {
      sid       = "CloudTrailAclCheck"
      actions   = ["s3:GetBucketAcl"]
      resources = [local.bucket_arn]

      principals {
        type        = "Service"
        identifiers = ["cloudtrail.amazonaws.com"]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:SourceArn"
        values   = var.cloudtrail_trail_arns
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.cloudtrail_trail_arns) > 0 ? [1] : []

    content {
      sid       = "CloudTrailWrite"
      actions   = ["s3:PutObject"]
      resources = ["${local.bucket_arn}/${var.cloudtrail_key_prefix}/AWSLogs/${local.account_id}/*"]

      principals {
        type        = "Service"
        identifiers = ["cloudtrail.amazonaws.com"]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:SourceArn"
        values   = var.cloudtrail_trail_arns
      }

      condition {
        test     = "StringEquals"
        variable = "s3:x-amz-acl"
        values   = ["bucket-owner-full-control"]
      }
    }
  }
}

data "aws_iam_policy_document" "bucket" {
  source_policy_documents = [data.aws_iam_policy_document.bucket_access.json]

  statement {
    sid       = "DenyOtherKmsKeys"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${local.bucket_arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = ["false"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.this.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = data.aws_iam_policy_document.bucket.json

  depends_on = [aws_s3_bucket_public_access_block.this]
}
