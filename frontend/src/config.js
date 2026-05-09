export const CONTRACT_ADDRESS = "0xaB35dd9c736cdA3F11EC0A14AB7eA20fD7A66533";
export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_HEX = "0xaa36a7";

export const CONTRACT_ABI = [
  // Reads
  "function owner() view returns (address)",
  "function itemName() view returns (string)",
  "function itemDescription() view returns (string)",
  "function endTime() view returns (uint256)",
  "function ended() view returns (bool)",
  "function bidderCount() view returns (uint256)",
  "function getBidders() view returns (address[])",
  "function hasBid(address) view returns (bool)",
  "function timeRemaining() view returns (uint256)",
  "function getHighestBidHandle() view returns (bytes32)",
  "function getWinnerAddressHandle() view returns (bytes32)",
  // Non-view ACL granters
  "function getMyBidHandle() returns (bytes32)",
  // Mutations
  "function placeBid(bytes32 encryptedAmount, bytes inputProof)",
  "function endAuction()",
  // Events
  "event BidPlaced(address indexed bidder)",
  "event AuctionEnded(address indexed by)"
];
