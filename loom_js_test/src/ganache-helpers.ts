import Web3 from 'web3'
import BN from 'bn.js'

/**
 * @returns The time of the last mined block in seconds.
 */
export async function latestBlockTime(web3: Web3): Promise<number> {
  const block = await web3.eth.getBlock('latest')
  return block.timestamp
}

function sendAsync<T>(web3: Web3, method: string, id: number, params?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    web3.currentProvider.send(
      {
        jsonrpc: '2.0',
        method,
        params,
        id
      },
      (error, response) => {
        if (error) {
          reject(error)
        } else {
          resolve(response.result)
        }
      }
    )
  })
}

export async function increaseTime(web3: Web3, duration: number): Promise<void> {
  const id = Date.now()
  const adj = await sendAsync<number>(web3, 'evm_increaseTime', id, [duration])
  return sendAsync<void>(web3, 'evm_mine', id + 1)
}

/**
 * Beware that due to the need of calling two separate ganache methods and rpc calls overhead
 * it's hard to increase time precisely to a target point so design your test to tolerate
 * small fluctuations from time to time.
 *
 * @param target Time in seconds
 */
export async function increaseTimeTo(web3: Web3, target: number) {
  const now = await latestBlockTime(web3)
  if (target < now) {
    throw Error(`Cannot increase current time (${now}) to a moment in the past (${target})`)
  }
  let diff = target - now
  increaseTime(web3, diff)
}

/**
 * Retrieves the ETH balance of a particular Ethereum address.
 *
 * @param address Hex-encoded Ethereum address.
 */
export async function getEthBalanceAtAddress(web3: Web3, address: string): Promise<BN> {
  const balance = await web3.eth.getBalance(address)
  return new BN(balance)
}
