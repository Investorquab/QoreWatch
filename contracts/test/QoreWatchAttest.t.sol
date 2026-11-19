// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {QoreWatchAttest} from "../src/QoreWatchAttest.sol";

contract QoreWatchAttestTest is Test {
    QoreWatchAttest internal c;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    event Attested(address indexed account, uint16 score, bytes32 reportHash, bytes8 code, uint64 time);

    function setUp() public {
        c = new QoreWatchAttest();
        vm.warp(1_795_000_000);
        vm.roll(10_400_000);
    }

    function test_attest_records_latest_and_emits() public {
        bytes32 h = keccak256("report");
        vm.expectEmit(true, false, false, true, address(c));
        emit Attested(alice, 92, h, bytes8(0x4142434432333435), 1_795_000_000);
        vm.prank(alice);
        c.attest(92, h, bytes8(0x4142434432333435));
        (uint64 time, uint64 blockNumber, uint16 score, bytes32 reportHash) = c.latest(alice);
        assertEq(time, 1_795_000_000);
        assertEq(blockNumber, 10_400_000);
        assertEq(score, 92);
        assertEq(reportHash, h);
        assertEq(c.count(alice), 1);
    }

    function test_attestation_is_always_about_the_sender() public {
        vm.prank(alice);
        c.attest(50, keccak256("a"), bytes8(0));
        (bool bobHas,,) = c.attestationOf(bob);
        assertFalse(bobHas);
        (bool aliceHas, QoreWatchAttest.Attestation memory a, uint256 total) = c.attestationOf(alice);
        assertTrue(aliceHas);
        assertEq(a.score, 50);
        assertEq(total, 1);
    }

    function test_later_attestations_replace_and_count() public {
        vm.startPrank(alice);
        c.attest(40, keccak256("first"), bytes8(0));
        vm.warp(1_795_000_600);
        c.attest(100, keccak256("second"), bytes8(0));
        vm.stopPrank();
        (uint64 time,, uint16 score, bytes32 h) = c.latest(alice);
        assertEq(time, 1_795_000_600);
        assertEq(score, 100);
        assertEq(h, keccak256("second"));
        assertEq(c.count(alice), 2);
    }

    function test_rejects_scores_above_100() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(QoreWatchAttest.ScoreOutOfRange.selector, uint16(101)));
        c.attest(101, keccak256("x"), bytes8(0));
    }

    function test_rejects_an_empty_report() public {
        vm.prank(alice);
        vm.expectRevert(QoreWatchAttest.EmptyReport.selector);
        c.attest(80, bytes32(0), bytes8(0));
    }

    function test_rejects_money() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) =
            address(c).call{value: 1 wei}(abi.encodeCall(QoreWatchAttest.attest, (80, keccak256("x"), bytes8(0))));
        assertFalse(ok);
        assertEq(address(c).balance, 0);
    }

    function testFuzz_any_valid_score_is_recorded(address who, uint16 score, bytes32 h) public {
        vm.assume(h != bytes32(0));
        score = uint16(bound(score, 0, 100));
        vm.prank(who);
        c.attest(score, h, bytes8(0));
        (bool exists, QoreWatchAttest.Attestation memory a,) = c.attestationOf(who);
        assertTrue(exists);
        assertEq(a.score, score);
        assertEq(a.reportHash, h);
    }
}
