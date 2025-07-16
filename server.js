require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
const { keypairIdentity, publicKey, transactionBuilder, generateSigner } = require('@metaplex-foundation/umi');
const { mplTokenMetadata, createNft } = require('@metaplex-foundation/mpl-token-metadata');
const { setComputeUnitLimit } = require('@metaplex-foundation/mpl-toolbox');
const { Connection, SystemProgram, PublicKey, LAMPORTS_PER_SOL, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const { publicKey: UMIPublicKey, percentAmount } = require('@metaplex-foundation/umi');
const path = require('path');
const bodyParser = require('body-parser');
const axios = require('axios');
const helmet = require('helmet');
const upload = require('express-fileupload');
const morgan = require('morgan');
const txTracker = require('./helper/txTracker');
const { updateFileOnGitHub } = require('./githubHelper');
const firebaseAuth = require('./firebaseAuth'); // Import the Firebase helper functions

const fs = require('fs').promises;

// Path to the JSON file that will store mint IDs
const MINT_TRACKING_FILE = path.join(__dirname, 'mint-tracking.json');

const {
  createTree,
  mplBubblegum,
  fetchMerkleTree,
  fetchTreeConfigFromSeeds,
  verifyCollection,
  TokenProgramVersion,
  getAssetWithProof,
  findLeafAssetIdPda,
  LeafSchema,
  mintToCollectionV1,
  parseLeafFromMintToCollectionV1Transaction,
  setAndVerifyCollection
} = require('@metaplex-foundation/mpl-bubblegum');

// Create the Express app
const app = express();

// Environment variables
const preQuicknodeEndpoint1 = process.env.HELIUS_RPC1;
const preQuicknodeEndpoint2 = process.env.HELIUS_RPC2;
const rpcEndPoint = process.env.RPC_ENDPOINT;
const pricePerNFT = process.env.AMOUNT;
const merkleTreeLink = UMIPublicKey(process.env.MERKLE_TREE);
const collectionMint = UMIPublicKey(process.env.TOKEN_ADDRESS);
const AUTHORIZED_WALLET = process.env.AIRDROP_ADMIN_WALLET;
const WHITELIST_END_TIME = 1762513111;

const MAX_SUPPLY = 2500;

// Add this after line 34 (after WHITELIST_END_TIME)
PRICING_TIERS = [
  {
    name: "Space Cadet NFTs",
    startDate: new Date('2025-07-15T15:55:00Z').getTime() / 1000,
    endDate: new Date('2025-07-17T15:55:00Z').getTime() / 1000,
    maxSupply: 1000,
    priceSOL: 0.5,
    priceLamports: 0.5 * LAMPORTS_PER_SOL
  },
  {
    name: "Space Voyager NFTs",
    startDate: new Date('2025-07-17T16:00:00Z').getTime() / 1000,
    endDate: new Date('2025-07-18T15:55:00Z').getTime() / 1000,
    maxSupply: 1000,
    priceSOL: 1,
    priceLamports: 1 * LAMPORTS_PER_SOL
  },
  {
    name: "Space Explorer NFTs",
    startDate: new Date('2025-07-18T16:00:00Z').getTime() / 1000,
    endDate: new Date('2025-07-19T15:55:00Z').getTime() / 1000,
    maxSupply: 400,
    priceSOL: 5,
    priceLamports: 5 * LAMPORTS_PER_SOL
  },
  {
    name: "Space Pioneer NFTs",
    startDate: new Date('2025-07-19T16:00:00Z').getTime() / 1000,
    endDate: new Date('2025-07-20T16:00:00Z').getTime() / 1000,
    maxSupply: 100,
    priceSOL: 10,
    priceLamports: 10 * LAMPORTS_PER_SOL
  }
];

// Store connected SSE clients
const clients = [];

// Configure middleware
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// CORS setup
const corsOptions = {
  origin: ['https://mint.in2space.io',], // your frontend domain
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true, // if your frontend needs cookies or auth
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
//app.options('*', cors(corsOptions));

// Security and utility middleware
app.use(helmet());
app.use(upload());
app.use(morgan('combined'));

// SSE endpoint
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(': Connected\n\n');
  clients.push(res);

  req.on('close', () => {
    clients.splice(clients.indexOf(res), 1);
  });
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://mint.in2space.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});


// Health check endpoint
app.get('/api/', (req, res) => {
  console.log("Health check successful");
  res.send('successful');
});


// Setup Solana/UMI
const string_key = process.env.STRING_KEY;

const privateKey = convertPrivateKey(string_key)


function convertPrivateKey(base58PrivateKey) {


  // Decode the base58 private key to get the raw bytes
  const secretKey = bs58.decode(base58PrivateKey);

  // Create a keypair from the secret key
  const keypair = Keypair.fromSecretKey(secretKey);

  // Get the full keypair bytes (secret key + public key)
  const fullKeypair = new Uint8Array([...keypair.secretKey]);
  //console.log("Extracted KKKK ---- :" + Uint8Array.from(Array.from(fullKeypair)))
  return Uint8Array.from(Array.from(fullKeypair));
}


const umiKeypairz = {
  publicKey: UMIPublicKey(privateKey.slice(32, 64)),
  secretKey: privateKey
};

const quicknodeEndpoint = `${preQuicknodeEndpoint1}?api-key=${preQuicknodeEndpoint2}`;

const umi = createUmi(quicknodeEndpoint)
  .use(keypairIdentity(umiKeypairz))
  .use(mplTokenMetadata())
  .use(mplBubblegum());

// Helper function to get current mint count
async function getCurrentMintCount() {
  try {
    const treeAccount = await fetchMerkleTree(umi, merkleTreeLink);
    const currentCount = Number(treeAccount.tree.sequenceNumber);
    console.log("currentCount:", currentCount);
    return currentCount;
  } catch (error) {
    console.error("Error fetching mint count:", error);
    throw error;
  }
}

function getCurrentTier() {
  const currentTime = Math.floor(Date.now() / 1000);

  for (const tier of PRICING_TIERS) {

    console.log("Tier Name :" + tier.name);
    console.log("Tier Start Time :" + tier.startDate);
    console.log("Tier End Time :" + tier.endDate);

    if (currentTime >= tier.startDate && currentTime < tier.endDate) {
      return tier;
    }
  }

  return null; // No active tier
}

async function getTierMintedCount(tierName) {
  try {
    return await firebaseAuth.getTierMintCount(tierName);
  } catch (error) {
    console.error("Error fetching tier mint count:", error);
    return 0;
  }
}

const merkleTreeSigner = generateSigner(umi);

async function getTransactionAmount(txSignature) {
  const connection = new Connection(quicknodeEndpoint); // Use your RPC endpoint

  // Fetch the transaction
  const tx = await connection.getTransaction(txSignature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) {
    throw new Error('Transaction not found');
  }

  // Extract pre & post balances to compute the transfer amount
  const accountKeys = tx.transaction.message.accountKeys;
  const preBalances = tx.meta.preBalances;
  const postBalances = tx.meta.postBalances;

  // The sender is usually the first account (fee payer)
  const sender = accountKeys[0].toString();
  const senderPreBalance = preBalances[0];
  const senderPostBalance = postBalances[0];

  // The amount sent is the difference minus fees
  const fee = tx.meta.fee;
  const amountLamports = senderPreBalance - senderPostBalance - fee;
  const amountSOL = amountLamports / LAMPORTS_PER_SOL;

  return amountSOL;
}

async function loadMintTrackingData() {
  try {
    const data = await fs.readFile(MINT_TRACKING_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    // If file doesn't exist or has invalid JSON, create a new structure
    const initialData = {
      mintedIds: [],
      lastMintedId: -1  // -1 indicates no mints have occurred yet
    };

    // Write the initial structure to file
    await fs.writeFile(MINT_TRACKING_FILE, JSON.stringify(initialData, null, 2));
    return initialData;
  }
}

// Function to check if an ID has been minted
async function isIdMinted(id) {
  const trackingData = await loadMintTrackingData();
  return trackingData.mintedIds.includes(id);
}

// Function to get the next ID to mint
async function getNextMintId() {
  const trackingData = await loadMintTrackingData();
  return trackingData.lastMintedId + 1;
}

async function recordMintedId(id) {
  const trackingData = await loadMintTrackingData();

  // Add the ID to the array if it's not already there
  if (!trackingData.mintedIds.includes(id)) {
    trackingData.mintedIds.push(id);
  }

  // Update the last minted ID
  trackingData.lastMintedId = id;

  // Write the updated data back to the file
  const content = JSON.stringify(trackingData, null, 2);
  await fs.writeFile(MINT_TRACKING_FILE, content);

  // Update GitHub
  try {
    await updateFileOnGitHub(
      'mint-tracking.json',
      content,
      `Update mint tracking: NFT #${id}`
    );
  } catch (error) {
    console.error('Failed to update GitHub:', error);
    // Implement retry logic if needed
  }
}

app.get('/api/current-tier', async (req, res) => {
  try {
    const currentTier = getCurrentTier();

    if (!currentTier) {
      return res.json({
        success: true,
        activeTier: null,
        message: 'No active tier currently'
      });
    }

    const tierMintedCount = await getTierMintedCount(currentTier.name);
    const isSoldOut = tierMintedCount >= currentTier.maxSupply;

    res.json({
      success: true,
      activeTier: {
        name: currentTier.name,
        priceSOL: currentTier.priceSOL,
        maxSupply: currentTier.maxSupply,
        minted: tierMintedCount,
        remaining: Math.max(0, currentTier.maxSupply - tierMintedCount),
        startDate: currentTier.startDate,
        endDate: currentTier.endDate,
        isSoldOut: isSoldOut,
        status: isSoldOut ? 'sold_out' : 'active'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Mint endpoint
app.post('/api/mint', async (req, res) => {
  try {
    const { userWallet, paymentSignature } = req.body;

    console.log("Received mint request:", { userWallet, paymentSignature });

    const currentTier = getCurrentTier();
    if (!currentTier) {
      return res.status(410).json({
        success: false,
        error: {
          code: 'NO_ACTIVE_TIER',
          message: 'No NFT tier is currently active for minting',
          timestamp: new Date().toISOString()
        }
      });
    }

    // Check tier supply limit
    const tierMintedCount = await getTierMintedCount(currentTier.name);
    if (tierMintedCount >= currentTier.maxSupply) {
      return res.status(410).json({
        success: false,
        error: {
          code: 'TIER_SUPPLY_EXHAUSTED',
          message: `${currentTier.name} is sold out`,
          tierName: currentTier.name,
          maxSupply: currentTier.maxSupply,
          currentMinted: tierMintedCount,
          timestamp: new Date().toISOString(),
          resolution: 'This tier has reached its maximum supply limit'
        }
      });
    }


    // STEP 1: Check if wallet is authorized in Firebase
    const isAuthorized = await firebaseAuth.isWalletAuthorized(userWallet);
    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'WALLET_NOT_AUTHORIZED',
          message: 'This wallet address is not authorized for minting',
          wallet: userWallet,
          timestamp: new Date().toISOString(),
          resolution: 'Contact admin to get your wallet whitelisted'
        }
      });
    }

    // STEP 2: Verify payment amount
    const amount = await getTransactionAmount(paymentSignature);
    console.log(`Payment amount: ${amount} SOL`);

    if ((amount * LAMPORTS_PER_SOL) != currentTier.priceLamports) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_PAYMENT',
          message: 'Payment amount does not match required price for current tier',
          expected: currentTier.priceSOL,
          received: amount,
          currentTier: currentTier.name,
          txid: paymentSignature,
          timestamp: new Date().toISOString(),
          resolution: 'Send the correct amount and try again'
        }
      });
    }

    // STEP 3: Check for duplicate transactions
    if (txTracker.isTransactionProcessed(paymentSignature)) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'DUPLICATE_TRANSACTION',
          message: 'This transaction ID has already been used',
          txid: paymentSignature,
          timestamp: new Date().toISOString(),
          resolution: 'Please use a new, unique transaction'
        }
      });
    }

    // STEP 4: Verify transaction details
    try {
      const txnData = await getWalletAddressesFromTransaction(paymentSignature);
      console.log('Transaction data verified');
    } catch (err) {
      console.error('Failed to verify transaction:', err);
      return res.status(400).json({
        success: false,
        error: {
          code: 'TRANSACTION_VERIFICATION_FAILED',
          message: 'Could not verify the payment transaction',
          details: err.message
        }
      });
    }

    // STEP 5: Get next mint ID
    let nftNumber = await getNextMintId();

    if (await isIdMinted(nftNumber)) {
      console.error(`NFT ID ${nftNumber} has already been minted. Finding next available ID.`);
      while (await isIdMinted(nftNumber)) {
        nftNumber++;
      }
    }

    // STEP 6: Check supply limit
    if (nftNumber >= MAX_SUPPLY) {
      console.error('Max supply reached');
      return res.status(410).json({
        success: false,
        error: {
          code: 'MAX_SUPPLY_REACHED',
          message: 'Maximum NFT supply has been reached',
          maxSupply: MAX_SUPPLY,
          timestamp: new Date().toISOString(),
          resolution: 'Contact admin for refund'
        }
      });
    }

    // STEP 7: Mint the NFT
    const nftName = `In2space #${nftNumber.toString().padStart(4, '0')}`;
    console.log(`Minting NFT: ${nftName} (${nftNumber}) for authorized wallet: ${userWallet}`);

    const uintSig = await transactionBuilder()
      .add(setComputeUnitLimit(umi, { units: 800_000 }))
      .add(await mintToCollectionV1(umi, {
        leafOwner: UMIPublicKey(userWallet),
        merkleTree: merkleTreeLink,
        collectionMint: collectionMint,
        metadata: {
          name: nftName,
          symbol: 'In2space',
          uri: `https://bafybeibd3pjah5dbeoh76lwbbsnrr3imnjb6xoatvoaeoqwtpgh5mpkdk4.ipfs.w3s.link/${nftNumber}.json`,
          sellerFeeBasisPoints: 500,
          collection: {
            key: collectionMint,
            verified: true
          },
          creators: [{
            address: umi.identity.publicKey,
            verified: true,
            share: 100
          }],
        },
      }));

    const { signature: mintSignature } = await uintSig.sendAndConfirm(umi, {
      confirm: { commitment: "finalized" },
      send: {
        skipPreflight: true,
      }
    });

    const leaf = await parseLeafFromMintToCollectionV1Transaction(
      umi,
      mintSignature
    );

    const assetId = findLeafAssetIdPda(umi, {
      merkleTree: merkleTreeLink,
      leafIndex: leaf.nonce,
    })[0];

    console.log("NFT minted successfully:", {
      nftNumber,
      userWallet,
      mintSignature: mintSignature
    });

    // STEP 8: Update tracking systems
    await recordMintedId(nftNumber);
    txTracker.addProcessedTransaction(paymentSignature);

    // STEP 9: Mark wallet as used in Firebase (remove from authorized collection)
    // STEP 9: Increment wallet mint count in Firebase
    try {
      const newMintCount = await firebaseAuth.incrementWalletMintCount(userWallet, mintSignature);
      console.log(`Incremented mint count for wallet ${userWallet} to ${newMintCount}/${firebaseAuth.MAX_MINTS_PER_WALLET}`);

      // STEP 9.1: Increment tier mint count
      const newTierMintCount = await firebaseAuth.incrementTierMintCount(currentTier.name, mintSignature, userWallet);
      console.log(`Incremented tier mint count for ${currentTier.name} to ${newTierMintCount}/${currentTier.maxSupply}`);

    } catch (firebaseError) {
      console.error('Failed to update Firebase after successful mint:', firebaseError);
      // Note: We don't fail the mint if Firebase update fails, but log it for manual cleanup
    }

    // STEP 10: Send success response
    res.json({
      success: true,
      nftId: assetId,
      imageUrl: `https://bafybeiecq6fwutvn7z6ouqwlswltja76glqrdkxdov77djprjwmyekykfa.ipfs.w3s.link/${nftNumber}.png`,
      name: nftName,
      nftNumber: nftNumber,
      details: {
        paymentVerification: {
          sender: userWallet,
          recipient: umi.identity.publicKey,
          amount: pricePerNFT,
          transactionId: mintSignature
        },
        walletStatus: 'removed_from_authorized_list'
      }
    });

  } catch (error) {
    console.error('Mint error:', {
      error: error.message,
      stack: error.stack,
      body: req.body
    });

    res.status(500).json({
      success: false,
      error: error.message || 'Mint failed',
      details: error.details || null
    });
  }
});

app.post('/api/admin/wallets/add', async (req, res) => {
  try {
    const { walletAddresses, adminKey } = req.body;

    // Verify admin access
    if (adminKey !== process.env.ADMIN_SECRET_KEY) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized access'
      });
    }

    if (!walletAddresses || !Array.isArray(walletAddresses)) {
      return res.status(400).json({
        success: false,
        error: 'walletAddresses must be an array'
      });
    }

    // Add wallets to Firebase
    await firebaseAuth.batchAddAuthorizedWallets(walletAddresses);

    res.json({
      success: true,
      message: `Added ${walletAddresses.length} wallets to authorized collection`,
      addedWallets: walletAddresses
    });

  } catch (error) {
    console.error('Error adding authorized wallets:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/admin/wallets/remove', async (req, res) => {
  try {
    const { walletAddress, adminKey } = req.body;

    if (adminKey !== process.env.ADMIN_SECRET_KEY) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized access'
      });
    }

    await firebaseAuth.removeAuthorizedWallet(walletAddress);

    res.json({
      success: true,
      message: `Wallet ${walletAddress} removed from authorized collection`
    });

  } catch (error) {
    console.error('Error removing authorized wallet:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Admin endpoint to view authorized wallets
app.get('/api/admin/wallets', async (req, res) => {
  try {
    const { adminKey, includeUsed } = req.query;

    if (adminKey !== process.env.ADMIN_SECRET_KEY) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized access'
      });
    }

    const wallets = await firebaseAuth.getAuthorizedWallets(includeUsed === 'true');

    res.json({
      success: true,
      totalWallets: wallets.length,
      wallets: wallets
    });

  } catch (error) {
    console.error('Error fetching authorized wallets:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/wallet/check/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;

    const isAuthorized = await firebaseAuth.isWalletAuthorized(walletAddress);

    res.json({
      success: true,
      walletAddress: walletAddress,
      isAuthorized: isAuthorized,
      message: isAuthorized ? 'Wallet is authorized for minting' : 'Wallet is not authorized for minting'
    });

  } catch (error) {
    console.error('Error checking wallet authorization:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/airdrop', async (req, res) => {
  try {
    const { userWallet, nftId } = req.body;

    console.log("Received airdrop request_1:", { userWallet, nftId });

    // Authentication check - only allow the authorized wallet
    if (req.headers.authorization !== `Bearer ${AUTHORIZED_WALLET}`) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Unauthorized access to airdrop endpoint',
          timestamp: new Date().toISOString()
        }
      });
    }

    console.log("Received airdrop request_2:", { userWallet, nftId });

    // Validate inputs
    if (!userWallet || !nftId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Wallet address and NFT ID are required',
          timestamp: new Date().toISOString()
        }
      });
    }

    // Convert nftId to number if it's a string
    const nftNumber = typeof nftId === 'string' ? parseInt(nftId, 10) : nftId;

    // Validate NFT ID
    if (isNaN(nftNumber) || nftNumber < 0 || nftNumber >= 10000) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_NFT_ID',
          message: 'NFT ID must be a valid number between 0 and 9999',
          timestamp: new Date().toISOString()
        }
      });
    }

    // Check if NFT ID has already been minted
    if (await isIdMinted(nftNumber)) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'NFT_ALREADY_MINTED',
          message: `NFT ID ${nftNumber} has already been minted`,
          timestamp: new Date().toISOString()
        }
      });
    }

    // NFT MINTING PROCESS
    const nftName = `In2space #${nftNumber.toString().padStart(4, '0')}`;

    console.log(`Airdropping NFT: ${nftName} (${nftNumber})`);

    const uintSig = await transactionBuilder()
      .add(setComputeUnitLimit(umi, { units: 800_000 }))
      .add(await mintToCollectionV1(umi, {
        leafOwner: publicKey(userWallet),
        merkleTree: merkleTreeLink,
        collectionMint: collectionMint,
        metadata: {
          name: nftName,
          uri: `https://bafybeibd3pjah5dbeoh76lwbbsnrr3imnjb6xoatvoaeoqwtpgh5mpkdk4.ipfs.w3s.link/${nftNumber}.json`,
          sellerFeeBasisPoints: 500,
          collection: {
            key: collectionMint,
            verified: true
          },
          creators: [{
            address: umi.identity.publicKey,
            verified: true,
            share: 100
          }],
        },
      }));

    const { signature: mintSignature } = await uintSig.sendAndConfirm(umi, {
      confirm: { commitment: "finalized" },
      send: {
        skipPreflight: true,
      }
    });

    const leaf = await parseLeafFromMintToCollectionV1Transaction(
      umi,
      mintSignature
    );

    const assetId = findLeafAssetIdPda(umi, {
      merkleTree: merkleTreeLink,
      leafIndex: leaf.nonce,
    })[0];

    console.log("NFT airdropped successfully:", {
      nftNumber,
      userWallet,
      mintSignature: mintSignature
    });

    // Record the minted ID in our tracking system WITHOUT updating lastMintedId
    await recordAirdropMintedId(nftNumber);

    res.json({
      success: true,
      nftId: assetId,
      imageUrl: `https://bafybeiecq6fwutvn7z6ouqwlswltja76glqrdkxdov77djprjwmyekykfa.ipfs.w3s.link/${nftNumber}.png`,
      name: nftName,
      details: {
        airdropDetails: {
          recipient: userWallet,
          transactionId: mintSignature
        }
      }
    });
  } catch (error) {
    console.error('Airdrop error:', {
      error: error.message,
      stack: error.stack,
      body: req.body
    });

    res.status(500).json({
      success: false,
      error: error.message || 'Airdrop failed',
      details: error.details || null
    });
  }
});

async function recordAirdropMintedId(id) {
  const trackingData = await loadMintTrackingData();

  // Add the ID to the array if it's not already there
  if (!trackingData.mintedIds.includes(id)) {
    trackingData.mintedIds.push(id);
  }

  // Note: We do NOT update lastMintedId for airdrops

  // Write the updated data back to the file
  const content = JSON.stringify(trackingData, null, 2);
  await fs.writeFile(MINT_TRACKING_FILE, content);

  // Update GitHub
  try {
    await updateFileOnGitHub(
      'mint-tracking.json',
      content,
      `Airdrop update: NFT #${id}`
    );
  } catch (error) {
    console.error('Failed to update GitHub:', error);
    // Implement retry logic if needed
  }
}

app.post('/api/createMerkleTree', async (req, res) => {
  try {
    const builder = await createTree(umi, {
      merkleTree: merkleTreeSigner,
      maxDepth: 14,
      maxBufferSize: 64,
      public: false
    });

    await builder.sendAndConfirm(umi);

    // Store values globally
    treeCreator = umi.identity.publicKey.toString();
    treeSigner = merkleTreeSigner;
    treeAddress = merkleTreeSigner.publicKey.toString();

    console.log("Tree Creator:", treeCreator);
    console.log("Tree Signer:", treeSigner.publicKey.toString());
    console.log("Tree Address:", treeAddress);

    res.json({
      success: true,
      treeCreator: treeCreator,
      treeSigner: treeSigner,
      treeAddress: treeAddress
    });

  } catch (error) {
    console.error("Error creating Merkle Tree:", error);
  }
});

app.post('/api/createCollection', async (req, res) => {
  try {
    if (!umi) {
      return res.status(500).json({
        success: false,
        error: "UMI not initialized. Check environment variables."
      });
    }

    const collectionMint = generateSigner(umi);

    const response = await createNft(umi, {
      mint: collectionMint,
      name: `In2space`,
      symbol: 'In2space',
      uri: 'https://bafybeiewvzfhcvqogfjhl3qiz76c6ffl453krbmucfykanoeopw54e7k7a.ipfs.w3s.link/In2spaceCollection.json',
      sellerFeeBasisPoints: percentAmount(0),
      isCollection: true,
      updateAuthority: umi.identity,
    }).sendAndConfirm(umi);

    // Get the mint address (public key) of the collection
    const collectionMintAddress = collectionMint.publicKey.toString();

    // Handle signature conversion
    let signature;
    try {
      if (response.signature) {
        if (typeof response.signature === 'object' && response.signature !== null) {
          if (typeof response.signature.toString === 'function') {
            signature = response.signature.toString();
          } else {
            signature = bs58.encode(Buffer.from(response.signature));
          }
        } else {
          signature = String(response.signature);
        }
      } else {
        signature = 'Signature not available';
      }
    } catch (error) {
      console.error("Error converting signature:", error);
      signature = 'Error converting signature';
    }

    console.log("Collection created successfully:", {
      collectionMint: collectionMintAddress,
      transactionSignature: signature
    });

    res.json({
      success: true,
      collectionMint: collectionMintAddress,
      transactionSignature: signature
    });

  } catch (error) {
    console.error("Error creating collection:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create collection'
    });
  }
});

app.post('/api/mintToCollection', async (req, res) => {
  try {
    const uintSig = await transactionBuilder()
      .add(setComputeUnitLimit(umi, { units: 800_000 }))
      .add(await mintToCollectionV1(umi, {
        leafOwner: umi.identity.publicKey,
        merkleTree: merkleTreeLink,
        collectionMint: collectionMint, // This is your collection mint address
        metadata: {
          name: "In2space",
          symbol: 'In2space',
          uri: "https://bafybeiewvzfhcvqogfjhl3qiz76c6ffl453krbmucfykanoeopw54e7k7a.ipfs.w3s.link/In2spaceCollection.json",
          sellerFeeBasisPoints: 0,
          collection: { key: collectionMint, verified: true },
          creators: [
            { address: umi.identity.publicKey, verified: true, share: 100 },
          ],
        },
      }));

    const { signature } = await uintSig.sendAndConfirm(umi, {
      confirm: { commitment: "finalized" },
    });

    /*const txid = bs58.encode(Buffer.from(signature));
    const leaf = await parseLeafFromMintToCollectionV1Transaction(umi, signature);

    // Get the asset ID (equivalent to mint address for cNFTs)
    const assetId = findLeafAssetIdPda(umi, {
      merkleTree: merkleTreeLink,
      leafIndex: leaf.nonce,
    })[0];

    // Get the asset details
    const rpcAsset = await umi.rpc.getAsset(assetId);

    res.json({
      success: true,
      collectionMint: collectionMint.toString(), // The collection mint address
      nft: {
        assetId: assetId.toString(), // The cNFT identifier (similar to mint address)
        txid: txid, // Transaction ID
        leafIndex: leaf.nonce, // Position in the merkle tree
        metadataUri: rpcAsset.content.json_uri, // NFT metadata URI
        owner: rpcAsset.ownership.owner, // Current owner
        // Include any other relevant details from rpcAsset
      }
    });
*/

    console.log("signature : " + signature);

    res.json({
      success: true,
      signature: signature
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Minting failed'
    });
  }
});


// Helper function to get wallet addresses from transaction
async function getWalletAddressesFromTransaction(txnId) {
  try {
    const rpcUrl = rpcEndPoint;

    const response = await axios.post(rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [
        txnId,
        {
          encoding: 'jsonParsed',
          commitment: 'confirmed'
        }
      ]
    });

    if (response.data.error) {
      throw new Error(response.data.error.message);
    }

    const transaction = response.data.result;

    if (!transaction) {
      throw new Error('Transaction not found');
    }

    // Extract account information
    const accountKeys = transaction.transaction.message.accountKeys;

    // Get signer addresses
    const signers = accountKeys
      .filter(account => account.signer)
      .map(account => account.pubkey);

    // Get writable addresses
    const writableAccounts = accountKeys
      .filter(account => account.writable)
      .map(account => account.pubkey);

    return {
      allAddresses: accountKeys.map(account => account.pubkey),
      signers: signers,
      writableAccounts: writableAccounts,
      feePayer: accountKeys[0].pubkey,
      meta: transaction.meta
    };
  } catch (error) {
    console.error('Error fetching transaction:', error.message);
    throw error;
  }
}

// Add this new endpoint to your Express app for debugging

app.get('/api/debug/time-check', (req, res) => {
  const currentTime = Math.floor(Date.now() / 1000);
  const currentTier = getCurrentTier();
  
  // Get detailed info about all tiers
  const tierDetails = PRICING_TIERS.map(tier => {
    const isActive = currentTime >= tier.startDate && currentTime < tier.endDate;
    const timeUntilStart = tier.startDate - currentTime;
    const timeUntilEnd = tier.endDate - currentTime;
    
    return {
      name: tier.name,
      startDate: tier.startDate,
      endDate: tier.endDate,
      startDateISO: new Date(tier.startDate * 1000).toISOString(),
      endDateISO: new Date(tier.endDate * 1000).toISOString(),
      isActive,
      timeUntilStart: timeUntilStart > 0 ? timeUntilStart : null,
      timeUntilEnd: timeUntilEnd > 0 ? timeUntilEnd : null,
      status: isActive ? 'ACTIVE' : (timeUntilStart > 0 ? 'UPCOMING' : 'ENDED')
    };
  });
  
  res.json({
    success: true,
    serverTime: {
      unix: currentTime,
      iso: new Date(currentTime * 1000).toISOString(),
      utc: new Date().toUTCString(),
      local: new Date().toString()
    },
    activeTier: currentTier ? currentTier.name : null,
    allTiers: tierDetails,
    nextTier: tierDetails.find(t => t.timeUntilStart > 0),
    debug: {
      message: "Compare your device time with serverTime.iso",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }
  });
});

// Replace your existing /api/current-tier endpoint with this enhanced version

app.get('/api/current-tier', async (req, res) => {
  try {
    const currentTime = Math.floor(Date.now() / 1000);
    const currentTier = getCurrentTier();

    // Add cache-busting headers
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    if (!currentTier) {
      // Find the next upcoming tier
      const nextTier = PRICING_TIERS.find(tier => tier.startDate > currentTime);
      
      return res.json({
        success: true,
        activeTier: null,
        message: 'No active tier currently',
        serverTime: {
          unix: currentTime,
          iso: new Date(currentTime * 1000).toISOString()
        },
        nextTier: nextTier ? {
          name: nextTier.name,
          startsIn: nextTier.startDate - currentTime,
          startTime: new Date(nextTier.startDate * 1000).toISOString()
        } : null,
        debug: {
          allTiersStatus: PRICING_TIERS.map(tier => ({
            name: tier.name,
            active: currentTime >= tier.startDate && currentTime < tier.endDate,
            startTime: new Date(tier.startDate * 1000).toISOString(),
            endTime: new Date(tier.endDate * 1000).toISOString()
          }))
        }
      });
    }

    const tierMintedCount = await getTierMintedCount(currentTier.name);
    const isSoldOut = tierMintedCount >= currentTier.maxSupply;

    res.json({
      success: true,
      activeTier: {
        name: currentTier.name,
        priceSOL: currentTier.priceSOL,
        maxSupply: currentTier.maxSupply,
        minted: tierMintedCount,
        remaining: Math.max(0, currentTier.maxSupply - tierMintedCount),
        startDate: currentTier.startDate,
        endDate: currentTier.endDate,
        startTime: new Date(currentTier.startDate * 1000).toISOString(),
        endTime: new Date(currentTier.endDate * 1000).toISOString(),
        isSoldOut: isSoldOut,
        status: isSoldOut ? 'sold_out' : 'active',
        timeRemaining: currentTier.endDate - currentTime
      },
      serverTime: {
        unix: currentTime,
        iso: new Date(currentTime * 1000).toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      serverTime: {
        unix: Math.floor(Date.now() / 1000),
        iso: new Date().toISOString()
      }
    });
  }
});
//--------------------------- verify cNFT Collection ---------------------------------//


app.post('/api/parentNFTVerify', async (req, res) => {
  try {
    const parentNftMint = new licKey('73itZp41Td5nj8z2AnQhGmbequoqtPNXvjxbDw1hj3Rn');
    const updateAuthority = new PublicKey('4mGCSmGmfAfq7uvLpV39uQRTLuveGX2EHk6iuN38YRLn');

    console.log('Attempting to verify parent NFT as collection...');
    console.log(`Parent NFT mint: ${parentNftMint.toString()}`);
    console.log(`Update authority: ${updateAuthority.toString()}`);

    const transaction = await verifyCollection(umi, {
      mint: parentNftMint,
      collectionAuthority: updateAuthority,
      isDelegated: false,
    }).sendAndConfirm(umi);

    console.log('Collection verification successful');
    console.log('Transaction signature:', transaction.signature.toString());

    return res.status(200).json({
      success: true,
      message: 'Parent NFT successfully verified as collection',
      transactionSignature: transaction.signature.toString()
    });
  } catch (err) {
    console.error('Error verifying parent NFT as collection:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to verify parent NFT as collection',
      error: err.message
    });
  }
});

app.post('/api/verifyCNFTCollection', async (req, res) => {
  try {
    const { leafIndex } = req.body;

    // Input validation
    if (leafIndex === undefined) {
      console.warn('[verifyCNFTCollection] ❗ Missing leafIndex in request body');
      return res.status(400).json({
        success: false,
        error: 'Leaf index is required'
      });
    }

    console.log(`[verifyCNFTCollection] 🔍 Starting verification for leafIndex: ${leafIndex}`);

    // Step 1: Find Asset ID PDA
    const assetIdPubkey = findLeafAssetIdPda(umi, {
      merkleTree: merkleTreeLink,
      leafIndex: leafIndex
    })[0];
    console.log(`[verifyCNFTCollection] 🧩 Asset ID derived: ${assetIdPubkey}`);

    // Step 2: Get asset with proof
    console.log('[verifyCNFTCollection] 📦 Fetching asset with proof...');
    const assetWithProof = await getAssetWithProof(umi, assetIdPubkey, {
      truncateCanopy: true
    });

    console.log('[verifyCNFTCollection] 🔍 assetWithProof:', JSON.stringify(assetWithProof, null, 2));
    console.log('[verifyCNFTCollection] ✅ Asset with proof fetched');

    // Step 3: Build verification transaction
    console.log('[verifyCNFTCollection] 🛠️ Building verification transaction...');
    const verificationBuilder = verifyCollection(umi, {
      ...assetWithProof,
      collectionMint: collectionMint,
      collectionAuthority: umi.identity,
    });

    // Step 4: Attempt transaction without LUT
    console.log('[verifyCNFTCollection] 📤 Sending verification transaction without LUT...');
    try {
      const transaction = await verificationBuilder.sendAndConfirm(umi);
      console.log(`[verifyCNFTCollection] ✅ Verification successful without LUT. Signature: ${transaction.signature}`);

      return res.status(200).json({
        success: true,
        message: 'cNFT collection verification successful (without LUT)',
        signature: transaction.signature
      });
    } catch (err) {
      if (!err.message.includes('too large')) throw err;
      console.warn('[verifyCNFTCollection] ⚠️ Transaction too large. Will attempt with LUT optimization...');
    }

    // Step 5: Use LUT optimization
    console.log('[verifyCNFTCollection] 🧠 Creating LUT for optimization...');
    const recentSlot = await umi.rpc.getSlot({ commitment: 'finalized' });
    const [createLutBuilders, lutAccounts] = createLutForTransactionBuilder(
      umi,
      verificationBuilder,
      recentSlot
    );

    if (createLutBuilders.length > 0) {
      console.log(`[verifyCNFTCollection] ➕ Creating ${createLutBuilders.length} LUT(s)...`);
      for (const createLutBuilder of createLutBuilders) {
        const sig = await createLutBuilder.sendAndConfirm(umi);
        console.log(`[verifyCNFTCollection] ✅ LUT created. Signature: ${sig.signature}`);
      }
    } else {
      console.log('[verifyCNFTCollection] 🟢 No additional LUTs needed');
    }

    // Step 6: Resend with LUTs
    console.log('[verifyCNFTCollection] 📤 Sending verification transaction with LUT...');
    const verificationSignature = await verificationBuilder
      .setAddressLookupTables(lutAccounts)
      .sendAndConfirm(umi);

    console.log(`[verifyCNFTCollection] ✅ Verification successful with LUT. Signature: ${verificationSignature.signature}`);

    return res.status(200).json({
      success: true,
      message: 'cNFT collection verification successful (with LUT)',
      signature: verificationSignature.signature,
      lutAccounts: lutAccounts.map(a => a.toBase58())
    });

  } catch (error) {
    console.error('[verifyCNFTCollection] ❌ Error verifying cNFT collection:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Unknown error occurred'
    });
  }
});

//--------------------------- verify cNFT Collection ---------------------------------//

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start the server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
