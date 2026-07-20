# GIWA Sepolia reviewer package

This directory can produce a deterministic, public-safe review bundle for the retained XPAYR Verified AgentPay GIWA Sepolia proof set.

## Build and verify

From the project root:

```bash
npm run reviewer:build
npm run reviewer:verify
```

The ignored output is `generated/giwa-sepolia-reviewer-package/`. Its `reviewer-manifest.json` records every copied path, exact byte length and SHA-256 digest. The manifest itself is sealed with the project's canonical JSON algorithm. Re-running the build without changing an allowlisted source produces the same package contents and manifest digest.

The copied verifier is self-contained within the bundle and can be run from the bundle root:

```bash
node scripts/verify-reviewer-package.mjs --package-root .
```

Verification fails closed on a missing, modified or extra file; a digest mismatch; a symlink; a forbidden path class; secret-like content; a private journal or lease; or serialized raw signed transaction material. It also reads and validates the packaged allowlist instead of trusting the manifest alone: package metadata, network binding, limits, boundaries and the exact ordered file set must match. Recomputing a manifest to smuggle an extra file therefore fails. The builder verifies the identity of an existing output package before replacement and refuses to delete unrelated or invalid output.

## Inclusion boundary

Only exact paths in `config/reviewer-package.allowlist.json` are eligible. The allowlist and the generated manifest—not this prose—are authoritative for the exact current contents. The current allowlist contains `81` files. Its scope covers the reviewer guide; runnable local UI/server and browser-wallet sources; the contract source and compiler artifact; public network/deployment configuration; the active public authority profile; the sealed reviewer index; public D1/D2/D3 evidence; historical and Phase 4 signed-policy/lifecycle/authenticated records; bounded public funding evidence; and the lifecycle/reviewer verification tests. The sealed reviewer-index canonical payload digest is `0x30e5f155ac7b4caeee4a8b149ff653f9c4b82b220b777c09a6344f4cf99e2be5`.

It intentionally excludes:

- signer files, private keys, environment files, keystores and access tokens;
- deployment/lifecycle/authentication journals, locks and resume leases;
- raw signed transactions, caches, dependencies and local process state;
- screenshots, fixture video and any claim of a published public demo;
- Mainnet, real customer funds, public-repository publication or GASOK submission claims.

Public EOA signatures, transaction hashes, calldata used by the evidence anchor, contract bytecode and canonical receipts are verification data, not private signer material. The package proves only the bounded retained GIWA Sepolia testnet result described by the reviewer index. Its auth-v1 artifacts use the disclosed historical same-EOA authority model; its Phase 4 auth-v2 artifacts use the distinct configured policy-authority and evidence-producer EOAs and remain limited to their exact profile/policy/lifecycle/file bindings.

The allowlisted negative security tests deliberately contain synthetic private-key-shaped and secret-placeholder literals to prove that the builder rejects populated unsafe input. These fixed test vectors are constructed in test source, are not loaded by any runtime path, and are not signer-derived credentials. Secret review must distinguish those explicit rejection fixtures from operative signer material; the latter is absent.

Phase 4 activates the sealed `phase4_sod_v1` profile, digest `0x766385f57fa89d679c5c8fc0222f5b765baceeb9899707b5fafe8df3fc881187`, with policy authority `0x89128251A3B46328Dc89A13B58C1339217B2fD34` and evidence producer `0x79E5c4591691a8369CE4537c25cF1aa3DDe65b45`. The allowlisted release lifecycle `evidence/lifecycle/phase4-sod-release-20260720t134245599z-efaa5ce2-lifecycle.evidence.json` completed `5/5` canonical steps with digest `0x9558da912bcba7998a65585aeaa61f2b11edd1e45bbfdbb42386f090542f1fbc` and terminal [`RELEASED` transaction](https://sepolia-explorer.giwa.io/tx/0x66695b08f17e9be7838ec1ab1cb08bb25259e0a9dc496ee1dc1070eca554c92e). Its auth-v2 sidecar digest is `0xc845c36b59294271b91ac5cf4780e4f276aa362fe7ad7f0e61c0cec571e7ded7`, with canonical [`XPA2` anchor](https://sepolia-explorer.giwa.io/tx/0x4463689c212a93a679e8f3ce1209d2d86d1f522a6798bc6de151a63174558ba9).

The allowlisted refund lifecycle `evidence/lifecycle/phase4-sod-refund-20260720t134245599z-cd885085-lifecycle.evidence.json` completed `4/4` canonical steps with digest `0x04a6552104ef92927ed7327669aa20f060672036cd3a3e2d794cdd13e938447e` and terminal [`REFUNDED` transaction](https://sepolia-explorer.giwa.io/tx/0x3f58ca24da8c6f5a729212207feeb14514dbb624be6ddd21e2189230137d6355). Its auth-v2 sidecar digest is `0xffd002fbc16b56752559a2483c7bacd5766fffc2ad53a61f7e0db8774053a1d4`, with canonical [`XPA2` anchor](https://sepolia-explorer.giwa.io/tx/0x8696c471adf870f2268515537c7be7f6989e8c5011c38256e846b56278807650). Both sidecars report `overall_authenticated=true`. This proves cryptographic control of the named distinct testnet EOAs for the exact retained bindings, not separate organizations, independent human review, legal identity, or production custody.

The checked-in allowlist exports the Phase 4 artifacts, and the final post-documentation `reviewer:build` plus independent `reviewer:verify` succeeded for all `81` files. `reviewer-manifest.json` is authoritative for the final package digest, byte count, and per-file hashes. The package has not been published or submitted to GASOK.

The deterministic `live_wallet` UI smoke is also outside the chain-proof claim. It used a stub provider to obtain direct `ALLOW`, decode a bounded `createJob` preview and cancel before broadcast, with `eth_sendTransaction=0`. It does not prove a real wallet signature, transaction, receipt or new G3 lifecycle. The reviewer bundle does not prove organizational identity, independent attestation, production readiness, publication or GASOK submission.
