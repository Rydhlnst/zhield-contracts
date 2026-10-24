// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Groth16Verifier} from "../src/Groth16Verifier.sol";
import {AssociationRegistry} from "../src/AssociationRegistry.sol";
import {ZhieldPool} from "../src/ZhieldPool.sol";
import {ZhieldRewardsVault} from "../src/ZhieldRewardsVault.sol";
import {IAssociationRegistry, IPoseidon1, IPoseidon2, IWithdrawVerifier} from "../src/interfaces.sol";

/*
  Deploys Zhield to Robinhood Chain: two Poseidon hashers, the Groth16 verifier,
  the AssociationRegistry, the RewardsVault and the 0.001, 0.01 and 0.1 ETH pools, whose
  0.20% shield fee goes to the vault from the first withdrawal.

  The deployer signs with an encrypted Foundry keystore; the private key never
  appears in a file or a command line:

    cast wallet import nockpad-deployer --interactive
    forge script script/Deploy.s.sol --rpc-url robinhood --account nockpad-deployer --broadcast

  Settings (environment variables, all optional):
    ZHIELD_OWNER          owner of the pools, registry and vault; the vault owner can withdraw
                          everything it holds (default: deployer)
    ZHIELD_OPERATOR       screening operator that posts approved-set roots (default: deployer)
    ZHIELD_FEE_RECIPIENT  where the 0.20% shield fee goes (default: the RewardsVault deployed here)
    ZHIELD_PUBLISHER      the holder-rewards bot that posts hourly Merkle roots (default: deployer)
    ZHIELD_REWARD_TOKEN   what the vault pays holders (default: NVIDIA • Robinhood Token, NVDA)
    ZHIELD_HOURLY_CAP     most reward tokens the bot may hand out per hour, in wei (default:
                          0.05 NVDA, about $10: $0.01 an hour for ~1,000 eligible holders)
    ZHIELD_DEPOSIT_CAP    max deposits per pool for a guarded launch, 0 = none (default: 0)
    ZHIELD_DEPLOYMENT_FILE where to record the addresses (default: deployments/robinhood.json)
*/
contract Deploy is Script {
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    address deployer;
    address owner;
    address operator;
    address payable feeRecipient;
    address publisher;
    address rewardToken;
    uint256 hourlyCap;
    uint32 cap;

    IPoseidon2 hasher;
    IPoseidon1 hasher1;
    Groth16Verifier verifier;
    AssociationRegistry registry;
    ZhieldRewardsVault vault;

    function run() external {
        deployer = msg.sender;
        owner = vm.envOr("ZHIELD_OWNER", deployer);
        operator = vm.envOr("ZHIELD_OPERATOR", deployer);
        cap = uint32(vm.envOr("ZHIELD_DEPOSIT_CAP", uint256(0)));
        publisher = vm.envOr("ZHIELD_PUBLISHER", deployer);
        rewardToken = vm.envOr("ZHIELD_REWARD_TOKEN", NVDA);
        hourlyCap = vm.envOr("ZHIELD_HOURLY_CAP", uint256(0.05 ether));

        bytes memory t3 = vm.parseBytes(vm.readFile("build/PoseidonT3.hex"));
        bytes memory t2 = vm.parseBytes(vm.readFile("build/PoseidonT2.hex"));

        vm.startBroadcast();
        hasher = IPoseidon2(_create(t3));
        hasher1 = IPoseidon1(_create(t2));
        verifier = new Groth16Verifier();
        registry = new AssociationRegistry(owner, operator);
        vault = new ZhieldRewardsVault(owner, publisher, rewardToken, hourlyCap);
        feeRecipient = payable(vm.envOr("ZHIELD_FEE_RECIPIENT", address(vault)));
        ZhieldPool poolA = _pool(0.001 ether);
        ZhieldPool poolB = _pool(0.01 ether);
        ZhieldPool poolC = _pool(0.1 ether);
        vm.stopBroadcast();

        console2.log("PoseidonT3          ", address(hasher));
        console2.log("PoseidonT2          ", address(hasher1));
        console2.log("Groth16Verifier     ", address(verifier));
        console2.log("AssociationRegistry ", address(registry));
        console2.log("RewardsVault        ", address(vault));
        console2.log("ZhieldPool 0.001 ETH", address(poolA));
        console2.log("ZhieldPool 0.01 ETH ", address(poolB));
        console2.log("ZhieldPool 0.1 ETH  ", address(poolC));
        console2.log("owner               ", owner);
        console2.log("operator            ", operator);
        console2.log("feeRecipient        ", feeRecipient);
        if (owner != deployer) console2.log("The owner must call acceptOwnership() on each pool.");

        // Addresses for the CLI and the app; only written when broadcasting, so a dry run never overwrites it.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            string memory k = "deployment";
            vm.serializeUint(k, "chainId", block.chainid);
            vm.serializeAddress(k, "poseidonT3", address(hasher));
            vm.serializeAddress(k, "poseidonT2", address(hasher1));
            vm.serializeAddress(k, "verifier", address(verifier));
            vm.serializeAddress(k, "registry", address(registry));
            vm.serializeAddress(k, "vault", address(vault));
            vm.serializeAddress(k, "poolA", address(poolA));
            vm.serializeAddress(k, "poolB", address(poolB));
            vm.serializeAddress(k, "poolC", address(poolC));
            vm.serializeAddress(k, "owner", owner);
            vm.serializeAddress(k, "operator", operator);
            vm.serializeAddress(k, "publisher", publisher);
            vm.serializeAddress(k, "rewardToken", rewardToken);
            vm.serializeUint(k, "hourlyCap", hourlyCap);
            string memory json = vm.serializeAddress(k, "feeRecipient", feeRecipient);
            vm.writeJson(json, vm.envOr("ZHIELD_DEPLOYMENT_FILE", string("deployments/robinhood.json")));
        }
    }

    /// The deployer owns the pool first so it can set the cap, then hands it to the owner.
    function _pool(uint256 size) internal returns (ZhieldPool pool) {
        pool = new ZhieldPool(
            IWithdrawVerifier(address(verifier)), hasher, hasher1, IAssociationRegistry(address(registry)), size, feeRecipient, deployer
        );
        if (cap > 0) pool.setDepositCap(cap);
        if (owner != deployer) pool.transferOwnership(owner);
    }

    function _create(bytes memory code) internal returns (address addr) {
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "Deploy: create failed");
    }
}
