<div align="center">
  <a href="https://xpayr.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://xpayr.com/public/images/xpayr-logo-white.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://xpayr.com/public/images/xpayr-logo-black.png" />
      <img src="https://xpayr.com/public/images/xpayr-logo-white.png" alt="XPayr Official Logo" width="220" />
    </picture>
  </a>
  <p>
    <a href="https://xpayr.com"><img src="https://xpayr.com/partner-badge.php?type=powered_by&theme=dark" alt="Powered by XPayr" height="28" /></a>
    <a href="https://mcp.xpayr.com"><img src="https://img.shields.io/badge/MCP_Portal-mcp.xpayr.com-029bfd?style=for-the-badge" alt="XPayr MCP Portal" height="28" /></a>
    <a href="https://docs.xpayr.com"><img src="https://img.shields.io/badge/Docs-docs.xpayr.com-10b981?style=for-the-badge" alt="XPayr Docs" height="28" /></a>
    <a href="https://www.npmjs.com/package/@xpayr/mcp-server"><img src="https://img.shields.io/npm/v/@xpayr/mcp-server?style=for-the-badge&color=cb3837&label=MCP%20NPM" alt="NPM @xpayr/mcp-server" height="28" /></a>
  </p>
  <p>
    <a href="https://xpayr.com"><b>Official Website</b></a> •
    <a href="https://mcp.xpayr.com"><b>AI &amp; MCP Portal (21 Tools)</b></a> •
    <a href="https://docs.xpayr.com"><b>Developer Docs</b></a> •
    <a href="https://xpayr.com/developers"><b>Developer Hub</b></a> •
    <a href="https://xpayr.com/tools/crypto-payment-fee-calculator"><b>0.5% Fee Calculator</b></a>
  </p>
</div>

---

# XPAYR Verified AgentPay for GIWA

[![Reviewer package CI](https://github.com/xpayrcom/xpayr-verified-agentpay-giwa/actions/workflows/ci.yml/badge.svg)](https://github.com/xpayrcom/xpayr-verified-agentpay-giwa/actions/workflows/ci.yml)

XPAYR Verified AgentPay is a testnet-only prototype for policy-controlled AI-agent jobs on GIWA Sepolia. It combines Dojang address verification, a non-custodial escrow state machine, canonical receipt verification, signed policy evidence, and producer-signed/on-chain-anchored evidence records.

## Reviewer entry points

- [One-page product and evidence overview](ONE_PAGER.md)
- [GASOK pitch deck (PDF)](deck/xpayr-verified-agentpay-gasok-deck.pdf)
- [GASOK English form package](GASOK_SUBMISSION.md)
- [Reviewer package overview](reviewer-package/README.md)
- [Escrow contract](reviewer-package/contracts/XPayrVerifiedAgentEscrow.sol)
- [Sealed reviewer index](reviewer-package/evidence/giwa-sepolia-reviewer-index-20260720.json)
- [Reviewer manifest](reviewer-package/reviewer-manifest.json)
- [Phase 4 release lifecycle](reviewer-package/evidence/lifecycle/phase4-sod-release-20260720t134245599z-efaa5ce2-lifecycle.evidence.json) and [auth-v2 sidecar](reviewer-package/evidence/authenticated/phase4-sod-release-20260720t134245599z-efaa5ce2-lifecycle.auth-v2.json)
- [Phase 4 refund lifecycle](reviewer-package/evidence/lifecycle/phase4-sod-refund-20260720t134245599z-cd885085-lifecycle.evidence.json) and [auth-v2 sidecar](reviewer-package/evidence/authenticated/phase4-sod-refund-20260720t134245599z-cd885085-lifecycle.auth-v2.json)
- [Security model](reviewer-package/SECURITY.md), [threat model](reviewer-package/THREAT_MODEL.md), and [test report](reviewer-package/TEST_REPORT.md)

The `reviewer-package/` directory is the exact sealed reviewer snapshot. Its manifest covers every payload file by path, byte length, and SHA-256 digest. Repository-level files outside that directory are intentionally outside the sealed payload.

Several sealed documents preserve their pre-publication checkpoint wording by design. They were not rewritten after the snapshot was signed and manifested. Current repository and release status is stated only in this root README and [RELEASE_NOTES.md](RELEASE_NOTES.md); GASOK form submission remains a separate applicant-controlled action.

## Verify locally

Node.js 22 or later is required.

```bash
node reviewer-package/scripts/verify-reviewer-package.mjs --package-root reviewer-package
npm --prefix reviewer-package ci
npm --prefix reviewer-package test
npm --prefix reviewer-package audit --omit=dev --audit-level=high
```

Run the integrity verifier before dependency installation: it intentionally rejects runtime additions such as `node_modules/` inside the sealed package directory.

## Scope and status

This repository demonstrates bounded GIWA Sepolia behavior using native test ETH. It does not claim a Mainnet deployment, production service, stablecoin support, real customer funds, KYC/AML decisions, autonomous AI fund release, an independent audit, or GIWA/Upbit endorsement.

The [`v0.1.0-gasok-demo` release](https://github.com/xpayrcom/xpayr-verified-agentpay-giwa/releases/tag/v0.1.0-gasok-demo) contains an English silent retained-evidence walkthrough produced without a new transaction and the sealed transfer ZIP. Exact asset hashes and media/package metadata are recorded in [RELEASE_NOTES.md](RELEASE_NOTES.md). The included [demo script](reviewer-package/DEMO_SCRIPT.md) is reviewer material and is not by itself chain evidence or a new transaction.

## License

Licensed under the [MIT License](LICENSE).
