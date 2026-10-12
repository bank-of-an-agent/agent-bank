# PostgreSQL 16 on RDS for the ledger: private, encrypted with a dedicated CMK, TLS-only,
# automated backups with point-in-time recovery, deletion protection, Performance Insights and
# an RDS-managed (and rotated) master password that never passes through Terraform.

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  region     = data.aws_region.current.region
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  log_exports = ["postgresql", "upgrade"]
}

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

  statement {
    sid       = "CloudWatchLogsUseForRdsLogExports"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${local.region}.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/rds/instance/${var.identifier}/*"]
    }
  }
}

resource "aws_kms_key" "this" {
  description             = "RDS ${var.identifier}: storage, backups, Performance Insights, master user secret, log exports"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json

  tags = var.tags
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.identifier}-rds"
  target_key_id = aws_kms_key.this.key_id
}

resource "aws_db_subnet_group" "this" {
  name        = var.identifier
  description = "Isolated subnets for ${var.identifier}"
  subnet_ids  = var.subnet_ids

  tags = var.tags
}

resource "aws_security_group" "this" {
  name        = "${var.identifier}-db"
  description = "PostgreSQL ${var.identifier}"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, { Name = "${var.identifier}-db" })
}

resource "aws_vpc_security_group_ingress_rule" "clients" {
  for_each = { for index, group in var.allowed_security_group_ids : tostring(index) => group }

  security_group_id            = aws_security_group.this.id
  description                  = "PostgreSQL from allowed client ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = each.value
}

resource "aws_db_parameter_group" "this" {
  name_prefix = "${var.identifier}-pg16-"
  family      = "postgres16"
  description = "TLS-only, audited connection settings for ${var.identifier}"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "ssl_min_protocol_version"
    value = "TLSv1.2"
  }

  parameter {
    name  = "password_encryption"
    value = "scram-sha-256"
  }

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  # DDL only: schema changes are audited, row data never reaches the logs.
  parameter {
    name  = "log_statement"
    value = "ddl"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = tostring(var.log_min_duration_statement_ms)
  }

  tags = var.tags

  lifecycle {
    create_before_destroy = true
  }
}

# Pre-create the export log groups so they get retention and encryption (RDS would otherwise
# create them without either).
resource "aws_cloudwatch_log_group" "this" {
  for_each = toset(local.log_exports)

  name              = "/aws/rds/instance/${var.identifier}/${each.value}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn

  tags = var.tags
}

data "aws_iam_policy_document" "monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "monitoring" {
  count = var.monitoring_interval > 0 ? 1 : 0

  name               = "${var.identifier}-rds-monitoring"
  assume_role_policy = data.aws_iam_policy_document.monitoring_assume.json

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "monitoring" {
  count = var.monitoring_interval > 0 ? 1 : 0

  role       = aws_iam_role.monitoring[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  identifier     = var.identifier
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class
  db_name        = var.db_name
  port           = 5432

  username                      = var.master_username
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.this.arn

  iam_database_authentication_enabled = var.iam_database_authentication_enabled

  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.this.arn

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]
  publicly_accessible    = false
  multi_az               = var.multi_az
  network_type           = "IPV4"
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  parameter_group_name = aws_db_parameter_group.this.name

  backup_retention_period   = var.backup_retention_period
  backup_window             = var.backup_window
  maintenance_window        = var.maintenance_window
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.identifier}-final"

  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false
  apply_immediately           = var.apply_immediately

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.this.arn
  performance_insights_retention_period = var.performance_insights_retention_period

  monitoring_interval = var.monitoring_interval
  monitoring_role_arn = one(aws_iam_role.monitoring[*].arn)

  enabled_cloudwatch_logs_exports = local.log_exports

  tags = var.tags

  depends_on = [aws_cloudwatch_log_group.this, aws_iam_role_policy_attachment.monitoring]
}
