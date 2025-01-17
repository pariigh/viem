import {
  type ReadContractErrorType,
  readContract,
} from '../../../actions/public/readContract.js'
import type { Client } from '../../../clients/createClient.js'
import type { Transport } from '../../../clients/transports/createTransport.js'
import { ContractFunctionRevertedError } from '../../../errors/contract.js'
import type { ErrorType } from '../../../errors/utils.js'
import type { Account } from '../../../types/account.js'
import type {
  Chain,
  DeriveChain,
  GetChainParameter,
} from '../../../types/chain.js'
import type { TransactionReceipt } from '../../../types/transaction.js'
import { portalAbi } from '../abis.js'
import { ReceiptContainsNoWithdrawalsError } from '../errors/withdrawal.js'
import type { GetContractAddressParameter } from '../types/contract.js'
import {
  type GetWithdrawalsErrorType,
  getWithdrawals,
} from '../utils/getWithdrawals.js'
import { type GetL2OutputErrorType, getL2Output } from './getL2Output.js'
import {
  type GetTimeToFinalizeErrorType,
  getTimeToFinalize,
} from './getTimeToFinalize.js'

export type GetWithdrawalStatusParameters<
  chain extends Chain | undefined = Chain | undefined,
  chainOverride extends Chain | undefined = Chain | undefined,
  _derivedChain extends Chain | undefined = DeriveChain<chain, chainOverride>,
> = GetChainParameter<chain, chainOverride> &
  GetContractAddressParameter<_derivedChain, 'l2OutputOracle' | 'portal'> & {
    receipt: TransactionReceipt
  }
export type GetWithdrawalStatusReturnType =
  | 'waiting-to-prove'
  | 'ready-to-prove'
  | 'waiting-to-finalize'
  | 'ready-to-finalize'
  | 'finalized'
export type GetWithdrawalStatusErrorType =
  | GetL2OutputErrorType
  | GetTimeToFinalizeErrorType
  | GetWithdrawalsErrorType
  | ReadContractErrorType
  | ErrorType

/**
 * Returns the current status of a withdrawal. Used for the [Withdrawal](/op-stack/guides/withdrawals.html) flow.
 *
 * - Docs: https://viem.sh/op-stack/actions/getWithdrawalStatus.html
 *
 * @param client - Client to use
 * @param parameters - {@link GetWithdrawalStatusParameters}
 * @returns Status of the withdrawal. {@link GetWithdrawalStatusReturnType}
 *
 * @example
 * import { createPublicClient, http } from 'viem'
 * import { getBlockNumber } from 'viem/actions'
 * import { mainnet, optimism } from 'viem/chains'
 * import { getWithdrawalStatus } from 'viem/op-stack'
 *
 * const publicClientL1 = createPublicClient({
 *   chain: mainnet,
 *   transport: http(),
 * })
 * const publicClientL2 = createPublicClient({
 *   chain: optimism,
 *   transport: http(),
 * })
 *
 * const receipt = await publicClientL2.getTransactionReceipt({ hash: '0x...' })
 * const status = await getWithdrawalStatus(publicClientL1, {
 *   receipt,
 *   targetChain: optimism
 * })
 */
export async function getWithdrawalStatus<
  chain extends Chain | undefined,
  account extends Account | undefined,
  chainOverride extends Chain | undefined = undefined,
>(
  client: Client<Transport, chain, account>,
  parameters: GetWithdrawalStatusParameters<chain, chainOverride>,
): Promise<GetWithdrawalStatusReturnType> {
  const { chain = client.chain, receipt, targetChain } = parameters

  const portalAddress = (() => {
    if (parameters.portalAddress) return parameters.portalAddress
    if (chain) return targetChain!.contracts.portal[chain.id].address
    return Object.values(targetChain!.contracts.portal)[0].address
  })()

  const [withdrawal] = getWithdrawals(receipt)

  if (!withdrawal)
    throw new ReceiptContainsNoWithdrawalsError({
      hash: receipt.transactionHash,
    })

  const [outputResult, proveResult, finalizedResult, timeToFinalizeResult] =
    await Promise.allSettled([
      getL2Output(client, {
        ...parameters,
        l2BlockNumber: receipt.blockNumber,
      }),
      readContract(client, {
        abi: portalAbi,
        address: portalAddress,
        functionName: 'provenWithdrawals',
        args: [withdrawal.withdrawalHash],
      }),
      readContract(client, {
        abi: portalAbi,
        address: portalAddress,
        functionName: 'finalizedWithdrawals',
        args: [withdrawal.withdrawalHash],
      }),
      getTimeToFinalize(client, {
        ...parameters,
        withdrawalHash: withdrawal.withdrawalHash,
      }),
    ])

  // If the L2 Output is not processed yet (ie. the actions throws), this means
  // that the withdrawal is not ready to prove.
  if (outputResult.status === 'rejected') {
    const error = outputResult.reason as GetL2OutputErrorType
    if (
      error.cause instanceof ContractFunctionRevertedError &&
      error.cause.data?.args?.[0] ===
        'L2OutputOracle: cannot get output for a block that has not been proposed'
    )
      return 'waiting-to-prove'
    throw error
  }
  if (proveResult.status === 'rejected') throw proveResult.reason
  if (finalizedResult.status === 'rejected') throw finalizedResult.reason
  if (timeToFinalizeResult.status === 'rejected')
    throw timeToFinalizeResult.reason

  const [_, proveTimestamp] = proveResult.value
  if (!proveTimestamp) return 'ready-to-prove'

  const finalized = finalizedResult.value
  if (finalized) return 'finalized'

  const { seconds } = timeToFinalizeResult.value
  return seconds > 0 ? 'waiting-to-finalize' : 'ready-to-finalize'
}
