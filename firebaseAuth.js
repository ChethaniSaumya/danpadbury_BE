// Firebase configuration and helper functions
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
// You'll need to add your Firebase service account key to your environment variables
let firebaseApp;

try {
  // Option 1: Using service account key file
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  
  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL // Optional: if using Realtime Database
  });
} catch (error) {
  console.error('Failed to initialize Firebase:', error);
  process.exit(1);
}

const db = admin.firestore();

// Collection names
const AUTHORIZED_WALLETS_COLLECTION = 'authorized_wallets';
const WALLET_MINT_COUNTS_COLLECTION = 'wallet_mint_counts';
const TIER_MINT_COUNTS_COLLECTION = 'tier_mint_counts';

// Configuration
const MAX_MINTS_PER_WALLET = 2;

/**
 * Check if a wallet address is authorized for minting
 * @param {string} walletAddress - The wallet address to check
 * @returns {Promise<boolean>} - True if wallet is authorized
 */
async function isWalletAuthorized(walletAddress) {
  try {
    const docRef = db.collection(AUTHORIZED_WALLETS_COLLECTION).doc(walletAddress);
    const doc = await docRef.get();
    
    if (!doc.exists) {
      console.log(`Wallet ${walletAddress} not found in authorized collection`);
      return false;
    }
    
    const data = doc.data();
    
    // Check if wallet authorization has expired
    if (data.expiresAt && data.expiresAt.toDate() < new Date()) {
      console.log(`Wallet ${walletAddress} authorization has expired`);
      return false;
    }
    
    // Check current mint count
    const currentMintCount = await getWalletMintCount(walletAddress);
    if (currentMintCount >= MAX_MINTS_PER_WALLET) {
      console.log(`Wallet ${walletAddress} has reached max mint limit (${currentMintCount}/${MAX_MINTS_PER_WALLET})`);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('Error checking wallet authorization:', error);
    return false;
  }
}

/**
 * Get the current mint count for a wallet
 * @param {string} walletAddress - The wallet address to check
 * @returns {Promise<number>} - Current mint count
 */
async function getWalletMintCount(walletAddress) {
  try {
    const docRef = db.collection(WALLET_MINT_COUNTS_COLLECTION).doc(walletAddress);
    const doc = await docRef.get();
    
    if (!doc.exists) {
      return 0;
    }
    
    return doc.data().mintCount || 0;
  } catch (error) {
    console.error('Error getting wallet mint count:', error);
    return 0;
  }
}

/**
 * Increment wallet mint count after successful mint
 * @param {string} walletAddress - The wallet address
 * @param {string} mintSignature - The transaction signature of the mint
 * @returns {Promise<number>} - New mint count
 */
async function incrementWalletMintCount(walletAddress, mintSignature) {
  try {
    const docRef = db.collection(WALLET_MINT_COUNTS_COLLECTION).doc(walletAddress);
    
    let newMintCount = 0;
    
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      
      if (!doc.exists) {
        // First mint for this wallet
        const walletData = {
          walletAddress: walletAddress,
          mintCount: 1,
          mintTransactions: [mintSignature],
          firstMintAt: admin.firestore.FieldValue.serverTimestamp(),
          lastMintAt: admin.firestore.FieldValue.serverTimestamp(),
          lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        };
        
        transaction.set(docRef, walletData);
        newMintCount = 1;
      } else {
        // Increment mint count
        const currentData = doc.data();
        const currentCount = currentData.mintCount || 0;
        const currentTransactions = currentData.mintTransactions || [];
        
        newMintCount = currentCount + 1;
        
        const updateData = {
          mintCount: newMintCount,
          mintTransactions: [...currentTransactions, mintSignature],
          lastMintAt: admin.firestore.FieldValue.serverTimestamp(),
          lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        };
        
        transaction.update(docRef, updateData);
      }
    });
    
    console.log(`Incremented mint count for wallet ${walletAddress} to ${newMintCount}`);
    return newMintCount;
  } catch (error) {
    console.error('Error incrementing wallet mint count:', error);
    throw error;
  }
}

/**
 * Get wallet mint status (count, transactions, etc.)
 * @param {string} walletAddress - The wallet address
 * @returns {Promise<Object>} - Wallet mint status
 */
async function getWalletMintStatus(walletAddress) {
  try {
    const docRef = db.collection(WALLET_MINT_COUNTS_COLLECTION).doc(walletAddress);
    const doc = await docRef.get();
    
    if (!doc.exists) {
      return {
        walletAddress: walletAddress,
        mintCount: 0,
        maxAllowed: MAX_MINTS_PER_WALLET,
        remaining: MAX_MINTS_PER_WALLET,
        mintTransactions: [],
        canMint: true
      };
    }
    
    const data = doc.data();
    const mintCount = data.mintCount || 0;
    
    return {
      walletAddress: walletAddress,
      mintCount: mintCount,
      maxAllowed: MAX_MINTS_PER_WALLET,
      remaining: Math.max(0, MAX_MINTS_PER_WALLET - mintCount),
      mintTransactions: data.mintTransactions || [],
      canMint: mintCount < MAX_MINTS_PER_WALLET,
      firstMintAt: data.firstMintAt,
      lastMintAt: data.lastMintAt
    };
  } catch (error) {
    console.error('Error getting wallet mint status:', error);
    throw error;
  }
}

/**
 * Get current mint count for a specific tier
 * @param {string} tierName - The name of the tier
 * @returns {Promise<number>} - Current mint count for the tier
 */
async function getTierMintCount(tierName) {
  try {
    const docRef = db.collection(TIER_MINT_COUNTS_COLLECTION).doc(tierName);
    const doc = await docRef.get();
    
    if (!doc.exists) {
      return 0;
    }
    
    return doc.data().mintCount || 0;
  } catch (error) {
    console.error('Error getting tier mint count:', error);
    return 0;
  }
}

/**
 * Increment tier mint count after successful mint
 * @param {string} tierName - The name of the tier
 * @param {string} mintSignature - The transaction signature
 * @param {string} walletAddress - The wallet that minted
 * @returns {Promise<number>} - New mint count for the tier
 */
async function incrementTierMintCount(tierName, mintSignature, walletAddress) {
  try {
    const docRef = db.collection(TIER_MINT_COUNTS_COLLECTION).doc(tierName);
    
    let newMintCount = 0;
    
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      
      if (!doc.exists) {
        // First mint for this tier
        const tierData = {
          tierName: tierName,
          mintCount: 1,
          mintTransactions: [{
            signature: mintSignature,
            wallet: walletAddress,
            timestamp: new Date() // Use regular Date object instead of serverTimestamp
          }],
          firstMintAt: admin.firestore.FieldValue.serverTimestamp(),
          lastMintAt: admin.firestore.FieldValue.serverTimestamp(),
          lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        };
        
        transaction.set(docRef, tierData);
        newMintCount = 1;
      } else {
        // Increment mint count
        const currentData = doc.data();
        const currentCount = currentData.mintCount || 0;
        const currentTransactions = currentData.mintTransactions || [];
        
        newMintCount = currentCount + 1;
        
        const updateData = {
          mintCount: newMintCount,
          mintTransactions: [...currentTransactions, {
            signature: mintSignature,
            wallet: walletAddress,
            timestamp: new Date() // Use regular Date object instead of serverTimestamp
          }],
          lastMintAt: admin.firestore.FieldValue.serverTimestamp(),
          lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        };
        
        transaction.update(docRef, updateData);
      }
    });
    
    console.log(`Incremented mint count for tier ${tierName} to ${newMintCount}`);
    return newMintCount;
  } catch (error) {
    console.error('Error incrementing tier mint count:', error);
    throw error;
  }
}

/**
 * Get tier statistics
 * @param {string} tierName - The name of the tier
 * @returns {Promise<Object>} - Tier statistics
 */
async function getTierStats(tierName) {
  try {
    const docRef = db.collection(TIER_MINT_COUNTS_COLLECTION).doc(tierName);
    const doc = await docRef.get();
    
    if (!doc.exists) {
      return {
        tierName: tierName,
        mintCount: 0,
        mintTransactions: [],
        firstMintAt: null,
        lastMintAt: null
      };
    }
    
    return {
      tierName: tierName,
      ...doc.data()
    };
  } catch (error) {
    console.error('Error getting tier stats:', error);
    throw error;
  }
}

/**
 * Add a wallet to the authorized collection
 * @param {string} walletAddress - The wallet address to authorize
 * @param {Object} options - Optional parameters
 * @returns {Promise<void>}
 */
async function addAuthorizedWallet(walletAddress, options = {}) {
  try {
    const docRef = db.collection(AUTHORIZED_WALLETS_COLLECTION).doc(walletAddress);
    
    const walletData = {
      walletAddress: walletAddress,
      addedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      ...options // Allow additional fields like expiresAt, etc.
    };
    
    await docRef.set(walletData);
    console.log(`Wallet ${walletAddress} added to authorized collection`);
  } catch (error) {
    console.error('Error adding authorized wallet:', error);
    throw error;
  }
}

/**
 * Get all authorized wallets (for admin purposes)
 * @param {boolean} includeUsed - Whether to include wallets that have reached max mints
 * @returns {Promise<Array>} - Array of wallet data
 */
async function getAuthorizedWallets(includeUsed = false) {
  try {
    const snapshot = await db.collection(AUTHORIZED_WALLETS_COLLECTION).get();
    const wallets = [];
    
    for (const doc of snapshot.docs) {
      const walletData = {
        id: doc.id,
        ...doc.data()
      };
      
      // Get mint count for this wallet
      const mintCount = await getWalletMintCount(doc.id);
      walletData.mintCount = mintCount;
      walletData.canMint = mintCount < MAX_MINTS_PER_WALLET;
      
      // Filter based on includeUsed parameter
      if (includeUsed || walletData.canMint) {
        wallets.push(walletData);
      }
    }
    
    return wallets;
  } catch (error) {
    console.error('Error getting authorized wallets:', error);
    throw error;
  }
}

/**
 * Remove a wallet from authorized collection entirely
 * @param {string} walletAddress - The wallet address to remove
 * @returns {Promise<void>}
 */
async function removeAuthorizedWallet(walletAddress) {
  try {
    const docRef = db.collection(AUTHORIZED_WALLETS_COLLECTION).doc(walletAddress);
    await docRef.delete();
    console.log(`Wallet ${walletAddress} removed from authorized collection`);
  } catch (error) {
    console.error('Error removing authorized wallet:', error);
    throw error;
  }
}

/**
 * Batch add multiple wallets to authorized collection
 * @param {Array<string>} walletAddresses - Array of wallet addresses
 * @param {Object} commonOptions - Common options for all wallets
 * @returns {Promise<void>}
 */
async function batchAddAuthorizedWallets(walletAddresses, commonOptions = {}) {
  try {
    const batch = db.batch();
    
    walletAddresses.forEach(walletAddress => {
      const docRef = db.collection(AUTHORIZED_WALLETS_COLLECTION).doc(walletAddress);
      const walletData = {
        walletAddress: walletAddress,
        addedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        ...commonOptions
      };
      batch.set(docRef, walletData);
    });
    
    await batch.commit();
    console.log(`Batch added ${walletAddresses.length} wallets to authorized collection`);
  } catch (error) {
    console.error('Error batch adding authorized wallets:', error);
    throw error;
  }
}

/**
 * Reset wallet mint count (admin function)
 * @param {string} walletAddress - The wallet address to reset
 * @returns {Promise<void>}
 */
async function resetWalletMintCount(walletAddress) {
  try {
    const docRef = db.collection(WALLET_MINT_COUNTS_COLLECTION).doc(walletAddress);
    await docRef.delete();
    console.log(`Reset mint count for wallet ${walletAddress}`);
  } catch (error) {
    console.error('Error resetting wallet mint count:', error);
    throw error;
  }
}

/**
 * Reset tier mint count (admin function)
 * @param {string} tierName - The tier name to reset
 * @returns {Promise<void>}
 */
async function resetTierMintCount(tierName) {
  try {
    const docRef = db.collection(TIER_MINT_COUNTS_COLLECTION).doc(tierName);
    await docRef.delete();
    console.log(`Reset mint count for tier ${tierName}`);
  } catch (error) {
    console.error('Error resetting tier mint count:', error);
    throw error;
  }
}

/**
 * Get statistics about minting
 * @returns {Promise<Object>} - Minting statistics
 */
async function getMintingStats() {
  try {
    const [authorizedSnapshot, mintCountSnapshot, tierCountSnapshot] = await Promise.all([
      db.collection(AUTHORIZED_WALLETS_COLLECTION).get(),
      db.collection(WALLET_MINT_COUNTS_COLLECTION).get(),
      db.collection(TIER_MINT_COUNTS_COLLECTION).get()
    ]);
    
    let totalMints = 0;
    let walletsWithMints = 0;
    let walletsAtMaxLimit = 0;
    
    mintCountSnapshot.forEach(doc => {
      const data = doc.data();
      const mintCount = data.mintCount || 0;
      totalMints += mintCount;
      
      if (mintCount > 0) {
        walletsWithMints++;
      }
      
      if (mintCount >= MAX_MINTS_PER_WALLET) {
        walletsAtMaxLimit++;
      }
    });
    
    const tierStats = {};
    tierCountSnapshot.forEach(doc => {
      const data = doc.data();
      tierStats[doc.id] = {
        tierName: doc.id,
        mintCount: data.mintCount || 0,
        firstMintAt: data.firstMintAt,
        lastMintAt: data.lastMintAt
      };
    });
    
    return {
      totalAuthorizedWallets: authorizedSnapshot.size,
      totalMints: totalMints,
      walletsWithMints: walletsWithMints,
      walletsAtMaxLimit: walletsAtMaxLimit,
      maxMintsPerWallet: MAX_MINTS_PER_WALLET,
      tierStats: tierStats
    };
  } catch (error) {
    console.error('Error getting minting stats:', error);
    throw error;
  }
}

/**
 * Get all tier statistics
 * @returns {Promise<Array>} - Array of tier statistics
 */
async function getAllTierStats() {
  try {
    const snapshot = await db.collection(TIER_MINT_COUNTS_COLLECTION).get();
    const tiers = [];
    
    snapshot.forEach(doc => {
      tiers.push({
        tierName: doc.id,
        ...doc.data()
      });
    });
    
    return tiers;
  } catch (error) {
    console.error('Error getting all tier stats:', error);
    throw error;
  }
}

// Legacy function - kept for backward compatibility but now uses mint count
async function markWalletAsUsed(walletAddress, mintSignature) {
  console.warn('markWalletAsUsed is deprecated. Use incrementWalletMintCount instead.');
  return await incrementWalletMintCount(walletAddress, mintSignature);
}

module.exports = {
  // Wallet functions
  isWalletAuthorized,
  getWalletMintCount,
  incrementWalletMintCount,
  getWalletMintStatus,
  resetWalletMintCount,
  
  // Tier functions
  getTierMintCount,
  incrementTierMintCount,
  getTierStats,
  resetTierMintCount,
  getAllTierStats,
  
  // Admin functions
  addAuthorizedWallet,
  getAuthorizedWallets,
  removeAuthorizedWallet,
  batchAddAuthorizedWallets,
  getMintingStats,
  
  // Legacy compatibility
  markWalletAsUsed,
  
  // Exports
  db, // Export db instance for custom queries if needed
  admin, // Export admin instance if needed
  MAX_MINTS_PER_WALLET // Export the constant
};