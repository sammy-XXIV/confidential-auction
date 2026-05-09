import { useEffect, useState, useCallback } from 'react';
import { BrowserProvider, Contract, ethers } from 'ethers';
import {
  CONTRACT_ADDRESS,
  CONTRACT_ABI,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_HEX,
} from './config.js';

const ZERO_HANDLE =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

function shortAddr(a) {
  if (!a) return '';
  return a.slice(0, 6) + '…' + a.slice(-4);
}

function toHex(val) {
  if (val == null) return val;
  if (typeof val === 'string') return val.startsWith('0x') ? val : '0x' + val;
  if (val instanceof Uint8Array) {
    let s = '0x';
    for (let i = 0; i < val.length; i++) s += val[i].toString(16).padStart(2, '0');
    return s;
  }
  if (Array.isArray(val)) {
    let s = '0x';
    for (let i = 0; i < val.length; i++) s += Number(val[i]).toString(16).padStart(2, '0');
    return s;
  }
  return val;
}

function formatRemaining(seconds) {
  const s = Number(seconds);
  if (s <= 0) return 'Ended';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  return `${m}m ${sec}s`;
}

let _fhevmInstance = null;
async function getFhevmInstance() {
  if (_fhevmInstance) return _fhevmInstance;
  if (!window.relayerSDK) throw new Error('relayer SDK not loaded');
  const { initSDK, createInstance, SepoliaConfig } = window.relayerSDK;
  await initSDK();
  _fhevmInstance = await createInstance({
    ...SepoliaConfig,
    network: window.ethereum,
  });
  return _fhevmInstance;
}

export default function App() {
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [contract, setContract] = useState(null);
  const [account, setAccount] = useState('');
  const [owner, setOwner] = useState('');

  const [item, setItem] = useState({ name: '', desc: '' });
  const [ended, setEnded] = useState(false);
  const [endTime, setEndTime] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [bidders, setBidders] = useState([]);
  const [hasBid, setHasBid] = useState(false);

  const [bidAmount, setBidAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ kind: '', text: '' });

  const [winner, setWinner] = useState({ address: '', amount: '' });
  const [winnerLoaded, setWinnerLoaded] = useState(false);

  const isOwner =
    account && owner && account.toLowerCase() === owner.toLowerCase();

  const setMsg = (kind, text) => setStatus({ kind, text });

  // ─── Connect Wallet ──────────────────────────────────────
  const connect = useCallback(async () => {
    try {
      if (!window.ethereum) {
        setMsg('err', 'MetaMask not found. Install MetaMask and reload.');
        return;
      }
      const _provider = new BrowserProvider(window.ethereum);
      await _provider.send('eth_requestAccounts', []);
      const network = await _provider.getNetwork();
      if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
        try {
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: SEPOLIA_HEX }],
          });
        } catch (e) {
          setMsg('err', 'Please switch to Sepolia testnet (chainId 11155111).');
          return;
        }
      }
      const _signer = await _provider.getSigner();
      const _contract = new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, _signer);
      const _account = await _signer.getAddress();
      const _owner = await _contract.owner();

      setProvider(_provider);
      setSigner(_signer);
      setContract(_contract);
      setAccount(_account);
      setOwner(_owner);
      setMsg('ok', `Connected: ${shortAddr(_account)}`);
    } catch (e) {
      setMsg('err', e.shortMessage || e.message);
    }
  }, []);

  // ─── Refresh Auction State ───────────────────────────────
  const refresh = useCallback(async () => {
    if (!contract) return;
    try {
      const [name, desc, isEnded, end, rem, list] = await Promise.all([
        contract.itemName(),
        contract.itemDescription(),
        contract.ended(),
        contract.endTime(),
        contract.timeRemaining(),
        contract.getBidders(),
      ]);
      setItem({ name, desc });
      setEnded(isEnded);
      setEndTime(Number(end));
      setRemaining(Number(rem));
      setBidders(list);
      if (account) {
        setHasBid(await contract.hasBid(account));
      }
    } catch (e) {
      console.error(e);
    }
  }, [contract, account]);

  useEffect(() => {
    if (contract) refresh();
  }, [contract, refresh]);

  // tick remaining time
  useEffect(() => {
    const t = setInterval(() => {
      setRemaining((r) => (r > 0 ? r - 1 : 0));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // ─── Place Bid ───────────────────────────────────────────
  const placeBid = async () => {
    if (!contract || !signer || !bidAmount) return;
    const amt = Number(bidAmount);
    if (!Number.isFinite(amt) || amt <= 0 || !Number.isInteger(amt)) {
      setMsg('err', 'Enter a positive integer amount.');
      return;
    }
    if (amt > Number.MAX_SAFE_INTEGER) {
      setMsg('err', 'Amount too large.');
      return;
    }
    setBusy(true);
    try {
      setMsg('info', 'Loading FHEVM instance…');
      const instance = await getFhevmInstance();

      setMsg('info', 'Encrypting your bid in your browser…');
      const checksumContract = ethers.getAddress(CONTRACT_ADDRESS);
      const checksumUser = ethers.getAddress(account);
      const enc = await instance
        .createEncryptedInput(checksumContract, checksumUser)
        .add64(BigInt(amt))
        .encrypt();

      const handle = toHex(enc.handles[0]);
      const inputProof = toHex(enc.inputProof);

      setMsg('info', 'Sending transaction… (FHE ops take 5–30s)');
      const tx = await contract.placeBid(handle, inputProof, {
        gasLimit: 1_500_000n,
      });
      setMsg('info', `Tx sent: ${tx.hash.slice(0, 18)}… waiting…`);
      await tx.wait();
      setMsg('ok', 'Bid placed! Nobody can see your amount until the auction is ended.');
      setBidAmount('');
      await refresh();
    } catch (e) {
      console.error(e);
      setMsg('err', e.shortMessage || e.message || 'Bid failed.');
    }
    setBusy(false);
  };

  // ─── End Auction ─────────────────────────────────────────
  const endAuction = async () => {
    if (!contract) return;
    setBusy(true);
    try {
      setMsg('info', 'Ending auction… this also makes the winner publicly decryptable.');
      const tx = await contract.endAuction({ gasLimit: 600_000n });
      setMsg('info', `Tx sent: ${tx.hash.slice(0, 18)}… waiting…`);
      await tx.wait();
      setMsg('ok', 'Auction ended. Click "Reveal Winner" to see the result.');
      await refresh();
    } catch (e) {
      console.error(e);
      setMsg('err', e.shortMessage || e.message || 'End failed.');
    }
    setBusy(false);
  };

  // ─── Reveal Winner via Public Decryption ─────────────────
  const revealWinner = async () => {
    if (!contract) return;
    setBusy(true);
    try {
      setMsg('info', 'Fetching encrypted handles from contract…');
      const bidHandle = await contract.getHighestBidHandle();
      const winnerHandle = await contract.getWinnerAddressHandle();
      if (bidHandle === ZERO_HANDLE || winnerHandle === ZERO_HANDLE) {
        setMsg('err', 'Auction has no encrypted result yet.');
        setBusy(false);
        return;
      }

      setMsg('info', 'Calling KMS for public decryption (5–15s)…');
      const instance = await getFhevmInstance();
      const result = await instance.publicDecrypt([bidHandle, winnerHandle]);
      const amount = result[bidHandle];
      const addrRaw = result[winnerHandle];
      const addr =
        typeof addrRaw === 'string'
          ? addrRaw
          : ethers.getAddress('0x' + BigInt(addrRaw).toString(16).padStart(40, '0'));

      setWinner({
        address: addr,
        amount: amount.toString(),
      });
      setWinnerLoaded(true);
      setMsg('ok', 'Winner revealed!');
    } catch (e) {
      console.error(e);
      setMsg('err', e.shortMessage || e.message || 'Reveal failed.');
    }
    setBusy(false);
  };

  return (
    <div className="app">
      <div className="hero">
        <div>
          <h1>
            🔒 Confidential Auction
            {ended ? (
              <span className="tag tag-ended">ENDED</span>
            ) : (
              <span className="tag tag-live">LIVE</span>
            )}
          </h1>
          <p>Sealed-bid auction on Zama FHEVM · Sepolia</p>
        </div>
        {account ? (
          <div className="wallet-pill">
            {shortAddr(account)} {isOwner && <span className="tag tag-owner">OWNER</span>}
          </div>
        ) : (
          <button className="btn" onClick={connect}>
            Connect Wallet
          </button>
        )}
      </div>

      {!account && (
        <div className="card">
          <h2>How it works</h2>
          <ol style={{ paddingLeft: 18, color: 'var(--muted)', lineHeight: 1.7 }}>
            <li>Connect your wallet on Sepolia.</li>
            <li>Place an encrypted bid — nobody (not even the contract) can read the amount.</li>
            <li>The contract computes the highest bid in FHE, fully encrypted.</li>
            <li>When the owner ends the auction, only the winner and the winning amount are revealed via public KMS decryption. Losing bids stay private forever.</li>
          </ol>
        </div>
      )}

      <div className="card">
        <h2>Item</h2>
        <div className="row">
          <span className="key">Name</span>
          <span className="val">{item.name || '…'}</span>
        </div>
        <div className="row">
          <span className="key">Description</span>
          <span className="val" style={{ maxWidth: '60%', textAlign: 'right' }}>
            {item.desc || '…'}
          </span>
        </div>
        <div className="row">
          <span className="key">Time remaining</span>
          <span className="val">{formatRemaining(remaining)}</span>
        </div>
        <div className="row">
          <span className="key">Status</span>
          <span className="val">
            {ended ? '🔓 Ended — winner is decryptable' : '🔒 Live — bids are encrypted'}
          </span>
        </div>
        <div className="row">
          <span className="key">Bidders</span>
          <span className="val">{bidders.length}</span>
        </div>
        <div className="row">
          <span className="key">Contract</span>
          <span className="val">
            <a
              href={`https://sepolia.etherscan.io/address/${CONTRACT_ADDRESS}`}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddr(CONTRACT_ADDRESS)} ↗
            </a>
          </span>
        </div>
      </div>

      {account && !ended && (
        <div className="card">
          <h2>Place encrypted bid</h2>
          <p className="muted">
            Bid amount is encrypted in your browser before being sent. Even the contract sees only ciphertext.
          </p>
          <div className="flex" style={{ marginTop: 12 }}>
            <input
              className="input grow"
              type="number"
              min="1"
              step="1"
              placeholder="e.g. 100"
              value={bidAmount}
              onChange={(e) => setBidAmount(e.target.value)}
              disabled={busy}
            />
            <button className="btn" onClick={placeBid} disabled={busy || !bidAmount}>
              {hasBid ? 'Update bid' : 'Place bid'}
            </button>
          </div>
          {hasBid && (
            <p className="muted" style={{ marginTop: 8 }}>
              ✓ You already bid. Re-bidding updates your stored amount; only bids strictly greater than the current sealed highest move the winner pointer.
            </p>
          )}
        </div>
      )}

      {account && isOwner && !ended && (
        <div className="card">
          <h2>Owner controls</h2>
          <p className="muted">
            End the auction early. After ending, the winner address and winning amount become publicly decryptable through the KMS — losing bids stay sealed.
          </p>
          <button className="btn btn-danger" onClick={endAuction} disabled={busy}>
            End auction now
          </button>
        </div>
      )}

      {ended && (
        <div className="card winner-card">
          <h2>🏆 Winner</h2>
          {!winnerLoaded ? (
            <>
              <p className="muted">
                The auction is over. Click below to fetch the encrypted winner from the contract and decrypt it via the KMS.
              </p>
              <button className="btn" onClick={revealWinner} disabled={busy}>
                Reveal winner
              </button>
            </>
          ) : (
            <>
              <div className="winner-amount">{winner.amount}</div>
              <div className="winner-addr">{winner.address}</div>
              <p className="muted" style={{ marginTop: 8 }}>
                Winning amount and address decrypted via FHEVM KMS public decryption. All other bids remain confidential.
              </p>
            </>
          )}
        </div>
      )}

      {bidders.length > 0 && (
        <div className="card">
          <h2>Bidders ({bidders.length})</h2>
          <div className="bid-list">
            {bidders.map((a) => (
              <div key={a}>
                {a.toLowerCase() === account.toLowerCase() ? (
                  <span className="you">{a} (you)</span>
                ) : (
                  a
                )}
              </div>
            ))}
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            Bid amounts are encrypted on-chain. Identities of bidders are public, but their bids are not.
          </p>
        </div>
      )}

      <div className={`status ${status.kind}`}>
        {status.text || (account ? 'Ready.' : 'Connect a wallet to start.')}
      </div>

      {account && (
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={refresh} disabled={busy}>
            Refresh
          </button>
        </div>
      )}

      <footer>
        Powered by{' '}
        <a href="https://docs.zama.ai" target="_blank" rel="noreferrer">
          Zama FHEVM
        </a>{' '}
        · Built with the{' '}
        <a
          href="https://github.com/sammy-XXIV/Fhevm-skill"
          target="_blank"
          rel="noreferrer"
        >
          Fhevm-skill
        </a>
      </footer>
    </div>
  );
}
