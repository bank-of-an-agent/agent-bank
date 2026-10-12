# Public edge: one internet-facing ALB, HTTPS only (TLS 1.2+), host-based routing to the three
# services (rules are created by the ecs-service module), AWS WAF in front.

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public ALB for ${local.name}"
  vpc_id      = module.network.vpc_id

  tags = { Name = "${local.name}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from the internet"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from the internet (redirected to HTTPS)"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_services" {
  for_each = local.ports

  security_group_id = aws_security_group.alb.id
  description       = "To ${each.key} tasks"
  ip_protocol       = "tcp"
  from_port         = each.value
  to_port           = each.value
  cidr_ipv4         = module.network.vpc_cidr_block
}

resource "aws_lb" "public" {
  name                       = "${local.name}-public"
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = module.network.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  desync_mitigation_mode     = "strictest"
  enable_http2               = true
  idle_timeout               = 60
  enable_deletion_protection = var.alb_deletion_protection
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.public.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.public.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.alb_certificate_arn

  routing_http_response_server_enabled                         = false
  routing_http_response_strict_transport_security_header_value = "max-age=63072000; includeSubDomains"
  routing_http_response_x_content_type_options_header_value    = "nosniff"

  # Unknown hosts get an RFC 9457 problem document, never a backend.
  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "application/json"
      status_code  = "404"
      message_body = jsonencode({ type = "about:blank", title = "Not Found", status = 404 })
    }
  }
}

# Internal and operational routes are never served publicly, whatever the host. The indexer
# reaches /internal/* through its own PrivateLink endpoint instead (privatelink.tf).
resource "aws_lb_listener_rule" "block_internal_paths" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 1

  action {
    type = "fixed-response"

    fixed_response {
      content_type = "application/json"
      status_code  = "404"
      message_body = jsonencode({ type = "about:blank", title = "Not Found", status = 404 })
    }
  }

  condition {
    path_pattern {
      values = ["/internal", "/internal/*", "/metrics", "/metrics/*"]
    }
  }
}

# --- WAF ---------------------------------------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "public" {
  count = var.enable_waf ? 1 : 0

  name        = "${local.name}-public"
  description = "Agent Bank sandbox public edge"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-common"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-ip-reputation"
    priority = 30

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-ip-reputation"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-limit-per-ip"
    priority = 40

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_rate_limit_per_5_minutes
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit-per-ip"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-public"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "public" {
  count = var.enable_waf ? 1 : 0

  resource_arn = aws_lb.public.arn
  web_acl_arn  = aws_wafv2_web_acl.public[0].arn
}

# --- DNS (optional) ------------------------------------------------------------------------------------------------

resource "aws_route53_record" "public" {
  for_each = var.route53_zone_id == null ? {} : {
    api         = var.api_hostname
    facilitator = var.facilitator_hostname
    console     = var.console_hostname
  }

  zone_id = var.route53_zone_id
  name    = each.value
  type    = "A"

  alias {
    name                   = aws_lb.public.dns_name
    zone_id                = aws_lb.public.zone_id
    evaluate_target_health = true
  }
}
