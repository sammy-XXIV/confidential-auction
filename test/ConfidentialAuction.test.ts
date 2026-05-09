import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { ConfidentialAuction } from "../typechain-types";

describe("ConfidentialAuction", function () {
  let auction: ConfidentialAuction;
  let auctionAddr: string;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;

  const ITEM = "Rare Painting";
  const DESC = "A one-of-a-kind digital painting NFT";
  const DURATION = 60 * 60; // 1 hour

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ConfidentialAuction");
    auction = (await Factory.connect(owner).deploy(ITEM, DESC, DURATION)) as unknown as ConfidentialAuction;
    await auction.waitForDeployment();
    auctionAddr = await auction.getAddress();
  });

  async function bid(signer: HardhatEthersSigner, amount: number) {
    const enc = await fhevm
      .createEncryptedInput(auctionAddr, signer.address)
      .add64(BigInt(amount))
      .encrypt();
    const tx = await auction
      .connect(signer)
      .placeBid(enc.handles[0], enc.inputProof);
    return tx.wait();
  }

  it("deploys with correct metadata", async function () {
    expect(await auction.owner()).to.equal(owner.address);
    expect(await auction.itemName()).to.equal(ITEM);
    expect(await auction.itemDescription()).to.equal(DESC);
    expect(await auction.ended()).to.equal(false);
    expect(await auction.bidderCount()).to.equal(0n);
  });

  it("rejects deployment with zero duration", async function () {
    const Factory = await ethers.getContractFactory("ConfidentialAuction");
    await expect(
      Factory.connect(owner).deploy(ITEM, DESC, 0)
    ).to.be.revertedWith("Duration must be positive");
  });

  it("accepts a single encrypted bid", async function () {
    await bid(alice, 100);
    expect(await auction.hasBid(alice.address)).to.equal(true);
    expect(await auction.bidderCount()).to.equal(1n);
    expect((await auction.getBidders())[0]).to.equal(alice.address);
  });

  it("emits BidPlaced", async function () {
    const enc = await fhevm
      .createEncryptedInput(auctionAddr, alice.address)
      .add64(50n)
      .encrypt();
    await expect(
      auction.connect(alice).placeBid(enc.handles[0], enc.inputProof)
    )
      .to.emit(auction, "BidPlaced")
      .withArgs(alice.address);
  });

  it("lets the bidder decrypt their own stored bid", async function () {
    await bid(alice, 250);
    const handle = await auction.connect(alice).getMyBidHandle.staticCall();
    // refresh ACL via state-changing call so alice has decrypt permission
    await (await auction.connect(alice).getMyBidHandle()).wait();
    const cleartext = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      handle,
      auctionAddr,
      alice
    );
    expect(cleartext).to.equal(250n);
  });

  it("getMyBidHandle reverts for non-bidder", async function () {
    await expect(auction.connect(alice).getMyBidHandle()).to.be.revertedWith(
      "No bid placed"
    );
  });

  it("does not double-count when same bidder re-bids", async function () {
    await bid(alice, 100);
    await bid(alice, 200);
    expect(await auction.bidderCount()).to.equal(1n);
  });

  it("re-bid replaces stored bid amount", async function () {
    await bid(alice, 100);
    await bid(alice, 50);
    await (await auction.connect(alice).getMyBidHandle()).wait();
    const handle = await auction.connect(alice).getMyBidHandle.staticCall();
    const cleartext = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      handle,
      auctionAddr,
      alice
    );
    expect(cleartext).to.equal(50n);
  });

  it("blocks bids after auction is ended", async function () {
    await bid(alice, 100);
    await auction.connect(owner).endAuction();
    const enc = await fhevm
      .createEncryptedInput(auctionAddr, bob.address)
      .add64(999n)
      .encrypt();
    await expect(
      auction.connect(bob).placeBid(enc.handles[0], enc.inputProof)
    ).to.be.revertedWith("Auction ended");
  });

  it("non-owner cannot end before deadline", async function () {
    await bid(alice, 100);
    await expect(auction.connect(alice).endAuction()).to.be.revertedWith(
      "Auction not yet expired"
    );
  });

  it("anyone can end after deadline", async function () {
    await bid(alice, 100);
    await ethers.provider.send("evm_increaseTime", [DURATION + 1]);
    await ethers.provider.send("evm_mine", []);
    await expect(auction.connect(alice).endAuction()).to.emit(
      auction,
      "AuctionEnded"
    );
  });

  it("cannot end twice", async function () {
    await bid(alice, 100);
    await auction.connect(owner).endAuction();
    await expect(auction.connect(owner).endAuction()).to.be.revertedWith(
      "Already ended"
    );
  });

  it("end + public decryption reveals the highest bidder", async function () {
    await bid(alice, 100);
    await bid(bob, 250);
    await bid(carol, 175);

    await auction.connect(owner).endAuction();

    const bidHandle = await auction.getHighestBidHandle();
    const winnerHandle = await auction.getWinnerAddressHandle();

    const winningBid = await fhevm.publicDecryptEuint(
      FhevmType.euint64,
      bidHandle
    );
    const winnerAddr = await fhevm.publicDecryptEaddress(winnerHandle);

    expect(winningBid).to.equal(250n);
    expect(winnerAddr.toLowerCase()).to.equal(bob.address.toLowerCase());
  });

  it("re-bid that beats current highest takes the lead", async function () {
    await bid(alice, 100);
    await bid(bob, 200);
    await bid(alice, 300); // Alice raises and wins

    await auction.connect(owner).endAuction();
    const bidHandle = await auction.getHighestBidHandle();
    const winnerHandle = await auction.getWinnerAddressHandle();
    const winningBid = await fhevm.publicDecryptEuint(
      FhevmType.euint64,
      bidHandle
    );
    const winnerAddr = await fhevm.publicDecryptEaddress(winnerHandle);

    expect(winningBid).to.equal(300n);
    expect(winnerAddr.toLowerCase()).to.equal(alice.address.toLowerCase());
  });

  it("zero-bidders auction ends with zero highest bid and address(0)", async function () {
    await auction.connect(owner).endAuction();
    const bidHandle = await auction.getHighestBidHandle();
    const winnerHandle = await auction.getWinnerAddressHandle();
    const winningBid = await fhevm.publicDecryptEuint(
      FhevmType.euint64,
      bidHandle
    );
    const winnerAddr = await fhevm.publicDecryptEaddress(winnerHandle);
    expect(winningBid).to.equal(0n);
    expect(winnerAddr.toLowerCase()).to.equal(ethers.ZeroAddress.toLowerCase());
  });

  it("timeRemaining ticks down and returns 0 after deadline", async function () {
    const t1 = await auction.timeRemaining();
    expect(t1).to.be.lessThanOrEqual(BigInt(DURATION));

    await ethers.provider.send("evm_increaseTime", [DURATION + 10]);
    await ethers.provider.send("evm_mine", []);
    expect(await auction.timeRemaining()).to.equal(0n);
  });
});
