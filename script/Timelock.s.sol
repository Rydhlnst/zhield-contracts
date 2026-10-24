// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {ZhieldRewardsVault} from "../src/ZhieldRewardsVault.sol";
import {ZhieldTimelock} from "../src/ZhieldTimelock.sol";

/*
  Puts the RewardsVault behind a two-day timelock. Run by the vault's current
  owner (the launch wallet), in one go:

    1. deploy ZhieldTimelock with no delay yet, the owner as proposer, anyone as executor
    2. vault.transferOwnership(timelock)
    3. through the timelock, at once: vault.acceptOwnership()
    4. through the timelock, at once: timelock.updateDelay(2 days)
    5. the owner renounces the timelock's admin role

  From then on every vault owner action waits two days in public. The owner can
  still withdraw, after the delay. Pools and the registry keep their owner, so
  deposits can still be paused at once in an emergency (no pool function can move ETH).

    forge script script/Timelock.s.sol --rpc-url robinhood --account zhield-launch --broadcast

  Settings: ZHIELD_DEPLOYMENT_FILE (default deployments/robinhood.json), where the
  vault is read and the timelock is recorded; ZHIELD_TIMELOCK_DELAY in seconds
  (default 2 days).
*/
contract Timelock is Script {
    function run() external returns (ZhieldTimelock tl) {
        string memory file = vm.envOr("ZHIELD_DEPLOYMENT_FILE", string("deployments/robinhood.json"));
        string memory json = vm.readFile(file);
        ZhieldRewardsVault vault = ZhieldRewardsVault(payable(vm.parseJsonAddress(json, ".vault")));
        uint256 delay = vm.envOr("ZHIELD_TIMELOCK_DELAY", uint256(2 days));

        vm.startBroadcast();
        (, address me,) = vm.readCallers();
        require(vault.owner() == me, "Timelock: run this as the vault owner");

        address[] memory proposers = new address[](1);
        proposers[0] = me;
        address[] memory executors = new address[](1);
        executors[0] = address(0); // anyone may execute once the delay has passed
        tl = new ZhieldTimelock(0, proposers, executors, me);

        vault.transferOwnership(address(tl));
        bytes memory accept = abi.encodeCall(ZhieldRewardsVault.acceptOwnership, ());
        tl.schedule(address(vault), 0, accept, bytes32(0), keccak256("zhield.accept"), 0);
        tl.execute(address(vault), 0, accept, bytes32(0), keccak256("zhield.accept"));

        bytes memory setDelay = abi.encodeCall(tl.updateDelay, (delay));
        tl.schedule(address(tl), 0, setDelay, bytes32(0), keccak256("zhield.delay"), 0);
        tl.execute(address(tl), 0, setDelay, bytes32(0), keccak256("zhield.delay"));

        tl.renounceRole(tl.DEFAULT_ADMIN_ROLE(), me);
        vm.stopBroadcast();

        require(vault.owner() == address(tl), "Timelock: vault not handed over");
        require(tl.getMinDelay() == delay, "Timelock: delay not set");
        console2.log("ZhieldTimelock", address(tl));
        console2.log("min delay (s)", delay);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            vm.writeJson(vm.toString(address(tl)), file, ".timelock");
            vm.writeJson(vm.toString(delay), file, ".timelockDelay");
        }
    }
}
