# Provider side of an AWS PrivateLink service: an internal NLB in front of ECS tasks, exposed
# as a VPC endpoint service that only allowlisted principals in other accounts can connect to.
# There is no VPC peering, transit gateway or shared routing between accounts: consumers get
# an ENI in their own VPC that reaches this listener and nothing else.

locals {
  tls           = var.certificate_arn != null
  listener_port = var.listener_port != null ? var.listener_port : (local.tls ? 443 : var.target_port)
}

resource "aws_security_group" "nlb" {
  name        = "${var.name}-nlb"
  description = "PrivateLink NLB for ${var.name}"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, { Name = "${var.name}-nlb" })
}

# PrivateLink traffic is admitted by the endpoint service's allowed principals (inbound rules
# are not enforced for it, see the NLB below), so the only rule needed is egress to targets.
resource "aws_vpc_security_group_egress_rule" "nlb_to_targets" {
  security_group_id = aws_security_group.nlb.id
  description       = "Forwarded requests and health checks to targets"
  ip_protocol       = "tcp"
  from_port         = var.target_port
  to_port           = var.target_port
  cidr_ipv4         = var.vpc_cidr_block
}

resource "aws_lb" "this" {
  name                             = "${var.name}-pl"
  load_balancer_type               = "network"
  internal                         = true
  subnets                          = var.subnet_ids
  security_groups                  = [aws_security_group.nlb.id]
  enable_cross_zone_load_balancing = true
  enable_deletion_protection       = var.deletion_protection

  enforce_security_group_inbound_rules_on_private_link_traffic = "off"

  tags = var.tags
}

resource "aws_lb_target_group" "this" {
  name                 = "${var.name}-pl"
  port                 = var.target_port
  protocol             = "TCP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = "30"

  connection_termination = true

  health_check {
    enabled             = true
    protocol            = "HTTP"
    path                = var.health_check_path
    port                = "traffic-port"
    matcher             = "200"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }

  tags = var.tags
}

resource "aws_lb_listener" "this" {
  load_balancer_arn = aws_lb.this.arn
  port              = local.listener_port
  protocol          = local.tls ? "TLS" : "TCP"
  certificate_arn   = var.certificate_arn
  ssl_policy        = local.tls ? var.ssl_policy : null

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }

  tags = var.tags
}

resource "aws_vpc_endpoint_service" "this" {
  acceptance_required        = var.acceptance_required
  network_load_balancer_arns = [aws_lb.this.arn]
  allowed_principals         = var.allowed_principal_arns
  supported_ip_address_types = ["ipv4"]

  tags = merge(var.tags, { Name = var.name })
}

resource "aws_vpc_endpoint_connection_accepter" "this" {
  for_each = toset(var.accepted_endpoint_ids)

  vpc_endpoint_service_id = aws_vpc_endpoint_service.this.id
  vpc_endpoint_id         = each.value
}
