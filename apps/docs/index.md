---
layout: home
title: Agent Bank
titleTemplate: Bank accounts for AI agents

hero:
  name: Agent Bank
  text: Bank accounts for AI agents, with limits that live in code
  tagline: Non-custodial USDC accounts on Base. Your agents pay, get paid, escrow and stream money under rules you set; Agent Bank co-signs within those rules.
  image:
    src: /mark.svg
    alt: Agent Bank mark
  actions:
    - theme: brand
      text: Get started
      link: /get-started/
    - theme: alt
      text: Framework quickstarts
      link: /quickstarts/
    - theme: alt
      text: API reference
      link: /api/

features:
  - title: Claude Agent SDK
    details: Give a Claude agent five money tools through an in-process MCP server, with every built-in tool switched off.
    link: /quickstarts/claude-agent-sdk
    linkText: Quickstart
  - title: OpenAI Agents SDK
    details: Wrap the TypeScript SDK as function tools for an OpenAI agent, with per-payment and per-run limits.
    link: /quickstarts/openai-agents-sdk
    linkText: Quickstart
  - title: Vercel AI SDK
    details: Add Agent Bank tools to generateText with Claude through @ai-sdk/anthropic.
    link: /quickstarts/vercel-ai-sdk
    linkText: Quickstart
  - title: LangChain.js and LangGraph
    details: Build a createAgent graph on Claude with money tools and call-limit middleware.
    link: /quickstarts/langchain
    linkText: Quickstart
  - title: Any MCP client
    details: Run agentbank-mcp over stdio or streamable HTTP and connect Claude Code, Claude Desktop, Cursor or your own host.
    link: /quickstarts/mcp-client
    linkText: Quickstart
  - title: Concepts in 5 minutes
    details: Principals, agents, the three keys, policies, the co-signer and what happens when an agent pays.
    link: /get-started/
    linkText: Read
---

::: warning Pre-release, testnet only
Agent Bank is pre-release software that runs on the **Base Sepolia testnet** only; mainnet chain ids are refused in code. Its smart contracts are **unaudited**. Agent Bank is **not a bank or a money transmitter**: it is non-custodial software, and that position still awaits review by counsel. **Nothing here is legal advice.** See [Regulatory posture](/concepts/regulatory-posture).
:::

## What Agent Bank is

Agent Bank gives every AI agent its own USDC account: a smart-contract wallet on Base that a human or company (the _principal_) owns. The agent pays other agents and addresses, pays for HTTP APIs with [x402](/guides/x402-buyer), charges for its own APIs, locks funds in escrow and streams payments, all under a spending policy the principal sets: per-payment and rolling daily, weekly and monthly caps, allowlists, velocity limits, time windows and human approval thresholds. The rules are enforced twice, by a deterministic policy engine behind Agent Bank's co-signer and by the account's own on-chain session scope, so a prompt-injected agent still cannot overspend. Every movement is recorded in a double-entry ledger and reconciled against the chain, and the owner can always withdraw everything directly on-chain, with or without Agent Bank.

## Three keys, one rule

Each account is controlled by three keys with sharply different powers.

<KeyTrio />

<p class="ab-motto">Agent Bank can <span>refuse</span> a payment, never make one.</p>

An operation is valid if the owner signs it, or if a live session key **and** the co-signer both sign it and the policy hook passes. The co-signer can only add the second signature to something the agent's session key already signed, and only within the scope the owner installed on-chain. See [Accounts and keys](/concepts/accounts-and-keys) and the [security model](/concepts/security-model).

## How a payment works

1. The agent asks to pay (`POST /v1/payments`, signed with its session key).
2. Agent Bank dry-runs the owner's policy, places a hold in the ledger and returns the user operation to sign, or queues it for a human approver.
3. The agent signs the operation hash with its session key.
4. The co-signer, in its own cloud account, decodes the raw operation, re-checks policy against its own spend history and adds the second signature, or refuses.
5. The operation is submitted through the bundler; the smart account checks both signatures and the session scope on-chain.
6. The indexer sees the transfer, the ledger posts the hold, and the payment is `settled`.

![Agent Bank architecture: agents, principals and sellers call the API and facilitator; the policy engine and co-signer run in a separate cloud account; only the agent's own smart account on Base can move money](/architecture-dark.png){.dark-only .figure}
![Agent Bank architecture: agents, principals and sellers call the API and facilitator; the policy engine and co-signer run in a separate cloud account; only the agent's own smart account on Base can move money](/architecture-light.png){.light-only .figure}

## Where to go next

- New here: [Concepts in 5 minutes](/get-started/), then the [local sandbox](/get-started/sandbox).
- Building an agent: pick a [framework quickstart](/quickstarts/) or wire up the [MCP server](/guides/mcp-server).
- Integrating directly: the [TypeScript SDK](/guides/typescript-sdk), the [Python SDK](/guides/python-sdk) or the [REST API](/api/).
- Selling an API per call: [x402: charge for APIs](/guides/x402-seller).
