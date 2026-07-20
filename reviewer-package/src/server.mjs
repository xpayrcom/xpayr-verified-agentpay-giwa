import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateCanonicalReceipt, evaluateFlashblocksSignal, normalizeTransactionHash } from './confirmation.mjs';
import { CanonicalReceiptClient } from './canonical-client.mjs';
import { asPublicError, DomainError, invariant } from './errors.mjs';
import { loadManifest, publicManifest, validateManifest } from './manifest.mjs';
import { canonicalJson, hashesEqual, sha256Hex } from './canonical-json.mjs';
import {
  createDemoFixtureDojangClient,
  XpayrGiwaAgentPayService,
} from './xpayr-agentpay-adapter.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = resolve(MODULE_DIR, '../public');
const DEFAULT_MANIFEST_PATH = resolve(MODULE_DIR, '../config/giwa-testnet.json');
const DEFAULT_REVIEWER_INDEX_PATH = resolve(MODULE_DIR, '../evidence/giwa-sepolia-reviewer-index-20260720.json');
const MAX_BODY_BYTES = 64 * 1024;
const REVIEWED_CHAIN_ID = 91342;
const REVIEWED_ESCROW_ADDRESS = '0x7b0630cBb92be8E11512cb331b8D1aef94cEEc53';
const REVIEWED_ESCROW_RUNTIME_CODE_KECCAK256 = '0x11c4e07f17a1dee1e23f5a3c113fdf7a67a9e73ccdceb8c989b52fae23c0a40a';
const SEALED_REVIEWER_INDEX_DIGEST = '0x30e5f155ac7b4caeee4a8b149ff653f9c4b82b220b777c09a6344f4cf99e2be5';
const WALLET_LIMITS = Object.freeze({
  maxJobValueWei: '1000000000000',
  maxGasPerTransaction: '500000',
  maxFeePerGasWei: '3000000',
  maxTotalRequestedCostWei: '10000000000000',
});

const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
});

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(body);
}

async function readJsonBody(request) {
  const contentType = request.headers['content-type'] ?? '';
  invariant(contentType.toLowerCase().startsWith('application/json'), 'JSON_CONTENT_TYPE_REQUIRED', 'Content-Type must be application/json.', { status: 415 });
  const length = Number(request.headers['content-length'] ?? 0);
  invariant(Number.isSafeInteger(length) && length <= MAX_BODY_BYTES, 'REQUEST_BODY_TOO_LARGE', 'Request body is too large.', { status: 413 });
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    invariant(received <= MAX_BODY_BYTES, 'REQUEST_BODY_TOO_LARGE', 'Request body is too large.', { status: 413 });
    chunks.push(chunk);
  }
  invariant(received > 0, 'REQUEST_BODY_REQUIRED', 'A JSON request body is required.');
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    invariant(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'JSON_OBJECT_REQUIRED', 'Request body must be a JSON object.');
    return parsed;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('INVALID_JSON', 'Request body is not valid JSON.');
  }
}

function routeMatch(pathname, pattern) {
  const match = pathname.match(pattern);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

function verifyReviewerIndex(value) {
  try {
    invariant(value && typeof value === 'object' && !Array.isArray(value), 'REVIEWER_PROOF_INTEGRITY_FAILED', 'Reviewer proof is not a JSON object.', { status: 503 });
    const { integrity, ...payload } = value;
    invariant(value.schema === 'xpayr.giwa.agentpay.reviewer-index.v1', 'REVIEWER_PROOF_INTEGRITY_FAILED', 'Reviewer proof schema is not recognized.', { status: 503 });
    invariant(value.chain_id === REVIEWED_CHAIN_ID, 'REVIEWER_PROOF_INTEGRITY_FAILED', 'Reviewer proof chain ID does not match GIWA Sepolia.', { status: 503 });
    invariant(value.contract?.address?.toLowerCase() === REVIEWED_ESCROW_ADDRESS.toLowerCase(), 'REVIEWER_PROOF_INTEGRITY_FAILED', 'Reviewer proof escrow address does not match the reviewed deployment.', { status: 503 });
    invariant(integrity?.algorithm === 'sha256'
      && integrity?.canonicalization === 'xpayr-canonical-json-v1'
      && integrity?.scope === 'entire_document_except_integrity',
    'REVIEWER_PROOF_INTEGRITY_FAILED', 'Reviewer proof integrity metadata is invalid.', { status: 503 });
    const computed = sha256Hex(canonicalJson(payload));
    invariant(hashesEqual(integrity.digest, computed)
      && hashesEqual(integrity.digest, SEALED_REVIEWER_INDEX_DIGEST),
    'REVIEWER_PROOF_INTEGRITY_FAILED', 'Reviewer proof does not match the sealed checked-in index.', { status: 503 });
    return value;
  } catch (error) {
    if (error instanceof DomainError && error.code === 'REVIEWER_PROOF_INTEGRITY_FAILED') throw error;
    throw new DomainError('REVIEWER_PROOF_INTEGRITY_FAILED', 'Reviewer proof could not be verified.', { status: 503, cause: error });
  }
}

async function loadReviewerIndex(reviewerIndexPath) {
  try {
    const source = await readFile(reviewerIndexPath, 'utf8');
    return verifyReviewerIndex(JSON.parse(source));
  } catch (error) {
    if (error instanceof DomainError && error.code === 'REVIEWER_PROOF_INTEGRITY_FAILED') throw error;
    throw new DomainError('REVIEWER_PROOF_INTEGRITY_FAILED', 'The sealed reviewer proof is unavailable or malformed.', { status: 503, cause: error });
  }
}

async function serveStatic(request, response, pathname, publicDir) {
  invariant(['GET', 'HEAD'].includes(request.method), 'METHOD_NOT_ALLOWED', 'Method not allowed.', { status: 405 });
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new DomainError('INVALID_PATH', 'Invalid request path.');
  }
  const candidate = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = resolve(publicDir, candidate);
  const outside = relative(publicDir, filePath);
  invariant(outside !== '..' && !outside.startsWith(`..${sep}`) && !outside.startsWith(sep), 'PATH_TRAVERSAL', 'Invalid static path.', { status: 403 });
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new DomainError('NOT_FOUND', 'Resource was not found.', { status: 404 });
  }
  invariant(info.isFile(), 'NOT_FOUND', 'Resource was not found.', { status: 404 });
  const body = request.method === 'HEAD' ? null : await readFile(filePath);
  response.writeHead(200, {
    'content-type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': extname(filePath) === '.html' ? 'no-store' : 'public, max-age=300',
    'content-security-policy': "default-src 'self'; connect-src 'self' https://sepolia-rpc.giwa.io https://sepolia-rpc-flashblocks.giwa.io; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(body);
}

export async function createAgentPayHttpServer({
  manifest = null,
  manifestPath = DEFAULT_MANIFEST_PATH,
  publicDir = DEFAULT_PUBLIC_DIR,
  reviewerIndexPath = DEFAULT_REVIEWER_INDEX_PATH,
  demoFixture = false,
  dojangClient = null,
  canonicalClient = null,
  service = null,
  logger = console,
} = {}) {
  const network = manifest ? validateManifest(manifest) : await loadManifest(manifestPath);
  const fixtureEnabled = demoFixture === true;
  const identityClient = dojangClient ?? (fixtureEnabled ? createDemoFixtureDojangClient() : null);
  const agentPay = service ?? new XpayrGiwaAgentPayService({ manifest: network, dojangClient: identityClient });
  const canonicalReader = canonicalClient ?? new CanonicalReceiptClient({ manifest: network });
  const identitySource = fixtureEnabled ? 'demo_fixture' : 'giwa_dojang_live_rpc';
  const mode = fixtureEnabled ? 'fixture' : 'live_wallet';
  const exactReviewedDeployment = network.chain_id === REVIEWED_CHAIN_ID
    && network.contracts.escrow?.toLowerCase() === REVIEWED_ESCROW_ADDRESS.toLowerCase();
  const walletExecution = mode === 'live_wallet' && exactReviewedDeployment;
  const runtime = Object.freeze({
    mode,
    identitySource,
    demoFixture: fixtureEnabled,
    walletExecution,
    serverChainWrites: false,
    serverTransactionSigning: false,
    chainWrites: false,
    transactionSigning: false,
    exactReviewedDeployment,
    reviewedEscrowAddress: REVIEWED_ESCROW_ADDRESS,
    reviewedEscrowRuntimeCodeKeccak256: REVIEWED_ESCROW_RUNTIME_CODE_KECCAK256,
    limits: WALLET_LIMITS,
    flashblocksCompletionAuthority: false,
    canonicalReceiptRequired: true,
  });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

      if (request.method === 'GET' && pathname === '/api/health') {
        sendJson(response, 200, {
          ok: true,
          service: 'xpayr-verified-agentpay-for-giwa',
          networkKey: network.network_key,
          chainId: network.chain_id,
          environment: network.environment,
          identitySource,
          mode,
          walletExecution,
          serverChainWrites: false,
          serverTransactionSigning: false,
          chainWrites: false,
          transactionSigning: false,
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/config') {
        sendJson(response, 200, {
          ok: true,
          product: 'XPAYR Verified AgentPay for GIWA',
          networkKey: network.network_key,
          chainId: network.chain_id,
          manifest: publicManifest(network),
          runtime,
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/reviewer-proof') {
        invariant(url.searchParams.size === 0, 'REVIEWER_PROOF_QUERY_FORBIDDEN', 'Reviewer proof does not accept caller-selected paths or query parameters.', { status: 422 });
        const proof = await loadReviewerIndex(reviewerIndexPath);
        sendJson(response, 200, {
          ok: true,
          source: 'sealed_checked_in_reviewer_index',
          proof,
        });
        return;
      }

      const dojangRoute = routeMatch(pathname, /^\/api\/dojang\/([^/]+)$/);
      if (request.method === 'GET' && dojangRoute) {
        const verdict = await agentPay.dojangClient.checkAddress(dojangRoute[0], {
          attesterId: url.searchParams.get('attesterId'),
        });
        sendJson(response, 200, { ok: true, verdict, identitySource });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/intents') {
        const record = await agentPay.createIntent(await readJsonBody(request));
        sendJson(response, 201, { ok: true, ...record });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/intents') {
        const state = url.searchParams.get('state');
        const records = agentPay.listIntents({ state });
        sendJson(response, 200, { ok: true, count: records.length, intents: records });
        return;
      }

      const intentRoute = routeMatch(pathname, /^\/api\/intents\/([^/]+)$/);
      if (request.method === 'GET' && intentRoute) {
        sendJson(response, 200, { ok: true, ...agentPay.getIntent(intentRoute[0]) });
        return;
      }

      const evidenceRoute = routeMatch(pathname, /^\/api\/intents\/([^/]+)\/evidence$/);
      if (request.method === 'GET' && evidenceRoute) {
        sendJson(response, 200, { ok: true, evidence: agentPay.evidence(evidenceRoute[0]) });
        return;
      }

      const actionRoute = routeMatch(pathname, /^\/api\/intents\/([^/]+)\/(approve|reject|bridge)$/);
      if (request.method === 'POST' && actionRoute) {
        const [id, action] = actionRoute;
        if (mode === 'live_wallet' && ['approve', 'reject'].includes(action)) {
          throw new DomainError(
            'LIVE_LOCAL_DECISION_FORBIDDEN',
            'Live mode does not accept unauthenticated local approval or rejection actions.',
            { status: 403 },
          );
        }
        if (mode === 'live_wallet' && action === 'bridge') {
          const current = agentPay.store.get(id);
          invariant(
            current.policy?.decision === 'ALLOW' && current.approval?.status === 'NOT_REQUIRED',
            'LIVE_POLICY_ALLOW_REQUIRED',
            'Live execution requires a direct ALLOW decision; a local HOLD override cannot authorize a wallet request.',
            { status: 409 },
          );
        }
        const body = action === 'bridge' ? {} : await readJsonBody(request);
        const record = action === 'approve'
          ? agentPay.approveIntent(id, body)
          : action === 'reject'
            ? agentPay.rejectIntent(id, body)
            : agentPay.prepareExecution(id);
        sendJson(response, 200, { ok: true, ...record });
        return;
      }

      const confirmationRoute = routeMatch(pathname, /^\/api\/intents\/([^/]+)\/confirmations\/(wallet-submitted|flashblocks|canonical)$/);
      if (request.method === 'POST' && confirmationRoute) {
        const [id, kind] = confirmationRoute;
        const body = await readJsonBody(request);
        const current = agentPay.store.get(id);
        if (kind === 'wallet-submitted') {
          const allowedFields = new Set(['transactionHash', 'transaction_hash']);
          const forbiddenFields = Object.keys(body).filter((field) => !allowedFields.has(field));
          invariant(forbiddenFields.length === 0, 'WALLET_SUBMISSION_OVERRIDE_FORBIDDEN', 'Wallet submission accepts only the transaction hash returned by the participant wallet.', {
            status: 422,
            details: forbiddenFields,
          });
          sendJson(response, 200, { ok: true, ...agentPay.recordWalletSubmitted(id, body) });
        } else if (kind === 'flashblocks') {
          const signal = evaluateFlashblocksSignal(body, {
            expectedTransactionHash: current.confirmation.transaction_hash,
          });
          sendJson(response, 200, { ok: true, ...agentPay.recordFlashblocks(id, signal) });
        } else {
          const allowedFields = new Set(['transactionHash', 'transaction_hash']);
          const forbiddenFields = Object.keys(body).filter((field) => !allowedFields.has(field));
          invariant(forbiddenFields.length === 0, 'CANONICAL_REQUEST_OVERRIDE_FORBIDDEN', 'Canonical proof fields are fetched by XPAYR and cannot be supplied by the caller.', {
            status: 422,
            details: forbiddenFields,
          });
          const binding = current.execution?.binding;
          invariant(binding?.escrow_contract, 'ESCROW_NOT_DEPLOYED', 'Canonical finalization is disabled until the GIWA escrow deployment is recorded.', { status: 409 });
          const requestedValue = body.transactionHash ?? body.transaction_hash;
          const storedHash = current.confirmation.transaction_hash
            ? normalizeTransactionHash(current.confirmation.transaction_hash)
            : null;
          invariant(storedHash !== null || requestedValue !== undefined, 'TRANSACTION_HASH_REQUIRED', 'A transaction hash is required for canonical verification.', { status: 422 });
          const requestedHash = requestedValue === undefined ? null : normalizeTransactionHash(requestedValue);
          if (storedHash !== null && requestedHash !== null) {
            invariant(requestedHash === storedHash, 'TRANSACTION_HASH_MISMATCH', 'Canonical proof request is bound to another transaction.', { status: 409 });
          }
          const expectedHash = storedHash ?? requestedHash;
          const proof = await canonicalReader.fetchTerminalProof({
            transactionHash: expectedHash,
            escrowAddress: binding.escrow_contract,
            jobId: binding.job_id,
          });
          const expected = {
            transaction_hash: expectedHash,
            contract_address: binding.escrow_contract,
            job_id: binding.job_id,
            job_nonce: binding.job_nonce,
            payer: binding.payer,
            provider: binding.provider,
            evaluator: binding.evaluator,
            allowed_senders: [binding.payer, binding.provider, binding.evaluator].filter(Boolean),
            amount_atomic: binding.amount_atomic,
            expires_at: binding.expires_at,
            policy_decision_hash: binding.policy_decision_hash,
          };
          const result = evaluateCanonicalReceipt({
            manifest: network,
            ...proof,
            expected,
          });
          sendJson(response, 200, { ok: true, ...agentPay.finalize(id, result) });
        }
        return;
      }

      if (pathname.startsWith('/api/')) {
        throw new DomainError('API_NOT_FOUND', 'API route was not found.', { status: 404 });
      }
      await serveStatic(request, response, pathname, resolve(publicDir));
    } catch (error) {
      const publicError = asPublicError(error);
      if (publicError.status >= 500 && typeof logger?.error === 'function') {
        logger.error({ code: error?.code ?? 'INTERNAL_ERROR', message: error?.message ?? 'Unknown server error' });
      }
      if (!response.headersSent) sendJson(response, publicError.status, publicError.body);
      else response.end();
    }
  });

  server.agentPay = agentPay;
  server.manifest = network;
  server.runtime = runtime;
  return server;
}

export async function startAgentPayServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4173;
  invariant(Number.isInteger(port) && port >= 0 && port <= 65535, 'INVALID_PORT', 'Invalid server port.');
  const server = await createAgentPayHttpServer(options);
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  return server;
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const port = Number(process.env.GIWA_AGENTPAY_PORT ?? '4173');
  const demoFixture = process.env.GIWA_AGENTPAY_DEMO_FIXTURE === '1';
  const server = await startAgentPayServer({ port, demoFixture });
  const address = server.address();
  console.log(`XPAYR Verified AgentPay local server: http://127.0.0.1:${address.port}`);
  console.log(`Runtime mode: ${server.runtime.mode}; identity source: ${server.runtime.identitySource}`);
  console.log('Server chain writes/signing: disabled; participant wallet execution follows /api/config');
}
