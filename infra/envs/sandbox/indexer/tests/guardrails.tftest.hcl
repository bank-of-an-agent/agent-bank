# Guardrails for the indexer root module. Runs offline with a mocked AWS provider:
#   tofu init -backend=false && tofu test        (OpenTofu >= 1.8 or Terraform >= 1.7)

mock_provider "aws" {
  # Data sources
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "333333333333"
      arn        = "arn:aws:sts::333333333333:assumed-role/agent-bank-deployer/test"
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
    defaults = { arn = "arn:aws:iam::333333333333:role/mock-role" }
  }

  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:us-east-1:333333333333:key/00000000-0000-0000-0000-000000000000"
      key_id = "00000000-0000-0000-0000-000000000000"
    }
  }

  mock_resource "aws_kms_alias" {
    defaults = { arn = "arn:aws:kms:us-east-1:333333333333:alias/mock" }
  }

  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-1:333333333333:mock-topic" }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:333333333333:log-group:/mock" }
  }

  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-1:333333333333:secret:agent-bank/mock-AbCdEf" }
  }

  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:us-east-1:333333333333:cluster/mock" }
  }

  mock_resource "aws_ecr_repository" {
    defaults = {
      arn            = "arn:aws:ecr:us-east-1:333333333333:repository/mock"
      repository_url = "333333333333.dkr.ecr.us-east-1.amazonaws.com/mock"
    }
  }

  mock_resource "aws_lb" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:333333333333:loadbalancer/app/mock/0123456789abcdef"
      arn_suffix = "app/mock/0123456789abcdef"
    }
  }

  mock_resource "aws_lb_target_group" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:333333333333:targetgroup/mock/0123456789abcdef"
      arn_suffix = "targetgroup/mock/0123456789abcdef"
    }
  }

  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:333333333333:listener/app/mock/0123456789abcdef/0123456789abcdef" }
  }

  mock_resource "aws_wafv2_web_acl" {
    defaults = { arn = "arn:aws:wafv2:us-east-1:333333333333:regional/webacl/mock/00000000-0000-0000-0000-000000000000" }
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
      master_user_secret = [{ kms_key_id = "arn:aws:kms:us-east-1:333333333333:key/00000000-0000-0000-0000-000000000000", secret_arn = "arn:aws:secretsmanager:us-east-1:333333333333:secret:rds-mock-AbCdEf", secret_status = "active" }]
    }
  }
}

variables {
  account_id = "333333333333"
  image_tag  = "0123456789abcdef0123456789abcdef01234567"
}

run "plans_on_base_sepolia" {
  command = plan

  variables {
    api_internal_endpoint_service_name = "com.amazonaws.vpce.us-east-1.vpce-svc-0123456789abcdef0"
  }

  assert {
    condition     = output.chain_id == 84532
    error_message = "The sandbox must target Base Sepolia (84532)."
  }
}

run "rejects_base_mainnet" {
  command = plan

  variables {
    chain_id = 8453
  }

  expect_failures = [var.chain_id]
}
