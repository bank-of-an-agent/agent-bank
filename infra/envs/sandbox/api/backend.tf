# Remote state for the API account. Uncomment before the first real apply.
#
# State is kept in the API account itself (a separate bucket per account): a versioned bucket
# with SSE-KMS and native S3 locking (OpenTofu/Terraform >= 1.10). The state contains no secret
# values (secrets are containers only and the RDS password is RDS-managed), but it does map the
# whole security boundary, so treat it as sensitive.
#
# terraform {
#   backend "s3" {
#     bucket       = "agent-bank-sandbox-tfstate-<api-account-id>"
#     key          = "sandbox/api/terraform.tfstate"
#     region       = "us-east-1"
#     encrypt      = true
#     kms_key_id   = "alias/agent-bank-tfstate"
#     use_lockfile = true # native S3 lock file; with older versions use dynamodb_table instead
#
#     assume_role = {
#       role_arn     = "arn:aws:iam::<api-account-id>:role/agent-bank-deployer"
#       session_name = "agent-bank-sandbox-api-state"
#     }
#   }
# }
