import BN from 'bn.js'

import { EthErc721Contract } from 'loom-js'
import { DEFAULT_GAS } from './config'

export class EthCardsContract extends EthErc721Contract {
  registerAsync(address: string): Promise<object> {
    return this.contract.methods.register().send({ from: address, gas: DEFAULT_GAS })
  }

  depositToPlasmaAsync(params: { tokenId: BN | number; from: string }): Promise<object> {
    const { tokenId, from } = params
    return this.contract.methods.depositToPlasma(tokenId).send({ from, gas: DEFAULT_GAS })
  }
}
