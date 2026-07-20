const GIWA_CHAIN = {
  chainId: '0x164ce',
  chainName: 'GIWA Sepolia',
  nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://sepolia-rpc.giwa.io'],
  blockExplorerUrls: ['https://sepolia-explorer.giwa.io'],
};

const $ = (selector) => document.querySelector(selector);
const form = $('#intent-form');
const message = $('#form-message');
const decisionEmpty = $('#decision-empty');
const decisionResult = $('#decision-result');
const decisionOrb = $('#decision-orb');
const ledgerBody = $('#ledger-body');
const stateRail = [...document.querySelectorAll('#state-rail li')];
const approveButton = $('#approve-intent');
const rejectButton = $('#reject-intent');
const evidenceButton = $('#download-evidence');
let walletClient = null;
const chainButtons = [...document.querySelectorAll('.chain-action')];

const appState = {
  intents: [],
  activeIntent: null,
  contractAddress: null,
  chainJob: null,
  runtimeIdentitySource: 'unknown',
  runtimeMode: 'checking',
  walletExecution: Object.freeze({ enabled: false }),
  walletAddress: null,
  walletChainId: null,
  intentBusy: false,
  walletBusy: false,
  walletUnsubscribe: null,
  preparedTransaction: null,
  preparingTransaction: null,
  chainJobIntentId: null,
  reviewerProof: null,
  pendingTerminalProof: null,
};

function normalizeAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(value || '') ? String(value).toLowerCase() : null;
}

function explorerLink(kind, value, label = shortHash(value)) {
  if (!value) return escapeHtml(label);
  const path = kind === 'tx' ? 'tx' : 'address';
  return `<a href="https://sepolia-explorer.giwa.io/${path}/${encodeURIComponent(value)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} ↗</a>`;
}

function loadWalletBundle() {
  if (window.XPayrAgentPayWallet) return Promise.resolve(window.XPayrAgentPayWallet);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/agentpay-wallet.js';
    script.async = true;
    script.addEventListener('load', () => resolve(window.XPayrAgentPayWallet));
    script.addEventListener('error', () => reject(new Error('Wallet client bundle could not be loaded.')));
    document.head.append(script);
  });
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function shortHash(value) {
  const text = String(value || '—');
  return text.length > 18 ? `${text.slice(0, 10)}…${text.slice(-6)}` : text;
}

function readFirst(object, paths, fallback = undefined) {
  for (const path of paths) {
    const value = path.split('.').reduce((cursor, part) => cursor?.[part], object);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const raw = await response.text();
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { error: raw || 'Invalid server response' }; }
  if (!response.ok) {
    const detail = readFirst(body, ['error.message', 'message', 'error'], `Request failed (${response.status})`);
    throw new Error(typeof detail === 'string' ? detail : `Request failed (${response.status})`);
  }
  return body;
}

function normalizeIntent(payload) {
  const source = payload.intent || payload.data?.intent || payload.data || payload;
  const policy = source.policy || source.policyDecision || payload.policy || {};
  const verification = source.verification || source.dojang || payload.verification || {};
  const decision = String(readFirst(source, ['decision', 'verdict', 'policy.verdict', 'policy.decision'], 'HOLD')).toUpperCase();
  const status = String(readFirst(source, ['status', 'state'], 'CREATED')).toUpperCase();
  const reasons = readFirst(source, ['reasons', 'policy.reasons'], []);
  return {
    ...source,
    id: String(readFirst(source, ['id', 'intentId', 'jobId'], 'pending')),
    jobId: String(readFirst(source, ['jobId', 'job_id', 'intent.job_id'], '—')),
    title: String(readFirst(source, ['title', 'intent.title', 'job.title', 'description'], $('#job-title').value)),
    payer: readFirst(source, ['payer', 'payerAddress', 'intent.payer'], null),
    provider: readFirst(source, ['provider', 'providerAddress', 'intent.provider'], null),
    evaluator: readFirst(source, ['evaluator', 'evaluatorAddress', 'intent.evaluator'], null),
    decision,
    status,
    policyHash: String(readFirst(source, ['policyHash', 'policy.hash', 'policy.fingerprint', 'fingerprint'], '—')),
    amountAtomic: String(readFirst(source, ['amountAtomic', 'amount_atomic', 'intent.amount_atomic'], '0')),
    execution: source.execution || payload.execution || null,
    confirmation: source.confirmation || payload.confirmation || null,
    verification,
    reasons: Array.isArray(reasons) ? reasons : [String(reasons)],
    evidence: source.evidence || payload.evidence || null,
    evidenceUrl: source.evidenceUrl || payload.evidenceUrl || null,
  };
}

function verificationLabel(intent) {
  const verification = intent.verification;
  if (typeof verification === 'boolean') return verification ? 'Verified' : 'Not verified';
  const overall = readFirst(verification || {}, ['verified', 'allVerified', 'status', 'result']);
  if (overall === true || String(overall).toLowerCase() === 'verified') return 'Verified';
  if (overall === false || String(overall).toLowerCase().includes('not')) return 'Not verified';
  const entries = Object.values(verification || {}).filter((item) => typeof item === 'boolean');
  if (entries.length) return entries.every(Boolean) ? 'Verified' : 'Not verified';
  return intent.requireVerification === false ? 'Not required' : 'Checked by policy';
}

function nextAction(intent) {
  if (intent.decision === 'DENY') return 'Correct policy or identity failure';
  if (intent.status === 'AWAITING_APPROVAL') return 'Merchant/evaluator approval';
  if (intent.status === 'READY') return 'Record deployment, then create escrow';
  if (intent.status === 'EXECUTION_PREPARED') return 'Create the bound escrow job';
  if (intent.status === 'PENDING') return 'Wait for canonical terminal receipt';
  if (intent.status === 'REFUNDED') return 'Refund verified; payment not completed';
  if (intent.status === 'FINALIZED') return 'Canonical terminal evidence available';
  if (intent.status === 'CREATED') return 'Fund the escrow on GIWA';
  if (intent.status === 'SUBMITTED') return 'Review deliverable hash';
  return 'Follow the escrow state';
}

function transactionLocked() {
  return Boolean(appState.preparingTransaction || appState.preparedTransaction || appState.walletBusy);
}

function updateLocalControls() {
  const locked = transactionLocked();
  form.querySelectorAll('input, button').forEach((control) => {
    control.disabled = locked || appState.intentBusy;
  });
  $('#evaluate-intent').textContent = appState.intentBusy ? 'Evaluating…' : 'Evaluate intent';
  const localDecisionEnabled = appState.runtimeMode === 'fixture';
  approveButton.hidden = !localDecisionEnabled;
  rejectButton.hidden = !localDecisionEnabled;
  const intent = appState.activeIntent;
  approveButton.disabled = locked || !localDecisionEnabled
    || !(intent?.decision === 'HOLD' && intent?.status === 'AWAITING_APPROVAL');
  rejectButton.disabled = locked || !localDecisionEnabled || !intent
    || ['EXECUTION_PREPARED', 'PENDING', 'FINALIZED', 'RELEASED', 'REFUNDED', 'REJECTED'].includes(intent.status);
  evidenceButton.disabled = !intent;
}

function setBusy(isBusy) {
  appState.intentBusy = isBusy;
  updateLocalControls();
}

function renderDecision(intent) {
  const previousIntentId = appState.activeIntent?.id;
  if (previousIntentId && previousIntentId !== intent.id) {
    clearPreparedTransaction({ restoreFocus: false });
    appState.chainJob = null;
    appState.chainJobIntentId = null;
    appState.pendingTerminalProof = null;
  }
  appState.activeIntent = intent;
  const recoverableHash = intent.confirmation?.transaction_hash;
  if (['EXECUTION_PREPARED', 'PENDING'].includes(intent.status)
    && /^0x[0-9a-fA-F]{64}$/.test(recoverableHash || '')
    && !intent.confirmation?.canonical) {
    appState.pendingTerminalProof = { intentId: intent.id, transactionHash: recoverableHash };
  } else if (appState.pendingTerminalProof?.intentId === intent.id) {
    appState.pendingTerminalProof = null;
  }
  decisionEmpty.hidden = true;
  decisionResult.hidden = false;
  decisionResult.dataset.decision = intent.decision;
  $('#decision-word').textContent = intent.decision;
  $('#decision-summary').textContent = intent.reasons.length
    ? intent.reasons.join(' · ')
    : `${intent.decision} produced by the XPAYR local policy gate.`;
  $('#decision-id').textContent = intent.id;
  $('#policy-hash').textContent = intent.policyHash;
  $('#dojang-result').textContent = verificationLabel(intent);
  $('#next-action').textContent = nextAction(intent);
  decisionOrb.className = `decision-orb is-${intent.decision.toLowerCase()}`;
  decisionOrb.textContent = intent.decision.slice(0, 1);
  decisionOrb.setAttribute('aria-label', `Policy decision ${intent.decision}`);
  renderState(intent.status);
  updateLocalControls();
  updateChainControls();
}

function renderState(status) {
  const primary = ['CREATED', 'FUNDED', 'SUBMITTED', 'APPROVED', 'RELEASED'];
  const terminalMap = { CANCELLED: 'FUNDED', REFUNDED: 'FUNDED', DISPUTED: 'SUBMITTED', REJECTED: 'CREATED' };
  const localCaption = {
    AWAITING_APPROVAL: 'AWAITING APPROVAL · local policy; chain job not created',
    READY: 'READY · local intent; chain job not created',
    EXECUTION_PREPARED: 'EXECUTION PREPARED · binding only; chain state pending',
    PENDING: 'PENDING · Flashblocks observation; not final',
    FINALIZED: 'FINALIZED · canonical terminal receipt verified',
  };
  const normalized = primary.includes(status) ? status : terminalMap[status] || 'CREATED';
  const activeIndex = primary.indexOf(normalized);
  stateRail.forEach((item, index) => {
    item.classList.toggle('is-complete', index < activeIndex);
    item.classList.toggle('is-active', index === activeIndex);
    if (index === activeIndex) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
  $('#state-caption').textContent = localCaption[status]
    || (terminalMap[status] ? `${status} · alternate chain path` : `${status} · primary chain path`);
}

function upsertIntent(intent) {
  const index = appState.intents.findIndex((item) => item.id === intent.id);
  if (index >= 0) appState.intents[index] = intent;
  else appState.intents.unshift(intent);
  renderLedger();
}

function renderLedger() {
  if (!appState.intents.length) return;
  ledgerBody.innerHTML = appState.intents.map((intent) => {
    const evidenceState = intent.evidence ? 'Checksummed' : intent.evidenceUrl ? 'Available' : 'Pending';
    return `<tr>
      <td><strong>${escapeHtml(intent.title)}</strong><br><small>${escapeHtml(shortHash(intent.id))}</small></td>
      <td><span class="status-tag ${escapeHtml(intent.decision.toLowerCase())}">${escapeHtml(intent.decision)}</span></td>
      <td>${escapeHtml(verificationLabel(intent))}</td>
      <td><span class="status-tag ${escapeHtml(intent.status.toLowerCase())}">${escapeHtml(intent.status)}</span></td>
      <td><button class="table-button" type="button" data-intent-id="${escapeHtml(intent.id)}">${evidenceState}</button></td>
    </tr>`;
  }).join('');
}

function setProofStage(stage = null) {
  const stages = ['prepared', 'requested', 'pending', 'canonical'];
  const activeIndex = stage ? stages.indexOf(stage) : -1;
  document.querySelectorAll('#proof-rail [data-proof-stage]').forEach((item, index) => {
    item.classList.toggle('is-complete', activeIndex >= 0 && index < activeIndex);
    item.classList.toggle('is-active', index === activeIndex);
    if (index === activeIndex) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
}

function roleAddresses(role) {
  const intent = appState.activeIntent;
  if (!intent) return [];
  const values = role === 'payer'
    ? [intent.payer]
    : role === 'provider'
      ? [intent.provider]
      : role === 'payer/evaluator'
        ? [intent.payer, intent.evaluator]
        : role === 'resolver'
          ? [intent.evaluator || intent.payer]
          : [intent.payer, intent.provider, intent.evaluator];
  return values.map(normalizeAddress).filter(Boolean);
}

function walletHasRole(role) {
  const connected = normalizeAddress(appState.walletAddress);
  return Boolean(connected && roleAddresses(role).includes(connected));
}

function nextRequiredRole() {
  if (!appState.activeIntent) return 'Select an intent';
  const state = appState.chainJobIntentId === appState.activeIntent.id
    ? appState.chainJob?.status || 'NONE'
    : 'NONE';
  if (state === 'NONE') return 'Payer';
  if (state === 'CREATED') return 'Payer';
  if (state === 'FUNDED') return 'Provider (submit) / payer (cancel)';
  if (state === 'SUBMITTED') return 'Payer/evaluator or participant';
  if (state === 'APPROVED') return 'Participant';
  if (state === 'DISPUTED') return 'Configured resolver';
  if (['CANCELLED', 'EXPIRED'].includes(state)) return 'Payer refund';
  return 'Read-only terminal state';
}

function renderWalletIdentity() {
  const live = appState.runtimeMode === 'live_wallet' && appState.walletExecution.enabled === true;
  const address = normalizeAddress(appState.walletAddress);
  const exactChain = Number(appState.walletChainId) === 91342;
  $('#wallet-lane-title').textContent = live
    ? address && exactChain ? 'Wallet authority ready' : 'Connect a GIWA Sepolia wallet'
    : 'Wallet execution disabled';
  $('#wallet-address').textContent = address ? shortHash(address) : 'Not connected';
  $('#wallet-address').title = address || '';
  $('#wallet-chain').textContent = exactChain ? 'GIWA Sepolia · 91342' : address ? 'Wrong or unknown chain' : 'Not checked';
  $('#wallet-role').textContent = nextRequiredRole();
  $('#wallet-limit').textContent = live
    ? `${readFirst(appState.walletExecution, ['limits.maxJobValueWei'], '—')} wei`
    : 'No chain request permitted';
  $('#wallet-light').classList.toggle('is-ready', Boolean(live && address && exactChain));
  const button = $('#connect-wallet');
  button.hidden = !live;
  button.disabled = !live || appState.walletBusy;
  button.textContent = address ? shortHash(address) : 'Connect test wallet';
}

function setRuntimeMode(mode, { identitySource = 'unknown' } = {}) {
  const live = mode === 'live_wallet';
  appState.runtimeMode = live ? 'live_wallet' : 'fixture';
  appState.runtimeIdentitySource = identitySource;
  const badge = $('#runtime-mode');
  badge.className = `mode-badge ${live ? 'is-live' : 'is-fixture'}`;
  badge.textContent = live
    ? 'Live GIWA Sepolia · user wallet confirmation'
    : 'Local fixture · chain writes disabled';
  $('#proof-mode-copy').textContent = live
    ? 'Live mode prepares bounded transactions; the connected participant remains the only signing authority.'
    : 'Fixture mode exercises local policy flow only. Wallet loading and all chain writes are hard-disabled.';
  $('#network-pill').innerHTML = live
    ? '<i aria-hidden="true"></i> GIWA Sepolia · 91342'
    : '<i aria-hidden="true"></i> Local fixture · not chain proof';
  if (!appState.activeIntent) {
    $('#state-caption').textContent = live
      ? 'LIVE RUNTIME · no chain job selected'
      : 'FIXTURE RUNTIME · no chain job created';
  }
  $('#load-demo').hidden = live;
  if (!live) {
    appState.walletAddress = null;
    appState.walletChainId = null;
    clearPreparedTransaction({ restoreFocus: false });
  }
  updateLocalControls();
  renderWalletIdentity();
}

function setButtonEnabled(id, role) {
  const button = $(id);
  button.disabled = transactionLocked() || !walletHasRole(role);
}

function updateChainControls() {
  const live = appState.runtimeMode === 'live_wallet' && appState.walletExecution.enabled === true;
  const walletReady = Boolean(
    live
    && appState.contractAddress
    && appState.activeIntent
    && walletClient
    && normalizeAddress(appState.walletAddress)
    && Number(appState.walletChainId) === 91342
    && !transactionLocked(),
  );
  chainButtons.forEach((button) => { button.disabled = true; });
  renderWalletIdentity();
  if (!live || !appState.contractAddress || !appState.activeIntent || !walletClient) return;
  $('#chain-refresh').disabled = appState.walletBusy;
  if (appState.pendingTerminalProof?.intentId === appState.activeIntent.id) {
    $('#chain-retry-evidence').disabled = appState.walletBusy;
  }
  if (!walletReady) return;
  const state = appState.chainJobIntentId === appState.activeIntent.id
    ? appState.chainJob?.status || 'NONE'
    : 'NONE';
  const now = Math.floor(Date.now() / 1000);
  const intentReady = ['READY', 'EXECUTION_PREPARED'].includes(appState.activeIntent.status);
  if (state === 'NONE' && intentReady) setButtonEnabled('#chain-create', 'payer');
  if (state === 'CREATED') {
    setButtonEnabled('#chain-fund', 'payer');
    setButtonEnabled('#chain-cancel', 'payer');
  }
  if (state === 'FUNDED') {
    setButtonEnabled('#chain-submit', 'provider');
    setButtonEnabled('#chain-cancel', 'payer');
  }
  if (state === 'SUBMITTED') {
    setButtonEnabled('#chain-approve', 'payer/evaluator');
    setButtonEnabled('#chain-dispute', 'participant');
  }
  if (state === 'APPROVED') {
    setButtonEnabled('#chain-release', 'participant');
    setButtonEnabled('#chain-dispute', 'participant');
  }
  if (state === 'DISPUTED') setButtonEnabled('#chain-resolve-provider', 'resolver');
  if (['CREATED', 'FUNDED', 'SUBMITTED'].includes(state) && appState.chainJob.expiresAt < now) {
    setButtonEnabled('#chain-expire', 'participant');
  }
  const refundableAmount = BigInt(appState.chainJob?.amountAtomic || '0') > 0n;
  if ((state === 'DISPUTED' || ['CANCELLED', 'EXPIRED'].includes(state) && refundableAmount)) {
    setButtonEnabled('#chain-refund', state === 'DISPUTED' ? 'resolver' : 'payer');
  }
  if (state === 'DISPUTED' && appState.chainJob.disputeOpenedAt + 7 * 24 * 60 * 60 < now) {
    setButtonEnabled('#chain-timeout-refund', 'payer');
  }
  $('#chain-refund b').textContent = state === 'DISPUTED' ? 'Resolve refund' : 'Claim refund';
  updateLocalControls();
}

function setChainStatus(text, transactionHash = null) {
  const target = $('#chain-status');
  target.textContent = text;
  if (transactionHash && /^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
    target.append(' ');
    const link = document.createElement('a');
    link.href = `https://sepolia-explorer.giwa.io/tx/${transactionHash}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open transaction ↗';
    target.append(link);
  }
}

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error?.message || `RPC ${method} failed.`);
  return payload.result;
}

async function observeFlashblocks(transactionHash) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const receipt = await rpc(
      'https://sepolia-rpc-flashblocks.giwa.io',
      'eth_getTransactionReceipt',
      [transactionHash],
    );
    if (receipt) return { seen: true, receipt };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { seen: false, receipt: null };
}

function snapshotActiveContext() {
  const intent = appState.activeIntent;
  if (!intent || !appState.contractAddress) return null;
  return Object.freeze({
    intentId: intent.id,
    jobId: intent.jobId,
    contractAddress: appState.contractAddress,
    intent: Object.freeze({ ...intent }),
    chainJob: appState.chainJobIntentId === intent.id && appState.chainJob
      ? Object.freeze({ ...appState.chainJob })
      : Object.freeze({ status: 'NONE' }),
  });
}

function contextIsActive(context) {
  return Boolean(context
    && appState.activeIntent?.id === context.intentId
    && appState.activeIntent?.jobId === context.jobId);
}

async function refreshChainJob(context = snapshotActiveContext()) {
  if (!context || !walletClient) return;
  try {
    const chainJob = await walletClient.readJob({
      contractAddress: context.contractAddress,
      jobId: context.jobId,
    });
    if (!contextIsActive(context)) return;
    appState.chainJob = chainJob;
    appState.chainJobIntentId = context.intentId;
    renderState(chainJob.status);
    setChainStatus(`Canonical contract state: ${chainJob.status}.`);
  } catch (error) {
    if (!contextIsActive(context)) return;
    if (/not found|execution reverted|NONE/i.test(error.message)) {
      appState.chainJob = { status: 'NONE' };
      appState.chainJobIntentId = context.intentId;
    } else setChainStatus(error.message);
  }
  updateChainControls();
}

function decimalWei(value) {
  try { return `${BigInt(value || '0').toString()} wei`; } catch { return 'Invalid'; }
}

function renderPreparedTransaction(entry) {
  const { label, prepared, context } = entry;
  const preview = prepared.preview;
  const decoded = preview.decoded || {};
  entry.button.querySelector('b').textContent = 'Review ready';
  $('#preview-action').textContent = preview.action || label;
  $('#preview-contract').textContent = preview.to || '—';
  $('#preview-signer').textContent = preview.from || '—';
  $('#preview-method').textContent = decoded.method || '—';
  $('#preview-job').textContent = decoded.jobId || context.jobId || '—';
  $('#preview-value').textContent = decimalWei(preview.valueWei);
  $('#preview-gas').textContent = String(preview.gasLimit || '—');
  $('#preview-fee').textContent = decimalWei(preview.maxFeePerGasWei);
  $('#preview-total').textContent = decimalWei(preview.maxTotalRequestedCostWei);
  const terms = {
    provider: decoded.provider,
    evaluator: decoded.evaluator,
    expected: decoded.expectedAmountWei === undefined ? undefined : decimalWei(decoded.expectedAmountWei),
    expiry: decoded.expiresAt === undefined
      ? undefined
      : `${decoded.expiresAt} · ${new Date(Number(decoded.expiresAt) * 1000).toISOString()}`,
    policy: decoded.policyDecisionHash,
    deliverable: decoded.deliverableHash,
    payout: decoded.payProvider === undefined ? undefined : decoded.payProvider ? 'Provider' : 'Payer / refund',
  };
  for (const [term, value] of Object.entries(terms)) {
    const row = document.querySelector(`[data-preview-term="${term}"]`);
    row.hidden = value === undefined;
    row.querySelector('dd').textContent = value ?? '—';
  }
  $('#transaction-review').hidden = false;
  setProofStage('prepared');
  setChainStatus(`${label} is bounded and ready for review. No wallet request has been sent.`);
  $('#confirm-wallet-send').focus();
}

function clearPreparedTransaction({ announce = false, restoreFocus = true } = {}) {
  const entry = appState.preparedTransaction || appState.preparingTransaction;
  const origin = entry?.button;
  if (origin?.querySelector('b')) origin.querySelector('b').textContent = entry.previous;
  appState.preparedTransaction = null;
  appState.preparingTransaction = null;
  $('#transaction-review').hidden = true;
  setProofStage(null);
  if (announce) setChainStatus('Prepared wallet request cancelled. Nothing was sent.');
  updateChainControls();
  if (restoreFocus && origin) origin.focus();
}

async function prepareChainTransaction(button, label, transactionFactory, { terminalOutcome = false } = {}) {
  if (transactionLocked()) return;
  const context = snapshotActiveContext();
  if (!context) return;
  const previous = button.querySelector('b').textContent;
  const preparation = { button, label, previous, context };
  appState.preparingTransaction = preparation;
  button.disabled = true;
  button.querySelector('b').textContent = 'Preparing…';
  updateChainControls();
  try {
    const prepared = await transactionFactory(context);
    if (!prepared?.preview || typeof prepared?.send !== 'function') {
      throw new Error('Wallet client did not return a bounded transaction preview.');
    }
    if (appState.preparingTransaction !== preparation || !contextIsActive(context)) {
      throw new Error('Active intent or wallet session changed while preparing. Prepare a fresh request.');
    }
    if (prepared.preview.decoded?.jobId?.toLowerCase() !== context.jobId.toLowerCase()) {
      throw new Error('Decoded wallet calldata does not match the selected job.');
    }
    appState.preparingTransaction = null;
    appState.preparedTransaction = { button, label, previous, prepared, terminalOutcome, context };
    renderPreparedTransaction(appState.preparedTransaction);
  } catch (error) {
    if (contextIsActive(context)) setChainStatus(error.shortMessage || error.message || `${label} preparation failed.`);
    if (appState.preparingTransaction === preparation) appState.preparingTransaction = null;
    button.querySelector('b').textContent = previous;
  } finally {
    updateChainControls();
  }
}

async function confirmPreparedTransaction() {
  const entry = appState.preparedTransaction;
  if (!entry || appState.walletBusy) return;
  const { button, label, previous, prepared, terminalOutcome, context } = entry;
  if (!contextIsActive(context)) {
    clearPreparedTransaction({ announce: true, restoreFocus: true });
    return;
  }
  appState.walletBusy = true;
  $('#confirm-wallet-send').disabled = true;
  $('#cancel-wallet-send').disabled = true;
  button.querySelector('b').textContent = 'Check wallet…';
  setProofStage('requested');
  try {
    const transaction = await prepared.send();
    if (terminalOutcome) {
      appState.pendingTerminalProof = { intentId: context.intentId, transactionHash: transaction.hash };
      try {
        const submitted = normalizeIntent(await api(`/api/intents/${encodeURIComponent(context.intentId)}/confirmations/wallet-submitted`, {
          method: 'POST',
          body: JSON.stringify({ transactionHash: transaction.hash }),
        }));
        upsertIntent(submitted);
        if (contextIsActive(context)) renderDecision(submitted);
      } catch (error) {
        setChainStatus(`Wallet returned a transaction hash, but server recovery registration failed: ${error.message}`, transaction.hash);
      }
    }
    setChainStatus(`${label} submitted. Flashblocks may show an early signal; it is not final.`, transaction.hash);
    button.querySelector('b').textContent = 'Pending…';
    setProofStage('pending');
    let flash = { seen: false };
    try {
      flash = await observeFlashblocks(transaction.hash);
      if (flash.seen) {
        setChainStatus(`${label} seen by Flashblocks as pending—not completed.`, transaction.hash);
        if (terminalOutcome) {
          await api(`/api/intents/${encodeURIComponent(context.intentId)}/confirmations/flashblocks`, {
            method: 'POST',
            body: JSON.stringify({ transactionHash: transaction.hash, seen: true }),
          });
        }
      }
    } catch {
      // A rate-limited preconfirmation endpoint cannot replace canonical confirmation.
    }
    const receipt = await transaction.wait(1, 120000);
    if (Number(receipt.status) !== 1) throw new Error(`${label} reverted on GIWA Sepolia.`);
    setChainStatus(`${label} confirmed by a canonical GIWA Sepolia receipt.`, transaction.hash);
    setProofStage('canonical');
    if (terminalOutcome) {
      appState.pendingTerminalProof = { intentId: context.intentId, transactionHash: receipt.hash || transaction.hash };
      try {
        await finalizeTerminalEvidence(context.intentId, appState.pendingTerminalProof.transactionHash);
        appState.pendingTerminalProof = null;
      } catch (error) {
        setChainStatus(`Transaction is canonical, but evidence verification must be retried: ${error.message}`, transaction.hash);
        await refreshChainJob(context);
        return;
      }
    }
    await refreshChainJob(context);
  } catch (error) {
    const cancelled = Number(error?.code) === 4001 || /user (?:rejected|cancelled)|action_rejected/i.test(error?.message || '');
    setChainStatus(cancelled
      ? 'Wallet request cancelled by the user. Nothing was retried.'
      : error.shortMessage || error.message || `${label} failed.`);
  } finally {
    button.querySelector('b').textContent = previous;
    appState.walletBusy = false;
    if (appState.preparedTransaction === entry) appState.preparedTransaction = null;
    if (appState.preparingTransaction?.context === context) appState.preparingTransaction = null;
    $('#transaction-review').hidden = true;
    $('#confirm-wallet-send').disabled = false;
    $('#cancel-wallet-send').disabled = false;
    updateChainControls();
  }
}

async function finalizeTerminalEvidence(intentId, transactionHash) {
  const payload = await api(`/api/intents/${encodeURIComponent(intentId)}/confirmations/canonical`, {
    method: 'POST',
    body: JSON.stringify({ transactionHash }),
  });
  const finalized = normalizeIntent(payload);
  upsertIntent(finalized);
  if (appState.activeIntent?.id === intentId) renderDecision(finalized);
}

async function retryTerminalEvidence() {
  const pending = appState.pendingTerminalProof;
  if (!pending || pending.intentId !== appState.activeIntent?.id) return;
  const button = $('#chain-retry-evidence');
  button.disabled = true;
  try {
    await finalizeTerminalEvidence(pending.intentId, pending.transactionHash);
    appState.pendingTerminalProof = null;
    setChainStatus('Canonical terminal evidence verified after retry.', pending.transactionHash);
    await refreshChainJob(snapshotActiveContext());
  } catch (error) {
    setChainStatus(`Evidence retry remains pending: ${error.message}`, pending.transactionHash);
  } finally {
    updateChainControls();
  }
}

async function prepareAndCreateJob(context) {
  const payload = await api(`/api/intents/${encodeURIComponent(context.intentId)}/bridge`, { method: 'POST' });
  const prepared = normalizeIntent(payload);
  if (prepared.id !== context.intentId || prepared.jobId.toLowerCase() !== context.jobId.toLowerCase()) {
    throw new Error('Execution binding response does not match the selected intent.');
  }
  upsertIntent(prepared);
  if (contextIsActive(context)) renderDecision(prepared);
  const binding = prepared.execution?.binding;
  if (!binding || binding.requires_contract_deployment) throw new Error('Execution binding has no deployed escrow contract.');
  const expiresAt = Number(binding.expires_at);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new Error('Execution binding has no valid policy-bound expiry.');
  }
  return walletClient.createJob({
    contractAddress: context.contractAddress,
    jobId: binding.job_id,
    jobNonce: binding.job_nonce,
    payer: binding.payer,
    provider: binding.provider,
    evaluator: binding.evaluator,
    amountAtomic: binding.amount_atomic,
    expiresAt,
    policyDecisionHash: binding.policy_decision_hash,
  });
}

function validateForm() {
  const addressPattern = /^0x[a-fA-F0-9]{40}$/;
  const addressInputs = [$('#payer-address'), $('#provider-address'), $('#evaluator-address')];
  let valid = true;
  for (const input of addressInputs) {
    const okay = !input.value || addressPattern.test(input.value.trim());
    input.setAttribute('aria-invalid', String(!okay));
    if (!okay || (input.required && !input.value)) valid = false;
  }
  const amount = Number($('#amount-eth').value);
  if (!Number.isFinite(amount) || amount <= 0) valid = false;
  if (!valid) throw new Error('Enter valid 0x wallet addresses and positive test ETH amounts.');
}

function formPayload() {
  return {
    title: $('#job-title').value.trim(),
    networkKey: 'giwa-testnet',
    payerAddress: $('#payer-address').value.trim(),
    providerAddress: $('#provider-address').value.trim(),
    evaluatorAddress: $('#evaluator-address').value.trim() || null,
    amountEth: $('#amount-eth').value,
    requireVerification: $('#require-verification').checked,
    requireApproval: appState.runtimeMode === 'fixture',
    asset: 'TEST_ETH',
  };
}

async function submitIntent(event) {
  event.preventDefault();
  message.textContent = '';
  try {
    validateForm();
    setBusy(true);
    const payload = await api('/api/intents', { method: 'POST', body: JSON.stringify(formPayload()) });
    const intent = normalizeIntent(payload);
    upsertIntent(intent);
    renderDecision(intent);
    showToast(`Intent ${intent.decision}: ${shortHash(intent.id)}`);
  } catch (error) {
    message.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function transitionIntent(action) {
  const intent = appState.activeIntent;
  if (!intent || intent.id === 'pending') return;
  if (appState.runtimeMode !== 'fixture') {
    showToast('Live mode has no unauthenticated local decision override. Submit a direct ALLOW intent.');
    return;
  }
  const button = action === 'approve' ? approveButton : rejectButton;
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = action === 'approve' ? 'Approving…' : 'Rejecting…';
  try {
    const payload = await api(`/api/intents/${encodeURIComponent(intent.id)}/${action}`, {
      method: 'POST',
      body: JSON.stringify(action === 'approve'
        ? { approver: intent.evaluator || intent.payer, manual: true }
        : { actor: intent.payer, manual: true }),
    });
    const updated = normalizeIntent(payload);
    upsertIntent(updated);
    renderDecision(updated);
    showToast(action === 'approve'
      ? 'Fixture HOLD cleared locally. This cannot authorize a live wallet request.'
      : 'Intent rejected.');
  } catch (error) {
    showToast(error.message);
  } finally {
    button.textContent = previous;
    if (appState.activeIntent) renderDecision(appState.activeIntent);
  }
}

async function resolveEvidence(intent) {
  if (intent.evidence) return intent.evidence;
  try {
    const payload = await api(`/api/intents/${encodeURIComponent(intent.id)}/evidence`);
    return payload.evidence || payload;
  } catch {
    throw new Error('Server evidence is not available for this intent yet. No local substitute was generated.');
  }
}

async function downloadEvidence(intent = appState.activeIntent) {
  if (!intent) return;
  try {
    const evidence = await resolveEvidence(intent);
    intent.evidence = evidence;
    upsertIntent(intent);
    const blob = new Blob([`${JSON.stringify(evidence, null, 2)}\n`], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `xpayr-giwa-evidence-${intent.id}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast('Checksummed evidence downloaded. The digest is not a producer signature.');
  } catch (error) {
    showToast(error.message);
  }
}

async function connectWallet() {
  if (appState.runtimeMode !== 'live_wallet' || appState.walletExecution.enabled !== true) {
    showToast('Wallet execution is disabled in this runtime mode.');
    return;
  }
  if (!walletClient || !window.ethereum) {
    showToast('No EIP-1193 wallet found. Install a test wallet to connect.');
    return;
  }
  const button = $('#connect-wallet');
  try {
    button.disabled = true;
    const connection = await walletClient.connect();
    appState.walletAddress = normalizeAddress(connection.address);
    appState.walletChainId = Number(connection.chainId);
    if (appState.walletAddress && !$('#payer-address').value) $('#payer-address').value = connection.address;
    renderWalletIdentity();
    updateChainControls();
    showToast('Test wallet connected to GIWA Sepolia. No transaction was signed.');
  } catch (error) {
    showToast(error.message || 'Wallet connection failed.');
  } finally {
    button.disabled = false;
    renderWalletIdentity();
  }
}

function applyWalletSession(session = {}) {
  const previousAddress = appState.walletAddress;
  const previousChain = appState.walletChainId;
  appState.walletAddress = normalizeAddress(session.address);
  appState.walletChainId = session.chainId === null || session.chainId === undefined
    ? null
    : Number(session.chainId);
  if (previousAddress !== appState.walletAddress || previousChain !== appState.walletChainId) {
    clearPreparedTransaction({ restoreFocus: false });
    if (appState.walletAddress && Number(appState.walletChainId) === 91342) {
      setChainStatus('Wallet session changed. Review the active intent and refresh canonical state.');
    } else {
      setChainStatus('Wallet session is not ready for GIWA Sepolia. Chain writes remain locked.');
    }
  }
  renderWalletIdentity();
  updateChainControls();
}

async function initializeWalletClient() {
  walletClient = await loadWalletBundle();
  if (typeof walletClient?.getSession === 'function') {
    applyWalletSession(await walletClient.getSession());
  }
  if (typeof walletClient?.watchSession === 'function') {
    appState.walletUnsubscribe?.();
    appState.walletUnsubscribe = walletClient.watchSession(applyWalletSession);
  }
}

function loadSafeFixture() {
  $('#payer-address').value = '0x1111111111111111111111111111111111111111';
  $('#provider-address').value = '0x2222222222222222222222222222222222222222';
  $('#evaluator-address').value = '0x3333333333333333333333333333333333333333';
  $('#amount-eth').value = '0.000001';
  $('#require-verification').checked = true;
  showToast('Address-format fixture loaded. Dojang—not the fixture—determines verification.');
}

let toastTimer;
function showToast(text) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
}

async function loadExistingIntents() {
  try {
    const payload = await api('/api/intents');
    const items = payload.intents || payload.data || (Array.isArray(payload) ? payload : []);
    appState.intents = items.map((item) => normalizeIntent(item));
    renderLedger();
    if (appState.intents[0]) renderDecision(appState.intents[0]);
  } catch {
    // The form remains usable and will surface a precise error on submission.
  }
}

function proofCard(tag, title, body, facts = []) {
  const items = facts.map(({ label, value, html }) => `<div><dt>${escapeHtml(label)}</dt><dd>${html || escapeHtml(value)}</dd></div>`).join('');
  return `<article class="retained-proof-card"><span>${escapeHtml(tag)}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p><dl>${items}</dl></article>`;
}

function renderReviewerProof(proof) {
  const source = readFirst(proof, ['contract.source_verification', 'sourceVerification'], {});
  const identity = readFirst(proof, ['identity'], {});
  const authority = readFirst(proof, ['authority_model'], {});
  const lifecycles = readFirst(proof, [
    'phase4_separation_of_duties.authenticated_lifecycles',
    'signed_policy_authenticated_d3',
    'signed_lifecycles',
    'lifecycles',
    'terminalProofs',
  ], []);
  const records = Array.isArray(lifecycles) ? lifecycles : Object.values(lifecycles || {});
  const release = records.find((item) => String(readFirst(item, ['outcome', 'terminal_state'], '')).toUpperCase().includes('RELEASE')) || records[0] || {};
  const refund = records.find((item) => String(readFirst(item, ['outcome', 'terminal_state'], '')).toUpperCase().includes('REFUND')) || records[1] || {};
  const contract = readFirst(proof, ['contract.address', 'deployment.contractAddress'], appState.contractAddress);
  const deploymentTx = readFirst(proof, ['contract.deployment_transaction_hash', 'deployment.transactionHash'], null);
  const digest = readFirst(proof, ['integrity.digest', 'reviewer_index_digest', 'digest'], '—');
  const sourceLevel = readFirst(source, ['verification_level', 'level'], 'verified_partial_expected_no_cbor');
  const d1Digest = readFirst(identity, ['d1_digest', 'digest'], '—');
  const releaseTx = readFirst(release, ['terminal_transaction_hash', 'transaction_hash', 'terminal.transaction_hash'], null);
  const refundTx = readFirst(refund, ['terminal_transaction_hash', 'transaction_hash', 'terminal.transaction_hash'], null);
  const releaseAnchor = readFirst(release, ['anchor_transaction_hash', 'anchor.transaction_hash'], null);
  const refundAnchor = readFirst(refund, ['anchor_transaction_hash', 'anchor.transaction_hash'], null);
  $('#proof-contract').innerHTML = explorerLink('address', contract);
  $('#proof-dojang').textContent = d1Digest === '—' ? 'Retained proof unavailable' : `Verified · ${shortHash(d1Digest)}`;
  $('#proof-source').textContent = String(sourceLevel).replaceAll('_', ' ');
  $('#canonical-lane-title').textContent = 'Retained index digest matched';
  $('#canonical-light').classList.add('is-ready');
  $('#reviewer-proof-cards').innerHTML = [
    proofCard('D1', 'Retained identity proof', 'The checked-in index references payer/provider reconstruction at one canonical block; this page validates the index digest, not a fresh RPC read.', [
      { label: 'Digest', value: shortHash(d1Digest) },
      { label: 'Payer', value: readFirst(identity, ['payer_deployer'], '—') },
      { label: 'Provider', value: readFirst(identity, ['provider'], '—') },
    ]),
    proofCard('D2', 'Retained deployment proof', 'The checked-in record contains the reconciled runtime code, creation input, and explorer-source result.', [
      { label: 'Escrow', html: explorerLink('address', contract) },
      { label: 'Deploy tx', html: deploymentTx ? explorerLink('tx', deploymentTx) : '—' },
      { label: 'Source level', value: String(sourceLevel).replaceAll('_', ' ') },
    ]),
    proofCard('D3 + XPA2', 'Retained release + refund', 'The sealed index binds two bounded test-ETH terminal outcomes to separate Phase 4 policy and evidence authorities, including canonical XPA2 anchors.', [
      { label: 'Release', html: releaseTx ? explorerLink('tx', releaseTx) : 'Retained in package' },
      { label: 'Refund', html: refundTx ? explorerLink('tx', refundTx) : 'Retained in package' },
      { label: 'Anchors', html: [releaseAnchor && explorerLink('tx', releaseAnchor, 'release'), refundAnchor && explorerLink('tx', refundAnchor, 'refund')].filter(Boolean).join(' · ') || 'Retained in package' },
      { label: 'Phase 4 authority', value: readFirst(authority, ['separation_of_duties'], false) ? 'Separated duties' : 'Same demo EOA · explicitly disclosed' },
      { label: 'Index digest', value: shortHash(digest) },
    ]),
  ].join('');
}

async function loadReviewerProof() {
  try {
    const payload = await api('/api/reviewer-proof');
    const proof = payload.proof || payload.reviewerProof || payload;
    appState.reviewerProof = proof;
    renderReviewerProof(proof);
  } catch (error) {
    $('#canonical-lane-title').textContent = 'Retained proof unavailable';
    $('#reviewer-proof-cards').innerHTML = `<article class="retained-proof-card is-failed"><span>!</span><h3>Proof gate failed closed</h3><p>${escapeHtml(error.message)}</p></article>`;
  }
}

async function loadRuntimeTruth() {
  try {
    const payload = await api('/api/config');
    const mode = String(readFirst(payload, ['identitySource', 'mode.identitySource', 'runtime.identitySource'], 'onchain'));
    const runtimeMode = String(readFirst(payload, ['runtime.mode'], mode.toLowerCase().includes('fixture') ? 'fixture' : 'live_wallet'));
    const walletExecution = readFirst(payload, ['runtime.walletExecution', 'walletExecution'], false);
    appState.walletExecution = Object.freeze(typeof walletExecution === 'object'
      ? walletExecution
      : {
          enabled: walletExecution === true,
          limits: readFirst(payload, ['runtime.limits'], {}),
          exactReviewedDeployment: readFirst(payload, ['runtime.exactReviewedDeployment'], false),
        });
    appState.contractAddress = readFirst(payload, [
      'manifest.contracts.escrow',
      'contracts.escrow',
      'deployment.contractAddress',
    ], null);
    setRuntimeMode(runtimeMode, { identitySource: mode });
    if (appState.contractAddress) {
      $('.deployment-truth').classList.add('is-ready');
      $('#deployment-label').textContent = `Escrow ${shortHash(appState.contractAddress)}`;
      $('#chain-status').textContent = appState.runtimeMode === 'live_wallet'
        ? 'Select an executable intent, connect the required participant wallet, then refresh canonical state.'
        : 'Fixture runtime confirmed. Wallet loading and chain writes are disabled.';
    }
    if (appState.runtimeMode === 'live_wallet' && appState.walletExecution.enabled === true) {
      try {
        await initializeWalletClient();
      } catch (error) {
        walletClient = null;
        setChainStatus(`Live read-only mode: ${error.message}`);
      }
    }
    updateChainControls();
  } catch (error) {
    setRuntimeMode('fixture', { identitySource: 'config_error_fail_closed' });
    setChainStatus(`Runtime truth failed closed: ${error.message}`);
  }
}

form.addEventListener('submit', submitIntent);
$('#load-demo').addEventListener('click', loadSafeFixture);
$('#connect-wallet').addEventListener('click', connectWallet);
approveButton.addEventListener('click', () => transitionIntent('approve'));
rejectButton.addEventListener('click', () => transitionIntent('reject'));
evidenceButton.addEventListener('click', () => downloadEvidence());
$('#chain-create').addEventListener('click', () => prepareChainTransaction(
  $('#chain-create'), 'Create job', prepareAndCreateJob,
));
$('#chain-fund').addEventListener('click', () => prepareChainTransaction(
  $('#chain-fund'),
  'Fund escrow',
  (context) => walletClient.fundJob({
    contractAddress: context.contractAddress,
    jobId: context.jobId,
    payer: context.intent.payer,
    amountAtomic: context.intent.amountAtomic,
  }),
));
$('#chain-submit').addEventListener('click', () => prepareChainTransaction(
  $('#chain-submit'),
  'Submit deliverable',
  (context) => walletClient.submitDeliverable({
    contractAddress: context.contractAddress,
    jobId: context.jobId,
    provider: context.intent.provider,
    deliverableHash: walletClient.hashDeliverable($('#deliverable-reference').value),
  }),
));
$('#chain-approve').addEventListener('click', () => prepareChainTransaction(
  $('#chain-approve'),
  'Approve deliverable',
  (context) => walletClient.approveJob({
    contractAddress: context.contractAddress,
    jobId: context.jobId,
    payer: context.intent.payer,
    evaluator: context.intent.evaluator,
  }),
));
$('#chain-release').addEventListener('click', () => prepareChainTransaction(
  $('#chain-release'),
  'Release payment',
  (context) => walletClient.releaseJob({
    contractAddress: context.contractAddress,
    jobId: context.jobId,
    payer: context.intent.payer,
    provider: context.intent.provider,
    evaluator: context.intent.evaluator,
  }),
  { terminalOutcome: true },
));
$('#chain-dispute').addEventListener('click', () => prepareChainTransaction(
  $('#chain-dispute'),
  'Open dispute',
  (context) => walletClient.openDispute({
    contractAddress: context.contractAddress,
    jobId: context.jobId,
    payer: context.intent.payer,
    provider: context.intent.provider,
    evaluator: context.intent.evaluator,
  }),
));
$('#chain-resolve-provider').addEventListener('click', () => prepareChainTransaction(
  $('#chain-resolve-provider'),
  'Resolve dispute to provider',
  (context) => walletClient.resolveDispute({
    contractAddress: context.contractAddress,
    jobId: context.jobId,
    resolver: context.intent.evaluator || context.intent.payer,
    payProvider: true,
  }),
  { terminalOutcome: true },
));
$('#chain-cancel').addEventListener('click', () => prepareChainTransaction(
  $('#chain-cancel'),
  'Cancel job',
  (context) => walletClient.cancelJob({
    contractAddress: context.contractAddress,
    jobId: context.jobId,
    payer: context.intent.payer,
  }),
));
$('#chain-expire').addEventListener('click', () => prepareChainTransaction(
  $('#chain-expire'),
  'Mark job expired',
  (context) => walletClient.markExpired({
    contractAddress: context.contractAddress,
    jobId: context.jobId,
    payer: context.intent.payer,
    provider: context.intent.provider,
    evaluator: context.intent.evaluator,
  }),
));
$('#chain-refund').addEventListener('click', () => prepareChainTransaction(
  $('#chain-refund'),
  appState.chainJobIntentId === appState.activeIntent?.id && appState.chainJob?.status === 'DISPUTED' ? 'Resolve dispute to payer' : 'Claim refund',
  (context) => context.chainJob?.status === 'DISPUTED'
    ? walletClient.resolveDispute({
        contractAddress: context.contractAddress,
        jobId: context.jobId,
        resolver: context.intent.evaluator || context.intent.payer,
        payProvider: false,
      })
    : walletClient.claimRefund({
        contractAddress: context.contractAddress,
        jobId: context.jobId,
        payer: context.intent.payer,
      }),
  { terminalOutcome: true },
));
$('#chain-timeout-refund').addEventListener('click', () => prepareChainTransaction(
  $('#chain-timeout-refund'),
  'Claim dispute timeout refund',
  (context) => walletClient.claimDisputeTimeoutRefund({
    contractAddress: context.contractAddress,
    jobId: context.jobId,
    payer: context.intent.payer,
  }),
  { terminalOutcome: true },
));
$('#chain-retry-evidence').addEventListener('click', retryTerminalEvidence);
$('#chain-refresh').addEventListener('click', () => refreshChainJob());
$('#confirm-wallet-send').addEventListener('click', confirmPreparedTransaction);
$('#cancel-wallet-send').addEventListener('click', () => clearPreparedTransaction({ announce: true }));
ledgerBody.addEventListener('click', (event) => {
  const button = event.target.closest('[data-intent-id]');
  if (!button) return;
  const intent = appState.intents.find((item) => item.id === button.dataset.intentId);
  if (intent) downloadEvidence(intent);
});

loadRuntimeTruth();
loadExistingIntents();
loadReviewerProof();
