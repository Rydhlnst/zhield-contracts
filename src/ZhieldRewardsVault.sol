// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
  Zhield RewardsVault: hourly rewards for $ZHIELD holders.

  The vault holds a reward token, such as NVIDIA • Robinhood Token (NVDA) on
  Robinhood Chain. Every hour, each wallet holding at least the minimum $ZHIELD
  earns a fixed dollar amount of the reward token (set off-chain: $0.01 for
  3,000,000 $ZHIELD at launch).

  $ZHIELD launches on Pons, so this vault cannot watch its transfers. A publisher
  bot snapshots $ZHIELD balances every hour, adds each eligible holder's reward,
  and posts a Merkle root of every holder's cumulative entitlement. Holders claim
  for themselves, from the wallet that holds $ZHIELD: one claim with the latest
  proof pays everything not claimed yet, to that wallet or to a fresh address.
  Nobody else, the team included, can claim for them.

  The bot cannot hand out more than the owner allows: each root may add at most
  hourlyCap per hour since the last root (counting at most MAX_CATCHUP_HOURS),
  and only one root per clock hour.

  The owner can withdraw any token or ETH at any time, including published and
  unclaimed rewards (every withdrawal emits OwnerWithdrawal), change the cap and
  change the publisher. Pool shield fees arrive here in ETH; the owner can swap
  them into the reward token and send them back.

  Leaves follow OpenZeppelin's MerkleProof convention:
    leaf = keccak256(bytes.concat(keccak256(abi.encode(account, cumulativeAmount))))
  with sorted pairs when hashing up the tree.
*/
contract ZhieldRewardsVault {
    uint256 public constant HOUR = 1 hours;
    uint256 public constant MAX_CATCHUP_HOURS = 24;

    address public immutable rewardToken;

    address public owner;
    address public pendingOwner;
    address public publisher;
    /// Most reward tokens a root may add per hour.
    uint256 public hourlyCap;

    bytes32 public root;
    bytes32 public previousRoot;
    /// Sum of every holder's cumulative entitlement in the current root.
    uint256 public publishedTotal;
    /// Start of the hour the last root was published in.
    uint256 public lastPublishHour;
    uint256 public rootCount;
    /// Total ever paid out to holders.
    uint256 public totalClaimed;

    mapping(address account => uint256) public claimed;

    uint256 private locked = 1;

    event RootPublished(uint256 indexed index, bytes32 root, uint256 cumulativeTotal, string uri);
    event Claimed(address indexed account, address to, uint256 amount, uint256 cumulative);
    event OwnerWithdrawal(address indexed token, address indexed to, uint256 amount);
    event HourlyCapChanged(uint256 hourlyCap);
    event PublisherChanged(address indexed publisher);
    event Received(address indexed from, uint256 amount);
    event OwnerProposed(address indexed owner);
    event OwnerChanged(address indexed owner);

    modifier onlyOwner() {
        require(msg.sender == owner, "Vault: not owner");
        _;
    }

    modifier nonReentrant() {
        require(locked == 1, "Vault: reentrant");
        locked = 2;
        _;
        locked = 1;
    }

    constructor(address _owner, address _publisher, address _rewardToken, uint256 _hourlyCap) {
        require(_owner != address(0) && _publisher != address(0) && _rewardToken != address(0), "Vault: zero address");
        owner = _owner;
        publisher = _publisher;
        rewardToken = _rewardToken;
        hourlyCap = _hourlyCap;
        lastPublishHour = _hour();
        emit OwnerChanged(_owner);
        emit PublisherChanged(_publisher);
        emit HourlyCapChanged(_hourlyCap);
    }

    /// Pool shield fees and any ETH sent here.
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    /* ---------- Publisher ---------- */

    /// How much the next root may add to publishedTotal if published now.
    function allowance() public view returns (uint256) {
        uint256 hrs = (_hour() - lastPublishHour) / HOUR;
        return (hrs > MAX_CATCHUP_HOURS ? MAX_CATCHUP_HOURS : hrs) * hourlyCap;
    }

    function publishRoot(bytes32 newRoot, uint256 cumulativeTotal, string calldata uri) external {
        require(msg.sender == publisher, "Vault: not publisher");
        require(newRoot != bytes32(0), "Vault: empty root");
        require(_hour() > lastPublishHour, "Vault: already published this hour");
        require(cumulativeTotal >= publishedTotal, "Vault: total went down");
        require(cumulativeTotal - publishedTotal <= allowance(), "Vault: over the hourly cap");
        previousRoot = root;
        root = newRoot;
        publishedTotal = cumulativeTotal;
        lastPublishHour = _hour();
        emit RootPublished(rootCount++, newRoot, cumulativeTotal, uri);
    }

    /* ---------- Holders ---------- */

    /// Pay the caller everything it has not claimed yet.
    function claim(uint256 cumulative, bytes32[] calldata proof) external nonReentrant {
        _claim(msg.sender, msg.sender, cumulative, proof);
    }

    /// The caller sends its rewards to another address, such as a fresh one.
    function claimTo(address to, uint256 cumulative, bytes32[] calldata proof) external nonReentrant {
        require(to != address(0), "Vault: zero recipient");
        _claim(msg.sender, to, cumulative, proof);
    }

    function _claim(address account, address to, uint256 cumulative, bytes32[] calldata proof) private {
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, cumulative))));
        // The previous root still works, so a claim built just before a new root lands goes through.
        require(_verify(proof, root, leaf) || (previousRoot != bytes32(0) && _verify(proof, previousRoot, leaf)), "Vault: invalid proof");
        uint256 already = claimed[account];
        require(cumulative > already, "Vault: nothing to claim");
        uint256 amount = cumulative - already;
        claimed[account] = cumulative;
        totalClaimed += amount;
        _pay(rewardToken, to, amount);
        emit Claimed(account, to, amount, cumulative);
    }

    /* ---------- Owner ---------- */

    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "Vault: zero recipient");
        _pay(token, to, amount);
        emit OwnerWithdrawal(token, to, amount);
    }

    /// Everything the vault holds of a token (address(0) = ETH).
    function withdrawAll(address token, address to) external onlyOwner nonReentrant {
        require(to != address(0), "Vault: zero recipient");
        uint256 amount = _balance(token);
        _pay(token, to, amount);
        emit OwnerWithdrawal(token, to, amount);
    }

    function setHourlyCap(uint256 _hourlyCap) external onlyOwner {
        hourlyCap = _hourlyCap;
        emit HourlyCapChanged(_hourlyCap);
    }

    function setPublisher(address _publisher) external onlyOwner {
        require(_publisher != address(0), "Vault: zero address");
        publisher = _publisher;
        emit PublisherChanged(_publisher);
    }

    function transferOwnership(address _owner) external onlyOwner {
        pendingOwner = _owner;
        emit OwnerProposed(_owner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "Vault: not pending owner");
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnerChanged(owner);
    }

    /* ---------- Views ---------- */

    function balanceOf(address token) external view returns (uint256) {
        return _balance(token);
    }

    /// Published to holders but not claimed yet.
    function owed() external view returns (uint256) {
        return publishedTotal - totalClaimed;
    }

    /* ---------- Internals ---------- */

    function _hour() private view returns (uint256) {
        return (block.timestamp / HOUR) * HOUR;
    }

    function _balance(address token) private view returns (uint256) {
        if (token == address(0)) return address(this).balance;
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        require(ok && data.length >= 32, "Vault: balanceOf failed");
        return abi.decode(data, (uint256));
    }

    function _pay(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool sent, ) = to.call{value: amount}("");
            require(sent, "Vault: ETH transfer failed");
            return;
        }
        // Works with tokens that return a bool and with ones that return nothing.
        (bool ok, bytes memory data) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "Vault: token transfer failed");
    }

    function _verify(bytes32[] calldata proof, bytes32 r, bytes32 leaf) private pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == r;
    }
}
