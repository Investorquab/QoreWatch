// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title QoreWatchAttest
/// @notice Lets an account record, on QoreChain, that it checked its own post-quantum health
///         with QoreWatch: the score it got and a hash of the full report. The account signs
///         the transaction itself (through QoreX, inside an ML-DSA-87 authorised EVM window),
///         so an attestation can only ever be made by the account it is about.
/// @dev Holds no funds, has no owner and nothing to upgrade. Anyone can read any attestation.
contract QoreWatchAttest {
    struct Attestation {
        uint64 time;
        uint64 blockNumber;
        uint16 score;
        bytes32 reportHash;
    }

    /// @notice The latest attestation of each account.
    mapping(address account => Attestation) public latest;
    /// @notice How many times each account has attested.
    mapping(address account => uint256) public count;

    /// @param account The account that attested (always msg.sender).
    /// @param score   The QoreWatch score it reported, 0 to 100.
    /// @param reportHash keccak256 of the canonical QoreWatch report.
    /// @param code    The one-time code from the QoreWatch chat that asked for it (0 if none).
    event Attested(address indexed account, uint16 score, bytes32 reportHash, bytes8 code, uint64 time);

    error ScoreOutOfRange(uint16 score);
    error EmptyReport();

    function attest(uint16 score, bytes32 reportHash, bytes8 code) external {
        if (score > 100) revert ScoreOutOfRange(score);
        if (reportHash == bytes32(0)) revert EmptyReport();
        Attestation memory a = Attestation({
            time: uint64(block.timestamp), blockNumber: uint64(block.number), score: score, reportHash: reportHash
        });
        latest[msg.sender] = a;
        unchecked {
            count[msg.sender] += 1;
        }
        emit Attested(msg.sender, score, reportHash, code, a.time);
    }

    /// @notice An account's latest attestation, and whether it has one.
    function attestationOf(address account) external view returns (bool exists, Attestation memory a, uint256 total) {
        a = latest[account];
        return (a.time != 0, a, count[account]);
    }
}
