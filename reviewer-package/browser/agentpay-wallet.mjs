import {
  AbiCoder,
  BrowserProvider,
  Contract,
  Interface,
  JsonRpcProvider,
  ZeroAddress,
  getAddress,
  keccak256,
  toQuantity,
  toUtf8Bytes,
} from 'ethers';

export const GIWA_CHAIN = Object.freeze({
  chainId: '0x164ce',
  chainName: 'GIWA Sepolia',
  nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://sepolia-rpc.giwa.io'],
  blockExplorerUrls: ['https://sepolia-explorer.giwa.io'],
});

export const WALLET_LIMITS = Object.freeze({
  maxJobValueWei: '1000000000000',
  maxGasPerTransaction: '500000',
  maxFeePerGasWei: '3000000',
  maxTotalRequestedCostWei: '10000000000000',
});

export const EXPECTED_ESCROW = Object.freeze({
  chainId: 91342,
  address: '0x7b0630cBb92be8E11512cb331b8D1aef94cEEc53',
  runtimeCodeBytes: 7527,
  runtimeCodeKeccak256: '0x11c4e07f17a1dee1e23f5a3c113fdf7a67a9e73ccdceb8c989b52fae23c0a40a',
});

export const STATUS_NAMES = Object.freeze([
  'NONE', 'CREATED', 'FUNDED', 'SUBMITTED', 'APPROVED',
  'RELEASED', 'DISPUTED', 'REFUNDED', 'EXPIRED', 'CANCELLED',
]);

const ABI = Object.freeze([
  'function createJob(bytes32 jobId,bytes32 jobNonce,address provider,address evaluator,uint128 expectedAmount,uint64 expiresAt,bytes32 policyDecisionHash)',
  'function fundJob(bytes32 jobId) payable',
  'function submitDeliverable(bytes32 jobId,bytes32 deliverableHash)',
  'function approveJob(bytes32 jobId)',
  'function releaseJob(bytes32 jobId)',
  'function openDispute(bytes32 jobId)',
  'function resolveDispute(bytes32 jobId,bool payProvider)',
  'function cancelJob(bytes32 jobId)',
  'function markExpired(bytes32 jobId)',
  'function claimRefund(bytes32 jobId)',
  'function claimDisputeTimeoutRefund(bytes32 jobId)',
  'function getJob(bytes32 jobId) view returns ((address payer,address provider,address evaluator,bytes32 jobNonce,uint128 expectedAmount,uint128 amount,uint64 expiresAt,uint64 disputeOpenedAt,uint8 status,bool verificationRequired,bytes32 policyDecisionHash,bytes32 deliverableHash))',
]);

const ESCROW_INTERFACE = new Interface(ABI);
const MAX_JOB_VALUE_WEI = BigInt(WALLET_LIMITS.maxJobValueWei);
const MAX_GAS_PER_TRANSACTION = BigInt(WALLET_LIMITS.maxGasPerTransaction);
const MAX_FEE_PER_GAS_WEI = BigInt(WALLET_LIMITS.maxFeePerGasWei);
const MAX_TOTAL_REQUESTED_COST_WEI = BigInt(WALLET_LIMITS.maxTotalRequestedCostWei);
const GAS_BUFFER_NUMERATOR = 120n;
const GAS_BUFFER_DENOMINATOR = 100n;
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const BYTECODE = /^0x(?:[0-9a-fA-F]{2})+$/;

let injectedWallet = null;
let walletProvider = null;
let observedWallet = null;
let observerHandlers = null;
let sendInFlight = false;
const sessionListeners = new Set();
let session = freezeSession({
  status: 'disconnected',
  connected: false,
  address: null,
  chainId: null,
  chainIdHex: null,
  reason: 'not_connected',
});

function walletError(code, message, cause = undefined) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function assertWallet(condition, code, message) {
  if (!condition) throw walletError(code, message);
}

function freezeSession(value) {
  return Object.freeze({ ...value });
}

function publishSession(next) {
  session = freezeSession(next);
  for (const listener of sessionListeners) {
    try {
      listener(session);
    } catch {
      // A presentation listener cannot weaken or interrupt wallet safety state.
    }
  }
}

function ethereum() {
  const injected = globalThis.window?.ethereum;
  if (!injected?.request) throw walletError('WALLET_UNAVAILABLE', 'No EIP-1193 wallet is available.');
  return injected;
}

function normalizeChainId(value) {
  assertWallet(typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value), 'INVALID_WALLET_CHAIN', 'Wallet returned an invalid chain ID.');
  const chainId = Number(BigInt(value));
  assertWallet(Number.isSafeInteger(chainId), 'INVALID_WALLET_CHAIN', 'Wallet returned an unsafe chain ID.');
  return { chainId, chainIdHex: toQuantity(chainId).toLowerCase() };
}

function normalizeAddress(value, label = 'wallet address') {
  try {
    return getAddress(value);
  } catch (cause) {
    throw walletError('INVALID_WALLET_ADDRESS', `Wallet returned an invalid ${label}.`, cause);
  }
}

function parseQuantity(value, label) {
  assertWallet(typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value), 'INVALID_RPC_QUANTITY', `Wallet returned an invalid ${label}.`);
  return BigInt(value);
}

function positiveValue(value, label) {
  let parsed;
  try {
    parsed = BigInt(value);
  } catch (cause) {
    throw walletError('INVALID_TRANSACTION_VALUE', `${label} must be an integer wei value.`, cause);
  }
  assertWallet(parsed > 0n, 'INVALID_TRANSACTION_VALUE', `${label} must be greater than zero.`);
  return parsed;
}

function installObservers(injected) {
  if (observedWallet === injected) return;
  if (observedWallet?.removeListener && observerHandlers) {
    observedWallet.removeListener('accountsChanged', observerHandlers.accountsChanged);
    observedWallet.removeListener('chainChanged', observerHandlers.chainChanged);
    observedWallet.removeListener('disconnect', observerHandlers.disconnect);
  }
  observedWallet = injected;
  observerHandlers = {
    accountsChanged(accounts) {
      walletProvider = null;
      const address = Array.isArray(accounts) && accounts.length > 0
        ? (() => {
            try { return normalizeAddress(accounts[0]); } catch { return null; }
          })()
        : null;
      publishSession({
        status: 'invalidated',
        connected: false,
        address,
        chainId: session.chainId,
        chainIdHex: session.chainIdHex,
        reason: 'accounts_changed_reconnect_required',
      });
    },
    chainChanged(value) {
      walletProvider = null;
      let nextChain = { chainId: null, chainIdHex: null };
      try { nextChain = normalizeChainId(value); } catch { /* invalid remains null */ }
      publishSession({
        status: 'invalidated',
        connected: false,
        address: session.address,
        ...nextChain,
        reason: 'chain_changed_reconnect_required',
      });
    },
    disconnect() {
      walletProvider = null;
      injectedWallet = null;
      publishSession({
        status: 'disconnected',
        connected: false,
        address: null,
        chainId: null,
        chainIdHex: null,
        reason: 'wallet_disconnected',
      });
    },
  };
  if (injected.on) {
    injected.on('accountsChanged', observerHandlers.accountsChanged);
    injected.on('chainChanged', observerHandlers.chainChanged);
    injected.on('disconnect', observerHandlers.disconnect);
  }
}

async function request(injected, method, params = undefined) {
  try {
    return await injected.request(params === undefined ? { method } : { method, params });
  } catch (cause) {
    if (Number(cause?.code) === 4001) {
      throw walletError(4001, 'Wallet request was cancelled by the user. No retry was attempted.', cause);
    }
    throw cause;
  }
}

export function getSession() {
  return session;
}

export function watchSession(listener) {
  assertWallet(typeof listener === 'function', 'INVALID_SESSION_LISTENER', 'Session listener must be a function.');
  sessionListeners.add(listener);
  listener(session);
  return () => sessionListeners.delete(listener);
}

export async function connect() {
  const injected = ethereum();
  const requestedAccounts = await request(injected, 'eth_requestAccounts');
  assertWallet(Array.isArray(requestedAccounts) && requestedAccounts.length > 0, 'WALLET_ACCOUNT_REQUIRED', 'Wallet did not expose an account.');
  try {
    await request(injected, 'wallet_switchEthereumChain', [{ chainId: GIWA_CHAIN.chainId }]);
  } catch (error) {
    if (Number(error?.code) !== 4902) throw error;
    await request(injected, 'wallet_addEthereumChain', [GIWA_CHAIN]);
    const addedChain = normalizeChainId(await request(injected, 'eth_chainId'));
    if (addedChain.chainId !== EXPECTED_ESCROW.chainId) {
      await request(injected, 'wallet_switchEthereumChain', [{ chainId: GIWA_CHAIN.chainId }]);
    }
  }

  const selectedChain = normalizeChainId(await request(injected, 'eth_chainId'));
  assertWallet(selectedChain.chainId === EXPECTED_ESCROW.chainId, 'WRONG_WALLET_CHAIN', 'Wallet must be connected to GIWA Sepolia.');
  const currentAccounts = await request(injected, 'eth_accounts');
  assertWallet(Array.isArray(currentAccounts) && currentAccounts.length > 0, 'WALLET_ACCOUNT_REQUIRED', 'Wallet did not expose a current account.');
  const requestedAddress = normalizeAddress(requestedAccounts[0]);
  const current = normalizeAddress(currentAccounts[0]);
  assertWallet(current.toLowerCase() === requestedAddress.toLowerCase(), 'WALLET_ACCOUNT_CHANGED', 'Wallet account changed during connection. Reconnect explicitly.');

  injectedWallet = injected;
  walletProvider = new BrowserProvider(injected, EXPECTED_ESCROW.chainId);
  installObservers(injected);
  publishSession({
    status: 'connected',
    connected: true,
    address: current,
    chainId: selectedChain.chainId,
    chainIdHex: selectedChain.chainIdHex,
    reason: null,
  });
  return Object.freeze({ address: current, chainId: selectedChain.chainId });
}

async function verifyEscrowCode(injected, contractAddress) {
  const normalized = normalizeAddress(contractAddress, 'escrow address');
  assertWallet(
    normalized.toLowerCase() === EXPECTED_ESCROW.address.toLowerCase(),
    'UNRECOGNIZED_ESCROW',
    'Wallet execution is locked to the reviewed GIWA Sepolia escrow deployment.',
  );
  const code = await request(injected, 'eth_getCode', [normalized, 'latest']);
  assertWallet(BYTECODE.test(code), 'ESCROW_CODE_MISSING', 'Reviewed GIWA escrow bytecode is not present.');
  assertWallet((code.length - 2) / 2 === EXPECTED_ESCROW.runtimeCodeBytes, 'ESCROW_BYTECODE_MISMATCH', 'GIWA escrow runtime byte length does not match the reviewed deployment.');
  assertWallet(keccak256(code).toLowerCase() === EXPECTED_ESCROW.runtimeCodeKeccak256, 'ESCROW_BYTECODE_MISMATCH', 'GIWA escrow runtime bytecode does not match the reviewed deployment.');
  return normalized;
}

function normalizeAllowedAddresses(addresses) {
  return addresses
    .filter((address) => address && String(address).toLowerCase() !== ZeroAddress.toLowerCase())
    .map((address) => normalizeAddress(address, 'role address'));
}

async function verifiedContext(contractAddress, allowedAddresses, roleLabel) {
  const injected = ethereum();
  assertWallet(
    session.status === 'connected' && injectedWallet === injected && walletProvider,
    'WALLET_RECONNECT_REQUIRED',
    'Connect the participant wallet before preparing a transaction.',
  );
  const selectedChain = normalizeChainId(await request(injected, 'eth_chainId'));
  if (selectedChain.chainId !== EXPECTED_ESCROW.chainId) {
    publishSession({ ...session, status: 'invalidated', connected: false, ...selectedChain, reason: 'wrong_chain_reconnect_required' });
    throw walletError('WRONG_WALLET_CHAIN', 'Wallet must be connected to GIWA Sepolia.');
  }
  const accounts = await request(injected, 'eth_accounts');
  assertWallet(Array.isArray(accounts) && accounts.length > 0, 'WALLET_ACCOUNT_REQUIRED', 'Wallet account is unavailable.');
  const address = normalizeAddress(accounts[0]);
  if (address.toLowerCase() !== session.address?.toLowerCase()) {
    publishSession({ ...session, status: 'invalidated', connected: false, address, reason: 'account_mismatch_reconnect_required' });
    throw walletError('WALLET_ACCOUNT_CHANGED', 'Wallet account changed. Reconnect explicitly.');
  }
  const allowed = normalizeAllowedAddresses(allowedAddresses);
  assertWallet(allowed.some((candidate) => candidate.toLowerCase() === address.toLowerCase()), 'WALLET_ROLE_FORBIDDEN', `Connected wallet is not an allowed ${roleLabel} for this job.`);
  const escrowAddress = await verifyEscrowCode(injected, contractAddress);
  return { injected, address, escrowAddress };
}

function validateCostCaps({ jobValueWei = null, valueWei, gasLimit, maxFeePerGasWei, maxPriorityFeePerGasWei }) {
  if (jobValueWei !== null) {
    assertWallet(jobValueWei <= MAX_JOB_VALUE_WEI, 'MAX_JOB_VALUE_EXCEEDED', `Job value exceeds the ${WALLET_LIMITS.maxJobValueWei} wei reviewer cap.`);
  }
  assertWallet(valueWei >= 0n && valueWei <= MAX_JOB_VALUE_WEI, 'MAX_JOB_VALUE_EXCEEDED', `Transaction value exceeds the ${WALLET_LIMITS.maxJobValueWei} wei reviewer cap.`);
  assertWallet(gasLimit > 0n && gasLimit <= MAX_GAS_PER_TRANSACTION, 'MAX_GAS_EXCEEDED', `Gas limit exceeds the ${WALLET_LIMITS.maxGasPerTransaction} reviewer cap.`);
  assertWallet(maxFeePerGasWei > 0n && maxFeePerGasWei <= MAX_FEE_PER_GAS_WEI, 'MAX_FEE_EXCEEDED', `Maximum fee exceeds the ${WALLET_LIMITS.maxFeePerGasWei} wei/gas reviewer cap.`);
  assertWallet(maxPriorityFeePerGasWei >= 0n && maxPriorityFeePerGasWei <= maxFeePerGasWei, 'INVALID_PRIORITY_FEE', 'Priority fee must not exceed the maximum fee.');
  const total = valueWei + gasLimit * maxFeePerGasWei;
  assertWallet(total <= MAX_TOTAL_REQUESTED_COST_WEI, 'MAX_TOTAL_COST_EXCEEDED', `Maximum requested cost exceeds the ${WALLET_LIMITS.maxTotalRequestedCostWei} wei reviewer cap.`);
  return total;
}

function decodeReviewTerms(method, data) {
  const decoded = ESCROW_INTERFACE.decodeFunctionData(method, data);
  const base = {
    method,
    jobId: String(decoded.jobId ?? decoded[0]),
  };
  if (method === 'createJob') {
    return Object.freeze({
      ...base,
      jobNonce: String(decoded.jobNonce),
      provider: normalizeAddress(decoded.provider, 'provider address'),
      evaluator: normalizeAddress(decoded.evaluator, 'evaluator address'),
      expectedAmountWei: decoded.expectedAmount.toString(),
      expiresAt: decoded.expiresAt.toString(),
      policyDecisionHash: String(decoded.policyDecisionHash),
    });
  }
  if (method === 'submitDeliverable') {
    return Object.freeze({ ...base, deliverableHash: String(decoded.deliverableHash) });
  }
  if (method === 'resolveDispute') {
    return Object.freeze({ ...base, payProvider: Boolean(decoded.payProvider) });
  }
  return Object.freeze(base);
}

async function prepareAction({ action, contractAddress, allowedAddresses, roleLabel, method, args, valueWei = 0n, jobValueWei = null }) {
  if (jobValueWei !== null) {
    assertWallet(jobValueWei <= MAX_JOB_VALUE_WEI, 'MAX_JOB_VALUE_EXCEEDED', `Job value exceeds the ${WALLET_LIMITS.maxJobValueWei} wei reviewer cap.`);
  }
  assertWallet(valueWei >= 0n && valueWei <= MAX_JOB_VALUE_WEI, 'MAX_JOB_VALUE_EXCEEDED', `Transaction value exceeds the ${WALLET_LIMITS.maxJobValueWei} wei reviewer cap.`);
  const context = await verifiedContext(contractAddress, allowedAddresses, roleLabel);
  const data = ESCROW_INTERFACE.encodeFunctionData(method, args);
  const decoded = decodeReviewTerms(method, data);
  const call = Object.freeze({
    from: context.address,
    to: context.escrowAddress,
    data,
    value: toQuantity(valueWei),
  });
  const [estimateResult, gasPriceResult, priorityResult] = await Promise.all([
    request(context.injected, 'eth_estimateGas', [call]),
    request(context.injected, 'eth_gasPrice'),
    request(context.injected, 'eth_maxPriorityFeePerGas'),
  ]);
  const gasEstimate = parseQuantity(estimateResult, 'gas estimate');
  const gasLimit = (gasEstimate * GAS_BUFFER_NUMERATOR + GAS_BUFFER_DENOMINATOR - 1n) / GAS_BUFFER_DENOMINATOR;
  const maxFeePerGasWei = parseQuantity(gasPriceResult, 'maximum fee');
  const maxPriorityFeePerGasWei = parseQuantity(priorityResult, 'priority fee');
  const maxTotalRequestedCostWei = validateCostCaps({
    jobValueWei,
    valueWei,
    gasLimit,
    maxFeePerGasWei,
    maxPriorityFeePerGasWei,
  });
  const preview = Object.freeze({
    action,
    to: context.escrowAddress,
    from: context.address,
    chainId: EXPECTED_ESCROW.chainId,
    decoded,
    data,
    valueWei: valueWei.toString(),
    gasLimit: gasLimit.toString(),
    maxFeePerGasWei: maxFeePerGasWei.toString(),
    maxPriorityFeePerGasWei: maxPriorityFeePerGasWei.toString(),
    maxTotalRequestedCostWei: maxTotalRequestedCostWei.toString(),
  });
  const transactionRequest = Object.freeze({
    from: preview.from,
    to: preview.to,
    data: preview.data,
    value: toQuantity(valueWei),
    gas: toQuantity(gasLimit),
    maxFeePerGas: toQuantity(maxFeePerGasWei),
    maxPriorityFeePerGas: toQuantity(maxPriorityFeePerGasWei),
  });
  let consumed = false;

  async function send() {
    if (sendInFlight) throw walletError('WALLET_TRANSACTION_IN_FLIGHT', 'Another wallet transaction request is already in flight.');
    if (consumed) throw walletError('WALLET_PREVIEW_ALREADY_USED', 'This transaction preview has already been used. Prepare a fresh preview.');
    consumed = true;
    sendInFlight = true;
    try {
      const current = await verifiedContext(contractAddress, allowedAddresses, roleLabel);
      assertWallet(current.address.toLowerCase() === preview.from.toLowerCase(), 'WALLET_ACCOUNT_CHANGED', 'Wallet account no longer matches the immutable preview.');
      validateCostCaps({ jobValueWei, valueWei, gasLimit, maxFeePerGasWei, maxPriorityFeePerGasWei });
      const hash = await request(current.injected, 'eth_sendTransaction', [transactionRequest]);
      assertWallet(TRANSACTION_HASH.test(hash), 'INVALID_TRANSACTION_HASH', 'Wallet returned an invalid transaction hash.');
      const providerAtSend = walletProvider;
      return Object.freeze({
        hash,
        wait(confirmations = 1, timeout = undefined) {
          return providerAtSend.waitForTransaction(hash, confirmations, timeout);
        },
      });
    } finally {
      sendInFlight = false;
    }
  }

  return Object.freeze({ preview, send });
}

export async function currentAddress() {
  return session.status === 'connected' ? session.address : null;
}

export async function createJob({ contractAddress, jobId, jobNonce, payer, provider, evaluator, amountAtomic, expiresAt, policyDecisionHash }) {
  if (deriveJobId(payer, jobNonce).toLowerCase() !== jobId.toLowerCase()) {
    throw walletError('JOB_BINDING_MISMATCH', 'Execution binding job ID does not match its payer and nonce.');
  }
  const jobValueWei = positiveValue(amountAtomic, 'Expected job amount');
  return prepareAction({
    action: 'createJob', contractAddress, allowedAddresses: [payer], roleLabel: 'payer', method: 'createJob',
    args: [jobId, jobNonce, provider, evaluator || ZeroAddress, jobValueWei, expiresAt, policyDecisionHash],
    jobValueWei,
  });
}

export async function fundJob({ contractAddress, jobId, payer, amountAtomic }) {
  const valueWei = positiveValue(amountAtomic, 'Funding amount');
  return prepareAction({ action: 'fundJob', contractAddress, allowedAddresses: [payer], roleLabel: 'payer', method: 'fundJob', args: [jobId], valueWei, jobValueWei: valueWei });
}

export async function submitDeliverable({ contractAddress, jobId, provider, deliverableHash }) {
  return prepareAction({ action: 'submitDeliverable', contractAddress, allowedAddresses: [provider], roleLabel: 'provider', method: 'submitDeliverable', args: [jobId, deliverableHash] });
}

export async function approveJob({ contractAddress, jobId, payer, evaluator }) {
  return prepareAction({ action: 'approveJob', contractAddress, allowedAddresses: [payer, evaluator], roleLabel: 'payer/evaluator', method: 'approveJob', args: [jobId] });
}

export async function releaseJob({ contractAddress, jobId, payer, provider, evaluator }) {
  return prepareAction({ action: 'releaseJob', contractAddress, allowedAddresses: [payer, provider, evaluator], roleLabel: 'participant', method: 'releaseJob', args: [jobId] });
}

export async function openDispute({ contractAddress, jobId, payer, provider, evaluator }) {
  return prepareAction({ action: 'openDispute', contractAddress, allowedAddresses: [payer, provider, evaluator], roleLabel: 'participant', method: 'openDispute', args: [jobId] });
}

export async function resolveDispute({ contractAddress, jobId, resolver, payProvider }) {
  return prepareAction({ action: 'resolveDispute', contractAddress, allowedAddresses: [resolver], roleLabel: 'dispute resolver', method: 'resolveDispute', args: [jobId, Boolean(payProvider)] });
}

export async function cancelJob({ contractAddress, jobId, payer }) {
  return prepareAction({ action: 'cancelJob', contractAddress, allowedAddresses: [payer], roleLabel: 'payer', method: 'cancelJob', args: [jobId] });
}

export async function markExpired({ contractAddress, jobId, payer, provider, evaluator }) {
  return prepareAction({ action: 'markExpired', contractAddress, allowedAddresses: [payer, provider, evaluator], roleLabel: 'participant', method: 'markExpired', args: [jobId] });
}

export async function claimRefund({ contractAddress, jobId, payer }) {
  return prepareAction({ action: 'claimRefund', contractAddress, allowedAddresses: [payer], roleLabel: 'payer', method: 'claimRefund', args: [jobId] });
}

export async function claimDisputeTimeoutRefund({ contractAddress, jobId, payer }) {
  return prepareAction({ action: 'claimDisputeTimeoutRefund', contractAddress, allowedAddresses: [payer], roleLabel: 'payer', method: 'claimDisputeTimeoutRefund', args: [jobId] });
}

export async function readJob({ contractAddress, jobId }) {
  const normalized = normalizeAddress(contractAddress, 'escrow address');
  assertWallet(normalized.toLowerCase() === EXPECTED_ESCROW.address.toLowerCase(), 'UNRECOGNIZED_ESCROW', 'Canonical reads are locked to the reviewed GIWA Sepolia escrow deployment.');
  const provider = new JsonRpcProvider(GIWA_CHAIN.rpcUrls[0], EXPECTED_ESCROW.chainId, { staticNetwork: true });
  const code = await provider.getCode(normalized);
  assertWallet(BYTECODE.test(code) && (code.length - 2) / 2 === EXPECTED_ESCROW.runtimeCodeBytes && keccak256(code).toLowerCase() === EXPECTED_ESCROW.runtimeCodeKeccak256, 'ESCROW_BYTECODE_MISMATCH', 'Canonical GIWA escrow bytecode does not match the reviewed deployment.');
  const job = await new Contract(normalized, ABI, provider).getJob(jobId);
  return {
    payer: job.payer,
    provider: job.provider,
    evaluator: job.evaluator,
    jobNonce: job.jobNonce,
    expectedAmountAtomic: job.expectedAmount.toString(),
    amountAtomic: job.amount.toString(),
    expiresAt: Number(job.expiresAt),
    disputeOpenedAt: Number(job.disputeOpenedAt),
    status: STATUS_NAMES[Number(job.status)] || `UNKNOWN_${job.status}`,
    verificationRequired: job.verificationRequired,
    policyDecisionHash: job.policyDecisionHash,
    deliverableHash: job.deliverableHash,
  };
}

export function hashDeliverable(value) {
  const text = String(value || '').trim();
  if (!text) throw walletError('DELIVERABLE_REQUIRED', 'Enter a deliverable reference before hashing.');
  return keccak256(toUtf8Bytes(text));
}

export function deriveJobId(payer, jobNonce) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'bytes32'], [payer, jobNonce]));
}
