import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DomainError, invariant } from './errors.mjs';
import { canonicalValue, deepClone } from './canonical-json.mjs';

export const GIWA_NETWORK = Object.freeze({
  networkKey: 'giwa-testnet',
  chainId: 91342,
  environment: 'testnet',
  canonicalRpc: 'https://sepolia-rpc.giwa.io',
  flashblocksRpc: 'https://sepolia-rpc-flashblocks.giwa.io',
  explorer: 'https://sepolia-explorer.giwa.io',
  dojangScroll: '0xd5077b67dcb56caC8b270C7788FC3E6ee03F17B9',
  eas: '0x4200000000000000000000000000000000000021',
  attesters: Object.freeze({
    upbitKorea: '0xd99b42e778498aa3c9c1f6a012359130252780511687a35982e8e52735453034',
    testnetFaucet: '0xaa92f8c143657dde575de430aecaea6ca91f2e6072339b16932d426895d8d678',
  }),
});

const SUPPORTED_SCHEMAS = new Set([
  'xpayr.giwa.network-manifest.v1',
  'xpayr.giwa.verified-agentpay.network.v1',
]);

const first = (...values) => values.find((value) => value !== undefined && value !== null);
const cleanUrl = (value) => (typeof value === 'string' ? value.replace(/\/+$/, '') : value);
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : value);

function collectText(value, path = '$', result = []) {
  if (typeof value === 'string') result.push({ path, value });
  if (Array.isArray(value)) value.forEach((entry, index) => collectText(entry, `${path}[${index}]`, result));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value)) {
      result.push({ path: `${path}::<key>`, value: key });
      collectText(entry, `${path}.${key}`, result);
    }
  }
  return result;
}

export function assertGiwaIsolation(value) {
  const foreign = collectText(value).filter(({ value: text }) => /(^|[^a-z])arc([^a-z]|$)/i.test(text));
  invariant(
    foreign.length === 0,
    'FOREIGN_RAIL_REFERENCE',
    'GIWA manifest must not contain foreign payment-rail identifiers.',
    { details: foreign.map(({ path }) => path) },
  );
}

function normalizeAttesters(raw) {
  let source = first(
    raw.dojang?.attester_allowlist,
    raw.dojang?.attesterAllowlist,
    raw.dojang?.attesters,
    raw.attesters?.allowlist,
    raw.attester_allowlist,
    [],
  );
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    source = Object.entries(source)
      .filter(([, entry]) => entry?.allowlisted !== false)
      .map(([label, entry]) => ({ ...entry, label: entry.label ?? label }));
  }
  invariant(Array.isArray(source), 'INVALID_ATTESTER_ALLOWLIST', 'Dojang attester allowlist must be an array.');

  return source.map((entry) => {
    if (typeof entry === 'string') {
      const id = lower(entry);
      return { id, label: null, test_only: id === lower(GIWA_NETWORK.attesters.testnetFaucet) };
    }
    invariant(entry && typeof entry === 'object', 'INVALID_ATTESTER', 'Invalid attester entry.');
    const id = lower(first(entry.id, entry.attester_id, entry.attesterId));
    return {
      id,
      label: first(entry.label, entry.name) ?? null,
      test_only: first(entry.test_only, entry.testOnly, id === lower(GIWA_NETWORK.attesters.testnetFaucet)),
    };
  });
}

function normalizeManifest(raw) {
  const rpc = raw.rpc ?? raw.rpc_urls ?? raw.endpoints ?? {};
  const contracts = raw.contracts ?? {};
  const confirmation = raw.confirmation_policy ?? raw.confirmationPolicy ?? {};
  const gas = raw.gas_asset ?? raw.gasAsset ?? raw.nativeCurrency ?? {};
  const explorerValue = first(raw.explorer?.base_url, raw.explorer?.baseUrl, raw.explorer?.url, raw.explorer_url, raw.explorer);

  return canonicalValue({
    schema: first(raw.schema, raw.schema_version, 'xpayr.giwa.network-manifest.v1'),
    network_key: first(raw.network_key, raw.networkKey),
    display_name: first(raw.display_name, raw.displayName, 'GIWA Sepolia'),
    chain_id: first(raw.chain_id, raw.chainId),
    environment: first(raw.environment, raw.stage),
    rpc: {
      canonical: cleanUrl(first(rpc.canonical?.url, rpc.canonical, rpc.standard?.url, rpc.standard, rpc.http, raw.rpc_url)),
      flashblocks: cleanUrl(first(rpc.flashblocks?.url, rpc.flashblocks, rpc.flashblocks_url, raw.flashblocks_rpc_url)),
    },
    explorer: cleanUrl(explorerValue),
    gas_asset: {
      symbol: first(gas.symbol, raw.gas_symbol),
      decimals: first(gas.decimals, 18),
      test_only: first(gas.test_only, gas.testOnly, raw.test_only, true),
      economic_value: first(gas.economic_value, gas.economicValue, gas.economicValueClaimed, false),
    },
    confirmation_policy: {
      flashblocks_role: first(
        confirmation.flashblocks_role,
        confirmation.flashblocksRole,
        rpc.flashblocks?.purpose,
        confirmation.flashblocksMaySetCompleted === false ? 'pending_ux_only' : undefined,
      ),
      canonical_receipt_required: first(
        confirmation.canonical_receipt_required,
        confirmation.canonicalReceiptRequired,
      ),
      required_confirmations: first(
        confirmation.required_confirmations,
        confirmation.requiredConfirmations,
        confirmation.minimumCanonicalConfirmations,
        1,
      ),
    },
    contracts: {
      dojang_scroll: first(
        contracts.dojang_scroll,
        contracts.dojangScroll,
        raw.dojang?.contract_address,
        raw.dojang?.contractAddress,
        raw.dojang?.dojangScrollAddress,
      ),
      eas: first(contracts.eas, contracts.eas_contract, contracts.easContract, raw.dojang?.easAddress),
      escrow: first(contracts.escrow, contracts.agentpay_escrow) ?? null,
    },
    dojang: {
      attester_allowlist: normalizeAttesters(raw),
      validity_source: first(raw.dojang?.validity_source, raw.dojang?.validitySource, 'contract_isVerified'),
    },
    capabilities: {
      mainnet: first(raw.capabilities?.mainnet, raw.mainnet, raw.constraints?.mainnetExecutionAllowed, false),
      wallet_sdk: first(raw.capabilities?.wallet_sdk, raw.capabilities?.walletSdk, false),
      paymaster: first(raw.capabilities?.paymaster, false),
      cross_chain: first(raw.capabilities?.cross_chain, raw.capabilities?.crossChain, raw.constraints?.crossChainAllowed, false),
    },
  });
}

export function validateManifest(raw) {
  invariant(raw && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_MANIFEST', 'Manifest must be an object.');
  assertGiwaIsolation(raw);
  const manifest = normalizeManifest(raw);

  invariant(SUPPORTED_SCHEMAS.has(manifest.schema), 'INVALID_MANIFEST_SCHEMA', 'Unsupported GIWA manifest schema.');
  invariant(manifest.network_key === GIWA_NETWORK.networkKey, 'NETWORK_KEY_MISMATCH', 'Unexpected network key.');
  invariant(manifest.chain_id === GIWA_NETWORK.chainId, 'CHAIN_ID_MISMATCH', 'Unexpected GIWA chain ID.');
  invariant(manifest.environment === GIWA_NETWORK.environment, 'ENVIRONMENT_MISMATCH', 'GIWA MVP is testnet-only.');
  invariant(manifest.rpc.canonical === GIWA_NETWORK.canonicalRpc, 'RPC_MISMATCH', 'Unexpected canonical GIWA RPC.');
  invariant(
    manifest.rpc.flashblocks === GIWA_NETWORK.flashblocksRpc,
    'FLASHBLOCKS_RPC_MISMATCH',
    'Unexpected GIWA Flashblocks RPC.',
  );
  invariant(manifest.explorer === GIWA_NETWORK.explorer, 'EXPLORER_MISMATCH', 'Unexpected GIWA explorer.');
  invariant(manifest.gas_asset.symbol === 'ETH', 'GAS_ASSET_MISMATCH', 'GIWA Sepolia gas asset must be ETH.');
  invariant(manifest.gas_asset.decimals === 18, 'GAS_DECIMALS_MISMATCH', 'ETH decimals must be 18.');
  invariant(manifest.gas_asset.test_only === true, 'TESTNET_ASSET_REQUIRED', 'MVP asset must be marked test-only.');
  invariant(
    manifest.gas_asset.economic_value === false,
    'ECONOMIC_VALUE_FORBIDDEN',
    'MVP manifest cannot claim economic value.',
  );
  invariant(
    ['pending_only', 'pending_ux_only'].includes(manifest.confirmation_policy.flashblocks_role),
    'INVALID_FLASHBLOCKS_ROLE',
    'Flashblocks must be pending-only.',
  );
  invariant(
    manifest.confirmation_policy.canonical_receipt_required === true,
    'CANONICAL_RECEIPT_REQUIRED',
    'Canonical receipt verification must be required.',
  );
  invariant(
    Number.isInteger(manifest.confirmation_policy.required_confirmations)
      && manifest.confirmation_policy.required_confirmations >= 1,
    'INVALID_CONFIRMATION_COUNT',
    'At least one canonical confirmation is required.',
  );
  invariant(
    lower(manifest.contracts.dojang_scroll) === lower(GIWA_NETWORK.dojangScroll),
    'DOJANG_CONTRACT_MISMATCH',
    'Unexpected DojangScroll contract.',
  );
  invariant(lower(manifest.contracts.eas) === lower(GIWA_NETWORK.eas), 'EAS_CONTRACT_MISMATCH', 'Unexpected EAS contract.');

  const officialAttesters = new Set(Object.values(GIWA_NETWORK.attesters).map(lower));
  for (const attester of manifest.dojang.attester_allowlist) {
    invariant(/^0x[0-9a-f]{64}$/.test(attester.id), 'INVALID_ATTESTER_ID', 'Attester ID must be bytes32.');
    invariant(officialAttesters.has(attester.id), 'UNRECOGNIZED_ATTESTER', 'Attester is not in the verified GIWA snapshot.');
  }
  invariant(manifest.dojang.attester_allowlist.length === officialAttesters.size, 'ATTESTER_SET_MISMATCH', 'Dojang allowlist must contain exactly the two official GIWA attesters.');
  const configuredAttesters = new Set(manifest.dojang.attester_allowlist.map((entry) => entry.id));
  invariant(configuredAttesters.size === officialAttesters.size, 'ATTESTER_SET_MISMATCH', 'Dojang attesters must be distinct.');
  invariant(
    [...officialAttesters].every((id) => configuredAttesters.has(id)),
    'ATTESTER_SET_MISMATCH',
    'Dojang allowlist must include UPBIT_KOREA and TESTNET_FAUCET.',
  );
  const upbitAttester = manifest.dojang.attester_allowlist.find((entry) => entry.id === lower(GIWA_NETWORK.attesters.upbitKorea));
  const faucetAttester = manifest.dojang.attester_allowlist.find((entry) => entry.id === lower(GIWA_NETWORK.attesters.testnetFaucet));
  invariant(
    upbitAttester?.test_only === false && faucetAttester?.test_only === true,
    'ATTESTER_TEST_SCOPE_MISMATCH',
    'UPBIT_KOREA must be non-test-only and TESTNET_FAUCET must be test-only.',
  );
  invariant(
    manifest.capabilities.mainnet === false
      && manifest.capabilities.wallet_sdk === false
      && manifest.capabilities.paymaster === false
      && manifest.capabilities.cross_chain === false,
    'UNVERIFIED_CAPABILITY',
    'Unverified future capabilities must remain disabled.',
  );

  return Object.freeze(deepClone(manifest));
}

export async function loadManifest(pathOrUrl = new URL('../config/giwa-testnet.json', import.meta.url)) {
  const path = pathOrUrl instanceof URL ? fileURLToPath(pathOrUrl) : pathOrUrl;
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new DomainError('INVALID_MANIFEST_JSON', 'GIWA manifest is not valid JSON.', { cause: error });
    }
    throw new DomainError('MANIFEST_READ_FAILED', 'GIWA manifest could not be read.', { cause: error });
  }
  return validateManifest(parsed);
}

export function publicManifest(manifest) {
  return deepClone(validateManifest(manifest));
}
