# Confidential Auction · Zama FHEVM

A sealed-bid auction where bids are encrypted on-chain. The contract computes the highest bid in fully-homomorphic encryption (FHE) — nobody (not even the contract) can read individual bids. When the owner ends the auction, only the winner's address and winning amount are publicly decrypted via the FHEVM KMS. Losing bids stay private forever.

**Live demo:** https://sammy-xxiv.github.io/confidential-auction/
**Contract (Sepolia):** [`0xaB35dd9c736cdA3F11EC0A14AB7eA20fD7A66533`](https://sepolia.etherscan.io/address/0xaB35dd9c736cdA3F11EC0A14AB7eA20fD7A66533)

## How it works

1. **Bid** — User encrypts an amount in their browser via the Zama relayer SDK and submits it. The contract sees only ciphertext.
2. **Compete** — Each bid is compared against the running encrypted highest bid using `FHE.gt` + `FHE.select`. The winner's address is also tracked encrypted (`eaddress`).
3. **End** — Owner (or anyone after the deadline) calls `endAuction()`. The contract calls `FHE.makePubliclyDecryptable` on the highest bid and winner address handles.
4. **Reveal** — The frontend calls `instance.publicDecrypt([bidHandle, winnerHandle])` against the KMS. The winner is revealed; all losing bids stay encrypted.

## Project layout

```
contracts/ConfidentialAuction.sol   ← FHE auction contract
test/ConfidentialAuction.test.ts    ← 16 unit tests against mock FHEVM
deploy/deploy.ts                    ← Sepolia deploy script
deployments/sepolia.json            ← Recorded address & metadata
frontend/                           ← React + Vite dApp
SKILL.md                            ← FHEVM skill reference (from sammy-XXIV/Fhevm-skill)
fhevm-lint.js                       ← FHEVM anti-pattern linter
```

## Build, test, deploy

```bash
# Contracts
npm install
npx hardhat test                                 # 16 tests pass
npm run lint:fhe                                 # FHEVM lint
npx hardhat clean && npx hardhat compile --network sepolia
npx hardhat run deploy/deploy.ts --network sepolia

# Frontend
cd frontend
npm install
npm run build
npx gh-pages -d dist
```

## Notes on the design

- Re-bidding is allowed; the bidder's stored ciphertext is replaced. Only bids strictly greater than the current sealed highest move the winner pointer.
- `_highestBid` and `_winnerAddress` are initialized in the constructor (no inline `FHE.asEuint64(0)` — see SKILL.md §4).
- Every storage update re-grants ACL via `FHE.allowThis` (SKILL.md §20 — stale handle anti-pattern).
- The ABI exposes `bytes32` not `euint64` for ethers compatibility (SKILL.md §16).
- `getMyBidHandle()` is non-`view` because `FHE.allow` modifies state (SKILL.md §13).

## Credits

Built with the [Fhevm-skill](https://github.com/sammy-XXIV/Fhevm-skill) — a distilled reference of FHEVM patterns and anti-patterns.
