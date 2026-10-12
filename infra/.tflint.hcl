# TFLint configuration for every module under infra/.
#   tflint --init && tflint --recursive          (run from infra/)

config {
  # Lint module calls with the values passed in, not just each module in isolation.
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "all"
}

plugin "aws" {
  enabled = true
  version = "0.49.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}

# Modules intentionally take tags through variables while the provider's default_tags carry the
# mandatory project / environment / account_role tags.
rule "terraform_standard_module_structure" {
  enabled = true
}
