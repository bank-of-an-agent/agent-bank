# Asserts the write-once properties of the audit archive against the real rendered policies.
# Fully offline: dummy credentials, no API calls.
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
  bucket_name    = "agent-bank-test-audit-111111111111"
  retention_days = 30
  writers = {
    cosigner = ["arn:aws:iam::111111111111:role/agent-bank-test-cosigner-task"]
    api      = ["arn:aws:iam::222222222222:role/agent-bank-test-api-task"]
  }
  cloudtrail_trail_arns = ["arn:aws:cloudtrail:us-east-1:111111111111:trail/agent-bank-test-key-usage"]
}

run "worm_archive" {
  command = plan

  assert {
    condition     = aws_s3_bucket.this.object_lock_enabled && aws_s3_bucket_object_lock_configuration.this.rule[0].default_retention[0].mode == "COMPLIANCE"
    error_message = "The audit bucket must use Object Lock in COMPLIANCE mode."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.this.block_public_acls,
      aws_s3_bucket_public_access_block.this.block_public_policy,
      aws_s3_bucket_public_access_block.this.ignore_public_acls,
      aws_s3_bucket_public_access_block.this.restrict_public_buckets,
    ])
    error_message = "All public access must be blocked."
  }

  assert {
    condition = anytrue([
      for statement in jsondecode(data.aws_iam_policy_document.bucket_access.json).Statement :
      statement.Effect == "Deny" && contains(flatten([statement.Action]), "s3:DeleteObjectVersion")
    ])
    error_message = "Deleting audit record versions must be explicitly denied."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(data.aws_iam_policy_document.bucket_access.json).Statement :
      toset(flatten([statement.Action])) == toset(["s3:PutObject"])
      if statement.Effect == "Allow" && startswith(try(statement.Sid, ""), "WritersPut")
    ])
    error_message = "Writers may only PutObject (no read, overwrite-protection bypass or delete)."
  }
}
