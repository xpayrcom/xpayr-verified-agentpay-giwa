// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @notice Minimal interface for GIWA Dojang Verified Address checks.
interface IDojangScroll {
    function isVerified(address account, bytes32 attesterId) external view returns (bool);
}

/// @title XPAYR Verified AgentPay Escrow
/// @notice A GIWA Sepolia-native, non-custodial escrow for policy-authorized AI agent jobs.
/// @dev The contract has no owner, operator withdrawal, token adapter, or mainnet switch.
contract XPayrVerifiedAgentEscrow {
    enum Status {
        NONE,
        CREATED,
        FUNDED,
        SUBMITTED,
        APPROVED,
        RELEASED,
        DISPUTED,
        REFUNDED,
        EXPIRED,
        CANCELLED
    }

    struct Job {
        address payer;
        address provider;
        address evaluator;
        bytes32 jobNonce;
        uint128 expectedAmount;
        uint128 amount;
        uint64 expiresAt;
        uint64 disputeOpenedAt;
        Status status;
        bool verificationRequired;
        bytes32 policyDecisionHash;
        bytes32 deliverableHash;
    }

    uint64 public constant DISPUTE_TIMEOUT = 7 days;

    address public immutable dojangScroll;
    bytes32 public immutable upbitKoreaAttesterId;
    bytes32 public immutable testnetFaucetAttesterId;

    mapping(bytes32 jobId => Job job) private jobs;

    uint256 private reentrancyState = 1;

    error ZeroAddress();
    error ZeroJobId();
    error ZeroJobNonce();
    error InvalidDerivedJobId(bytes32 expected, bytes32 supplied);
    error ZeroPolicyDecisionHash();
    error ZeroDeliverableHash();
    error ZeroAmount();
    error ZeroExpectedAmount();
    error UnexpectedFundingAmount(uint256 expected, uint256 actual);
    error InvalidAttesterConfiguration();
    error InvalidExpiry(uint64 expiresAt, uint256 currentTimestamp);
    error InvalidPartyConfiguration();
    error JobAlreadyExists(bytes32 jobId);
    error JobNotFound(bytes32 jobId);
    error InvalidStatus(Status expected, Status actual);
    error InvalidStatusForAction(Status actual);
    error Unauthorized(address actor);
    error AddressNotVerified(address account);
    error VerificationUnavailable();
    error TransferFailed(address recipient, uint256 amount);
    error Reentrancy();
    error UnexpectedNativeTransfer();
    error DisputeTimeoutNotReached(uint256 availableAt, uint256 currentTimestamp);

    event JobCreated(
        bytes32 indexed jobId,
        address indexed payer,
        address indexed provider,
        address evaluator,
        bytes32 jobNonce,
        uint256 expectedAmount,
        uint64 expiresAt,
        bytes32 policyDecisionHash,
        bool verificationRequired
    );
    event JobFunded(bytes32 indexed jobId, address indexed payer, uint256 amount);
    event DeliverableSubmitted(bytes32 indexed jobId, address indexed provider, bytes32 deliverableHash);
    event JobApproved(bytes32 indexed jobId, address indexed approver);
    event JobReleased(bytes32 indexed jobId, address indexed actor, address indexed provider, uint256 amount);
    event JobDisputed(bytes32 indexed jobId, address indexed actor, uint64 openedAt);
    event DisputeResolved(bytes32 indexed jobId, address indexed resolver, bool paidProvider);
    event JobCancelled(bytes32 indexed jobId, address indexed payer, uint256 refundableAmount);
    event JobExpired(bytes32 indexed jobId, address indexed actor, uint256 refundableAmount);
    event JobRefunded(bytes32 indexed jobId, address indexed payer, uint256 amount, bytes32 reason);

    modifier nonReentrant() {
        if (reentrancyState != 1) revert Reentrancy();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    constructor(address dojangScroll_, bytes32 upbitKoreaAttesterId_, bytes32 testnetFaucetAttesterId_) {
        if (dojangScroll_ == address(0)) revert ZeroAddress();
        if (
            upbitKoreaAttesterId_ == bytes32(0) || testnetFaucetAttesterId_ == bytes32(0)
                || upbitKoreaAttesterId_ == testnetFaucetAttesterId_
        ) {
            revert InvalidAttesterConfiguration();
        }
        if (dojangScroll_.code.length == 0) revert VerificationUnavailable();
        dojangScroll = dojangScroll_;
        upbitKoreaAttesterId = upbitKoreaAttesterId_;
        testnetFaucetAttesterId = testnetFaucetAttesterId_;
    }

    /// @notice Registers an immutable set of participants and an XPAYR policy decision.
    /// @dev The caller is always the payer. An evaluator is optional but, when set, must be independent.
    function createJob(
        bytes32 jobId,
        bytes32 jobNonce,
        address provider,
        address evaluator,
        uint128 expectedAmount,
        uint64 expiresAt,
        bytes32 policyDecisionHash
    ) external {
        if (jobId == bytes32(0)) revert ZeroJobId();
        if (jobNonce == bytes32(0)) revert ZeroJobNonce();
        bytes32 expectedJobId = deriveJobId(msg.sender, jobNonce);
        if (jobId != expectedJobId) revert InvalidDerivedJobId(expectedJobId, jobId);
        if (jobs[jobId].status != Status.NONE) revert JobAlreadyExists(jobId);
        if (provider == address(0)) revert ZeroAddress();
        if (provider == msg.sender) revert InvalidPartyConfiguration();
        if (evaluator == provider || (evaluator != address(0) && evaluator == msg.sender)) {
            revert InvalidPartyConfiguration();
        }
        if (expectedAmount == 0) revert ZeroExpectedAmount();
        if (expiresAt <= block.timestamp) revert InvalidExpiry(expiresAt, block.timestamp);
        if (policyDecisionHash == bytes32(0)) revert ZeroPolicyDecisionHash();

        _requireVerified(msg.sender);
        _requireVerified(provider);
        if (evaluator != address(0)) _requireVerified(evaluator);

        jobs[jobId] = Job({
            payer: msg.sender,
            provider: provider,
            evaluator: evaluator,
            jobNonce: jobNonce,
            expectedAmount: expectedAmount,
            amount: 0,
            expiresAt: expiresAt,
            disputeOpenedAt: 0,
            status: Status.CREATED,
            verificationRequired: true,
            policyDecisionHash: policyDecisionHash,
            deliverableHash: bytes32(0)
        });

        emit JobCreated(
            jobId, msg.sender, provider, evaluator, jobNonce, expectedAmount, expiresAt, policyDecisionHash, true
        );
    }

    function deriveJobId(address payer, bytes32 jobNonce) public pure returns (bytes32) {
        return keccak256(abi.encode(payer, jobNonce));
    }

    /// @notice Locks native GIWA Sepolia test ETH for an existing job.
    function fundJob(bytes32 jobId) external payable {
        Job storage job = _job(jobId);
        _requireStatus(job, Status.CREATED);
        _requirePayer(job);
        _requireBeforeExpiry(job);
        if (msg.value != job.expectedAmount) {
            revert UnexpectedFundingAmount(job.expectedAmount, msg.value);
        }
        _requireVerified(msg.sender);

        job.amount = uint128(msg.value);
        job.status = Status.FUNDED;

        emit JobFunded(jobId, msg.sender, msg.value);
    }

    /// @notice Commits the provider's deliverable hash without placing its contents onchain.
    function submitDeliverable(bytes32 jobId, bytes32 deliverableHash) external {
        Job storage job = _job(jobId);
        _requireStatus(job, Status.FUNDED);
        if (msg.sender != job.provider) revert Unauthorized(msg.sender);
        _requireBeforeExpiry(job);
        if (deliverableHash == bytes32(0)) revert ZeroDeliverableHash();
        _requireVerified(msg.sender);

        job.deliverableHash = deliverableHash;
        job.status = Status.SUBMITTED;

        emit DeliverableSubmitted(jobId, msg.sender, deliverableHash);
    }

    /// @notice Records payer/evaluator approval. Approval never transfers funds by itself.
    function approveJob(bytes32 jobId) external {
        Job storage job = _job(jobId);
        _requireStatus(job, Status.SUBMITTED);
        _requireApprover(job);
        _requireBeforeExpiry(job);
        _requireVerified(msg.sender);

        job.status = Status.APPROVED;

        emit JobApproved(jobId, msg.sender);
    }

    /// @notice Releases an approved job to its immutable provider.
    /// @dev Any job participant may execute an already-authorized release; the destination cannot be changed.
    function releaseJob(bytes32 jobId) external nonReentrant {
        Job storage job = _job(jobId);
        _requireStatus(job, Status.APPROVED);
        if (!_isParticipant(job, msg.sender)) revert Unauthorized(msg.sender);

        uint256 amount = job.amount;
        address provider = job.provider;
        job.amount = 0;
        job.status = Status.RELEASED;

        _sendNative(provider, amount);

        emit JobReleased(jobId, msg.sender, provider, amount);
    }

    /// @notice Opens a dispute before release. No funds move at this transition.
    /// @dev APPROVED jobs remain disputable so a provider that cannot receive native ETH cannot trap funds.
    function openDispute(bytes32 jobId) external {
        Job storage job = _job(jobId);
        if (job.status != Status.SUBMITTED && job.status != Status.APPROVED) {
            revert InvalidStatusForAction(job.status);
        }
        if (!_isParticipant(job, msg.sender)) revert Unauthorized(msg.sender);
        if (job.status == Status.SUBMITTED) _requireBeforeExpiry(job);
        _requireVerified(msg.sender);

        uint64 openedAt = uint64(block.timestamp);
        job.disputeOpenedAt = openedAt;
        job.status = Status.DISPUTED;

        emit JobDisputed(jobId, msg.sender, openedAt);
    }

    /// @notice Resolves a dispute to the provider or payer.
    /// @dev The independent evaluator is resolver when configured; otherwise the payer resolves the MVP dispute.
    function resolveDispute(bytes32 jobId, bool payProvider) external nonReentrant {
        Job storage job = _job(jobId);
        _requireStatus(job, Status.DISPUTED);
        address resolver = job.evaluator == address(0) ? job.payer : job.evaluator;
        if (msg.sender != resolver) revert Unauthorized(msg.sender);
        _requireVerified(msg.sender);

        uint256 amount = job.amount;
        address recipient = payProvider ? job.provider : job.payer;
        job.amount = 0;
        job.status = payProvider ? Status.RELEASED : Status.REFUNDED;

        _sendNative(recipient, amount);

        emit DisputeResolved(jobId, msg.sender, payProvider);
        if (payProvider) {
            emit JobReleased(jobId, msg.sender, job.provider, amount);
        } else {
            emit JobRefunded(jobId, job.payer, amount, keccak256("DISPUTE_RESOLUTION"));
        }
    }

    /// @notice Cancels a job before submission. A funded cancellation must be claimed separately.
    function cancelJob(bytes32 jobId) external {
        Job storage job = _job(jobId);
        _requirePayer(job);
        if (job.status != Status.CREATED && job.status != Status.FUNDED) {
            revert InvalidStatusForAction(job.status);
        }

        job.status = Status.CANCELLED;

        emit JobCancelled(jobId, msg.sender, job.amount);
    }

    /// @notice Marks a non-terminal, unapproved job expired after its immutable deadline.
    function markExpired(bytes32 jobId) external {
        Job storage job = _job(jobId);
        if (block.timestamp <= job.expiresAt) revert InvalidExpiry(job.expiresAt, block.timestamp);
        if (job.status != Status.CREATED && job.status != Status.FUNDED && job.status != Status.SUBMITTED) {
            revert InvalidStatusForAction(job.status);
        }

        job.status = Status.EXPIRED;

        emit JobExpired(jobId, msg.sender, job.amount);
    }

    /// @notice Returns cancelled or expired funds to the immutable payer.
    /// @dev No Dojang re-check is required for recovery; identity revocation must not trap payer funds.
    function claimRefund(bytes32 jobId) external nonReentrant {
        Job storage job = _job(jobId);
        _requirePayer(job);
        if (job.status != Status.CANCELLED && job.status != Status.EXPIRED) {
            revert InvalidStatusForAction(job.status);
        }
        _refund(jobId, job, keccak256("CANCELLED_OR_EXPIRED"));
    }

    /// @notice Fail-safe refund if an evaluator never resolves an open dispute.
    function claimDisputeTimeoutRefund(bytes32 jobId) external nonReentrant {
        Job storage job = _job(jobId);
        _requireStatus(job, Status.DISPUTED);
        _requirePayer(job);
        uint256 availableAt = uint256(job.disputeOpenedAt) + DISPUTE_TIMEOUT;
        if (block.timestamp <= availableAt) {
            revert DisputeTimeoutNotReached(availableAt, block.timestamp);
        }
        _refund(jobId, job, keccak256("DISPUTE_TIMEOUT"));
    }

    function getJob(bytes32 jobId) external view returns (Job memory) {
        Job memory job = jobs[jobId];
        if (job.status == Status.NONE) revert JobNotFound(jobId);
        return job;
    }

    function isVerified(address account) external view returns (bool) {
        (bool available, bool verified) = _verificationResult(account);
        return available && verified;
    }

    receive() external payable {
        revert UnexpectedNativeTransfer();
    }

    fallback() external payable {
        revert UnexpectedNativeTransfer();
    }

    function _job(bytes32 jobId) private view returns (Job storage job) {
        job = jobs[jobId];
        if (job.status == Status.NONE) revert JobNotFound(jobId);
    }

    function _requireStatus(Job storage job, Status expected) private view {
        if (job.status != expected) revert InvalidStatus(expected, job.status);
    }

    function _requirePayer(Job storage job) private view {
        if (msg.sender != job.payer) revert Unauthorized(msg.sender);
    }

    function _requireApprover(Job storage job) private view {
        if (msg.sender != job.payer && msg.sender != job.evaluator) revert Unauthorized(msg.sender);
    }

    function _requireBeforeExpiry(Job storage job) private view {
        if (block.timestamp > job.expiresAt) revert InvalidExpiry(job.expiresAt, block.timestamp);
    }

    function _isParticipant(Job storage job, address actor) private view returns (bool) {
        return actor == job.payer || actor == job.provider || actor == job.evaluator;
    }

    function _requireVerified(address account) private view {
        (bool available, bool verified) = _verificationResult(account);
        if (!available) revert VerificationUnavailable();
        if (!verified) revert AddressNotVerified(account);
    }

    function _verificationResult(address account) private view returns (bool available, bool verified) {
        (bool upbitAvailable, bool upbitVerified) = _attesterVerification(account, upbitKoreaAttesterId);
        if (upbitVerified) return (true, true);

        (bool faucetAvailable, bool faucetVerified) = _attesterVerification(account, testnetFaucetAttesterId);
        if (faucetVerified) return (true, true);

        return (upbitAvailable && faucetAvailable, false);
    }

    function _attesterVerification(address account, bytes32 configuredAttesterId)
        private
        view
        returns (bool available, bool verified)
    {
        (bool success, bytes memory result) =
            dojangScroll.staticcall(abi.encodeCall(IDojangScroll.isVerified, (account, configuredAttesterId)));
        if (!success || result.length != 32) return (false, false);
        uint256 rawResult;
        assembly {
            rawResult := mload(add(result, 0x20))
        }
        if (rawResult > 1) return (false, false);
        return (true, rawResult == 1);
    }

    function _refund(bytes32 jobId, Job storage job, bytes32 reason) private {
        uint256 amount = job.amount;
        if (amount == 0) revert ZeroAmount();
        address payer = job.payer;
        job.amount = 0;
        job.status = Status.REFUNDED;

        _sendNative(payer, amount);

        emit JobRefunded(jobId, payer, amount, reason);
    }

    function _sendNative(address recipient, uint256 amount) private {
        (bool sent,) = payable(recipient).call{ value: amount }("");
        if (!sent) revert TransferFailed(recipient, amount);
    }
}
