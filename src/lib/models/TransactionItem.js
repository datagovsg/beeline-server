/* eslint-disable new-cap */
import _ from "lodash"
export default modelCache => {
  let DataTypes = modelCache.db.Sequelize
  return modelCache.db.define(
    "transactionItem",
    {
      transactionId: {
        type: DataTypes.INTEGER,
      },
      itemType: {
        type: DataTypes.STRING(20),
        allowNull: false,
        validate: {
          isIn: {
            args: [
              [
                "ticketRefund",
                "referralCredits",
                "payment",
                "refundPayment",
                "account",
                "routePass",
                "routeCredits",
                "userCredit",
                "ticketSale",
                "ticketExpense",
                "discount",
                "transfer",
                "payables",
              ],
            ],
            msg: "Invalid transactionItem type",
          },
        },
        /** One of...
        Payment,
        Ticket,
        (future) Voucher,
        (future) Credit,
      **/
      },
      itemId: {
        type: DataTypes.INTEGER,
        // allowNull: false, // sequelize doesn't support adding child item first
        /** Can reference
        payments.id if item_type == 'Payment',
        **/
      },
      notes: DataTypes.JSONB,
      debit: DataTypes.DECIMAL(10, 2),
      /* Store credit/debit in the same column, but in opposite sign */
      credit: {
        type: DataTypes.VIRTUAL,
        set: function(val) {
          this.setDataValue("debit", modelCache.neg(val))
        },
        get: function() {
          let v = this.getDataValue("debit")
          return modelCache.neg(v)
        },
      },
      // Sequelize 3.24 just broke DECIMAL types
      // by returning strings instead of numbers
      debitF: {
        type: DataTypes.VIRTUAL,
        set: function(val) {
          this.setDataValue("debit", val)
        },
        get: function() {
          let v = this.getDataValue("debit")
          return v == null ? null : parseFloat(v)
        },
      },
      creditF: {
        type: DataTypes.VIRTUAL,
        set: function(val) {
          this.setDataValue("debit", modelCache.neg(val))
        },
        get: function() {
          let v = this.getDataValue("debit")
          return v == null ? null : parseFloat(modelCache.neg(v))
        },
      },
    },
    {
      indexes: [
        { fields: ["itemType", "itemId"] }, /* Necessary for reverse lookup */
      ],
      classMethods: {
        /**
         * Manually pulls all the payments, transactions, what-have-you associations
         * @param {array} inst - an array of transaction items
         * @param {object} associationOptions - options specific to each association type
         * @param {object} options - global options when finding associations
         * @return {array} inst
         */
        async getAssociatedItems(inst, associationOptions, options) {
          if (!(inst instanceof Array)) {
            inst = [inst]
          }
          // group by item type
          let instsByItemType = _.groupBy(inst, i => i.itemType)

          let simulatedInclude = []
          let simulatedIncludeNames = []

          // for each association....
          let promises = []
          for (let association in this.associations) {
            // only the belongs-to relationships
            if (this.associations[association].foreignKey !== "itemId") {
              continue
            }

            // Need to do these stuff to allow toJSON to work correctly
            simulatedInclude.push({
              model: this.associations[association].target,
              as: association,
            })
            simulatedIncludeNames.push(association)

            // no item requested
            if (!instsByItemType[association]) {
              continue
            }

            // pull the item ids
            let itemIds = instsByItemType[association].map(item => item.itemId)

            // query by the item ids
            let findPromise = this.associations[association].target
              .findAll(
                _.assign(
                  {
                    where: _.fromPairs([
                      [
                        this.associations[association].target
                          .primaryKeyAttribute,
                        { $in: itemIds },
                      ],
                    ]),
                  },
                  options,
                  associationOptions && associationOptions[association]
                )
              )
              .then(results => {
                // create the association
                let resultsById = _.keyBy(results, r => r.id)

                for (let item of instsByItemType[association]) {
                  // a sequelize instance
                  if (item.dataValues) {
                    item.dataValues[association] =
                      resultsById[item.itemId] || null

                    // Hack to make toJSON() succeed
                    item.$options.include = item.$options.include || []
                    item.$options.include = item.$options.include.concat(
                      simulatedInclude
                    )
                    item.$options.includeNames =
                      item.$options.includeNames || []
                    item.$options.includeNames = item.$options.includeNames.concat(
                      simulatedIncludeNames
                    )

                    //
                    item[association] = resultsById[item.itemId] || null
                  } else {
                    item[association] =
                      resultsById[item.itemId].toJSON() || null
                  }
                }
              })
            promises.push(findPromise)
          }

          await Promise.all(promises)
          return inst
        },
      },
    }
  )
}

export const makeAssociation = function makeAssociation(modelCache) {
  let TransactionItem = modelCache.require("TransactionItem")
  let Transaction = modelCache.require("Transaction")
  let Account = modelCache.require("Account")
  let Payment = modelCache.require("Payment")
  let RefundPayment = modelCache.require("RefundPayment")
  let Discount = modelCache.require("Discount")
  let Transfer = modelCache.require("Transfer")
  let Ticket = modelCache.require("Ticket")
  let Credit = modelCache.require("Credit")
  let ReferralCredit = modelCache.require("ReferralCredit")
  let RouteCredit = modelCache.require("RouteCredit")
  let RoutePass = modelCache.require("RoutePass")
  TransactionItem.belongsTo(Transaction, {
    foreignKey: "transactionId",
  })
  // all 7 below no check becos constriant: false, but can read by getXXX
  TransactionItem.belongsTo(Account, {
    foreignKey: "itemId",
    constraints: false,
    as: "account",
  })
  TransactionItem.belongsTo(Payment, {
    foreignKey: "itemId",
    constraints: false,
    as: "payment",
  })
  TransactionItem.belongsTo(RefundPayment, {
    foreignKey: "itemId",
    constraints: false,
    as: "refundPayment",
  })
  TransactionItem.belongsTo(Discount, {
    foreignKey: "itemId",
    constraints: false,
    as: "discount",
  })
  TransactionItem.belongsTo(Transfer, {
    foreignKey: "itemId",
    constraints: false,
    as: "transfer",
  })
  TransactionItem.belongsTo(Ticket, {
    foreignKey: "itemId",
    constraints: false,
    as: "ticketSale",
  })
  TransactionItem.belongsTo(Ticket, {
    foreignKey: "itemId",
    constraints: false,
    as: "ticketExpense",
  })
  TransactionItem.belongsTo(Ticket, {
    foreignKey: "itemId",
    constraints: false,
    as: "ticketRefund",
  })
  TransactionItem.belongsTo(Credit, {
    foreignKey: "itemId",
    constraints: false,
    as: "userCredit",
  })
  TransactionItem.belongsTo(ReferralCredit, {
    foreignKey: "itemId",
    constraints: false,
    as: "referralCredit",
  })
  TransactionItem.belongsTo(RouteCredit, {
    foreignKey: "itemId",
    constraints: false,
    as: "routeCredits",
  })
  TransactionItem.belongsTo(RoutePass, {
    foreignKey: "itemId",
    constraints: false,
    as: "routePass",
  })
}
