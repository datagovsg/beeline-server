const assert = require('assert')

export default class ModelCache {

  constructor (db) {
    this.db = db // the sequelize database connection
    this.models = {}
    this.syncTasks = []
    this.postSyncTasks = []
    this.makeAssociationFunctions = []
  }

  require (modelName) {
    // model has been created before
    if (this.models[modelName]) {
      return this.models[modelName]
    }
    if (this.models[modelName] === false) {
      throw new Error("Cyclic dependency!")
    }

    // not created before
    // set to false -- cyclic dependency check
    this.models[modelName] = false
    var modelModule = require('../models/' + modelName)
    var modelDefinition = modelModule.default
    var model = modelDefinition(this)

    // ensure model is a well-defined object
    assert(model)
    this.models[modelName] = model

    // do not sync if dontSync == true
    // used for views
    if (!modelModule.dontSync) {
      this.syncTasks.push((t) => model.sync({transaction: t}))
    }

    // if the module wants a post-sync function
    if (modelModule.postSync) {
      this.postSyncTasks = this.postSyncTasks.concat(modelModule.postSync)
    }

    // make association functions
    if (modelModule.makeAssociation) {
      this.makeAssociationFunctions.push(modelModule.makeAssociation)
    }
  }

  /**
  Negates DECIMAL types as well as Number types
  **/
  neg (decimalValue) {
    if (decimalValue == null) { return null }

    if (typeof decimalValue === 'number') {
      return -decimalValue
    } else {
      if (decimalValue.startsWith('-')) {
        return decimalValue.substr(1)
      } else {
        return '-' + decimalValue
      }
    }
  }

  makeAssociations () {
    for (let assocFn of this.makeAssociationFunctions) {
      assocFn(this)
    }
  }

}
