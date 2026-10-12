# Agent Bank infrastructure

OpenTofu (Terraform-compatible) code for the Agent Bank **sandbox** on AWS: three AWS accounts,
one root module per account, plus the reusable modules they are built from.

> **Testnet only. Nothing in this directory may be applied to Base mainnet (chain ID 8453).**
> Every root module rejects any `chain_id` other than Base Sepolia (84532), and there is no
> production environment (see [`envs/production/README.md`](envs/production/README.md)).
> Mainnet stays locked until the Phase 5 gate (legal sign-off, closed audits, verified exit
> tool) and then happens only with a human present. No mainnet keys are created, held or
> requested here.

## Layout

```
infra/
  modules/
    network/              VPC; public/private/database subnets on 2-3 AZ IDs; NAT; VPC endpoints; flow logs
    postgres/             RDS PostgreSQL 16: CMK, TLS-only, PITR, deletion protection, Performance Insights
    ecs-service/          Fargate service: ECR repo, task def, log group, SG, autoscaling, optional ALB rule
    cosigner-kms/         secp256k1 SIGN_VERIFY KMS key, locked-down key policy, key-usage trail + alarms
    secrets/              Secrets Manager containers (no values), per-secret reader allowlists
    observability/        SNS (CMK) + SLO and integrity alarms + dashboard
    audit-log/            S3 Object Lock (COMPLIANCE) archive for the hash-chained audit log
    privatelink-service/  internal NLB + VPC endpoint service (provider side of PrivateLink)
  envs/
    sandbox/
      cosigner/           root module for the co-signer account
      api/                root module for the API account (api, facilitator, console, ledger Postgres)
      indexer/            root module for the indexer account
    production/README.md  why production is intentionally not defined
  docker/healthcheck.cjs  health probe baked into every image by the root Dockerfile
```

## Accounts and trust boundaries

The design doc requires separate cloud accounts for the co-signer, the API and the indexer, and
that no human holds production signing material. Each account is a separate root module, a
separate state file and a separate deploy role. Accounts never share routes: there is no VPC
peering and no transit gateway. Every cross-account call goes through an AWS PrivateLink
endpoint service that allowlists one consumer account and requires explicit acceptance.

```
                 Internet (HTTPS only, AWS WAF)
                              |
+-----------------------------v------------------------------------------------+
| API account                     ALB  /internal/* and /metrics blocked        |
|   api :8080 --------+    facilitator :8083    console :3000 (no AWS creds)   |
|     |   \           +---------+                                              |
|     |    \                    v                                              |
|     |     \        ledger Postgres 16 (isolated subnets)                     |
|     |      +--> interface endpoint ======(PrivateLink)=============+         |
|     |                                                              |         |
|   NLB <-- endpoint service (allows indexer account) <==========+   |         |
+------------------------------------------------------------------|---|------+
                                                                   |   |
+----------------------------------------------+   +---------------|---v------+
| Indexer account                              |   | Co-signer account        |
|   indexer :8082 (single writer)              |   |   no IGW, no NAT         |
|     -> own Postgres                          |   |   endpoint service       |
|     -> RPC via NAT                           |   |    -> NLB -> cosigner    |
|     -> interface endpoint to the API ========+   |       :8081 -> KMS Sign  |
|   alarms: reconciliation mismatch, lag       |   |   audit archive (WORM)   |
+----------------------------------------------+   +--------------------------+
```

| Account       | Holds                                                                                                                                                    | Inbound from                                                            | Outbound to                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **co-signer** | Policy engine + co-signer (Fargate), the secp256k1 KMS key, `COSIGNER_SHARED_SECRET`, the audit archive (S3 Object Lock), key-usage CloudTrail trail     | API account only, via PrivateLink (allowlisted, accepted)               | AWS APIs through VPC endpoints only (KMS, Secrets Manager, ECR, Logs, S3 restricted to ECR layers and its own audit prefix). No internet route exists. |
| **api**       | Public ALB + WAF, `api`, `facilitator`, `console`, ledger PostgreSQL 16, vendor secrets (Pimlico, KYB, screening, RPC, webhook key, testnet relayer key) | Internet (HTTPS); indexer account (only `/internal/*`, via PrivateLink) | Co-signer (PrivateLink), vendors and RPC (NAT), audit archive (S3 API, `api/` prefix, PutObject only)                                                  |
| **indexer**   | Chain indexer + reconciliation worker, its own PostgreSQL, RPC URL, reconciliation and lag alarms                                                        | Nothing                                                                 | RPC provider (NAT), API `/internal/*` (PrivateLink)                                                                                                    |

Properties enforced in code:

- **The bank cannot sign by accident or on purpose.** KMS keys are non-exportable. The key
  policy allows `kms:Sign` and `kms:GetPublicKey` only for the co-signer task role, only with
  `ECDSA_SHA_256` over a digest, and only through the co-signer VPC's KMS endpoint. Explicit
  denies back each rule. The account root gets read-only metadata, so no IAM policy can ever
  grant Sign. Grants are denied. Only the break-glass role, from an MFA session, can disable
  the key or schedule its deletion. ECS Exec is hard-disabled on every service.
- **Fail closed.** The API learns the co-signer's address only from `COSIGNER_URL`. Without
  it, or while the co-signer is down, payments must be refused. The co-signer has its own
  latency, availability and healthy-target alarms in its own account.
- **No secret values in code, plans or state.** Only secret _containers_ are created. Values
  are written out of band. Each secret's resource policy denies `GetSecretValue` to everyone
  except the consuming service's execution role, so operators can write values but cannot
  read them back. RDS master passwords are RDS-managed.
- **Tamper-evident audit.** The hash-chained audit export and the key-usage trail land in an
  S3 Object Lock bucket in COMPLIANCE mode. Writers may only `PutObject` under their own
  prefix, and deletes are denied.
- **Hardened containers.** Distroless runtime, non-root uid 65532, read-only root filesystem,
  all Linux capabilities dropped, init process for signal handling, no public IPs.
- **Mainnet guard.** Every root's `chain_id` variable rejects 8453 and accepts only 84532, and
  `tofu test` proves it.

KMS note: AWS KMS has no CloudTrail _data event_ type. Every KMS call, including each `Sign`,
is a _management_ event. The `cosigner-kms` module therefore creates a dedicated trail that
records all management events (KMS included). It also records S3 data events for the audit
prefixes, delivers to the WORM bucket and CloudWatch Logs, and raises real-time alarms on any
unexpected signer, any key policy or state change, and any denied call against the key.

## Prerequisites

Per account, created by the account baseline (landing zone), not by this code:

- A deploy role, default `agent-bank-deployer`, assumable by CI only (e.g. GitHub OIDC with
  environment protection). It administers the signing key but cannot use it.
- Co-signer account only: a break-glass role, default `agent-bank-break-glass`. It must
  exist before the first apply, because KMS rejects key policies that name unknown principals.
  Require MFA for it and alarm on its use.
- A state bucket per account if you enable the commented S3 backend in each `backend.tf`.
  Locking uses `use_lockfile` (OpenTofu/Terraform >= 1.10) or a DynamoDB table.
- API account: an ACM certificate covering the three public hostnames.
- Recommended org guardrails (SCPs): deny `ecs:ExecuteCommand` in the co-signer account,
  restrict `iam:PassRole` on `agent-bank-sandbox-cosigner-task` and `kms:PutKeyPolicy` to the
  pipeline, and deny leaving the organization or disabling CloudTrail.

Tools: OpenTofu >= 1.6 (>= 1.8 for `tofu test`; the code was validated with 1.13.1) or
Terraform >= 1.6, plus AWS provider `~> 6.68` (lock files pin 6.68.0). The lock files were
written by OpenTofu; Terraform users run `terraform init -upgrade` once.

## Required inputs

| Root                    | Required                                                                                                     | Cross-account inputs (outputs of other roots)                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `envs/sandbox/cosigner` | `account_id`, `api_account_id`, `image_tag`                                                                  | `accepted_api_endpoint_ids` <- api `cosigner_vpc_endpoint_id`                                                                                                                                  |
| `envs/sandbox/api`      | `account_id`, `image_tag`, `api_hostname`, `facilitator_hostname`, `console_hostname`, `alb_certificate_arn` | `cosigner_endpoint_service_name`, `audit_log_bucket_arn`, `audit_log_kms_key_arn` <- cosigner; `indexer_account_id`; `accepted_indexer_endpoint_ids` <- indexer `api_internal_vpc_endpoint_id` |
| `envs/sandbox/indexer`  | `account_id`, `image_tag`                                                                                    | `api_internal_endpoint_service_name` <- api `internal_api_endpoint_service_name`                                                                                                               |

Each root ships a `terraform.tfvars.example`. Real `*.tfvars` files are git-ignored.
`region` defaults to `us-east-1` and must be the same in all three accounts, because
PrivateLink is regional. Subnets are placed by AZ ID; leave `availability_zone_ids` unset
everywhere, or set the same IDs everywhere, so the consumer endpoints land in AZs the
provider NLBs serve.

## Plan and apply

Run from each root with credentials that can assume that account's deploy role. The provider
refuses to operate on any account other than `account_id`.

```sh
cd infra/envs/sandbox/<cosigner|api|indexer>
cp terraform.tfvars.example terraform.tfvars        # fill in
tofu init                                            # after enabling backend.tf
tofu plan -out=tfplan
tofu apply tfplan
```

Use `tofu init -backend=false` for local validation only.

First-time bootstrap. Cross-account links need two passes because each side needs the other's
IDs:

1. **cosigner** (pass 1) with `cosigner_min_count = 0`. Note the outputs
   `cosigner_endpoint_service_name`, `audit_log_bucket_arn` and `audit_log_kms_key_arn`.
2. **api** (pass 1) with those values, `indexer_account_id`, and every
   `service_capacity.*.min = 0`. Note the outputs `cosigner_vpc_endpoint_id` and
   `internal_api_endpoint_service_name`.
3. **cosigner** (pass 2) with `accepted_api_endpoint_ids = [<cosigner_vpc_endpoint_id>]`.
4. **indexer** with `api_internal_endpoint_service_name` and `indexer_enabled = false`. Note
   the output `api_internal_vpc_endpoint_id`.
5. **api** (pass 2) with `accepted_indexer_endpoint_ids = [<api_internal_vpc_endpoint_id>]`.
6. Write secret values (names are in each root's `secret_names` output). The same random value
   goes into both copies of `COSIGNER_SHARED_SECRET` and of `INTERNAL_API_SHARED_SECRET`.
   Build `DATABASE_URL` from an application role you create with the RDS-managed master
   secret.
   ```sh
   aws secretsmanager put-secret-value --secret-id agent-bank-sandbox/api/DATABASE_URL --secret-string file://db-url.txt
   ```
7. Build and push images to each account's ECR (`ecr_repository_url(s)` outputs), then
   re-apply each root with the real `image_tag` and normal task counts.

Images:

```sh
docker build --build-arg APP=cosigner --build-arg GIT_SHA=$(git rev-parse HEAD) -t <cosigner-ecr-url>:$(git rev-parse HEAD) .
```

Repositories use immutable tags, and `image_tag = "latest"` is rejected.

Destroying is deliberately hard. The signing key has `prevent_destroy`, and its key policy lets
only the MFA break-glass role schedule deletion. Locked audit objects, and so the bucket,
outlive the retention period whatever anyone does. RDS has deletion protection and takes a
final snapshot.

## Application contract

What the infrastructure provides to, and expects from, the apps:

| Service     | Port | Env (non-secret)                                                                                                                             | Secrets (Secrets Manager -> env)                                                                                                                                                                                                                                         |
| ----------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| cosigner    | 8081 | `KMS_KEY_ID`, `AUDIT_LOG_BUCKET`, `AUDIT_LOG_PREFIX=cosigner/`, `METRICS_NAMESPACE=AgentBank/Cosigner`                                       | `COSIGNER_SHARED_SECRET`                                                                                                                                                                                                                                                 |
| api         | 8080 | `COSIGNER_URL` (absent = refuse payments), `PUBLIC_BASE_URL`, `AUDIT_LOG_BUCKET`, `AUDIT_LOG_PREFIX=api/`, `METRICS_NAMESPACE=AgentBank/Api` | `DATABASE_URL`, `COSIGNER_SHARED_SECRET`, `PIMLICO_API_KEY`, `WEBHOOK_SIGNING_KEY`, `SCREENING_API_KEY`, `KYB_API_KEY`, `CHAIN_RPC_URL`, `INTERNAL_API_SHARED_SECRET`, `API_RELAYER_KEY` (testnet gas wallet), `PROOFS_ATTESTER_KEY` (registry attester, moves no funds) |
| facilitator | 8083 | `PUBLIC_BASE_URL`, `X402_NETWORK=base-sepolia`, `METRICS_NAMESPACE=AgentBank/Facilitator`                                                    | `DATABASE_URL`, `FACILITATOR_RELAYER_KEY` (testnet gas wallet), `SCREENING_API_KEY`, `CHAIN_RPC_URL`                                                                                                                                                                     |
| console     | 3000 | `API_BASE_URL`, `PUBLIC_BASE_URL`, `HOSTNAME=0.0.0.0` (no AWS credentials)                                                                   | `CONSOLE_SESSION_SECRET`                                                                                                                                                                                                                                                 |
| indexer     | 8082 | `API_INTERNAL_URL`, `RECONCILIATION_WINDOW=20`, `METRICS_NAMESPACE=AgentBank/Indexer`, `RECONCILIATION_METRICS_NS=AgentBank/Reconciliation`  | `DATABASE_URL` (indexer DB), `CHAIN_RPC_URL`, `INTERNAL_API_SHARED_SECRET`                                                                                                                                                                                               |

Every service also gets `NODE_ENV=production`, `APP_ENV=sandbox`, `CHAIN_ID=84532`,
`LOG_LEVEL`, `PORT`, `AWS_REGION` (except console) and `HEALTHCHECK_PATH=/healthz`. Apps must:

- Serve `GET /healthz` on `PORT`, returning 200 when ready. It is used by the container health
  check, the ALB and the NLBs.
- Listen on `0.0.0.0` and exit on SIGTERM within 30 s.
- Write only to `/tmp`; the console may also write to `/app/.next/cache`.
- Authenticate `/internal/*` (indexer to API) and co-signer requests with the shared HMAC
  secrets. The ALB already blocks `/internal/*` and `/metrics` from the internet.
- Publish these metrics without dimensions. CloudWatch Embedded Metric Format (EMF) works with
  no extra permissions, which matters for the co-signer, whose VPC has no monitoring endpoint.

| Namespace                  | Metric                           | Alarm                                                |
| -------------------------- | -------------------------------- | ---------------------------------------------------- |
| `AgentBank/Cosigner`       | `DecisionLatency` (ms)           | p99 > 300 ms in 3 of 5 minutes                       |
| `AgentBank/Cosigner`       | `Requests`, `Errors` (count)     | availability < 99.9% (policy denials are not errors) |
| `AgentBank/Reconciliation` | `UnmatchedEvents` (count)        | any value > 0                                        |
| `AgentBank/Indexer`        | `BlockLag` (blocks)              | > 20 for 3 minutes, or no data                       |
| `AgentBank/Webhooks`       | `DeadLetteredDeliveries` (count) | any value > 0                                        |

AWS-native alarms are also created: API target 5xx rate > 1%, co-signer healthy NLB targets,
ECS running task counts, RDS CPU and free storage, and co-signer key misuse
(`AgentBank/Security`, from the key-usage trail).

## Validation

```sh
cd infra
nix shell nixpkgs#opentofu -c tofu fmt -recursive -check
for root in envs/sandbox/*/; do (cd "$root" && tofu init -backend=false && tofu validate && tofu test); done
(cd modules/cosigner-kms && tofu init -backend=false && tofu test)   # real key policy, offline
(cd modules/audit-log && tofu init -backend=false && tofu test)      # WORM properties, offline
nix shell nixpkgs#tflint -c sh -c 'tflint --init && tflint --recursive'
```

The root tests run a full plan against a mocked AWS provider. They check that each root plans
on Base Sepolia and that `chain_id = 8453` is rejected. The module tests render the real policy
documents offline and assert the co-signing key and audit archive guarantees. No AWS
credentials are needed.

## Sandbox shortcuts to revisit before production

- Two AZs, a single NAT gateway, a single-AZ RDS and a short (30-day) Object Lock retention.
- PrivateLink listeners are TCP pass-through with HMAC request authentication. Production
  should terminate TLS (ACM Private CA certificate on the NLB plus private DNS) or use mTLS.
- The audit archive lives in the co-signer account. Production should use a dedicated
  log-archive account.
- Account baseline items (organization CloudTrail, GuardDuty, Security Hub, AWS Config,
  ALB/WAF access logs) are expected from the landing zone and are not duplicated here.
