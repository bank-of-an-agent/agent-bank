# Asserts the properties of the co-signing key that the design depends on, against the key
# policy JSON the real AWS provider renders. Fully offline: dummy credentials, no API calls
# (account, region and partition lookups are overridden).
#   tofu init -backend=false && tofu test        (OpenTofu >= 1.8 or Terraform >= 1.7)

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "offline-test"
  secret_key                  = "offline-test"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}

override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "111111111111" }
}

override_data {
  target = data.aws_region.current
  values = { region = "us-east-1" }
}

override_data {
  target = data.aws_partition.current
  values = { partition = "aws" }
}

variables {
  name                         = "agent-bank-test-cosigner"
  signer_role_arn              = "arn:aws:iam::111111111111:role/agent-bank-test-cosigner-task"
  key_admin_role_arns          = ["arn:aws:iam::111111111111:role/agent-bank-deployer"]
  break_glass_role_arn         = "arn:aws:iam::111111111111:role/agent-bank-break-glass"
  allowed_kms_vpc_endpoint_ids = ["vpce-0123456789abcdef0"]
  trail_name                   = "agent-bank-test-cosigner-key-usage"
  trail_s3_bucket_name         = "agent-bank-test-audit-111111111111"
  trail_kms_key_arn            = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000000"
  alarm_sns_topic_arn          = "arn:aws:sns:us-east-1:111111111111:agent-bank-test-alarms"
}

run "key_policy" {
  command = plan

  assert {
    condition     = aws_kms_key.this.customer_master_key_spec == "ECC_SECG_P256K1" && aws_kms_key.this.key_usage == "SIGN_VERIFY"
    error_message = "The co-signing key must be a secp256k1 SIGN_VERIFY key."
  }

  assert {
    condition     = !aws_kms_key.this.multi_region && !aws_kms_key.this.bypass_policy_lockout_safety_check
    error_message = "The key must be single-region and keep the policy lockout safety check."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(data.aws_iam_policy_document.key.json).Statement :
      alltrue([for principal in flatten([statement.Principal.AWS]) : principal == var.signer_role_arn])
      if statement.Effect == "Allow" && length(setintersection(toset(flatten([statement.Action])), toset(["kms:Sign", "kms:GetPublicKey", "kms:*"]))) > 0
    ])
    error_message = "Only the co-signer task role may be allowed kms:Sign or kms:GetPublicKey."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(data.aws_iam_policy_document.key.json).Statement :
      !contains(flatten([statement.Action]), "kms:*")
    ])
    error_message = "The key policy must not grant kms:* to anyone (including the account root)."
  }

  assert {
    condition = anytrue([
      for statement in jsondecode(data.aws_iam_policy_document.key.json).Statement :
      statement.Effect == "Deny" && contains(flatten([statement.Action]), "kms:Sign") && try(statement.Condition.ArnNotEquals["aws:PrincipalArn"], "") == var.signer_role_arn
    ])
    error_message = "An explicit deny must block kms:Sign for every principal except the co-signer task role."
  }

  assert {
    condition = anytrue([
      for statement in jsondecode(data.aws_iam_policy_document.key.json).Statement :
      statement.Effect == "Deny" && contains(flatten([statement.Action]), "kms:Sign") && try(statement.Condition.StringNotEquals["aws:SourceVpce"], "") == "vpce-0123456789abcdef0"
    ])
    error_message = "kms:Sign must be denied outside the co-signer VPC's KMS endpoint."
  }

  assert {
    condition = anytrue([
      for statement in jsondecode(data.aws_iam_policy_document.key.json).Statement :
      statement.Effect == "Deny" && contains(flatten([statement.Action]), "kms:ScheduleKeyDeletion") && try(statement.Condition.BoolIfExists["aws:MultiFactorAuthPresent"], "") == "false"
    ])
    error_message = "Scheduling key deletion must be denied without MFA."
  }

  assert {
    condition = anytrue([
      for statement in jsondecode(data.aws_iam_policy_document.key.json).Statement :
      statement.Effect == "Deny" && contains(flatten([statement.Action]), "kms:CreateGrant")
    ])
    error_message = "Grants (which could delegate kms:Sign) must be denied."
  }
}
