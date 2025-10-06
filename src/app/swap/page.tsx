'use client'

import { useState, useEffect } from 'react'
import { SwapTokens } from '@/components/amm/swap-tokens'
import { PoolListWithProps } from '@/components/amm/pool-list'
import { useWalletUi } from '@wallet-ui/react'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { address } from '@solana/addresses'
import { 
  deriveVaultAPDA, 
  deriveVaultBPDA, 
  derivePoolAuthPDA,
  deriveTokenAta
} from '@/components/amm/amm-utils'
import { fetchPool, getSwapTokenInstruction } from '../../../anchor/src/client/js/generated'
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, createSyncNativeInstruction, createCloseAccountInstruction } from '@solana/spl-token'
import { createTransaction, IInstruction, LAMPORTS_PER_SOL, signAndSendTransactionMessageWithSigners, getBase58Decoder } from 'gill'
import { fromLegacyTransactionInstruction } from '@/lib/utils'
import { useWalletUiSigner } from '@/components/solana/use-wallet-ui-signer'
import { AMM_PROGRAM_ID } from '@/components/amm/amm-data-access'

interface DetailedPoolInfo {
  address: string
  mintA?: string
  mintB?: string
  vaultABalance?: number
  vaultBBalance?: number
  vaultAAddress?: string
  vaultBAddress?: string
  TokenADecimal?: number
  TokenBDecimal?: number
  isLoading?: boolean
  error?: string
  feeBps?: number
  [key: string]: unknown
}

// Helper function to format token amounts
function formatTokenAmount(amount: number, decimals: number = 9): string {
  return (amount / Math.pow(10, decimals)).toFixed(4)
}

export default function SwapPage() {
  const { client, account } = useWalletUi()
  const [selectedPool, setSelectedPool] = useState('')
  const [swapFromTokenA, setSwapFromTokenA] = useState(true)
  const [swapAmount, setSwapAmount] = useState('')
  const [minimumAmountOut, setMinimumAmountOut] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [pools, setPools] = useState<DetailedPoolInfo[]>([])
  const [poolsLoading, setPoolsLoading] = useState(true)
  
  const rawSigner = useWalletUiSigner()
  const signer = account ? rawSigner : null
  
  // Get pool from URL params if available
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search)
      const poolParam = urlParams.get('pool')
      if (poolParam) {
        setSelectedPool(poolParam)
      }
    }
  }, [])

  // Fetch pools
  useEffect(() => {
    async function fetchPools() {
      if (!client?.rpc) {
        setPoolsLoading(false)
        return
      }

      try {
        const PROGRAM_ID = AMM_PROGRAM_ID
        const poolAccounts = await client.rpc.getProgramAccounts(address(PROGRAM_ID.toBase58()), { encoding: 'base64' }).send()
        
        const detailedPools = await Promise.all(
          poolAccounts.map(async (p) => {
            try {
              const poolData = await fetchPool(client.rpc, address(p.pubkey))
              const mintA = poolData.data.mintA
              const mintB = poolData.data.mintB

              const [vaultAAddress] = deriveVaultAPDA(new PublicKey(p.pubkey))
              const [vaultBAddress] = deriveVaultBPDA(new PublicKey(p.pubkey))

              let vaultABalance = 0
              let vaultBBalance = 0
              let TokenADecimal = 0
              let TokenBDecimal = 0

              try {
                const tokenBalanceA = await client.rpc.getTokenAccountBalance(address(vaultAAddress.toBase58())).send()
                vaultABalance = Number(tokenBalanceA.value.amount)
                TokenADecimal = Number(tokenBalanceA.value.decimals)
              } catch (e) {
                console.log('Could not fetch vault A balance:', e)
              }

              try {
                const tokenBalanceB = await client.rpc.getTokenAccountBalance(address(vaultBAddress.toBase58())).send()
                vaultBBalance = Number(tokenBalanceB.value.amount)
                TokenBDecimal = Number(tokenBalanceB.value.decimals)
              } catch (e) {
                console.log('Could not fetch vault B balance:', e)
              }

              return {
                address: p.pubkey,
                mintA,
                mintB,
                vaultABalance,
                vaultBBalance,
                vaultAAddress: vaultAAddress.toBase58(),
                vaultBAddress: vaultBAddress.toBase58(),
                TokenADecimal,
                TokenBDecimal,
                feeBps: poolData.data.feeBps,
                isLoading: false,
                ...p.account?.data
              } as DetailedPoolInfo
            } catch (error) {
              console.error(`Error fetching details for pool ${p.pubkey}:`, error)
              return {
                address: p.pubkey,
                isLoading: false,
                error: 'Failed to load pool details',
                ...p.account?.data
              } as DetailedPoolInfo
            }
          })
        )

        setPools(detailedPools)
      } catch (err) {
        console.error('Error fetching pools:', err)
      } finally {
        setPoolsLoading(false)
      }
    }

    fetchPools()
  }, [client])

  const handleSwap = async () => {
    if (!swapAmount || !selectedPool) {
      toast.error('Please provide swap amount and select a pool')
      return
    }

    if (!signer || !account || !client) {
      toast.error('Wallet not connected')
      return
    }

    const swapAmountNum = parseFloat(swapAmount)
    if (swapAmountNum <= 0) {
      toast.error('Swap amount must be greater than 0')
      return
    }

    setIsLoading(true)
    try {
      // Fetch pool data to get mint addresses
      const poolData = await fetchPool(client.rpc, address(selectedPool))
      const mintA = new PublicKey(poolData.data.mintA)
      const mintB = new PublicKey(poolData.data.mintB)

      console.log('Pool data:', poolData)

      // Derive vault addresses
      const [vaultA] = deriveVaultAPDA(new PublicKey(selectedPool))
      const [vaultB] = deriveVaultBPDA(new PublicKey(selectedPool))
      const [poolAuth] = derivePoolAuthPDA(new PublicKey(selectedPool))

      // Check if either token is WSOL
      const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112')
      const isMintAWSOL = mintA.equals(WSOL_MINT)
      const isMintBWSOL = mintB.equals(WSOL_MINT)

      const mintAData = await client.rpc.getTokenAccountBalance(address(vaultA.toBase58())).send();
      const mintBData = await client.rpc.getTokenAccountBalance(address(vaultB.toBase58())).send();

      // Get user token accounts
      const userAta_A = await deriveTokenAta(new PublicKey(account.publicKey), mintA)
      const userAta_B = await deriveTokenAta(new PublicKey(account.publicKey), mintB)

      const { value: latestBlockhash } = await client.rpc.getLatestBlockhash().send()
      const ix: IInstruction[] = []

      // Calculate swap amount in lamports
      const swapAmountLamports = swapAmountNum * (swapFromTokenA ? 10** mintAData.value.decimals : 10** mintBData.value.decimals)

      // Handle WSOL wrapping if needed for input token
      if (swapFromTokenA && isMintAWSOL) {
        // Wrapping SOL to WSOL for Token A
        let WsolBalance;
        try {
          WsolBalance = await client.rpc.getTokenAccountBalance(address(userAta_A.toBase58())).send()
          console.log('WSOL ATA already exists:', userAta_A.toBase58())
        } catch {
          // Create ATA if it doesn't exist
          const createAtaIx = createAssociatedTokenAccountInstruction(
            new PublicKey(account.publicKey),
            userAta_A,
            new PublicKey(account.publicKey),
            mintA
          )
          console.log('Creating ATA for Token A (WSOL):', userAta_A.toBase58())
          ix.push(fromLegacyTransactionInstruction(createAtaIx))
        }

        if(WsolBalance && Number(WsolBalance.value.amount) < swapAmountLamports){
          const wrapSolIx = SystemProgram.transfer({
            fromPubkey: new PublicKey(account.publicKey),
            toPubkey: userAta_A,
            lamports: swapAmountLamports-Number(WsolBalance.value.amount),
          });
          ix.push(fromLegacyTransactionInstruction(wrapSolIx));
        } else if (!WsolBalance) {
          // Transfer SOL to WSOL ATA (this automatically wraps it)
          const wrapSolIx = SystemProgram.transfer({
            fromPubkey: new PublicKey(account.publicKey),
            toPubkey: userAta_A,
            lamports: swapAmountLamports,
          })
          console.log('Wrapping SOL to WSOL, transfer instruction:', wrapSolIx)
          ix.push(fromLegacyTransactionInstruction(wrapSolIx))
        }

        // Sync native (converts SOL balance to WSOL tokens)
        const syncNativeIx = createSyncNativeInstruction(userAta_A, TOKEN_PROGRAM_ID)
        console.log('Syncing native for WSOL ATA:', syncNativeIx)
        ix.push(fromLegacyTransactionInstruction(syncNativeIx))
      } else if (!swapFromTokenA && isMintBWSOL) {
        // Wrapping SOL to WSOL for Token B
        let balance;
        try {
          balance = (await client.rpc.getTokenAccountBalance(address(userAta_B.toBase58())).send()).value.amount;
          console.log('WSOL ATA already exists:', userAta_B.toBase58())
        } catch {
          // Create ATA if it doesn't exist
          const createAtaIx = createAssociatedTokenAccountInstruction(
            new PublicKey(account.publicKey),
            userAta_B,
            new PublicKey(account.publicKey),
            mintB
          )
          console.log('Creating ATA for Token B (WSOL):', userAta_B.toBase58())
          ix.push(fromLegacyTransactionInstruction(createAtaIx))
        }
        // if (balance && parseInt(balance) < swapAmountLamports) {
          // Transfer SOL to WSOL ATA
          const wrapSolIx = SystemProgram.transfer({
            fromPubkey: new PublicKey(account.publicKey),
            toPubkey: userAta_B,
            lamports: swapAmountLamports,
          })
          console.log('Wrapping SOL to WSOL, transfer instruction:', swapAmountLamports)
          ix.push(fromLegacyTransactionInstruction(wrapSolIx))
        // }

        // Sync native
        const syncNativeIx = createSyncNativeInstruction(userAta_B, TOKEN_PROGRAM_ID)
        console.log('Syncing native for WSOL ATA:', syncNativeIx)
        ix.push(fromLegacyTransactionInstruction(syncNativeIx))
      }

      // Ensure ATAs exist for both tokens
      try {
        await client.rpc.getTokenAccountBalance(address(userAta_A.toBase58())).send()
        console.log('ATA for Token A exists:', userAta_A.toBase58())
      } catch {
        if (!isMintAWSOL || !swapFromTokenA) {
          const createAtaIx = createAssociatedTokenAccountInstruction(
            new PublicKey(account.publicKey),
            userAta_A,
            new PublicKey(account.publicKey),
            mintA
          )
          console.log('Creating ATA for Token A:', userAta_A.toBase58())
          ix.push(fromLegacyTransactionInstruction(createAtaIx))
        }
      }

      try {
        await client.rpc.getTokenAccountBalance(address(userAta_B.toBase58())).send()
      } catch {
        if (!isMintBWSOL || swapFromTokenA) {
          const createAtaIx = createAssociatedTokenAccountInstruction(
            new PublicKey(account.publicKey),
            userAta_B,
            new PublicKey(account.publicKey),
            mintB
          )
          console.log('Creating ATA for Token B:', userAta_B.toBase58())
          ix.push(fromLegacyTransactionInstruction(createAtaIx))
        }
      }

      // Calculate minimum amount out (with 1% slippage protection if not specified)
      let minAmountOut = 1 // Default minimum of 1 lamport
      if (minimumAmountOut) {
        minAmountOut = parseFloat(minimumAmountOut) * LAMPORTS_PER_SOL
      }

      console.log(vaultA.toBase58());
      console.log(vaultB.toBase58());
      console.log(userAta_A.toBase58());
      console.log(userAta_B.toBase58());
      // Create swap instruction
      if(swapFromTokenA){
        const swapInstruction = getSwapTokenInstruction({
          pool: address(selectedPool),
          signer: signer,
          vaultA: address(vaultA.toBase58()),
          vaultB: address(vaultB.toBase58()),
          userAtaA: address(userAta_A.toBase58()),
          userAtaB: address(userAta_B.toBase58()),
          poolAuth: address(poolAuth.toBase58()),
          tokenProgram: address(TOKEN_PROGRAM_ID.toBase58()),
          amountIn: swapAmountLamports,
          minimumOut: minAmountOut
        })
        ix.push(swapInstruction)
      }else{
        const swapInstruction = getSwapTokenInstruction({
          pool: address(selectedPool),
          signer: signer,
          vaultA: address(vaultB.toBase58()),
          vaultB: address(vaultA.toBase58()),
          userAtaA: address(userAta_B.toBase58()),
          userAtaB: address(userAta_A.toBase58()),
          poolAuth: address(poolAuth.toBase58()),
          tokenProgram: address(TOKEN_PROGRAM_ID.toBase58()),
          amountIn: swapAmountLamports,
          minimumOut: minAmountOut
        })
        ix.push(swapInstruction)
      }


      // Handle WSOL unwrapping if needed for output token
      if (swapFromTokenA && isMintBWSOL) {
        // Unwrapping WSOL back to SOL for Token B
        const syncNativeIx = createSyncNativeInstruction(userAta_B, TOKEN_PROGRAM_ID)
        console.log('Syncing native for WSOL ATA:', syncNativeIx)
        ix.push(fromLegacyTransactionInstruction(syncNativeIx))

        const closeAtaIx = createCloseAccountInstruction(
          userAta_B,
          new PublicKey(account.publicKey),
          new PublicKey(account.publicKey)
        )
        console.log('Closing WSOL ATA to unwrap to SOL:', closeAtaIx)
        ix.push(fromLegacyTransactionInstruction(closeAtaIx))
      } else if (!swapFromTokenA && isMintAWSOL) {
        // Unwrapping WSOL back to SOL for Token A
        const syncNativeIx = createSyncNativeInstruction(userAta_A, TOKEN_PROGRAM_ID)
        console.log('Syncing native for WSOL ATA:', syncNativeIx)
        ix.push(fromLegacyTransactionInstruction(syncNativeIx))

        const closeAtaIx = createCloseAccountInstruction(
          userAta_A,
          new PublicKey(account.publicKey),
          new PublicKey(account.publicKey)
        )
        console.log('Closing WSOL ATA to unwrap to SOL:', closeAtaIx)
        ix.push(fromLegacyTransactionInstruction(closeAtaIx))
      }

      // Create transaction
      const transaction = createTransaction({
        feePayer: signer,
        version: 'legacy',
        latestBlockhash,
        instructions: ix,
      })

      // Simulate transaction
      const simulation = await client.simulateTransaction(transaction)
      console.log('Swap simulation result:', simulation)
      console.log('Simulation logs:', simulation.value.logs)

      toast.info('Please confirm the transaction in your wallet...')

      // Send transaction
      const signature = await signAndSendTransactionMessageWithSigners(transaction)
      const decoder = getBase58Decoder()
      const sig58 = decoder.decode(signature)
      console.log('Swap transaction signature:', sig58)

      const fromToken = swapFromTokenA ? 'Token A' : 'Token B'
      const toToken = swapFromTokenA ? 'Token B' : 'Token A'
      
      toast.success(
        `Swap successful! ${swapAmount} ${fromToken} swapped for ${toToken}` + 
        (((swapFromTokenA && isMintBWSOL) || (!swapFromTokenA && isMintAWSOL)) ? ' (WSOL unwrapped to SOL)' : '')
      )
      
      console.log('Swap completed:', {
        selectedPool,
        swapAmount,
        swapFromTokenA,
        minimumAmountOut,
        wallet: account.publicKey,
        mintA: mintA.toBase58(),
        mintB: mintB.toBase58(),
        isMintAWSOL,
        isMintBWSOL,
        unwrappedToSOL: ((swapFromTokenA && isMintBWSOL) || (!swapFromTokenA && isMintAWSOL))
      })

      // Clear form
      setSwapAmount('')
      setMinimumAmountOut('')
    } catch (error) {
      console.error('Error swapping:', error)
      toast.error('Error swapping: ' + (error as Error).message)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="max-w-full mx-auto p-6 space-y-8">
      {/* Enhanced Navigation Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white dark:bg-gray-800 rounded-xl p-6 shadow-sm border border-gray-200 dark:border-gray-700">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-4">
          <Link href="/">
            <Button variant="outline" size="sm" className="w-full sm:w-auto">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to AMM
            </Button>
          </Link>
          <div className="w-full sm:w-auto">
            <h2 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
              🔄 Swap Tokens
            </h2>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              Trade tokens instantly with minimal slippage
            </p>
          </div>
        </div>
        
        {/* Swap Stats */}
        {/* <div className="flex gap-4">
          <div className="text-center">
            <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">0.3%</div>
            <div className="text-xs text-gray-500">Trading Fee</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">~0.5s</div>
            <div className="text-xs text-gray-500">Avg Settlement</div>
          </div>
        </div> */}
      </div>

      {/* Selected Pool Info */}
      {/* {selectedPool && (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-6 shadow-lg border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                💎 Selected Pool for Swap
              </h3>
              <p className="text-gray-600 dark:text-gray-400 font-mono">
                {selectedPool.slice(0, 8)}...{selectedPool.slice(-8)}
              </p>
            </div>
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => setSelectedPool('')}
            >
              Clear Selection
            </Button>
          </div>
        </div>
      )} */}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
        {/* Left - Swap Interface (Larger) */}
        <div className="lg:col-span-3">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="bg-white dark:bg-gray-800 p-6 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                🔄 Token Swap
                {!selectedPool && (
                  <span className="ml-auto text-xs bg-yellow-100 text-yellow-800 px-2 py-1 rounded-full border border-yellow-200">
                    Select Pool First
                  </span>
                )}
              </h2>
              <p className="text-gray-600 dark:text-gray-400 mt-1">
                Instant token exchange with automated market making
              </p>
            </div>
            
            <div className="p-6">
              {!selectedPool ? (
                <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                  <div className="text-6xl mb-4">🔍</div>
                  <h3 className="text-xl font-semibold mb-2">Select a Pool to Start Trading</h3>
                  <p>Choose a liquidity pool from the right panel to begin swapping tokens</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Trading Information */}
                  <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg border border-blue-200 dark:border-blue-800">
                    <h4 className="font-semibold text-blue-800 dark:text-blue-200 mb-2">💡 Trading Info</h4>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-blue-700 dark:text-blue-300">Trading Fee:</span>
                        <span className="font-bold ml-2">0.3%</span>
                      </div>
                      <div>
                        <span className="text-blue-700 dark:text-blue-300">Slippage:</span>
                        <span className="font-bold ml-2">0.5%</span>
                      </div>
                    </div>
                  </div>
                  
                  <SwapTokens 
                    selectedPool={selectedPool}
                    swapFromTokenA={swapFromTokenA}
                    swapAmount={swapAmount}
                    minimumAmountOut={minimumAmountOut}
                    onPoolChange={setSelectedPool}
                    onSwapDirectionChange={setSwapFromTokenA}
                    onSwapAmountChange={setSwapAmount}
                    onMinimumAmountOutChange={setMinimumAmountOut}
                    onSwap={handleSwap}
                    isLoading={isLoading}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right - Pool List (Smaller) */}
        <div className="lg:col-span-2">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden h-fit">
            <div className="bg-white dark:bg-gray-800 p-6 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                🏊‍♂️ Available Pools
              </h2>
              <p className="text-gray-600 dark:text-gray-400 mt-1">
                Select a pool to trade
              </p>
            </div>
            
            <div className="p-6">
              {poolsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="flex items-center gap-2 text-gray-500">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-500"></div>
                    Loading pools...
                  </div>
                </div>
              ) : (
                <PoolListWithProps 
                  pools={pools}
                  selectedPool={selectedPool}
                  onSelectPool={setSelectedPool}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}