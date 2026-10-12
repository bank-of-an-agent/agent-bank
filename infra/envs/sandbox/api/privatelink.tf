# Cross-account connectivity of the API account. Accounts never share routes: each link is a
# PrivateLink endpoint service (provider side, allowlisted principals, explicit acceptance)
# plus an interface endpoint (consumer side, security-grouped to a single caller).

# --- Consumer: API -> co-signer (co-signer account) ------------------------------------------------------

resource "aws_security_group" "cosigner_endpoint" {
  count = local.cosigner_enabled ? 1 : 0

  name        = "${local.name}-cosigner-endpoint"
  description = "Interface endpoint to the co-signer PrivateLink service; only the API tasks may use it"
  vpc_id      = module.network.vpc_id

  tags = { Name = "${local.name}-cosigner-endpoint" }
}

resource "aws_vpc_security_group_ingress_rule" "cosigner_endpoint_from_api" {
  count = local.cosigner_enabled ? 1 : 0

  security_group_id            = aws_security_group.cosigner_endpoint[0].id
  description                  = "Co-sign requests from the API tasks"
  ip_protocol                  = "tcp"
  from_port                    = var.cosigner_endpoint_port
  to_port                      = var.cosigner_endpoint_port
  referenced_security_group_id = module.api.security_group_id
}

resource "aws_vpc_endpoint" "cosigner" {
  count = local.cosigner_enabled ? 1 : 0

  vpc_id              = module.network.vpc_id
  service_name        = var.cosigner_endpoint_service_name
  vpc_endpoint_type   = "Interface"
  subnet_ids          = module.network.private_subnet_ids
  security_group_ids  = [aws_security_group.cosigner_endpoint[0].id]
  private_dns_enabled = false

  tags = { Name = "${local.name}-to-cosigner" }
}

# --- Provider: API /internal/* -> indexer account ---------------------------------------------------------

module "internal_api_endpoint_service" {
  source = "../../../modules/privatelink-service"
  count  = local.internal_api_enabled ? 1 : 0

  name                   = "${local.prefix}-api-int"
  vpc_id                 = module.network.vpc_id
  vpc_cidr_block         = module.network.vpc_cidr_block
  subnet_ids             = module.network.private_subnet_ids
  target_port            = local.ports.api
  allowed_principal_arns = ["arn:${local.partition}:iam::${var.indexer_account_id}:root"]
  acceptance_required    = true
  accepted_endpoint_ids  = var.accepted_indexer_endpoint_ids
}
