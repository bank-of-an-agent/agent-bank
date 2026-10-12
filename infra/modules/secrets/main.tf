# Secrets Manager *containers* only. Terraform never sees a secret value: there is deliberately
# no aws_secretsmanager_secret_version here. Operators (or a rotation function) write values
# directly, e.g.
#   aws secretsmanager put-secret-value --secret-id agent-bank/sandbox/api/DATABASE_URL \
#     --secret-string file://database-url.txt
# Each secret can carry a resource policy that denies GetSecretValue to everyone except the
# listed reader roles (normally the ECS execution role of the service that consumes it).

resource "aws_kms_key" "this" {
  description             = "Secrets Manager secrets under ${var.name_prefix}"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  tags = var.tags
}

resource "aws_kms_alias" "this" {
  name          = "alias/${replace(var.name_prefix, "/", "-")}-secrets"
  target_key_id = aws_kms_key.this.key_id
}

resource "aws_secretsmanager_secret" "this" {
  for_each = var.secrets

  name                    = "${var.name_prefix}/${each.key}"
  description             = each.value.description
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = var.recovery_window_in_days

  tags = merge(var.tags, { env_var = each.key })
}

data "aws_iam_policy_document" "readers" {
  for_each = { for key, arns in var.readers : key => arns if length(arns) > 0 }

  statement {
    sid       = "DenyReadExceptConsumers"
    effect    = "Deny"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "ArnNotLike"
      variable = "aws:PrincipalArn"
      values   = each.value
    }
  }
}

resource "aws_secretsmanager_secret_policy" "readers" {
  for_each = { for key, document in data.aws_iam_policy_document.readers : key => document.json }

  secret_arn          = aws_secretsmanager_secret.this[each.key].arn
  policy              = each.value
  block_public_policy = true
}
