// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoseidonTree} from "./PoseidonTree.sol";
import {IAssociationRegistry, IPoseidon1, IPoseidon2, IWithdrawVerifier} from "./interfaces.sol";

/*
  One Zhield pool for one fixed amount (0.1, 1 or 10 ETH).

  deposit   Put exactly `denomination` in with a commitment Poseidon(nullifier, secret).
            It joins the deposit tree.
  approve   The screening operator (named in the AssociationRegistry) approves
            deposits whose source passed screening. Only commitments that were
            deposited here can be approved, and each joins the approved tree.
  withdraw  Show a Groth16 proof that your note is in the deposit tree and in the
            approved tree, and that its nullifier is unspent. Pays a fresh address;
            0.20% goes to the fee recipient (the RewardsVault) and an optional
            relayer fee (at most 0.30%) to the relayer that sent it.
  ragequit  The depositor can always take the full amount back to the address it
            came from by revealing the note. It gives up privacy for that note,
            but nothing is ever frozen.

  Both trees are rebuilt by anyone from the Deposit and Approved events, so the
  app needs no server to build a proof, and every approval is public.

  The owner can pause new deposits, set a deposit cap, and change the fee
  recipient behind a 7-day timelock. It cannot move, freeze or redirect user funds.
*/
contract ZhieldPool {
    using PoseidonTree for PoseidonTree.Tree;

    uint256 public constant FIELD_SIZE = PoseidonTree.FIELD_SIZE;
    uint256 public constant SHIELD_FEE_BPS = 20; // 0.20%
    uint256 public constant MAX_RELAYER_FEE_BPS = 30; // 0.30%
    uint256 public constant FEE_RECIPIENT_DELAY = 7 days;

    IWithdrawVerifier public immutable verifier;
    IPoseidon2 public immutable hasher;
    IPoseidon1 public immutable nullifierHasher;
    IAssociationRegistry public immutable registry;
    uint256 public immutable denomination;

    uint256[20] public zeros;
    PoseidonTree.Tree private deposits;
    PoseidonTree.Tree private approvals;

    address public owner;
    address public pendingOwner;
    address payable public feeRecipient;
    address payable public nextFeeRecipient;
    uint256 public nextFeeRecipientAt;
    bool public depositsPaused;
    /// Maximum number of deposits; 0 means no cap.
    uint32 public depositCap;

    mapping(uint256 commitment => address) public depositorOf;
    mapping(uint256 commitment => bool) public approved;
    mapping(uint256 nullifierHash => bool) public nullifierSpent;

    uint256 private locked = 1;

    event Deposit(uint256 indexed commitment, uint32 leafIndex, address indexed depositor, uint256 timestamp);
    event Approved(uint256 indexed commitment, uint32 leafIndex);
    event Withdrawal(address to, uint256 nullifierHash, address indexed relayer, uint256 relayerFee, uint256 shieldFee);
    event Ragequit(uint256 indexed commitment, uint256 nullifierHash, address indexed depositor);
    event DepositsPaused(bool paused);
    event DepositCapChanged(uint32 cap);
    event FeeRecipientProposed(address recipient, uint256 activeAt);
    event FeeRecipientChanged(address recipient);
    event OwnerProposed(address indexed owner);
    event OwnerChanged(address indexed owner);

    modifier nonReentrant() {
        require(locked == 1, "Pool: reentrant");
        locked = 2;
        _;
        locked = 1;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Pool: not owner");
        _;
    }

    constructor(
        IWithdrawVerifier _verifier,
        IPoseidon2 _hasher,
        IPoseidon1 _nullifierHasher,
        IAssociationRegistry _registry,
        uint256 _denomination,
        address payable _feeRecipient,
        address _owner
    ) {
        require(_denomination > 0, "Pool: zero denomination");
        require(_feeRecipient != address(0) && _owner != address(0), "Pool: zero address");
        verifier = _verifier;
        hasher = _hasher;
        nullifierHasher = _nullifierHasher;
        registry = _registry;
        denomination = _denomination;
        feeRecipient = _feeRecipient;
        owner = _owner;

        uint256[21] memory z = PoseidonTree.zeros(_hasher);
        for (uint256 i = 0; i < 20; i++) zeros[i] = z[i];
        deposits.init(z);
        approvals.init(z);

        emit FeeRecipientChanged(_feeRecipient);
        emit OwnerChanged(_owner);
    }

    /* ---------- Users ---------- */

    function deposit(uint256 commitment) external payable nonReentrant {
        require(!depositsPaused, "Pool: deposits paused");
        require(msg.value == denomination, "Pool: wrong amount");
        require(commitment < FIELD_SIZE && commitment != 0, "Pool: bad commitment");
        require(depositorOf[commitment] == address(0), "Pool: duplicate commitment");
        require(depositCap == 0 || deposits.nextIndex < depositCap, "Pool: cap reached");

        uint32 leafIndex = deposits.insert(hasher, zeros, commitment);
        depositorOf[commitment] = msg.sender;
        emit Deposit(commitment, leafIndex, msg.sender, block.timestamp);
    }

    function withdraw(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256 root,
        uint256 assocRoot,
        uint256 nullifierHash,
        address payable recipient,
        address payable relayer,
        uint256 relayerFee
    ) external nonReentrant {
        require(!nullifierSpent[nullifierHash], "Pool: note already spent");
        require(deposits.isKnownRoot(root), "Pool: unknown root");
        require(approvals.isKnownRoot(assocRoot), "Pool: unknown approved-set root");
        require(recipient != address(0), "Pool: zero recipient");
        require(relayerFee <= (denomination * MAX_RELAYER_FEE_BPS) / 10_000, "Pool: relayer fee too high");
        require(relayerFee == 0 || relayer != address(0), "Pool: fee without relayer");
        require(
            verifier.verifyProof(
                a, b, c, [root, assocRoot, nullifierHash, uint256(uint160(address(recipient))), uint256(uint160(address(relayer))), relayerFee]
            ),
            "Pool: invalid proof"
        );

        nullifierSpent[nullifierHash] = true;
        uint256 shieldFee = (denomination * SHIELD_FEE_BPS) / 10_000;
        _send(feeRecipient, shieldFee);
        if (relayerFee > 0) _send(relayer, relayerFee);
        _send(recipient, denomination - shieldFee - relayerFee);
        emit Withdrawal(recipient, nullifierHash, relayer, relayerFee, shieldFee);
    }

    /// Exit hatch for the depositor: the full amount back to the address that deposited it.
    function ragequit(uint256 nullifier, uint256 secret) external nonReentrant {
        require(nullifier < FIELD_SIZE && secret < FIELD_SIZE, "Pool: value out of field");
        uint256 commitment = hasher.poseidon([nullifier, secret]);
        address depositor = depositorOf[commitment];
        require(depositor != address(0), "Pool: unknown note");
        require(msg.sender == depositor, "Pool: only the depositor");
        uint256 nullifierHash = nullifierHasher.poseidon([nullifier]);
        require(!nullifierSpent[nullifierHash], "Pool: note already spent");

        nullifierSpent[nullifierHash] = true;
        _send(payable(depositor), denomination);
        emit Ragequit(commitment, nullifierHash, depositor);
    }

    /* ---------- Screening operator ---------- */

    /// Approve deposits whose source passed screening. Order of the calls is the order of the tree.
    function approve(uint256[] calldata commitments) external {
        require(msg.sender == registry.operator(), "Pool: not operator");
        for (uint256 i = 0; i < commitments.length; i++) {
            uint256 commitment = commitments[i];
            require(depositorOf[commitment] != address(0), "Pool: not deposited");
            require(!approved[commitment], "Pool: already approved");
            approved[commitment] = true;
            uint32 leafIndex = approvals.insert(hasher, zeros, commitment);
            emit Approved(commitment, leafIndex);
        }
    }

    /* ---------- Views ---------- */

    function depositRoot() external view returns (uint256) {
        return deposits.lastRoot();
    }

    function approvedRoot() external view returns (uint256) {
        return approvals.lastRoot();
    }

    function isKnownRoot(uint256 root) external view returns (bool) {
        return deposits.isKnownRoot(root);
    }

    function isKnownApprovedRoot(uint256 root) external view returns (bool) {
        return approvals.isKnownRoot(root);
    }

    function depositCount() external view returns (uint32) {
        return deposits.nextIndex;
    }

    function approvedCount() external view returns (uint32) {
        return approvals.nextIndex;
    }

    /* ---------- Owner: no access to funds ---------- */

    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPaused(paused);
    }

    function setDepositCap(uint32 cap) external onlyOwner {
        depositCap = cap;
        emit DepositCapChanged(cap);
    }

    function proposeFeeRecipient(address payable recipient) external onlyOwner {
        require(recipient != address(0), "Pool: zero address");
        nextFeeRecipient = recipient;
        nextFeeRecipientAt = block.timestamp + FEE_RECIPIENT_DELAY;
        emit FeeRecipientProposed(recipient, nextFeeRecipientAt);
    }

    function activateFeeRecipient() external {
        require(nextFeeRecipient != address(0), "Pool: nothing proposed");
        require(block.timestamp >= nextFeeRecipientAt, "Pool: timelock");
        feeRecipient = nextFeeRecipient;
        nextFeeRecipient = payable(address(0));
        emit FeeRecipientChanged(feeRecipient);
    }

    function transferOwnership(address _owner) external onlyOwner {
        pendingOwner = _owner;
        emit OwnerProposed(_owner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "Pool: not pending owner");
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnerChanged(owner);
    }

    function _send(address payable to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "Pool: ETH transfer failed");
    }
}
