// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {
    FHE,
    euint64,
    externalEuint64,
    eaddress,
    ebool
} from "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title ConfidentialAuction — sealed-bid auction on Zama FHEVM
/// @notice Bids are encrypted client-side and never revealed. The contract
///         tracks the highest bid and the winner's address fully encrypted.
///         When the owner ends the auction, the winner and amount are made
///         publicly decryptable via the FHEVM KMS so the frontend can reveal
///         them — losing bids stay private forever.
contract ConfidentialAuction is ZamaEthereumConfig {
    address public immutable owner;
    string public itemName;
    string public itemDescription;
    uint256 public endTime;

    bool public ended;

    address[] public bidders;
    mapping(address => bool) public hasBid;
    mapping(address => euint64) private _bids;

    euint64 private _highestBid;
    eaddress private _winnerAddress;

    event BidPlaced(address indexed bidder);
    event AuctionEnded(address indexed by);

    constructor(
        string memory _itemName,
        string memory _itemDescription,
        uint256 _durationSeconds
    ) {
        require(_durationSeconds > 0, "Duration must be positive");
        owner = msg.sender;
        itemName = _itemName;
        itemDescription = _itemDescription;
        endTime = block.timestamp + _durationSeconds;

        _highestBid = FHE.asEuint64(0);
        _winnerAddress = FHE.asEaddress(address(0));
        FHE.allowThis(_highestBid);
        FHE.allowThis(_winnerAddress);
    }

    /// @notice Place an encrypted bid. Re-bidding by the same address is
    ///         allowed; only bids strictly greater than the running highest
    ///         move the winner pointer.
    function placeBid(externalEuint64 encryptedAmount, bytes calldata inputProof)
        external
    {
        require(!ended, "Auction ended");
        require(block.timestamp < endTime, "Auction expired");

        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);

        if (!hasBid[msg.sender]) {
            bidders.push(msg.sender);
            hasBid[msg.sender] = true;
        }

        _bids[msg.sender] = amount;
        FHE.allowThis(_bids[msg.sender]);
        FHE.allow(_bids[msg.sender], msg.sender);

        ebool isHigher = FHE.gt(amount, _highestBid);
        _highestBid = FHE.select(isHigher, amount, _highestBid);
        _winnerAddress = FHE.select(
            isHigher,
            FHE.asEaddress(msg.sender),
            _winnerAddress
        );

        FHE.allowThis(_highestBid);
        FHE.allowThis(_winnerAddress);

        emit BidPlaced(msg.sender);
    }

    /// @notice End the auction and make the winner + winning amount publicly
    ///         decryptable. Only the owner can end early; anyone can end after
    ///         the deadline.
    function endAuction() external {
        require(!ended, "Already ended");
        if (msg.sender != owner) {
            require(block.timestamp >= endTime, "Auction not yet expired");
        }
        ended = true;

        FHE.makePubliclyDecryptable(_highestBid);
        FHE.makePubliclyDecryptable(_winnerAddress);

        emit AuctionEnded(msg.sender);
    }

    /// @notice Returns the encrypted handle of the caller's own bid so they
    ///         can decrypt it via the relayer SDK and confirm what was sent.
    function getMyBidHandle() external returns (euint64) {
        require(hasBid[msg.sender], "No bid placed");
        FHE.allow(_bids[msg.sender], msg.sender);
        return _bids[msg.sender];
    }

    /// @notice Encrypted handle of the highest bid. Once the auction is ended
    ///         this handle is publicly decryptable; before that, only the
    ///         contract itself holds permission and the value stays sealed.
    function getHighestBidHandle() external view returns (euint64) {
        return _highestBid;
    }

    /// @notice Encrypted handle of the winner's address. Same access rules as
    ///         getHighestBidHandle.
    function getWinnerAddressHandle() external view returns (eaddress) {
        return _winnerAddress;
    }

    function bidderCount() external view returns (uint256) {
        return bidders.length;
    }

    function getBidders() external view returns (address[] memory) {
        return bidders;
    }

    function timeRemaining() external view returns (uint256) {
        if (block.timestamp >= endTime) return 0;
        return endTime - block.timestamp;
    }
}
