# Guardrails for the API root module. Runs offline with a mocked AWS provider:
#   tofu init -backend=false && tofu test        (OpenTofu >= 1.8 or Terraform >= 1.7)

mock_provider "aws" {
  # Data sources
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "222222222222"
      arn        = "arn:aws:sts::222222222222:assumed-role/agent-bank-deployer/test"
      user_id    = "AROAEXAMPLEEXAMPLE:test"
    }
  }

  mock_data "aws_partition" {
    defaults = {
      partition  = "aws"
      dns_suffix = "amazonaws.com"
    }
  }

  mock_data "aws_region" {
    defaults = {
      region = "us-east-1"
    }
  }

  mock_data "aws_availability_zones" {
    defaults = {
      names    = ["us-east-1a", "us-east-1b", "us-east-1c"]
      zone_ids = ["use1-az1", "use1-az2", "use1-az4"]
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  # Resources: well-formed computed values so the provider's own ARN/ID validators accept them.
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::222222222222:role/mock-role" }
  }

  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:us-east-1:222222222222:key/00000000-0000-0000-0000-000000000000"
      key_id = "00000000-0000-0000-0000-000000000000"
    }
  }

  mock_resource "aws_kms_alias" {
    defaults = { arn = "arn:aws:kms:us-east-1:222222222222:alias/mock" }
  }

  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-1:222222222222:mock-topic" }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:222222222222:log-group:/mock" }
  }

  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-1:222222222222:secret:agent-bank/mock-AbCdEf" }
  }

  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:us-east-1:222222222222:cluster/mock" }
  }

  mock_resource "aws_ecr_repository" {
    defaults = {
      arn            = "arn:aws:ecr:us-east-1:222222222222:repository/mock"
      repository_url = "222222222222.dkr.ecr.us-east-1.amazonaws.com/mock"
    }
  }

  mock_resource "aws_lb" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:222222222222:loadbalancer/app/mock/0123456789abcdef"
      arn_suffix = "app/mock/0123456789abcdef"
    }
  }

  mock_resource "aws_lb_target_group" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:222222222222:targetgroup/mock/0123456789abcdef"
      arn_suffix = "targetgroup/mock/0123456789abcdef"
    }
  }

  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:222222222222:listener/app/mock/0123456789abcdef/0123456789abcdef" }
  }

  mock_resource "aws_wafv2_web_acl" {
    defaults = { arn = "arn:aws:wafv2:us-east-1:222222222222:regional/webacl/mock/00000000-0000-0000-0000-000000000000" }
  }

  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mock-bucket" }
  }

  mock_resource "aws_vpc_endpoint" {
    defaults = {
      id             = "vpce-0123456789abcdef0"
      prefix_list_id = "pl-63a5400a"
      dns_entry      = [{ dns_name = "vpce-0123456789abcdef0-mock.vpce-svc-0123456789abcdef0.us-east-1.vpce.amazonaws.com", hosted_zone_id = "Z7HUB22UULQXV" }]
    }
  }

  mock_resource "aws_db_instance" {
    defaults = {
      master_user_secret = [{ kms_key_id = "arn:aws:kms:us-east-1:222222222222:key/00000000-0000-0000-0000-000000000000", secret_arn = "arn:aws:secretsmanager:us-east-1:222222222222:secret:rds-mock-AbCdEf", secret_status = "active" }]
    }
  }
}

variables {
  account_id           = "222222222222"
  image_tag            = "0123456789abcdef0123456789abcdef01234567"
  api_hostname         = "api.sandbox.example.com"
  facilitator_hostname = "x402.sandbox.example.com"
  console_hostname     = "console.sandbox.example.com"
  alb_certificate_arn  = "arn:aws:acm:us-east-1:222222222222:certificate/00000000-0000-0000-0000-000000000000"
}

run "plans_standalone_on_base_sepolia" {
  command = plan

  assert {
    condition     = output.chain_id == 84532
    error_message = "The sandbox must target Base Sepolia (84532)."
  }

  assert {
    condition     = output.cosigner_vpc_endpoint_id == null
    error_message = "Without a co-signer service name no endpoint may be created (the API must fail closed)."
  }
}

run "plans_fully_wired" {
  command = plan

  variables {
    cosigner_endpoint_service_name = "com.amazonaws.vpce.us-east-1.vpce-svc-0123456789abcdef0"
    audit_log_bucket_arn           = "arn:aws:s3:::agent-bank-sandbox-audit-111111111111"
    audit_log_kms_key_arn          = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000000"
    indexer_account_id             = "333333333333"
  }

  assert {
    condition     = length(aws_vpc_endpoint.cosigner) == 1 && length(module.internal_api_endpoint_service) == 1
    error_message = "Both PrivateLink links should be planned when wired."
  }
}

run "rejects_base_mainnet" {
  command = plan

  variables {
    chain_id = 8453
  }

  expect_failures = [var.chain_id]
}

run "rejects_half_configured_audit_export" {
  command = plan

  variables {
    audit_log_bucket_arn = "arn:aws:s3:::agent-bank-sandbox-audit-111111111111"
  }

  expect_failures = [aws_iam_role_policy.api_task]
}
