# XPAYR Verified AgentPay for GIWA

XPAYR Verified AgentPay is a GIWA Sepolia testnet MVP for policy-controlled AI-agent payments. It verifies required participants through Dojang, binds an exact signed spending policy to a non-custodial escrow job, requires a committed deliverable and human release decision, and exports reproducible settlement evidence.

## The problem

AI agents can initiate work and payments, but counterparty verification, spending authority, delivery proof, human approval, and settlement evidence are usually split across unrelated systems. Merchants cannot safely delegate spending when those controls cannot be reviewed as one lifecycle.

## The product

1. A merchant or agent creates a normalized payment intent.
2. XPAYR returns `ALLOW`, `HOLD`, or `DENY` under a bounded merchant policy.
3. Payer, provider, and optional evaluator addresses must pass the configured Dojang attester policy.
4. The payer funds the exact native-test-ETH amount in the GIWA escrow.
5. The provider commits a deliverable hash.
6. A human merchant or evaluator approves release, dispute, or refund.
7. XPAYR independently verifies the canonical receipt, transaction, terminal event, and on-chain state.
8. A producer-signed evidence record is anchored on GIWA Sepolia.

Flashblocks is used only for fast observed/pending feedback. It never decides completion.

## Why GIWA

- **Dojang Verified Address:** mandatory participant verification at the contract boundary.
- **GIWA-local escrow:** identity signal, job state, and settlement share one chain context.
- **Flashblocks UX:** fast pending feedback with independent canonical confirmation.
- **Wallet-ready lifecycle:** pending jobs, review, approve, release, dispute, refund, and evidence history map naturally to wallet actions.
- **Expansion path:** `up.id`, Verified Code, account abstraction, and paymaster support are program-dependent next steps, not current claims.

## Retained testnet proof

- Network: GIWA Sepolia, chain ID `91342`
- Escrow: [`0x7b0630cBb92be8E11512cb331b8D1aef94cEEc53`](https://sepolia-explorer.giwa.io/address/0x7b0630cBb92be8E11512cb331b8D1aef94cEEc53?tab=contract)
- Release lifecycle: `5/5`, terminal state `RELEASED`
- Refund lifecycle: `4/4`, terminal state `REFUNDED`
- Phase 4 authenticated evidence: `2/2` producer signatures and canonical `XPA2` anchors
- Public package tests: `107/107` Node tests and `11/11` reviewer tests
- Contract tests retained in the package: `36/36` Foundry tests
- Sealed manifest: `81` payload files, `1,557,591` bytes, digest `0x943a30124f5219d34ef0043aeebaea4a60b349a8c0f15649bb31b91239e779ad`

Blockscout reports the source as verified at the expected partial level for a no-CBOR build (`verified_partial_expected_no_cbor`). The project does not claim FULL verification for this immutable deployment.

## Initial users and roadmap

The initial wedge is an API-first escrow and evidence primitive for agent marketplaces, merchants delegating bounded tasks, freelancer or agency workflows, and platforms that require authorization-before-settlement proof.

The GASOK path is: retain and package the testnet MVP; run bounded developer pilots; adapt to confirmed private-network requirements; deepen wallet and identity integrations; then measure job completion, approval latency, refunds, transaction volume, and repeat usage. The current product is pre-pilot and does not claim users, TVL, or production revenue.

## Scope boundaries

This repository does not claim GIWA Mainnet, real customer funds, a canonical stablecoin, KYC/AML decisions, autonomous evaluator release, GIWA Wallet SDK completion, an independent audit, GIWA/Upbit endorsement, or a guaranteed GASOK grant.

Primary application track: **Track 04. AI / WEB3**. GIWA-Native is product positioning, not a second form selection.
