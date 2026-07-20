import { AbiCoder, keccak256 } from 'ethers';
import { sha256Hex } from './canonical-json.mjs';
import { invariant } from './errors.mjs';
import { normalizeAddress } from './dojang-client.mjs';
import { GIWA_NETWORK, validateManifest } from './manifest.mjs';

const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const ETH_AMOUNT_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,18}))?$/;
const JOB_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DEFAULT_EXPIRY_SECONDS = 24 * 60 * 60;
const MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
const ABI_CODER = AbiCoder.defaultAbiCoder();

export const DEFAULT_POLICY = Object.freeze({
  version: 'xpayr.giwa.agent-policy.v1',
  allowed_assets: Object.freeze(['ETH']),
  max_transaction_atomic: '1000000000000000000',
  daily_limit_atomic: '2000000000000000000',
  approval_threshold_atomic: '50000000000000000',
  max_intents_per_hour: 10,
  required_verified_roles: Object.freeze(['payer', 'provider']),
  verify_evaluator_when_present: true,
});

function atomic(value, field) {
  invariant(typeof value === 'string' && DECIMAL_PATTERN.test(value), 'INVALID_ATOMIC_AMOUNT', `${field} must be a base-10 string.`);
  return BigInt(value);
}

export function parseEthToAtomic(value) {
  const input = typeof value === 'number' ? String(value) : value;
  invariant(typeof input === 'string', 'INVALID_ETH_AMOUNT', 'amountEth must be a decimal string.');
  const match = input.match(ETH_AMOUNT_PATTERN);
  invariant(match, 'INVALID_ETH_AMOUNT', 'amountEth supports up to 18 decimal places.');
  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? '').padEnd(18, '0');
  return (whole * 10n ** 18n + BigInt(fraction || '0')).toString();
}

function identityVerified(identity, role) {
  const entry = identity?.[role];
  return entry === true || entry?.verified === true;
}

function normalizeTitle(value) {
  if (value === undefined || value === null || value === '') return null;
  invariant(typeof value === 'string' && value.trim().length <= 120, 'INVALID_TITLE', 'title must be at most 120 characters.');
  return value.trim();
}

function evaluationTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  invariant(!Number.isNaN(date.getTime()), 'INVALID_POLICY_CLOCK', 'Policy clock must return a valid time.');
  return {
    iso: date.toISOString(),
    epochSeconds: Math.floor(date.getTime() / 1000),
  };
}

function normalizeUsage(usage = {}) {
  const recentIntentCount = usage.recent_intent_count ?? usage.recentIntentCount ?? 0;
  const dailySpentAtomic = usage.daily_spent_atomic ?? usage.dailySpentAtomic ?? '0';
  invariant(Number.isInteger(recentIntentCount) && recentIntentCount >= 0, 'INVALID_VELOCITY_CONTEXT', 'Trusted velocity context is invalid.');
  atomic(dailySpentAtomic, 'daily_spent_atomic');
  return { recent_intent_count: recentIntentCount, daily_spent_atomic: dailySpentAtomic };
}

export function deriveJobId(payer, jobNonce) {
  const normalizedPayer = normalizeAddress(payer, 'payer address');
  invariant(typeof jobNonce === 'string' && JOB_ID_PATTERN.test(jobNonce), 'INVALID_JOB_NONCE', 'Trusted job nonce must be bytes32.');
  return keccak256(ABI_CODER.encode(['address', 'bytes32'], [normalizedPayer, jobNonce.toLowerCase()])).toLowerCase();
}

export function normalizeIntent(input, {
  nowSeconds = Math.floor(Date.now() / 1000),
  jobNonce = null,
} = {}) {
  invariant(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_INTENT', 'Intent must be an object.');
  const payer = normalizeAddress(input.payer ?? input.payerAddress, 'payer address');
  const provider = normalizeAddress(input.provider ?? input.providerAddress, 'provider address');
  const evaluatorValue = input.evaluator ?? input.evaluatorAddress;
  const evaluator = evaluatorValue ? normalizeAddress(evaluatorValue, 'evaluator address') : null;
  const amountAtomic = input.amount_atomic ?? input.amountAtomic
    ?? (input.amountEth !== undefined ? parseEthToAtomic(input.amountEth) : undefined);
  atomic(amountAtomic, 'amount');
  const title = normalizeTitle(input.title);
  invariant(Number.isSafeInteger(nowSeconds) && nowSeconds > 0, 'INVALID_POLICY_CLOCK', 'Invalid policy clock.');
  const requestedExpiry = input.expires_at ?? input.expiresAt;
  const expiresAt = requestedExpiry === undefined || requestedExpiry === null
    ? nowSeconds + DEFAULT_EXPIRY_SECONDS
    : typeof requestedExpiry === 'string' && /^[0-9]+$/.test(requestedExpiry)
      ? Number(requestedExpiry)
      : requestedExpiry;
  invariant(Number.isSafeInteger(expiresAt), 'INVALID_EXPIRY', 'expires_at must be a Unix timestamp in seconds.');
  invariant(expiresAt > nowSeconds, 'INVALID_EXPIRY', 'expires_at must be in the future.');
  invariant(expiresAt <= nowSeconds + MAX_EXPIRY_SECONDS, 'INVALID_EXPIRY', 'expires_at cannot exceed seven days.');
  invariant(input.job_id === undefined && input.jobId === undefined, 'UNTRUSTED_JOB_ID_OVERRIDE', 'jobId is derived by XPAYR and cannot be supplied by the caller.');
  invariant(input.job_nonce === undefined && input.jobNonce === undefined, 'UNTRUSTED_JOB_NONCE_OVERRIDE', 'jobNonce is derived by XPAYR and cannot be supplied by the caller.');
  invariant(typeof jobNonce === 'string' && JOB_ID_PATTERN.test(jobNonce), 'INVALID_JOB_NONCE', 'Trusted job nonce must be bytes32.');
  const normalizedJobNonce = jobNonce.toLowerCase();
  const jobId = deriveJobId(payer, normalizedJobNonce);

  const requestedAsset = String(input.asset?.symbol ?? input.asset ?? 'ETH').toUpperCase();
  const asset = requestedAsset === 'TEST_ETH' ? 'ETH' : requestedAsset;

  return {
    job_id: jobId,
    job_nonce: normalizedJobNonce,
    title,
    network_key: input.network_key ?? input.networkKey ?? GIWA_NETWORK.networkKey,
    payer,
    provider,
    evaluator,
    asset,
    asset_decimals: input.asset?.decimals ?? input.assetDecimals ?? 18,
    amount_atomic: amountAtomic,
    expires_at: expiresAt,
    force_approval: input.force_approval === true || input.forceApproval === true || input.requireApproval === true,
  };
}

function validatePolicy(policy) {
  invariant(policy.version === DEFAULT_POLICY.version, 'INVALID_POLICY_VERSION', 'Unsupported policy version.');
  invariant(Array.isArray(policy.allowed_assets) && policy.allowed_assets.length > 0, 'INVALID_POLICY', 'allowed_assets is required.');
  atomic(policy.max_transaction_atomic, 'max_transaction_atomic');
  atomic(policy.daily_limit_atomic, 'daily_limit_atomic');
  atomic(policy.approval_threshold_atomic, 'approval_threshold_atomic');
  invariant(Number.isInteger(policy.max_intents_per_hour) && policy.max_intents_per_hour > 0, 'INVALID_POLICY', 'Invalid velocity limit.');
  return Object.freeze({ ...policy, allowed_assets: [...policy.allowed_assets], required_verified_roles: [...policy.required_verified_roles] });
}

export class PolicyEngine {
  constructor({ manifest, policy = DEFAULT_POLICY, now = () => new Date().toISOString() }) {
    this.manifest = validateManifest(manifest);
    this.policy = validatePolicy({ ...DEFAULT_POLICY, ...policy });
    this.now = now;
  }

  evaluate(input, { identity = {}, usage = {}, jobNonce = null } = {}) {
    const time = evaluationTime(this.now());
    const intent = normalizeIntent(input, { nowSeconds: time.epochSeconds, jobNonce });
    const trustedUsage = normalizeUsage(usage);
    const amount = atomic(intent.amount_atomic, 'amount');
    const dailySpent = atomic(trustedUsage.daily_spent_atomic, 'daily_spent_atomic');
    const deny = [];
    const hold = [];

    if (intent.network_key !== this.manifest.network_key) deny.push('NETWORK_NOT_ALLOWED');
    if (!this.policy.allowed_assets.includes(intent.asset) || intent.asset_decimals !== 18) deny.push('ASSET_NOT_ALLOWED');
    if (amount <= 0n) deny.push('AMOUNT_MUST_BE_POSITIVE');
    if (amount > atomic(this.policy.max_transaction_atomic, 'max_transaction_atomic')) deny.push('MAX_TRANSACTION_EXCEEDED');
    if (dailySpent + amount > atomic(this.policy.daily_limit_atomic, 'daily_limit_atomic')) deny.push('DAILY_LIMIT_EXCEEDED');
    if (trustedUsage.recent_intent_count >= this.policy.max_intents_per_hour) deny.push('VELOCITY_LIMIT_EXCEEDED');
    if (intent.payer === intent.provider) deny.push('ROLE_COLLISION');
    if (intent.evaluator && (intent.evaluator === intent.payer || intent.evaluator === intent.provider)) {
      deny.push('EVALUATOR_ROLE_COLLISION');
    }

    const requiredRoles = [...this.policy.required_verified_roles];
    if (intent.evaluator && this.policy.verify_evaluator_when_present) requiredRoles.push('evaluator');
    for (const role of [...new Set(requiredRoles)]) {
      if (!identityVerified(identity, role)) deny.push(`DOJANG_${role.toUpperCase()}_NOT_VERIFIED`);
    }

    if (intent.force_approval) hold.push('MANUAL_APPROVAL_REQUESTED');
    if (amount >= atomic(this.policy.approval_threshold_atomic, 'approval_threshold_atomic')) {
      hold.push('APPROVAL_THRESHOLD_REACHED');
    }

    const decision = deny.length > 0 ? 'DENY' : hold.length > 0 ? 'HOLD' : 'ALLOW';
    const reasons = [...new Set(decision === 'DENY' ? deny : decision === 'HOLD' ? hold : ['POLICY_PASSED'])].sort();
    const executionFields = {
      network_key: intent.network_key,
      chain_id: this.manifest.chain_id,
      job_id: intent.job_id,
      job_nonce: intent.job_nonce,
      payer: intent.payer,
      provider: intent.provider,
      evaluator: intent.evaluator,
      asset: intent.asset,
      asset_decimals: intent.asset_decimals,
      amount_atomic: intent.amount_atomic,
      expires_at: intent.expires_at,
    };
    const policySnapshot = {
      policy_version: this.policy.version,
      decision,
      reasons,
      execution_fingerprint: sha256Hex(executionFields),
      limits: {
        max_transaction_atomic: this.policy.max_transaction_atomic,
        daily_limit_atomic: this.policy.daily_limit_atomic,
        approval_threshold_atomic: this.policy.approval_threshold_atomic,
        max_intents_per_hour: this.policy.max_intents_per_hour,
      },
      identity_checks: Object.fromEntries(
        [...new Set(requiredRoles)].sort().map((role) => [role, identityVerified(identity, role)]),
      ),
      usage_context: trustedUsage,
    };

    return {
      decision,
      verdict: decision,
      reasons,
      decision_hash: sha256Hex(policySnapshot),
      policy_hash: sha256Hex(policySnapshot),
      execution_fingerprint: policySnapshot.execution_fingerprint,
      evaluated_at: time.iso,
      policy_snapshot: policySnapshot,
      normalized_intent: intent,
    };
  }
}
