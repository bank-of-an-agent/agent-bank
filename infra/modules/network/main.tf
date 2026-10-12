# VPC with three subnet tiers per AZ:
#   public   - ALB / NAT only (optional; the co-signer account has none)
#   private  - ECS tasks and interface VPC endpoints
#   database - RDS only, no route to the internet in either direction
# Interface endpoints (KMS, Secrets Manager, ECR, Logs, ...) and an S3 gateway endpoint let
# workloads reach AWS APIs without internet egress, so the co-signer VPC needs no NAT at all.

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  region     = data.aws_region.current.region
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  az_ids   = var.availability_zone_ids != null ? var.availability_zone_ids : slice(sort(data.aws_availability_zones.available.zone_ids), 0, var.az_count)
  az_count = length(local.az_ids)

  # Deterministic layout (for a /16): private /20s from the bottom of the range, then /24s for
  # public (offset 48) and database (offset 64) subnets.
  private_cidrs  = [for i in range(local.az_count) : cidrsubnet(var.cidr_block, 4, i)]
  public_cidrs   = [for i in range(local.az_count) : cidrsubnet(var.cidr_block, 8, 48 + i)]
  database_cidrs = [for i in range(local.az_count) : cidrsubnet(var.cidr_block, 8, 64 + i)]

  public_subnet_count = var.create_public_subnets ? local.az_count : 0
  nat_gateway_count   = var.enable_nat_gateway && var.create_public_subnets ? (var.single_nat_gateway ? 1 : local.az_count) : 0

  flow_log_group_name = "/vpc/${var.name}/flow-logs"
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(var.tags, { Name = var.name })

  lifecycle {
    precondition {
      condition     = var.create_public_subnets || !var.enable_nat_gateway
      error_message = "enable_nat_gateway = true requires create_public_subnets = true (NAT gateways live in public subnets)."
    }
  }
}

# Adopt the default security group and strip all of its rules so nothing can use it by
# accident (CIS AWS Foundations 5.4).
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, { Name = "${var.name}-default-deny-all" })
}

# --- Subnets -------------------------------------------------------------------------------

resource "aws_subnet" "public" {
  count = local.public_subnet_count

  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.public_cidrs[count.index]
  availability_zone_id    = local.az_ids[count.index]
  map_public_ip_on_launch = false

  tags = merge(var.tags, { Name = "${var.name}-public-${local.az_ids[count.index]}", tier = "public" })
}

resource "aws_subnet" "private" {
  count = local.az_count

  vpc_id               = aws_vpc.this.id
  cidr_block           = local.private_cidrs[count.index]
  availability_zone_id = local.az_ids[count.index]

  tags = merge(var.tags, { Name = "${var.name}-private-${local.az_ids[count.index]}", tier = "private" })
}

resource "aws_subnet" "database" {
  count = local.az_count

  vpc_id               = aws_vpc.this.id
  cidr_block           = local.database_cidrs[count.index]
  availability_zone_id = local.az_ids[count.index]

  tags = merge(var.tags, { Name = "${var.name}-database-${local.az_ids[count.index]}", tier = "database" })
}

# --- Internet egress (optional) --------------------------------------------------------------

resource "aws_internet_gateway" "this" {
  count = var.create_public_subnets ? 1 : 0

  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, { Name = var.name })
}

resource "aws_eip" "nat" {
  count = local.nat_gateway_count

  domain = "vpc"

  tags = merge(var.tags, { Name = "${var.name}-nat-${count.index}" })

  depends_on = [aws_internet_gateway.this]
}

resource "aws_nat_gateway" "this" {
  count = local.nat_gateway_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = merge(var.tags, { Name = "${var.name}-nat-${local.az_ids[count.index]}" })
}

# --- Routing -----------------------------------------------------------------------------------

resource "aws_route_table" "public" {
  count = var.create_public_subnets ? 1 : 0

  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, { Name = "${var.name}-public" })
}

resource "aws_route" "public_internet" {
  count = var.create_public_subnets ? 1 : 0

  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this[0].id
}

resource "aws_route_table_association" "public" {
  count = local.public_subnet_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_route_table" "private" {
  count = local.az_count

  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, { Name = "${var.name}-private-${local.az_ids[count.index]}" })
}

resource "aws_route" "private_nat" {
  count = local.nat_gateway_count > 0 ? local.az_count : 0

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[var.single_nat_gateway ? 0 : count.index].id
}

resource "aws_route_table_association" "private" {
  count = local.az_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# Database subnets share one route table with only the local route (plus the S3 gateway).
resource "aws_route_table" "database" {
  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, { Name = "${var.name}-database" })
}

resource "aws_route_table_association" "database" {
  count = local.az_count

  subnet_id      = aws_subnet.database[count.index].id
  route_table_id = aws_route_table.database.id
}

# --- VPC endpoints -----------------------------------------------------------------------------

resource "aws_vpc_endpoint" "s3" {
  count = var.enable_s3_gateway_endpoint ? 1 : 0

  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(aws_route_table.private[*].id, [aws_route_table.database.id])
  policy            = var.s3_gateway_endpoint_policy

  tags = merge(var.tags, { Name = "${var.name}-s3" })
}

resource "aws_security_group" "endpoints" {
  count = length(var.interface_endpoint_services) > 0 ? 1 : 0

  name        = "${var.name}-vpc-endpoints"
  description = "HTTPS from inside the VPC to interface VPC endpoints"
  vpc_id      = aws_vpc.this.id

  tags = merge(var.tags, { Name = "${var.name}-vpc-endpoints" })
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  count = length(var.interface_endpoint_services) > 0 ? 1 : 0

  security_group_id = aws_security_group.endpoints[0].id
  description       = "HTTPS from the VPC"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = var.cidr_block
}

resource "aws_vpc_endpoint" "interface" {
  for_each = toset(var.interface_endpoint_services)

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${local.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints[0].id]

  tags = merge(var.tags, { Name = "${var.name}-${replace(each.value, ".", "-")}" })
}

# --- Flow logs -----------------------------------------------------------------------------------

data "aws_iam_policy_document" "flow_logs_kms" {
  count = var.enable_flow_logs ? 1 : 0

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
    sid       = "CloudWatchLogsUseForFlowLogGroup"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${local.region}.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:${local.flow_log_group_name}"]
    }
  }
}

resource "aws_kms_key" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  description             = "${var.name} VPC flow logs"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.flow_logs_kms[0].json

  tags = var.tags
}

resource "aws_kms_alias" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name          = "alias/${var.name}-flow-logs"
  target_key_id = aws_kms_key.flow_logs[0].key_id
}

resource "aws_cloudwatch_log_group" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name              = local.flow_log_group_name
  retention_in_days = var.flow_logs_retention_days
  kms_key_id        = aws_kms_key.flow_logs[0].arn

  tags = var.tags
}

data "aws_iam_policy_document" "flow_logs_assume" {
  count = var.enable_flow_logs ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:ec2:${local.region}:${local.account_id}:vpc-flow-log/*"]
    }
  }
}

resource "aws_iam_role" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name               = "${var.name}-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.flow_logs_assume[0].json

  tags = var.tags
}

data "aws_iam_policy_document" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  statement {
    actions = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"]
    resources = [
      aws_cloudwatch_log_group.flow_logs[0].arn,
      "${aws_cloudwatch_log_group.flow_logs[0].arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name   = "write-flow-logs"
  role   = aws_iam_role.flow_logs[0].id
  policy = data.aws_iam_policy_document.flow_logs[0].json
}

resource "aws_flow_log" "this" {
  count = var.enable_flow_logs ? 1 : 0

  vpc_id                   = aws_vpc.this.id
  traffic_type             = "ALL"
  log_destination_type     = "cloud-watch-logs"
  log_destination          = aws_cloudwatch_log_group.flow_logs[0].arn
  iam_role_arn             = aws_iam_role.flow_logs[0].arn
  max_aggregation_interval = 60

  tags = merge(var.tags, { Name = var.name })
}
