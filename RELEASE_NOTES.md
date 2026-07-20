# v0.1.0-gasok-demo

This release publishes the public reviewer snapshot and a 158-second English silent walkthrough of the retained GIWA Sepolia evidence for XPAYR Verified AgentPay.

## Assets

### `xpayr-verified-agentpay-giwa-retained-evidence-demo.mp4`

- SHA-256: `66bddf05a9b24352dfaae58e1c08e18cdcadbaf3cd85cf9a8b8d3962b08176b5`
- Size: `2,104,393` bytes
- Media: `158.000s`, `1280x720`, `25 fps`, H.264 `yuv420p`, one video stream, no audio
- Purpose: retained-evidence walkthrough; no new wallet transaction or chain write was produced for the video

The video visibly separates the local fixture UX from the retained GIWA Sepolia evidence. The fixture is labeled `NOT CHAIN PROOF`; the evidence section shows chain `91342`, native test ETH, distinct policy/evidence roles, release `5/5`, refund `4/4` with `payment_completed=false`, both canonical `XPA2` anchors, and the expected no-CBOR partial source-verification level.

### `xpayr-verified-agentpay-giwa-sepolia-reviewer-20260720.zip`

- SHA-256: `e29df49f1bc1a09bb6fdb4d2dcb1011bbd166f4a03f2570490a87e40a69eeb71`
- Size: `458,609` bytes
- ZIP entries: `82`
- Reviewer payload files: `81`
- Reviewer payload bytes: `1,557,591`
- Canonical manifest digest: `0x943a30124f5219d34ef0043aeebaea4a60b349a8c0f15649bb31b91239e779ad`
- Manifest file SHA-256: `872b3b990be48f8ab1f6c35c1fc481176353d41fc664abcc94e788cf6c6e0d6a`

Run the package verifier before dependency installation:

```bash
node scripts/verify-reviewer-package.mjs --package-root .
```

The same sealed snapshot is available in this repository under `reviewer-package/`.

## Verified scope

- GIWA Sepolia, chain ID `91342`
- Escrow `0x7b0630cBb92be8E11512cb331b8D1aef94cEEc53`
- Release lifecycle: `5/5`, `RELEASED`, payment completed
- Refund lifecycle: `4/4`, `REFUNDED`, payment not completed
- Phase 4 evidence authentication: two producer signatures and two canonical zero-value `XPA2` anchors
- Source visibility: `verified_partial_expected_no_cbor`; no FULL-verification claim

## Boundaries

This is a testnet reviewer release. It does not claim GIWA Mainnet, production service, real customer funds, stablecoin support, KYC/AML decisions, autonomous AI release, a completed GIWA Wallet integration, an independent audit, GIWA/Upbit endorsement, or a guaranteed GASOK grant.
