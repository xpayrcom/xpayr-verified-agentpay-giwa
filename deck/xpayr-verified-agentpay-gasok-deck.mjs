import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Presentation,
  PresentationFile,
  image,
  layers,
  shape,
  text,
} from "@oai/artifact-tool";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.AGENTPAY_DECK_OUTPUT_DIR || SCRIPT_DIR;
const ASSET_DIR = process.env.AGENTPAY_DECK_ASSET_DIR || path.join(SCRIPT_DIR, "assets");
const RENDER_DIR = process.env.AGENTPAY_DECK_RENDER_DIR || path.join(OUTPUT_DIR, "rendered");
const PPTX_PATH =
  process.env.AGENTPAY_DECK_PPTX ||
  path.join(OUTPUT_DIR, "xpayr-verified-agentpay-gasok-deck.pptx");

const COLORS = {
  canvas: "#FBFBF8",
  ink: "#102A30",
  muted: "#536970",
  panel: "#EEF2F0",
  rule: "#A9B8B5",
  teal: "#168A83",
  mint: "#BFE8DB",
  coral: "#D64A3A",
  white: "#FFFFFF",
};

const FONT = "Helvetica Neue";
const MONO = "Courier New";
const PAGE = { left: 41.33, top: 36.12, width: 1197.34, height: 648.55 };

function textNode(value, position, style = {}, name = "text") {
  return text([value], {
    name,
    position,
    width: position.width,
    height: position.height,
    style: {
      fontSize: "18px",
      typeface: FONT,
      color: COLORS.ink,
      alignment: "left",
      verticalAlignment: "top",
      autoFit: "none",
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      ...style,
    },
  });
}

function lineNode(name, left, top, width, fill = COLORS.rule, weight = 1) {
  return shape({
    name,
    geometry: "straightConnector1",
    fill: "none",
    line: { style: "solid", width: weight, fill },
    position: { left, top },
    width,
    height: 0.03,
  });
}

function rectNode(name, left, top, width, height, fill, line = "none") {
  return shape({
    name,
    geometry: "rect",
    fill,
    line:
      line === "none"
        ? { style: "solid", width: 0, fill: "none" }
        : { style: "solid", width: 1, fill: line },
    position: { left, top },
    width,
    height,
  });
}

function circleNode(name, left, top, size, fill) {
  return shape({
    name,
    geometry: "ellipse",
    fill,
    line: { style: "solid", width: 0, fill: "none" },
    position: { left, top },
    width: size,
    height: size,
  });
}

function footerNode(pageNumber) {
  return textNode(
    String(pageNumber).padStart(2, "0"),
    { left: 1184.18, top: 661, width: 54.48, height: 18 },
    {
      fontSize: "13px",
      alignment: "right",
      verticalAlignment: "bottom",
      color: COLORS.muted,
    },
    `footer-${pageNumber}`,
  );
}

function slideTitle(value, pageNumber) {
  return textNode(
    value,
    { left: 41.33, top: 36.12, width: 1120, height: 96 },
    { fontSize: "40px", color: COLORS.ink, bold: true },
    `title-${pageNumber}`,
  );
}

function addSlide(presentation, name, nodes) {
  const slide = presentation.slides.add();
  slide.background.fill = COLORS.canvas;
  slide.compose(
    layers({ name, width: "fill", height: "fill" }, nodes),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

function buildCover(presentation) {
  return addSlide(presentation, "layout-01-cover", [
    rectNode("cover-accent", 41.33, 118, 146, 5, COLORS.coral),
    textNode(
      "XPAYR  /  GASOK",
      { left: 41.33, top: 41.18, width: 420, height: 32 },
      { fontSize: "18px", bold: true, color: COLORS.teal },
      "cover-eyebrow",
    ),
    textNode(
      "TRACK 04  /  AI / WEB3",
      { left: 860, top: 41.18, width: 378.67, height: 32 },
      { fontSize: "17px", bold: true, alignment: "right", color: COLORS.muted },
      "cover-track",
    ),
    textNode(
      "Verified AgentPay\nfor GIWA",
      { left: 41.33, top: 172, width: 1040, height: 248 },
      { fontSize: "76px", bold: true, color: COLORS.ink, verticalAlignment: "bottom" },
      "cover-title",
    ),
    textNode(
      "Policy-controlled, non-custodial escrow for AI-agent work —\nwith retained GIWA Sepolia evidence.",
      { left: 41.33, top: 486, width: 840, height: 84 },
      { fontSize: "28px", color: COLORS.muted },
      "cover-subtitle",
    ),
    lineNode("cover-bottom-rule", 41.33, 630, 1197.34, COLORS.rule, 1),
    textNode(
      "GIWA Sepolia  •  Chain 91342  •  Human release authority  •  Canonical receipts",
      { left: 41.33, top: 646, width: 980, height: 24 },
      { fontSize: "15px", color: COLORS.muted },
      "cover-proof-line",
    ),
  ]);
}

function buildProblem(presentation) {
  return addSlide(presentation, "layout-05-two-column-problem", [
    slideTitle("AI agents can pay. Trust still breaks between systems.", 2),
    lineNode("problem-title-rule", 41.33, 126, 1197.34, COLORS.rule, 1),
    textNode(
      "FRAGMENTED TODAY",
      { left: 41.33, top: 174, width: 300, height: 28 },
      { fontSize: "16px", bold: true, color: COLORS.coral },
      "problem-left-label",
    ),
    textNode(
      "Counterparty identity\nSpend authority\nDelivery status\nRelease approval",
      { left: 41.33, top: 222, width: 520, height: 220 },
      { fontSize: "31px", bold: true, color: COLORS.ink },
      "problem-left-list",
    ),
    textNode(
      "Each answer usually lives in a different wallet, policy service, workflow, or audit log.",
      { left: 41.33, top: 480, width: 520, height: 76 },
      { fontSize: "20px", color: COLORS.muted },
      "problem-left-body",
    ),
    lineNode("problem-column-divider", 632, 174, 0.03, COLORS.rule, 1),
    rectNode("problem-right-mark", 671, 174, 6, 345, COLORS.teal),
    textNode(
      "TRUST BOUND TO THE PAYMENT",
      { left: 707, top: 174, width: 470, height: 28 },
      { fontSize: "16px", bold: true, color: COLORS.teal },
      "problem-right-label",
    ),
    textNode(
      "One intent.\nOne policy decision.\nOne canonical receipt.",
      { left: 707, top: 222, width: 500, height: 206 },
      { fontSize: "36px", bold: true, color: COLORS.ink },
      "problem-right-claim",
    ),
    textNode(
      "AgentPay makes identity, authorization, escrow state, delivery proof, and human release reviewable as one transaction-bound evidence trail.",
      { left: 707, top: 460, width: 500, height: 108 },
      { fontSize: "20px", color: COLORS.muted },
      "problem-right-body",
    ),
    footerNode(2),
  ]);
}

function buildWorkflow(presentation) {
  const columns = [41.33, 452.33, 864.33];
  return addSlide(presentation, "layout-17-three-stage-workflow", [
    slideTitle("Guarded workflow binds policy, escrow, and evidence.", 3),
    textNode(
      "REQUEST  →  VERIFY  →  POLICY  →  FUND  →  SUBMIT  →  RELEASE / REFUND",
      { left: 41.33, top: 128, width: 1197.34, height: 34 },
      { fontSize: "17px", bold: true, color: COLORS.teal },
      "workflow-sequence",
    ),
    lineNode("workflow-timeline", 41.33, 338, 1197.34, COLORS.ink, 1),
    ...columns.map((left, index) =>
      circleNode(`workflow-dot-${index + 1}`, left, 331.5, 14, index === 1 ? COLORS.coral : COLORS.teal),
    ),
    textNode(
      "01  IDENTIFY",
      { left: columns[0], top: 282, width: 260, height: 28 },
      { fontSize: "17px", bold: true, color: COLORS.teal },
      "workflow-label-1",
    ),
    textNode(
      "02  CONTROL",
      { left: columns[1], top: 282, width: 260, height: 28 },
      { fontSize: "17px", bold: true, color: COLORS.coral },
      "workflow-label-2",
    ),
    textNode(
      "03  SETTLE",
      { left: columns[2], top: 282, width: 260, height: 28 },
      { fontSize: "17px", bold: true, color: COLORS.teal },
      "workflow-label-3",
    ),
    textNode(
      "Verify the parties",
      { left: columns[0], top: 382, width: 340, height: 44 },
      { fontSize: "27px", bold: true },
      "workflow-heading-1",
    ),
    textNode(
      "Merchant creates a job. Payer and provider are checked through Dojang testnet attestations.",
      { left: columns[0], top: 442, width: 340, height: 112 },
      { fontSize: "19px", color: COLORS.muted },
      "workflow-body-1",
    ),
    textNode(
      "Constrain the agent",
      { left: columns[1], top: 382, width: 340, height: 44 },
      { fontSize: "27px", bold: true },
      "workflow-heading-2",
    ),
    textNode(
      "XPAYR returns ALLOW, HOLD, or DENY. Only an allowed intent can fund the non-custodial escrow.",
      { left: columns[1], top: 442, width: 340, height: 112 },
      { fontSize: "19px", color: COLORS.muted },
      "workflow-body-2",
    ),
    textNode(
      "Finish canonically",
      { left: columns[2], top: 382, width: 340, height: 44 },
      { fontSize: "27px", bold: true },
      "workflow-heading-3",
    ),
    textNode(
      "Provider submits a delivery hash. Human approval releases—or a bounded terminal path refunds—and XPA2 seals the evidence.",
      { left: columns[2], top: 442, width: 340, height: 128 },
      { fontSize: "19px", color: COLORS.muted },
      "workflow-body-3",
    ),
    footerNode(3),
  ]);
}

function buildWhyGiwa(presentation) {
  return addSlide(presentation, "layout-13-giwa-native-grid", [
    slideTitle("GIWA is part of the product logic—not a network toggle.", 4),
    lineNode("giwa-grid-v", 640, 166, 0.03, COLORS.rule, 1),
    lineNode("giwa-grid-h", 41.33, 400, 1197.34, COLORS.rule, 1),
    textNode(
      "01  DOJANG VERIFIED ADDRESS",
      { left: 41.33, top: 174, width: 520, height: 30 },
      { fontSize: "16px", bold: true, color: COLORS.teal },
      "giwa-cell-label-1",
    ),
    textNode(
      "Participant checks are bound to the job. Current proof is a TESTNET_FAUCET attestation with test_only=true—not KYC.",
      { left: 41.33, top: 224, width: 530, height: 120 },
      { fontSize: "20px", color: COLORS.ink },
      "giwa-cell-body-1",
    ),
    textNode(
      "02  GIWA SEPOLIA ESCROW",
      { left: 676, top: 174, width: 520, height: 30 },
      { fontSize: "16px", bold: true, color: COLORS.teal },
      "giwa-cell-label-2",
    ),
    textNode(
      "The lifecycle executes on chain 91342 in an XPAYR escrow contract, preserving participant and human-release authority.",
      { left: 676, top: 224, width: 520, height: 120 },
      { fontSize: "20px", color: COLORS.ink },
      "giwa-cell-body-2",
    ),
    textNode(
      "03  FLASHBLOCKS FEEDBACK",
      { left: 41.33, top: 428, width: 520, height: 30 },
      { fontSize: "16px", bold: true, color: COLORS.coral },
      "giwa-cell-label-3",
    ),
    textNode(
      "A fast signal can improve pending UX. Completion is claimed only after the canonical transaction receipt is verified.",
      { left: 41.33, top: 478, width: 530, height: 116 },
      { fontSize: "20px", color: COLORS.ink },
      "giwa-cell-body-3",
    ),
    textNode(
      "04  GIWA WALLET PATH",
      { left: 676, top: 428, width: 520, height: 30 },
      { fontSize: "16px", bold: true, color: COLORS.coral },
      "giwa-cell-label-4",
    ),
    textNode(
      "Pending jobs, approve, release, refund, and dispute are designed for a native wallet surface. Integration is the next phase—not a shipped claim.",
      { left: 676, top: 478, width: 520, height: 116 },
      { fontSize: "20px", color: COLORS.ink },
      "giwa-cell-body-4",
    ),
    textNode(
      "GIWA Sepolia  •  Chain 91342  •  Escrow 0x7b0630cBb92be8E11512cb331b8D1aef94cEEc53",
      { left: 41.33, top: 624, width: 1085, height: 24 },
      { fontSize: "15px", color: COLORS.muted, typeface: MONO },
      "giwa-contract-footer",
    ),
    footerNode(4),
  ]);
}

function buildProduct(presentation, screenshotBytes) {
  return addSlide(presentation, "layout-08-product-image-split", [
    textNode(
      "The shipped MVP shows the full reviewer flow.",
      { left: 41.33, top: 36.12, width: 560, height: 96 },
      { fontSize: "40px", bold: true },
      "product-title",
    ),
    textNode(
      "AVAILABLE NOW",
      { left: 41.33, top: 156, width: 300, height: 28 },
      { fontSize: "16px", bold: true, color: COLORS.teal },
      "product-label",
    ),
    textNode(
      "Create a bounded agent intent\nVerify payer and provider\nReturn ALLOW / HOLD / DENY\nFund and control non-custodial escrow\nOpen retained evidence and explorer links",
      { left: 41.33, top: 206, width: 540, height: 250 },
      { fontSize: "22px", color: COLORS.ink },
      "product-list",
    ),
    rectNode("product-boundary-mark", 41.33, 518, 6, 108, COLORS.coral),
    textNode(
      "Scope boundary\nTestnet only—no mainnet, real funds, stablecoin claim, autonomous evaluator release, GIWA Wallet implementation, or grant-outcome claim.",
      { left: 67, top: 518, width: 534, height: 108 },
      { fontSize: "16px", color: COLORS.muted, bold: false },
      "product-boundary",
    ),
    rectNode("product-image-backing", 658.17, 41.62, 581.6, 588.14, COLORS.panel, COLORS.rule),
    image({
      name: "agentpay-reviewer-ui",
      blob: screenshotBytes,
      contentType: "image/png",
      alt: "XPAYR Verified AgentPay reviewer interface on GIWA Sepolia",
      fit: "cover",
      geometry: "rect",
      position: { left: 670.17, top: 53.62 },
      width: 557.6,
      height: 564.14,
    }),
    rectNode("product-image-caption-backing", 670.17, 583.62, 557.6, 34, COLORS.ink),
    textNode(
      "Reviewer UI • retained-evidence mode",
      { left: 682, top: 592, width: 520, height: 18 },
      { fontSize: "13px", color: COLORS.white, alignment: "right", bold: true },
      "product-image-caption",
    ),
    footerNode(5),
  ]);
}

function buildProof(presentation) {
  const cardX = [41.33, 452.67, 864.28];
  const cardW = 374.67;
  const cardTop = 318;
  return addSlide(presentation, "layout-19-proof-metrics", [
    slideTitle("The testnet proof is repeatable, bounded, and reviewable.", 6),
    textNode(
      "Two canonical terminal paths are retained with authenticated XPA2 envelopes.\nSource verification: verified_partial_expected_no_cbor — never presented as FULL.",
      { left: 41.33, top: 118, width: 1197.34, height: 88 },
      { fontSize: "20px", color: COLORS.muted },
      "proof-intro",
    ),
    textNode(
      "Historical source run 221/221  •  Public package 107/107  •  Reviewer 11/11  •  Foundry 36/36",
      { left: 41.33, top: 236, width: 1197.34, height: 30 },
      { fontSize: "17px", bold: true, color: COLORS.teal },
      "proof-test-line",
    ),
    ...cardX.map((left, index) =>
      rectNode(`proof-card-${index + 1}`, left, cardTop, cardW, 306, COLORS.panel),
    ),
    textNode(
      "5 / 5",
      { left: 73.74, top: 354, width: 308, height: 88 },
      { fontSize: "54px", bold: true, color: COLORS.teal, verticalAlignment: "bottom" },
      "proof-stat-1",
    ),
    textNode(
      "RELEASE LIFECYCLE",
      { left: 73.74, top: 468, width: 308, height: 26 },
      { fontSize: "16px", bold: true, color: COLORS.ink },
      "proof-label-1",
    ),
    textNode(
      "RELEASED terminal state\nXPA2 receipt authenticated",
      { left: 73.74, top: 516, width: 308, height: 70 },
      { fontSize: "18px", color: COLORS.muted },
      "proof-body-1",
    ),
    textNode(
      "4 / 4",
      { left: 485.17, top: 354, width: 308, height: 88 },
      { fontSize: "54px", bold: true, color: COLORS.coral, verticalAlignment: "bottom" },
      "proof-stat-2",
    ),
    textNode(
      "REFUND LIFECYCLE",
      { left: 485.17, top: 468, width: 308, height: 26 },
      { fontSize: "16px", bold: true, color: COLORS.ink },
      "proof-label-2",
    ),
    textNode(
      "REFUNDED terminal state\nXPA2 receipt authenticated",
      { left: 485.17, top: 516, width: 308, height: 70 },
      { fontSize: "18px", color: COLORS.muted },
      "proof-body-2",
    ),
    textNode(
      "2 / 2",
      { left: 896.78, top: 354, width: 308, height: 88 },
      { fontSize: "54px", bold: true, color: COLORS.teal, verticalAlignment: "bottom" },
      "proof-stat-3",
    ),
    textNode(
      "AUTH-V2 CASES",
      { left: 896.78, top: 468, width: 308, height: 26 },
      { fontSize: "16px", bold: true, color: COLORS.ink },
      "proof-label-3",
    ),
    textNode(
      "Producer signature checked\nAnchor binding checked",
      { left: 896.78, top: 516, width: 308, height: 70 },
      { fontSize: "18px", color: COLORS.muted },
      "proof-body-3",
    ),
    textNode(
      "Manifest • 81 files • 1,557,591 bytes • 0x943a30124f5219d34ef0043aeebaea4a60b349a8c0f15649bb31b91239e779ad",
      { left: 41.33, top: 641, width: 1095, height: 18 },
      { fontSize: "12px", color: COLORS.muted, typeface: MONO },
      "proof-manifest",
    ),
    footerNode(6),
  ]);
}

function buildRoadmap(presentation) {
  const cardX = [41.33, 452.33, 864.83];
  return addSlide(presentation, "layout-18-roadmap", [
    slideTitle("A five-month path compounds market evidence.", 7),
    textNode(
      "PRE-PILOT WEDGE  /  translation, research, and digital-service jobs",
      { left: 41.33, top: 112, width: 1197.34, height: 28 },
      { fontSize: "17px", bold: true, color: COLORS.teal },
      "roadmap-wedge",
    ),
    ...cardX.map((left, index) =>
      rectNode(`roadmap-card-${index + 1}`, left, 162, 374.67, 356, index === 1 ? "#E8F3EF" : COLORS.panel),
    ),
    textNode(
      "TESTNET MVP",
      { left: 73.85, top: 198, width: 309.64, height: 34 },
      { fontSize: "24px", bold: true, color: COLORS.ink },
      "roadmap-title-1",
    ),
    textNode(
      "Validate job intent → human release with demo users. Track completion, refund paths, and evidence usability.",
      { left: 73.85, top: 260, width: 309.64, height: 150 },
      { fontSize: "19px", color: COLORS.muted },
      "roadmap-body-1",
    ),
    textNode(
      "Proof already shipped\nCanonical release + refund",
      { left: 73.85, top: 438, width: 309.64, height: 58 },
      { fontSize: "16px", bold: true, color: COLORS.teal },
      "roadmap-proof-1",
    ),
    textNode(
      "PRIVATE MAINNET + KBW",
      { left: 484.85, top: 198, width: 309.64, height: 58 },
      { fontSize: "24px", bold: true, color: COLORS.ink },
      "roadmap-title-2",
    ),
    textNode(
      "Harden policy, authority, and monitoring. Demonstrate wallet interaction and report success, time-to-release, retry, and refund KPIs.",
      { left: 484.85, top: 276, width: 309.64, height: 152 },
      { fontSize: "19px", color: COLORS.muted },
      "roadmap-body-2",
    ),
    textNode(
      "Target outcome\nWallet-ready reviewer demo",
      { left: 484.85, top: 438, width: 309.64, height: 58 },
      { fontSize: "16px", bold: true, color: COLORS.teal },
      "roadmap-proof-2",
    ),
    textNode(
      "GROWTH STAGE",
      { left: 897.35, top: 198, width: 309.64, height: 34 },
      { fontSize: "24px", bold: true, color: COLORS.ink },
      "roadmap-title-3",
    ),
    textNode(
      "Integrate agent platforms and service marketplaces. Add session keys and paymasters only after security and authority gates.",
      { left: 897.35, top: 260, width: 309.64, height: 150 },
      { fontSize: "19px", color: COLORS.muted },
      "roadmap-body-3",
    ),
    textNode(
      "Scale signal\nSuccessful jobs + user growth",
      { left: 897.35, top: 438, width: 309.64, height: 58 },
      { fontSize: "16px", bold: true, color: COLORS.teal },
      "roadmap-proof-3",
    ),
    lineNode("roadmap-timeline", 41.33, 564, 1197.34, COLORS.ink, 1),
    ...cardX.map((left, index) =>
      circleNode(`roadmap-dot-${index + 1}`, left, 557.5, 14, index === 1 ? COLORS.coral : COLORS.teal),
    ),
    textNode(
      "MVP",
      { left: 41.33, top: 590, width: 250, height: 28 },
      { fontSize: "18px", bold: true },
      "roadmap-label-1",
    ),
    textNode(
      "PRIVATE MAINNET",
      { left: 452.33, top: 590, width: 250, height: 28 },
      { fontSize: "18px", bold: true },
      "roadmap-label-2",
    ),
    textNode(
      "KBW → GROWTH",
      { left: 864.83, top: 590, width: 250, height: 28 },
      { fontSize: "18px", bold: true },
      "roadmap-label-3",
    ),
    footerNode(7),
  ]);
}

function buildAsk(presentation) {
  return addSlide(presentation, "layout-26-gasok-ask", [
    textNode(
      "GASOK DECISION",
      { left: 41.33, top: 41.18, width: 420, height: 32 },
      { fontSize: "18px", bold: true, color: COLORS.teal },
      "ask-eyebrow",
    ),
    textNode(
      "TRACK 04  /  AI / WEB3",
      { left: 860, top: 41.18, width: 378.67, height: 32 },
      { fontSize: "17px", bold: true, alignment: "right", color: COLORS.muted },
      "ask-track",
    ),
    rectNode("ask-accent", 41.33, 130, 146, 5, COLORS.coral),
    textNode(
      "Choose XPAYR to advance\na proven GIWA agent-payment path.",
      { left: 41.33, top: 178, width: 1090, height: 252 },
      { fontSize: "64px", bold: true, color: COLORS.ink, verticalAlignment: "bottom" },
      "ask-title",
    ),
    textNode(
      "Engineering + security review\nGIWA Wallet integration guidance\nPrivate-mainnet and KPI support",
      { left: 41.33, top: 504, width: 520, height: 114 },
      { fontSize: "22px", color: COLORS.ink },
      "ask-support",
    ),
    lineNode("ask-right-rule", 690, 504, 520, COLORS.rule, 1),
    textNode(
      "READY NOW",
      { left: 690, top: 524, width: 220, height: 26 },
      { fontSize: "16px", bold: true, color: COLORS.teal },
      "ask-ready-label",
    ),
    textNode(
      "Testnet MVP + canonical retained evidence",
      { left: 690, top: 560, width: 480, height: 28 },
      { fontSize: "20px", bold: true },
      "ask-ready-body",
    ),
    textNode(
      "NEXT WITH GASOK  /  wallet-ready UX + private-mainnet KPIs",
      { left: 690, top: 608, width: 500, height: 26 },
      { fontSize: "16px", color: COLORS.muted },
      "ask-next",
    ),
  ]);
}

async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(RENDER_DIR, { recursive: true });

  const screenshotBytes = await fs.readFile(path.join(ASSET_DIR, "agentpay-reviewer-ui.png"));
  const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });

  buildCover(presentation);
  buildProblem(presentation);
  buildWorkflow(presentation);
  buildWhyGiwa(presentation);
  buildProduct(presentation, screenshotBytes);
  buildProof(presentation);
  buildRoadmap(presentation);
  buildAsk(presentation);

  for (const [index, slide] of presentation.slides.items.entries()) {
    const stem = `slide-${String(index + 1).padStart(2, "0")}`;
    await writeBlob(
      path.join(RENDER_DIR, `${stem}.png`),
      await presentation.export({ slide, format: "png", scale: 2 }),
    );
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(path.join(RENDER_DIR, `${stem}.layout.json`), await layout.text());
  }

  await writeBlob(
    path.join(RENDER_DIR, "xpayr-agentpay-gasok-montage.webp"),
    await presentation.export({ format: "webp", montage: true, scale: 1 }),
  );

  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(PPTX_PATH);

  const inspect = await presentation.inspect({
    kind: "slide,textbox,shape,image",
    maxChars: 30000,
  });
  await fs.writeFile(path.join(RENDER_DIR, "deck-inspect.ndjson"), inspect.ndjson);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
