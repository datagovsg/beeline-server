import {Promotion} from './Promotion'
import assert from 'assert'
import _ from 'lodash'

/**
 * Extends the default Promotion by mandating the limitByRouteTags qualifying criteria
 */
export class RoutePass extends Promotion {
  constructor (transactionBuilder, params, options, description, promotionId, qualifiers) {
    assert.strictEqual(typeof params.tag, 'string', 'RoutePass requires a "tag" param')
    assert(params.tag, 'RoutePass promos must be associated with a tag')

    // Add a limit by route tags criterion
    var newParams = _.cloneDeep(params)
    newParams.qualifyingCriteria.push({
      type: 'limitByRouteTags',
      params: {
        tags: [params.tag]
      }
    })

    super(transactionBuilder, newParams, options, description, promotionId, qualifiers)
  }

  async preApplyHooks () {
    assert(!this.transactionBuilder.transactionItemsByType.ticketSale)
  }
}
