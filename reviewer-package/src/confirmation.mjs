import { id, Interface } from 'ethers';
import { invariant } from './errors.mjs';
import { normalizeAddress, normalizeBytes32 } from './dojang-client.mjs';
import { validateManifest } from './manifest.mjs';
import { deriveJobId } from './policy-engine.mjs';

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const RELEASED_STATUS = 5;
const REFUNDED_STATUS = 7;
const TERMINAL_INTERFACE = new Interface([
  'event JobReleased(bytes32 indexed jobId,address indexed actor,address indexed provider,uint256 amount)',
  'event JobRefunded(bytes32 indexed jobId,address indexed payer,uint256 amount,bytes32 reason)',
  'event DisputeResolved(bytes32 indexed jobId,address indexed resolver,bool paidProvider)',
  'function releaseJob(bytes32 jobId)',
  'function resolveDispute(bytes32 jobId,bool payProvider)',
  'function claimRefund(bytes32 jobId)',
  'function claimDisputeTimeoutRefund(bytes32 jobId)',
]);

export const JOB_RELEASED_EVENT_TOPIC = TERMINAL_INTERFACE.getEvent('JobReleased').topicHash.toLowerCase();
export const JOB_REFUNDED_EVENT_TOPIC = TERMINAL_INTERFACE.getEvent('JobRefunded').topicHash.toLowerCase();
export const DISPUTE_RESOLVED_EVENT_TOPIC = TERMINAL_INTERFACE.getEvent('DisputeResolved').topicHash.toLowerCase();
export const RELEASE_JOB_SELECTOR = TERMINAL_INTERFACE.getFunction('releaseJob').selector.toLowerCase();
export const RESOLVE_DISPUTE_SELECTOR = TERMINAL_INTERFACE.getFunction('resolveDispute').selector.toLowerCase();
export const CLAIM_REFUND_SELECTOR = TERMINAL_INTERFACE.getFunction('claimRefund').selector.toLowerCase();
export const CLAIM_DISPUTE_TIMEOUT_REFUND_SELECTOR = TERMINAL_INTERFACE.getFunction('claimDisputeTimeoutRefund').selector.toLowerCase();

const REFUND_REASONS = Object.freeze({
  claim_refund: id('CANCELLED_OR_EXPIRED').toLowerCase(),
  claim_dispute_timeout_refund: id('DISPUTE_TIMEOUT').toLowerCase(),
  resolve_dispute: id('DISPUTE_RESOLUTION').toLowerCase(),
});

export function normalizeTransactionHash(value) {
  invariant(typeof value === 'string' && HASH_PATTERN.test(value), 'INVALID_TRANSACTION_HASH', 'Invalid transaction hash.');
  return value.toLowerCase();
}

function quantity(value, field) {
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) return Number(BigInt(value));
  invariant(Number.isSafeInteger(value) && value >= 0, 'INVALID_RPC_QUANTITY', `Invalid ${field}.`);
  return value;
}

function successStatus(value) {
  return value === 1 || value === '1' || value === '0x1' || value === true;
}

function decodeTerminalAction(input) {
  if (typeof input !== 'string' || !/^0x[0-9a-fA-F]+$/.test(input)) return null;
  const selector = input.slice(0, 10).toLowerCase();
  const candidates = [
    ['release_job', 'releaseJob', RELEASE_JOB_SELECTOR],
    ['resolve_dispute', 'resolveDispute', RESOLVE_DISPUTE_SELECTOR],
    ['claim_refund', 'claimRefund', CLAIM_REFUND_SELECTOR],
    ['claim_dispute_timeout_refund', 'claimDisputeTimeoutRefund', CLAIM_DISPUTE_TIMEOUT_REFUND_SELECTOR],
  ];
  const candidate = candidates.find(([, , expectedSelector]) => selector === expectedSelector);
  if (!candidate) return null;
  const [kind, functionName] = candidate;
  try {
    const decoded = TERMINAL_INTERFACE.decodeFunctionData(functionName, input);
    return {
      kind,
      job_id: decoded.jobId.toLowerCase(),
      pay_provider: kind === 'resolve_dispute' ? decoded.payProvider === true : null,
    };
  } catch {
    return null;
  }
}

function parseTerminalLogs(logs) {
  const parsed = { released: [], refunded: [], resolved: [] };
  for (const log of logs) {
    if (!Array.isArray(log?.topics) || typeof log.topics[0] !== 'string') continue;
    const topic = log.topics[0].toLowerCase();
    if (![JOB_RELEASED_EVENT_TOPIC, JOB_REFUNDED_EVENT_TOPIC, DISPUTE_RESOLVED_EVENT_TOPIC].includes(topic)) continue;
    try {
      const event = TERMINAL_INTERFACE.parseLog({ topics: log.topics, data: log.data });
      const contract = normalizeAddress(log.address, 'terminal log contract');
      if (event?.name === 'JobReleased') {
        parsed.released.push({
          contract,
          job_id: event.args.jobId.toLowerCase(),
          actor: normalizeAddress(event.args.actor, 'release actor'),
          provider: normalizeAddress(event.args.provider, 'release provider'),
          amount_atomic: event.args.amount.toString(),
        });
      } else if (event?.name === 'JobRefunded') {
        parsed.refunded.push({
          contract,
          job_id: event.args.jobId.toLowerCase(),
          payer: normalizeAddress(event.args.payer, 'refund payer'),
          amount_atomic: event.args.amount.toString(),
          reason: event.args.reason.toLowerCase(),
        });
      } else if (event?.name === 'DisputeResolved') {
        parsed.resolved.push({
          contract,
          job_id: event.args.jobId.toLowerCase(),
          resolver: normalizeAddress(event.args.resolver, 'dispute resolver'),
          paid_provider: event.args.paidProvider === true,
        });
      }
    } catch {
      // Malformed logs are ignored and make the applicable terminal checks fail closed.
    }
  }
  return parsed;
}

export function evaluateFlashblocksSignal(signal, { expectedTransactionHash = null } = {}) {
  invariant(signal && typeof signal === 'object', 'INVALID_FLASHBLOCKS_SIGNAL', 'Invalid Flashblocks signal.');
  const transactionHash = normalizeTransactionHash(signal.transaction_hash ?? signal.transactionHash);
  if (expectedTransactionHash) {
    invariant(transactionHash === normalizeTransactionHash(expectedTransactionHash), 'TRANSACTION_HASH_MISMATCH', 'Unexpected transaction hash.');
  }

  return {
    source: 'client_reported_flashblocks_pending',
    status: signal.seen === false ? 'NOT_SEEN' : 'PENDING',
    transaction_hash: transactionHash,
    seen: signal.seen !== false,
    terminal: false,
    completed: false,
    payment_completion_authority: false,
    observed_at: signal.observed_at ?? signal.observedAt ?? new Date().toISOString(),
  };
}

export function evaluateCanonicalReceipt({
  manifest,
  proofSource,
  proofChainId = null,
  receipt,
  transaction = null,
  headBlockNumber,
  canonicalBlock = null,
  jobState = null,
  expected = {},
}) {
  const network = validateManifest(manifest);
  const observedChainId = Number(proofChainId);
  const canonicalChainIdValid = Number.isSafeInteger(observedChainId)
    && observedChainId === network.chain_id;
  invariant(receipt && typeof receipt === 'object', 'INVALID_RECEIPT', 'Canonical receipt is required.');
  const receiptHash = normalizeTransactionHash(receipt.transactionHash ?? receipt.transaction_hash);
  const expectedHash = normalizeTransactionHash(expected.transaction_hash ?? expected.transactionHash);
  const expectedContract = normalizeAddress(expected.contract_address ?? expected.contractAddress, 'expected escrow contract');
  const expectedJobId = normalizeBytes32(expected.job_id ?? expected.jobId, 'expected job ID');
  const expectedJobNonce = normalizeBytes32(expected.job_nonce ?? expected.jobNonce, 'expected job nonce');
  const expectedPayer = normalizeAddress(expected.payer, 'expected payer');
  const expectedProvider = normalizeAddress(expected.provider, 'expected provider');
  const expectedEvaluator = expected.evaluator
    ? normalizeAddress(expected.evaluator, 'expected evaluator')
    : ZERO_ADDRESS;
  const expectedPolicyHash = normalizeBytes32(
    expected.policy_decision_hash ?? expected.policyDecisionHash,
    'expected policy decision hash',
  );
  const expectedDeliverableValue = expected.deliverable_hash ?? expected.deliverableHash;
  const expectedDeliverableProvided = expectedDeliverableValue !== undefined && expectedDeliverableValue !== null;
  const expectedDeliverableHash = expectedDeliverableProvided
    ? normalizeBytes32(expectedDeliverableValue, 'expected deliverable hash')
    : null;
  const expectedAmount = BigInt(expected.amount_atomic ?? expected.amountAtomic);
  const expectedExpiry = Number(expected.expires_at ?? expected.expiresAt);
  invariant(Number.isSafeInteger(expectedExpiry) && expectedExpiry > 0, 'INVALID_EXPIRY', 'Expected expiry is invalid.');
  const allowedSenders = new Set((expected.allowed_senders ?? expected.allowedSenders ?? [])
    .filter(Boolean)
    .map((address) => normalizeAddress(address, 'allowed release sender')));
  invariant(allowedSenders.size > 0, 'ALLOWED_SENDERS_REQUIRED', 'Stored job parties are required.');
  const blockNumber = quantity(receipt.blockNumber ?? receipt.block_number, 'receipt block number');
  const receiptBlockHash = normalizeBytes32(receipt.blockHash ?? receipt.block_hash, 'receipt block hash');
  const head = quantity(headBlockNumber, 'head block number');
  const confirmations = head >= blockNumber ? head - blockNumber + 1 : 0;
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const transactionPresent = transaction && typeof transaction === 'object';
  const transactionHash = transactionPresent
    ? normalizeTransactionHash(transaction.hash ?? transaction.transactionHash)
    : null;
  const transactionSender = transactionPresent ? normalizeAddress(transaction.from, 'transaction sender') : null;
  const transactionTarget = transactionPresent ? normalizeAddress(transaction.to, 'transaction target') : null;
  const transactionBlockHash = transactionPresent && transaction.blockHash
    ? normalizeBytes32(transaction.blockHash, 'transaction block hash')
    : null;
  const transactionBlockNumber = transactionPresent && transaction.blockNumber !== undefined && transaction.blockNumber !== null
    ? quantity(transaction.blockNumber, 'transaction block number')
    : null;
  const terminalAction = transactionPresent
    ? decodeTerminalAction(transaction.input ?? transaction.data)
    : null;
  const inferredOutcome = terminalAction?.kind === 'release_job'
    || (terminalAction?.kind === 'resolve_dispute' && terminalAction.pay_provider === true)
    ? 'RELEASED'
    : terminalAction?.kind === 'claim_refund'
      || terminalAction?.kind === 'claim_dispute_timeout_refund'
      || (terminalAction?.kind === 'resolve_dispute' && terminalAction.pay_provider === false)
      ? 'REFUNDED'
      : null;
  const canonicalBlockHash = canonicalBlock?.hash
    ? normalizeBytes32(canonicalBlock.hash, 'canonical block hash')
    : null;
  const canonicalBlockNumber = canonicalBlock?.number !== undefined && canonicalBlock?.number !== null
    ? quantity(canonicalBlock.number, 'canonical block number')
    : null;

  const terminalLogs = parseTerminalLogs(logs);
  const releaseMatches = terminalLogs.released.filter(
    (log) => log.contract === expectedContract && log.job_id === expectedJobId,
  );
  const refundMatches = terminalLogs.refunded.filter(
    (log) => log.contract === expectedContract && log.job_id === expectedJobId,
  );
  const resolutionMatches = terminalLogs.resolved.filter(
    (log) => log.contract === expectedContract && log.job_id === expectedJobId,
  );
  const release = releaseMatches.length === 1 ? releaseMatches[0] : null;
  const refund = refundMatches.length === 1 ? refundMatches[0] : null;
  const resolution = resolutionMatches.length === 1 ? resolutionMatches[0] : null;
  const normalizedJobState = jobState && typeof jobState === 'object'
    ? {
        payer: normalizeAddress(jobState.payer, 'job-state payer'),
        provider: normalizeAddress(jobState.provider, 'job-state provider'),
        evaluator: normalizeAddress(jobState.evaluator ?? ZERO_ADDRESS, 'job-state evaluator'),
        job_nonce: normalizeBytes32(jobState.job_nonce ?? jobState.jobNonce, 'job-state job nonce'),
        expected_amount_atomic: BigInt(
          jobState.expected_amount_atomic ?? jobState.expectedAmountAtomic,
        ).toString(),
        amount_atomic: BigInt(jobState.amount_atomic ?? jobState.amountAtomic).toString(),
        expires_at: Number(jobState.expires_at ?? jobState.expiresAt),
        status: Number(jobState.status),
        verification_required: jobState.verification_required ?? jobState.verificationRequired,
        policy_decision_hash: normalizeBytes32(
          jobState.policy_decision_hash ?? jobState.policyDecisionHash,
          'job-state policy hash',
        ),
        deliverable_hash: normalizeBytes32(
          jobState.deliverable_hash ?? jobState.deliverableHash,
          'job-state deliverable hash',
        ),
      }
    : null;

  const expectedResolver = expectedEvaluator === ZERO_ADDRESS ? expectedPayer : expectedEvaluator;
  const expectedRefundReason = terminalAction ? REFUND_REASONS[terminalAction.kind] ?? null : null;
  const actionSenderAuthorized = terminalAction?.kind === 'release_job'
    ? transactionSender !== null && allowedSenders.has(transactionSender)
    : terminalAction?.kind === 'resolve_dispute'
      ? transactionSender === expectedResolver
      : ['claim_refund', 'claim_dispute_timeout_refund'].includes(terminalAction?.kind)
        ? transactionSender === expectedPayer
        : false;
  const requiresDeliverable = inferredOutcome === 'RELEASED'
    || terminalAction?.kind === 'resolve_dispute'
    || terminalAction?.kind === 'claim_dispute_timeout_refund';
  const deliverableCommitted = normalizedJobState?.deliverable_hash !== `0x${'0'.repeat(64)}`;
  const isResolve = terminalAction?.kind === 'resolve_dispute';

  const checks = {
    independent_rpc_refetch: proofSource === 'canonical_rpc_refetch',
    canonical_chain_id: canonicalChainIdValid,
    transaction_hash: receiptHash === expectedHash,
    receipt_success: successStatus(receipt.status),
    block_is_canonical_height: head >= blockNumber,
    required_confirmations: confirmations >= network.confirmation_policy.required_confirmations,
    canonical_block_hash: canonicalBlockHash === receiptBlockHash && canonicalBlockNumber === blockNumber,
    transaction_present: transactionPresent,
    transaction_bound: transactionHash === receiptHash,
    transaction_block_hash: transactionBlockHash === receiptBlockHash,
    transaction_block_number: transactionBlockNumber === blockNumber,
    transaction_to_escrow: transactionTarget === expectedContract,
    transaction_value_zero: transactionPresent && BigInt(transaction.value ?? '0x0') === 0n,
    terminal_action_recognized: inferredOutcome !== null,
    terminal_call_job_id: terminalAction?.job_id === expectedJobId,
    release_call_job_id: terminalAction?.kind === 'release_job' && terminalAction.job_id === expectedJobId,
    action_sender_authorized: actionSenderAuthorized,
    sender_is_job_party: transactionSender !== null && allowedSenders.has(transactionSender),
    terminal_event_unambiguous: inferredOutcome === 'RELEASED'
      ? releaseMatches.length === 1 && refundMatches.length === 0
      : inferredOutcome === 'REFUNDED'
        ? refundMatches.length === 1 && releaseMatches.length === 0
        : false,
    release_event_signature: release !== null,
    release_log_contract: release !== null,
    release_job_id: release?.job_id === expectedJobId,
    release_actor_is_sender: release !== null && release.actor === transactionSender,
    release_provider: release !== null && release.provider === expectedProvider,
    release_amount: release !== null && BigInt(release.amount_atomic) === expectedAmount,
    refund_event_signature: refund !== null,
    refund_log_contract: refund !== null,
    refund_job_id: refund?.job_id === expectedJobId,
    refund_payer: refund !== null && refund.payer === expectedPayer,
    refund_amount: refund !== null && BigInt(refund.amount_atomic) === expectedAmount,
    refund_reason: refund !== null && expectedRefundReason !== null && refund.reason === expectedRefundReason,
    resolution_event_consistent: isResolve
      ? resolution !== null
        && resolution.resolver === transactionSender
        && resolution.paid_provider === terminalAction.pay_provider
      : resolutionMatches.length === 0,
    job_state_present: normalizedJobState !== null,
    job_id_derived_from_nonce: deriveJobId(expectedPayer, expectedJobNonce) === expectedJobId,
    job_state_job_nonce: normalizedJobState?.job_nonce === expectedJobNonce,
    job_state_released: normalizedJobState?.status === RELEASED_STATUS,
    job_state_refunded: normalizedJobState?.status === REFUNDED_STATUS,
    job_state_terminal_status: inferredOutcome === 'RELEASED'
      ? normalizedJobState?.status === RELEASED_STATUS
      : inferredOutcome === 'REFUNDED'
        ? normalizedJobState?.status === REFUNDED_STATUS
        : false,
    job_state_balance_zero: normalizedJobState?.amount_atomic === '0',
    job_state_expected_amount: normalizedJobState?.expected_amount_atomic === expectedAmount.toString(),
    job_state_payer: normalizedJobState?.payer === expectedPayer,
    job_state_provider: normalizedJobState?.provider === expectedProvider,
    job_state_evaluator: normalizedJobState?.evaluator === expectedEvaluator,
    job_state_expiry: normalizedJobState?.expires_at === expectedExpiry,
    job_state_policy_hash: normalizedJobState?.policy_decision_hash === expectedPolicyHash,
    job_state_verification_required: normalizedJobState?.verification_required === true,
    job_state_deliverable_committed: deliverableCommitted,
    job_state_deliverable_sufficient: !requiresDeliverable || deliverableCommitted,
    job_state_deliverable_hash: expectedDeliverableProvided
      ? normalizedJobState?.deliverable_hash === expectedDeliverableHash
      : null,
  };
  const commonRequiredChecks = [
    'independent_rpc_refetch',
    'canonical_chain_id',
    'transaction_hash',
    'receipt_success',
    'block_is_canonical_height',
    'required_confirmations',
    'canonical_block_hash',
    'transaction_present',
    'transaction_bound',
    'transaction_block_hash',
    'transaction_block_number',
    'transaction_to_escrow',
    'transaction_value_zero',
    'terminal_action_recognized',
    'terminal_call_job_id',
    'action_sender_authorized',
    'sender_is_job_party',
    'terminal_event_unambiguous',
    'resolution_event_consistent',
    'job_state_present',
    'job_id_derived_from_nonce',
    'job_state_job_nonce',
    'job_state_terminal_status',
    'job_state_balance_zero',
    'job_state_expected_amount',
    'job_state_payer',
    'job_state_provider',
    'job_state_evaluator',
    'job_state_expiry',
    'job_state_policy_hash',
    'job_state_verification_required',
    'job_state_deliverable_sufficient',
  ];
  const outcomeRequiredChecks = inferredOutcome === 'RELEASED'
    ? ['release_event_signature', 'release_log_contract', 'release_job_id', 'release_actor_is_sender', 'release_provider', 'release_amount', 'job_state_released']
    : inferredOutcome === 'REFUNDED'
      ? ['refund_event_signature', 'refund_log_contract', 'refund_job_id', 'refund_payer', 'refund_amount', 'refund_reason', 'job_state_refunded']
      : [];
  const requiredChecks = [...commonRequiredChecks, ...outcomeRequiredChecks];
  if (expectedDeliverableProvided) requiredChecks.push('job_state_deliverable_hash');
  const failures = requiredChecks.filter((name) => checks[name] !== true);
  const canonicalTerminalVerified = failures.length === 0;
  const completed = canonicalTerminalVerified && inferredOutcome === 'RELEASED';
  const refunded = canonicalTerminalVerified && inferredOutcome === 'REFUNDED';

  return {
    source: 'giwa_canonical_rpc',
    chain_id: canonicalChainIdValid ? observedChainId : null,
    contract_address: expectedContract,
    status: completed ? 'FINALIZED' : refunded ? 'REFUNDED' : 'REJECTED',
    outcome: canonicalTerminalVerified ? inferredOutcome : null,
    inferred_outcome: inferredOutcome,
    terminal_action: terminalAction?.kind ?? null,
    transaction_hash: receiptHash,
    transaction_sender: transactionSender,
    transaction_target: transactionTarget,
    block_number: blockNumber,
    block_hash: receiptBlockHash,
    head_block_number: head,
    confirmations,
    receipt_status: successStatus(receipt.status) ? 'success' : 'failed',
    explorer_url: `${network.explorer}/tx/${receiptHash}`,
    terminal: canonicalTerminalVerified,
    canonical_terminal_verified: canonicalTerminalVerified,
    completed,
    refunded,
    payment_completion_authority: completed,
    release,
    refund,
    resolution,
    job_state: normalizedJobState,
    checks,
    required_checks: requiredChecks,
    failures,
  };
}
