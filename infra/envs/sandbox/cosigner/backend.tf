# Remote state for the co-signer account. Uncomment before the first real apply.
#
# State is kept in the co-signer account itself (never in the API account): a versioned bucket
# with SSE-KMS and native S3 locking (OpenTofu/Terraform >= 1.10). The state contains no secret
# values (secrets are containers only and the RDS password is RDS-managed), but it does map the
# whole security boundary, so treat it as sensitive.
#
# terraform {
#   backend "s3" {
#     bucket       = "agent-bank-sandbox-tfstate-<cosigner-account-id>"
#     key          = "sandbox/cosigner/terraform.tfstate"
#     region       = "us-east-1"
#     encrypt      = true
#     kms_key_id   = "alias/agent-bank-tfstate"
#     use_lockfile = true # native S3 lock file; with older versions use dynamodb_table instead
#
#     assume_role = {
#       role_arn     = "arn:aws:iam::<cosigner-account-id>:role/agent-bank-deployer"
#       session_name = "agent-bank-sandbox-cosigner-state"
#     }
#   }
# }
