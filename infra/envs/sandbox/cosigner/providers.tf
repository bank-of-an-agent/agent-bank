provider "aws" {
  region = var.region

  # Refuse to touch any account other than the co-signer account, whatever credentials are in
  # the environment.
  allowed_account_ids = [var.account_id]

  assume_role {
    role_arn     = local.deployer_role_arn
    session_name = "agent-bank-${local.environment}-${local.account_role}"
    external_id  = var.assume_role_external_id
  }

  default_tags {
    tags = local.default_tags
  }
}
