
function makeErrorClass (name) {
  var constructor = function (message, data) {
    // Error.apply(this, [message]);
    this.message = message
    this.name = name
    this.stack = (new Error(message)).stack
    this.data = data
  }

  constructor.prototype = Object.create(Error.prototype)
  constructor.prototype.constructor = constructor

  constructor.assert = function (condition, message, data) {
    if (!condition) {
      throw new constructor(message || `Expected false == true`, data)
    }
  }
  constructor.assert.strictEqual = function (v1, v2, message, data) {
    if (v1 !== v2) {
      throw new constructor(message || `Expected ${v1} === ${v2}`, data)
    }
  }
  constructor.assert.strictNotEqual = function (v1, v2, message, data) {
    if (v1 === v2) {
      throw new constructor(message || `Expected ${v1} !== ${v2}`, data)
    }
  }

  return constructor
}

export var SecurityError = makeErrorClass('SecurityError')
export var TransactionError = makeErrorClass('TransactionError')
export var ChargeError = makeErrorClass('ChargeError')
export var RateLimitError = makeErrorClass('RateLimitError')
export var NotFoundError = makeErrorClass('NotFoundError')
export var InvalidArgumentError = makeErrorClass('InvalidArgumentError')
