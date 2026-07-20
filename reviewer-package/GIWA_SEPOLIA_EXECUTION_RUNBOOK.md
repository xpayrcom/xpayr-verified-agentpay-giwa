# GIWA Sepolia D1 / D2 / D3 + Phase 4 SoD Execution Runbook

Bu runbook yalnız GIWA Sepolia (`chainId=91342`) ve ekonomik değeri olmayan native test ETH içindir. Mainnet, gerçek müşteri fonu, stablecoin, Arc artefaktı veya otomatik faucet kullanımı kapsam dışıdır.

Operasyonel faz adlari ve evidence kodlari:

- `D1`: pozitif, block-hash-pinned Dojang/UID/EAS kaniti (`D1` evidence);
- `D2`: tek GIWA Sepolia deployment ve runtime kaniti (`G2` evidence);
- `D3`: release ve refund lifecycle kanitlari (`G3` evidence).

Package gate'i `Node >=22`'dir; final dogrulama `Node 24.14.0` ile yapilmistir. Resmi referanslar: [GIWA baglantisi](https://docs.giwa.io/giwa-chain/en/get-started/connect-to-giwa), [test ETH faucetleri](https://docs.giwa.io/giwa-chain/en/get-started/faucets), [GIWA Playground](https://docs.giwa.io/giwa-chain/en/get-started/giwa-playground), [Dojang Verified Address](https://docs.giwa.io/giwa-chain/en/giwa-ecosystem/dojang/verified-address), [Dojang kontratlari](https://docs.giwa.io/giwa-chain/en/giwa-ecosystem/dojang/contracts) ve [testnet kullanim kosullari](https://docs.giwa.io/giwa-chain/en/terms-and-policies/testnet-terms-of-use).

## Mevcut kapı

Onaylı D1/D2/D3 testnet execution fazı ve Phase 4 separation-of-duties (SoD) release/refund/auth-v2 chain execution tamamlandı:

- deployment durumu `deployed_testnet`;
- payer/deployer `0xB209dd7408FFD12A8575a429be946DeD5FbaD732`, provider `0x065b8EbeC5a59ef6324138Ecf21D630AE4137152`;
- `xpayr.up.id` ve `mbo.up.id` yalnız okunabilir etiketlerdir; authorization kanıtı değildir;
- payer/provider için pozitif aynı-blok D1 mevcut;
- tek D2 deployment ile ayrı D3 release ve refund kanıtları tamamlandı;
- completed journal'lar audit için saklanıyor, aktif lifecycle lock veya resume lease yok;
- Blockscout source visibility `verified_blockscout`; seviye `verified_partial_expected_no_cbor`; local/explorer source SHA-256 ve exact creation input eşit;
- iki yeni D3 koşusu EIP-712-signed `ALLOW` policy artifact'i ile tamamlandı ve iki auth-v1 sidecar canonical GIWA anchor ile doğrulandı;
- Phase 4 profili `phase4_sod_v1` aktiftir: policy authority `0x89128251A3B46328Dc89A13B58C1339217B2fD34`, evidence producer `0x79E5c4591691a8369CE4537c25cF1aa3DDe65b45`, canonical profil digest'i `0x766385f57fa89d679c5c8fc0222f5b765baceeb9899707b5fafe8df3fc881187`;
- iki authority birbirinden ve payer/provider operasyon rollerinden ayrıdır; her authority için repo dışında, tek anahtarlı ve tam `0600` izinli ayrı dosya mevcuttur;
- Phase 4 release `RELEASED` sonucuna `5/5` başarılı canonical adımla, refund `REFUNDED` sonucuna `4/4` başarılı canonical adımla ulaştı; iki lifecycle da ayrı SoD policy authority imzasına bağlıdır;
- release evidence digest'i `0x9558da912bcba7998a65585aeaa61f2b11edd1e45bbfdbb42386f090542f1fbc`, canonical `XPA2` anchor'ı `0x4463689c212a93a679e8f3ce1209d2d86d1f522a6798bc6de151a63174558ba9` ve block'u `31211004`;
- refund evidence digest'i `0x04a6552104ef92927ed7327669aa20f060672036cd3a3e2d794cdd13e938447e`, canonical `XPA2` anchor'ı `0x8696c471adf870f2268515537c7be7f6989e8c5011c38256e846b56278807650` ve block'u `31211036`;
- canlı UI yolu yalnız doğrudan `ALLOW` intent'i transaction preview'a taşır; canlı modda yerel `HOLD` approve/reject bypass'i kapalıdır. Decode edilmiş preview/cancel browser koşusu deterministic EIP-1193 stub ile `sendCount=0` doğrular; gerçek wallet, yayınlanmış transaction veya demo video kanıtı değildir;
- public yayın ve GASOK submission yapılmadı.

Deploy gerçek gas kullanımı `1,709,085`, effective gas price `1,000,251 wei`, gerçek maliyet `1,709,513,980,335 wei` oldu ve `10,000,000,000,000 wei` cap altında kaldı.

## 1. İzole test hesapları

Tarihsel D1/D2/D3/auth-v1 baseline iki operasyon hesabı kullanır:

- `payer/deployer`: deploy, create, fund, approve ve release/refund;
- `provider`: deliverable submit.

Evaluator boş bırakılır. Phase 4 SoD yeni bir execution için bunlara iki ayrı EOA ekler: yalnız artifact imzalayan `policy authority` ve yalnız producer signature/`XPA2` self-anchor üreten `evidence producer`. Böylece toplam dört adres birbirinden ayrıdır; policy authority gas ödemez, evidence producer yalnız anchor gas'ını öder. Tüm hesaplar Arc veya başka XPAYR rail signer'larından ayrı, yalnız testnet için oluşturulmuş ve kullanıcı kontrollü olmalıdır.

Her hesap için normal tarayıcıda:

1. [GIWA Faucet](https://faucet.giwa.io) üzerinden test ETH claim et.
2. [GIWA Sepolia Playground](https://sepolia-playground.giwa.io/) üzerinde `Issue Dojang` işlemini imzala.
3. Adresi kaydet; özel anahtarı sohbete, loga veya repo içine koyma.

Faucet claim otomasyonu ve limit aşma girişimi yapılmaz. Resmî faucet limiti ve koşulları execution gününde yeniden kontrol edilir.

## 2. D1 — pozitif Dojang kanıtı

Önce dosya yazmadan doğrula:

```bash
nvm use
npm run preflight:d1 -- \
  --payer <PAYER_ADDRESS> \
  --provider <PROVIDER_ADDRESS>
```

İki rol de `verified=true` olduktan sonra benzersiz bir dosyaya yaz:

```bash
npm run preflight:d1 -- \
  --payer <PAYER_ADDRESS> \
  --provider <PROVIDER_ADDRESS> \
  --write \
  --output evidence/d1/<UNIQUE_D1_FILE>.json
```

Recorder iki resmî attester ID'sini aynı canonical block hash'inde sorgular. Pozitif sonuçta UID, EAS attestation, recipient, schema, aynı bloktan `DojangAttesterBook` attester adresi, revocation, expiration ve `bool isVerified=true` alanlarını doğrular. Dosya `0600`, atomik ve overwrite kapalıdır.

## 3. Secret teslimi

`xpayr.com` Git reposunun tamamen dışında, symlink/hard-link olmayan, mevcut kullanıcıya ait ve izinleri tam `0600` olan bir dosya oluştur:

```dotenv
GIWA_DEPLOYER_PRIVATE_KEY=<redacted>
GIWA_LIFECYCLE_PAYER_PRIVATE_KEY=<redacted>
GIWA_LIFECYCLE_PROVIDER_PRIVATE_KEY=<redacted>
GIWA_LIFECYCLE_EVALUATOR_PRIVATE_KEY=
```

Dosyanın içeriğini paylaşma. Yalnız mutlak yolunu `GIWA_AGENTPAY_ENV_FILE` ile komuta ver. Dosyada yorum/boş satır dışında yalnız tırnaksız `KEY=VALUE` veya `export KEY=VALUE` satırları kullanılır; shell genişletmesi, quoted değer ve başka dotenv sözdizimi kabul edilmez. Loader `realpath` üzerinden tüm repo kökünü, relative path'i, symlink/hard-link'i, farklı dosya sahibini, duplicate/unsupported değişkenleri ve `0600` dışındaki izinleri reddeder. Ambient signer değişkeni ile dosya değişkeni çakışırsa execution durur; signer değerlerini yalnız bu dosyadan yüklemek için shell'deki eski `GIWA_DEPLOYER_PRIVATE_KEY` ve `GIWA_LIFECYCLE_*_PRIVATE_KEY` export'larını önce kaldır. Salt-okunur preflight secret dosyasını yüklemez; D3 execute de secret'i ancak deployment/D1/fee/balance/journal kapılarından sonra yükler.

Phase 4 SoD iki ek ve birbirinden ayrı repo-external `0600` dosya kullanır:

```dotenv
GIWA_POLICY_AUTHORITY_PRIVATE_KEY=<redacted>
```

```dotenv
GIWA_EVIDENCE_PRODUCER_PRIVATE_KEY=<redacted>
```

Bu iki dosya oluşturulmuş ve yalnız public adresleri profile yazılmıştır. İçerikleri, tam dosya yolları ve anahtar değerleri loga, reviewer package'a veya bu runbook'a yazılmaz. Policy dosyası yalnız policy imzalama komutuna, evidence-producer dosyası yalnız auth-v2 anchor komutuna `GIWA_AGENTPAY_ENV_FILE` olarak verilir. Operasyonel payer/provider signer'ları bunlardan ayrı tutuldu; tamamlanan Phase 4 execution hiçbir private key'i lifecycle/auth-v2 evidence JSON'larına yazmadı.

## 4. D2 — tek deployment

Önce son kez salt-okunur kontrol:

```bash
npm run preflight
npm run preflight:deploy
```

Sonra benzersiz run ID ile yalnız bir kez çalıştır:

```bash
GIWA_AGENTPAY_ENV_FILE=<ABSOLUTE_SECURE_ENV_PATH> \
npm run deploy:giwa-testnet -- \
  --confirm-chain-id=91342 \
  --confirm-network=giwa-testnet \
  --deployer-address=<PAYER_ADDRESS> \
  --provider-address=<PROVIDER_ADDRESS> \
  --d1-evidence=evidence/d1/<UNIQUE_D1_FILE>.json \
  --deployment-run-id=<UNIQUE_DEPLOYMENT_RUN_ID> \
  --max-cost-wei=10000000000000
```

Araç signer yüklemeden önce D1 artifact şema/checksum/rol/adres/UID-EAS geçerliliğini doğrular, artifact'in tamamını retained block'ta canonical RPC'den bağımsız olarak yeniden kurar ve exact canonical JSON eşliği ister; signer adresini ayrıca `--deployer-address` ile birebir bağlar. Broadcast öncesi predicted address/nonce/hash bilgilerini private, gerçek `wx` exclusive recovery journal'a yazar. Eşzamanlı ikinci deploy lock'u alamaz; journal oluşursa kör retry yapılmaz. Başarılı receipt sonrasında şunlar zorunludur:

- receipt status `1`, yeniden okunmuş canonical block hash ve confirmation sayısı;
- contract address ve non-empty runtime code;
- solc immutable reference alanları maskelendikten sonra runtime bytecode'un birebir eşliği;
- DojangScroll ile iki attester immutable getter'ının beklenen değerleri;
- artifact SHA, effective gas price, actual cost, deployment evidence JSON ve explorer linkleri.

Explorer source verification ayrı bir reviewer-visibility adımıdır. Immutable-aware exact runtime ve creation-input kanıtı D2/D3 execution authority'sidir; source verification tek başına lifecycle authority değildir. Mevcut kontrat Blockscout'ta `Pass - Verified` / `is_verified=true` durumundadır; v2 sınıflandırması `is_partially_verified=true`, `is_fully_verified=false` olarak gözlenmiştir. Bu `PARTIAL` sonucu Foundry'nin sabit `bytecode_hash=none` / `cbor_metadata=false` ayarları nedeniyle CBOR metadata içermeyen deployment için beklenir. Submission GUID `7b0630cbb92be8e11512cb331b8d1aef94ceec536a5d5b82`, local/explorer source SHA-256 `4ff7ce24715191f79772ecaed517a39e24a0dadc90695be38bdaec809f9dec09`, exact `7,967`-byte creation-input SHA-256 `36bb86676e4f148342e23177c205bda68bf70b595b48c1a2ad021d0a288ece37` olarak uzlaşmıştır. Mevcut adres için `FULL` sınıfı CBOR-enabled yeni deployment gerektirir; bu runbook kör tekrar veya sırf rozet için redeploy yapmaz. Constructor argümanları:

```bash
CONSTRUCTOR_ARGS=$(cast abi-encode 'constructor(address,bytes32,bytes32)' \
  0xd5077b67dcb56caC8b270C7788FC3E6ee03F17B9 \
  0xd99b42e778498aa3c9c1f6a012359130252780511687a35982e8e52735453034 \
  0xaa92f8c143657dde575de430aecaea6ca91f2e6072339b16932d426895d8d678)

forge verify-contract \
  --chain 91342 \
  --watch \
  --verifier blockscout \
  --verifier-url https://sepolia-explorer.giwa.io/api \
  --constructor-args "$CONSTRUCTOR_ARGS" \
  <ESCROW_ADDRESS> \
  contracts/XPayrVerifiedAgentEscrow.sol:XPayrVerifiedAgentEscrow
```

Foundry ayarları solc `0.8.30`, optimizer `200`, EVM `paris`, `bytecode_hash=none` ve `cbor_metadata=false` olarak sabittir.

Explorer doğrulaması başarılı olsa bile `config/deployment.json` içindeki `evidence.explorerVerified` alanı kanıt/URL yeniden okunup uzlaştırılmadan elle `true` yapılmaz. Bu checkpoint'te `evidence.explorerVerified=true`, top-level `sourceVerification=verified_blockscout` ve `evidence.sourceVerificationLevel=verified_partial_expected_no_cbor`; kaynak ve seviye kanıtları `evidence/deployment/giwa-testnet-source-verification-20260719T231930Z.json` ile `evidence/deployment/giwa-testnet-source-verification-level-recheck-20260720T005420Z.json` dosyalarına bağlıdır.

## 5. D3 — release ve refund

Her yol için farklı `jobNonce`, payer-bound `jobId`, run ID ve evidence dosyası kullanılır. Değer ve maliyet için önerilen dar başlangıç sınırları:

- `job-value-wei=1000000000000` (`0.000001` test ETH);
- `max-job-value-wei=1000000000000`;
- `max-fee-per-gas-wei=3000000`;
- `max-gas-per-transaction=500000`;
- `max-total-cost-wei=10000000000000`;
- `expiry-seconds=86400`;
- `confirmations=1`.

Önce exact job binding için imzalı policy artifact'i salt-okunur doğrulanır, sonra açık execute kapısıyla yazılır:

```bash
npm run preflight:policy -- \
  --confirm-chain-id=91342 \
  --confirm-network=giwa-testnet \
  --confirm-testnet-only=GIWA_SEPOLIA_TEST_ETH_ONLY \
  --policy-run-id=<UNIQUE_POLICY_RUN_ID> \
  --record-id=<STABLE_POLICY_RECORD_ID> \
  --intent-id=<STABLE_INTENT_ID> \
  --authority-address=<PAYER_ADDRESS> \
  --payer-address=<PAYER_ADDRESS> \
  --provider-address=<PROVIDER_ADDRESS> \
  --job-id=<PAYER_BOUND_JOB_ID> \
  --job-nonce=<UNIQUE_JOB_NONCE> \
  --outcome=release \
  --deliverable-hash=<DELIVERABLE_HASH> \
  --job-value-wei=1000000000000 \
  --max-job-value-wei=1000000000000 \
  --expiry-seconds=7200

GIWA_AGENTPAY_ENV_FILE=<ABSOLUTE_SECURE_ENV_PATH> \
npm run policy:giwa-testnet -- <SAME_EXACT_ARGS>
```

Refund policy'sinde `--outcome=refund` kullanılır ve `--deliverable-hash` atlanır. Policy signer'ı bu testnet modelinde payer/deployer'dır. Araç yalnız `ALLOW` üretir; EIP-712 domain/type/message, ruleset, validity ve exact job alanlarını imzalar; artifact `evidence/policy/<UNIQUE_POLICY_RUN_ID>.policy.json` altına `0600` ve no-overwrite yazılır.

Yukarıdaki payer/deployer authority komutu legacy auth-v1 kayıtlarını yeniden üretmek için değil, tarihsel akışı açıklamak için korunur. Phase 4 için exact aynı job binding'de şu iki değişiklik zorunludur:

- `--authority-address=0x89128251A3B46328Dc89A13B58C1339217B2fD34` ve `--authority-profile=phase4_sod_v1` kullan;
- execute adımında yalnız `GIWA_POLICY_AUTHORITY_PRIVATE_KEY` içeren ayrı repo-external `0600` dosyayı ver.

Policy authority işlem yayınlamaz ve gas ödemez. Phase 4 release/refund policy artifact'leri yeni payer-bound job parametreleriyle ayrı ayrı imzalandı; eski lifecycle dosyalarına sonradan SoD etiketi eklenmedi.

Ardından `npm run preflight:lifecycle -- <args>` ile signer yüklemeden kontrol edilir. D3, signed policy'yi, D2 deployment kaydındaki D1 artifact'ini ve deployment kaydını exact doğrular; rolleri canlı aggregate Dojang üzerinden tekrar okur. Aynı argümanlar başarıyla geçtikten sonra:

```bash
GIWA_AGENTPAY_ENV_FILE=<ABSOLUTE_SECURE_ENV_PATH> \
npm run lifecycle:giwa-testnet -- \
  --confirm-chain-id=91342 \
  --confirm-network=giwa-testnet \
  --confirm-testnet-only=GIWA_SEPOLIA_TEST_ETH_ONLY \
  --lifecycle-run-id=<UNIQUE_RUN_ID> \
  --outcome=release \
  --payer-address=<PAYER_ADDRESS> \
  --provider-address=<PROVIDER_ADDRESS> \
  --job-id=<PAYER_BOUND_JOB_ID> \
  --job-nonce=<UNIQUE_JOB_NONCE> \
  --policy-evidence=evidence/policy/<UNIQUE_POLICY_RUN_ID>.policy.json \
  --deliverable-hash=<DELIVERABLE_HASH> \
  --job-value-wei=1000000000000 \
  --max-job-value-wei=1000000000000 \
  --max-total-cost-wei=10000000000000 \
  --max-fee-per-gas-wei=3000000 \
  --max-gas-per-transaction=500000 \
  --expiry-seconds=86400 \
  --confirmations=1
```

Release akışı `create → fund → submit → approve → release`; refund akışı ayrı job/run ID ile `create → fund → cancel → claimRefund` olur. Refund komutunda `--deliverable-hash` atlanır veya tam zero-bytes32 verilir; non-zero değer fail-closed reddedilir. Release evidence'i canonical job state'teki hash'i CLI'daki hash ile birebir eşler. Refund terminal recovery'dir, payment completion değildir.

Phase 4 lifecycle için aynı komuta `--authority-profile=phase4_sod_v1` eklenir. Runner signed policy authority'sini, aktif profil digest'ini ve payer/provider ile rol ayrımını fail-closed doğrular. Tamamlanan release koşusu `create → fund → submit → approve → release` adımlarının `5/5`'ini, refund koşusu `create → fund → cancel → claimRefund` adımlarının `4/4`'ünü receipt status `1` ile doğruladı.

Runner bütün lifecycle'lar için ortak private `active-execution.lock.json` lock'u alır; farklı run ID'leri aynı signer nonce'u üzerinde eşzamanlı çalışamaz. Temiz tamamlanmada global lock silinir; hata/crash sonrasında kalır ve canonical pending nonce/journal incelemesi olmadan elle kaldırılmaz. Başlangıçtaki per-run recovery journal gerçek `wx` exclusivity ile oluşturulur; her imzalı adım aynı journal'ı broadcast'ten önce atomik olarak günceller. Private key veya signed transaction bytes saklanmaz. Evidence tamamlanmadan önce her adımın transaction/receipt'i, sender/target/nonce/value/calldata alanları, receipt block membership'i ve iki canonical block okumasından türetilen gerçek confirmation sayısı tekrar doğrulanır; terminal event, exact deliverable hash ve job state ayrıca kanıtlanır. Signed-policy yolu yalnız exact EIP-712 `ALLOW` artifact'ini kabul eder ve policy origin ayrıntılarını lifecycle evidence'a yazar. Eski `--policy-decision-hash` seçeneği yalnız legacy uyumluluk içindir; bu yolla üretilen dosya `not_provided_cli_hash_only` kalır ve auth-v1'e yükseltilemez.

RPC stale-state, load-balanced receipt/block uyuşmazlığı veya process crash sonrasında kör retry yapılmaz. Yalnız aynı parametrelerle açık `--resume --execute` kullanılır. Resume yolu mevcut lock/journal/run/chain/escrow/payer bağlarını, strict step prefix'ini, her kayıtlı transaction'ın sender/target/type/chain/nonce/calldata/value/gas/fee alanlarını ve receipt'in canonical block üyeliğini yeniden doğrular. State EIP-1898 block hash ile `requireCanonical` okunur, hash state okumasından önce/sonra kontrol edilir, nonce devamlılığı tam `last + 1` olmalıdır. Ayrı `resume.lease` eşzamanlı finalization'ı engeller. `prepared_before_broadcast` kaydındaki exact planned hash ağda receipt'siz görünüyorsa duplicate broadcast yapılmaz; yalnız doğrulanmış owned resume lease bırakılır, global lock ve journal korunur, receipt görünür olduğunda sonraki explicit resume aynı hash'i canonical reconcile eder. İşlem gerçekten yoksa aynı hash'in yeniden üretilmesi ancak retained gas limit ve max fee güncel explicit CLI cap'lerini aşmıyorsa mümkündür. Canonical prefix tekrar imzalanmaz veya yayınlanmaz; yalnız eksik suffix için gereken signer yüklenir. Tüm adımlar zaten canonical ise signer yüklemeden ve `transaction_broadcast_count=0` ile evidence/journal finalization idempotent tamamlanır.

Lifecycle evidence tamamlandıktan sonra producer signature + anchor katmanı önce salt-okunur, sonra exact digest/cap onayıyla çalıştırılır:

```bash
npm run preflight:authenticate -- \
  --source-evidence=evidence/lifecycle/<SIGNED_RUN_ID>.evidence.json \
  --signed-policy=evidence/policy/<SIGNED_POLICY_RUN_ID>.policy.json \
  --producer-address=<PAYER_ADDRESS>

GIWA_AGENTPAY_ENV_FILE=<ABSOLUTE_SECURE_ENV_PATH> \
npm run authenticate:giwa-testnet -- \
  --source-evidence=evidence/lifecycle/<SIGNED_RUN_ID>.evidence.json \
  --signed-policy=evidence/policy/<SIGNED_POLICY_RUN_ID>.policy.json \
  --producer-address=<PAYER_ADDRESS> \
  --confirm-chain-id=91342 \
  --confirm-network=giwa-testnet \
  --confirm-evidence-digest=<LIFECYCLE_DIGEST> \
  --confirm-policy-digest=<POLICY_ARTIFACT_DIGEST> \
  --max-fee-per-gas-wei=3000000 \
  --max-cost-wei=150000000000
```

Auth-v1 yalnız signed-policy evidence level ve lifecycle içindeki exact `policy_origin` path/file-SHA/artifact/binding/typed-data/authority alanları seçilen policy dosyasıyla birebir eşleşirse ilerler. Anchor, producer EOA'nın kendisine gönderdiği zero-value type-2 `XPA1` calldata işlemidir. Bu model EOA kontrolünü kanıtlar; bağımsız attestation veya separation of duties sağlamaz.

Phase 4 yeni lifecycle için auth-v2 yolu ayrı evidence producer ve `XPA2` calldata kullanır:

```bash
npm run preflight:authenticate -- \
  --source-evidence=evidence/lifecycle/<PHASE4_RUN_ID>.evidence.json \
  --signed-policy=evidence/policy/<PHASE4_POLICY_RUN_ID>.policy.json \
  --producer-address=0x79E5c4591691a8369CE4537c25cF1aa3DDe65b45 \
  --authority-profile=phase4_sod_v1

GIWA_AGENTPAY_ENV_FILE=<ABSOLUTE_EVIDENCE_PRODUCER_ENV_PATH> \
npm run authenticate:giwa-testnet -- \
  --source-evidence=evidence/lifecycle/<PHASE4_RUN_ID>.evidence.json \
  --signed-policy=evidence/policy/<PHASE4_POLICY_RUN_ID>.policy.json \
  --producer-address=0x79E5c4591691a8369CE4537c25cF1aa3DDe65b45 \
  --authority-profile=phase4_sod_v1 \
  --confirm-chain-id=91342 \
  --confirm-network=giwa-testnet \
  --confirm-evidence-digest=<LIFECYCLE_DIGEST> \
  --confirm-policy-digest=<POLICY_ARTIFACT_DIGEST> \
  --max-fee-per-gas-wei=3000000 \
  --max-cost-wei=150000000000
```

Anchor runner `50,000 gas × canlı maxFeePerGas` üzerinden rezerv hesaplar; `3,000,000 wei` fee cap'inde tek anchor için üst sınır `150,000,000,000 wei` olur. Tamamlanan iki `XPA2` anchor'ın her biri `30,120 gas`, `1,000,251 wei` effective gas price, zero value ve receipt status `1` kaydetti. Release anchor'ı block `31211004`, refund anchor'ı block `31211036` içinde canonical olarak doğrulandı. Her gelecekteki execute öncesi canlı fee, balance, latest/pending nonce ve gas estimate yine yeniden doğrulanmalıdır; policy authority gas ödemez.

## 6. Tamamlanan execution kaydı

- D1: `evidence/d1/giwa-sepolia-d1-xpayr-mbo-20260719T220311Z.json`; block `31153475`, hash `0xc89cddeed490aaf8e95b099d6677f4c3b72bf24dcfa1898224871e60cfe1a624`, digest/reconstruction digest `0x3f15cacd2a712f419d8fb220d6840bfe484504df5d0278a8e57da7a58020fe9c`.
- D2: contract `0x7b0630cBb92be8E11512cb331b8D1aef94cEEc53`; tx `0x1fda4860da932d6beab0bedd10046d4dc01a21908c5a2ce969a197bce0006908`; block `31153615`; evidence `evidence/deployment/giwa-testnet-deployment-20260719220537.json`.
- Source verification: `evidence/deployment/giwa-testnet-source-verification-20260719T231930Z.json`; Blockscout `Pass - Verified`. Level recheck: `evidence/deployment/giwa-testnet-source-verification-level-recheck-20260720T005420Z.json`; expected no-CBOR `PARTIAL=true`, `FULL=false`, exact creation input match `true`.
- Historical D3: original release/refund dosyaları korunur; policy origin `not_provided_cli_hash_only`, producer auth `not_provided`.
- Signed-policy D3 release: job `0xa3e3f4a98d9a6c28c6be6f42159eb8950c347b5ca520636cf16c99e6ed6cd0a9`; terminal tx `0xacc9adae988c5094459dec4ff097b4641b608de03a6f0ab820367a6521c87ce2`; lifecycle digest `0x80fb1c283d09476bf8caa78c097af17666e9f275688a8b9e628122a3c276b903`.
- Signed-policy D3 refund: job `0x5f7f7075eac19ed40139af4de22d905d34f67303a8d7564599ea86c480dcbaf5`; terminal tx `0x12b65cd22071206fc9a0bfdf62efad91a1eee526fb83cb21dfa0f8fb99104fa6`; lifecycle digest `0x306e041fa5ad2ee337dccc84fe86f3f3973e940d6a1dae410b725a0c932374a3`.
- Auth-v1 release/refund anchors: `0x6e1cbe55b2a964388339a1f2912953707a0881c289e2579c92f384384909da5d` / `0xbef25cd50a0d5582718a20b818bba43acd587ea69758005689362b2fc82f2be3`; both canonical and signature-verified.
- Phase 4 SoD release: `evidence/lifecycle/phase4-sod-release-20260720t134245599z-efaa5ce2-lifecycle.evidence.json`; job `0x9df3f7d659991dfa95ac7ca89e4c531b09a497d65070cd4856db4a9f51eac740`; `RELEASED`, `payment_completed=true`, `5/5` başarılı step; terminal tx `0x66695b08f17e9be7838ec1ab1cb08bb25259e0a9dc496ee1dc1070eca554c92e`; evidence digest `0x9558da912bcba7998a65585aeaa61f2b11edd1e45bbfdbb42386f090542f1fbc`.
- Phase 4 SoD release auth-v2: `evidence/authenticated/phase4-sod-release-20260720t134245599z-efaa5ce2-lifecycle.auth-v2.json`; producer signature verified; `XPA2` anchor `0x4463689c212a93a679e8f3ce1209d2d86d1f522a6798bc6de151a63174558ba9`, block `31211004`, receipt status `1`.
- Phase 4 SoD refund: `evidence/lifecycle/phase4-sod-refund-20260720t134245599z-cd885085-lifecycle.evidence.json`; job `0x774f6daa21eb143b12f03e964b21ec5863f509f5f96b0f4b6ace50675204cff6`; `REFUNDED`, `payment_completed=false`, `refunded=true`, `4/4` başarılı step; terminal tx `0x3f58ca24da8c6f5a729212207feeb14514dbb624be6ddd21e2189230137d6355`; evidence digest `0x04a6552104ef92927ed7327669aa20f060672036cd3a3e2d794cdd13e938447e`.
- Phase 4 SoD refund auth-v2: `evidence/authenticated/phase4-sod-refund-20260720t134245599z-cd885085-lifecycle.auth-v2.json`; producer signature verified; `XPA2` anchor `0x8696c471adf870f2268515537c7be7f6989e8c5011c38256e846b56278807650`, block `31211036`, receipt status `1`.
- Phase 4 authority binding: policy authority `0x89128251A3B46328Dc89A13B58C1339217B2fD34`; evidence producer `0x79E5c4591691a8369CE4537c25cF1aa3DDe65b45`; profile digest `0x766385f57fa89d679c5c8fc0222f5b765baceeb9899707b5fafe8df3fc881187`; `separation_of_duties=true` in both lifecycle origins and auth-v2 sidecars.
- Phase 4 bounded funding evidence: `evidence/funding/phase4-sod-evidence-producer-funding-20260720.json`; canonical `1,000,000,000,000 wei` native test-ETH transfer tx `0x0fecdfdd511b78d1a3b00f818348fc457d242f1f42725eab1d135ae8e42ef6e4`, block `31209759`; artifact digest `0xb2ad8c9f45fa5fdc803d83afc3f1046adac017a20097632b0bff8c2aaa06d6c3`.
- Reviewer index: `evidence/giwa-sepolia-reviewer-index-20260720.json`; canonical payload digest `0x30e5f155ac7b4caeee4a8b149ff653f9c4b82b220b777c09a6344f4cf99e2be5`. `config/reviewer-package.allowlist.json` artık Phase 4 policy/lifecycle/auth-v2 ve funding artifact'lerini içeren `81` explicit dosya kaydına sahiptir.

## 7. Güvenli Phase 4 sonraki adımları

1. Tamamlanan Phase 4 lifecycle, policy, auth-v2 ve journal dosyalarını immutable audit kaydı olarak koru; overwrite veya eski auth-v1 kayıtlarıyla birleştirme yapma.
2. Reviewer index'in `0x30e5f155ac7b4caeee4a8b149ff653f9c4b82b220b777c09a6344f4cf99e2be5` digest'ini ve `81` dosyalı allowlist'i koru; exported package doğrulamasında secret scan ile iki anchor'ın explorer URL/receipt/block/profile/evidence digest bağlarını yeniden doğrula.
3. Yeni bir live-wallet demo videosu kaydedilecekse fixture video ile karıştırma; real wallet transaction, pending ve canonical confirmation ekranlarını ayrı göster ve yukarıdaki retained evidence dosyalarına bağla.
4. Blockscout `Pass - Verified`, source SHA eşliği ve expected no-CBOR `PARTIAL` sınıfını submission öncesi canlı yeniden kontrol et; bunu lifecycle/auth-v2 authority'si yerine kullanma.
5. Applicant/account/content alanlarını, track seçimini ve program deadline/time-zone bilgisini submission anında yeniden doğrula.
6. Public push, video yayınlama ve GASOK form submission yalnız açık kullanıcı onayı sonrasında yapılır.

## 8. Durdurma kuralları

- Aktif deployment/lifecycle journal, `active-execution.lock.json` veya resume lease varsa kör retry etme. `status=completed` journal audit kaydıdır ve tek başına aktif engel değildir.
- D1 rollerinden biri negatifse, retained-block reconstruction unavailable/mismatch ise veya exact canonical eşlik bozulursa imza yükleme ve broadcast yapma.
- Chain ID, receipt, canonical block, runtime bytecode, immutable, fee, gas, balance veya cap kontrolü başarısızsa dur.
- SoD profile inactive/digest mismatch ise, iki authority veya herhangi bir authority ile operasyon rolü çakışıyorsa, policy yanlış authority ile imzalıysa ya da evidence producer `XPA2` self-anchor için yetersiz fonluysa dur.
- Her yeni lifecycle'da signer dosyaları repo-external exact-`0600`/tek-link güvenlik doğrulamasından geçmezse execute etme; authority secret dosyalarını birleştirme, kopyalama veya içeriklerini çıktıya alma.
- Flashblocks yalnız pending UX sinyalidir; completion authority değildir.
- Explorer source statusunu canlı Blockscout, seviye alanları, kaynak SHA ve creation-input eşliği olmadan değiştirme; source visibility'yi exact runtime/receipt kanıtıyla karıştırma. Mevcut no-CBOR adres için `FULL` hedefiyle kör POST veya redeploy yapma.
- Mainnet, gerçek fon, faucet otomasyonu, public yayın ve GASOK submission bu runbook tarafından yapılmaz.
