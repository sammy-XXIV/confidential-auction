import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const ITEM_NAME = "Sealed-Bid Trophy NFT";
const ITEM_DESCRIPTION =
  "Demo confidential auction on Zama FHEVM Sepolia. Bids are encrypted client-side; only the winner is revealed.";
const DURATION_SECONDS = 60 * 60 * 24 * 7; // 7 days

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await deployer.provider!.getBalance(deployer.address);
  console.log("Network:    ", network.name);
  console.log("Deployer:   ", deployer.address);
  console.log("Balance:    ", ethers.formatEther(balance), "ETH");
  console.log("Item:       ", ITEM_NAME);
  console.log("Duration:   ", DURATION_SECONDS, "seconds");

  if (balance === 0n && network.name === "sepolia") {
    throw new Error("Deployer has 0 ETH on Sepolia. Fund the address first.");
  }

  const Factory = await ethers.getContractFactory("ConfidentialAuction");
  const contract = await Factory.deploy(
    ITEM_NAME,
    ITEM_DESCRIPTION,
    DURATION_SECONDS
  );
  console.log("Tx hash:    ", contract.deploymentTransaction()?.hash);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("\n✅ Deployed at:", address);
  console.log(
    "Etherscan:  ",
    `https://sepolia.etherscan.io/address/${address}`
  );

  // Save deployment info
  const out = {
    network: network.name,
    address,
    itemName: ITEM_NAME,
    itemDescription: ITEM_DESCRIPTION,
    durationSeconds: DURATION_SECONDS,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    txHash: contract.deploymentTransaction()?.hash,
  };
  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log("Saved:      ", outFile);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
