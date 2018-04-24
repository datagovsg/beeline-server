const _ = require("lodash")
const { TransactionError } = require("../util/errors")
const { formatDateUTC } = require("../util/common")
const assert = require("assert")

/**

Preamble:
- The class will be referred to as TransactionBuilder.
- Instances of the class (e.g. created with new TransactionBuilder()) will be
  referred to as transactionBuilder.

# TransanctionBuilder class (10 Nov 2016).

WARNING: Although this class is used as if it were immutable, it is still not
100% side-effect free. DO NOT REUSE instances that have been previously transformed.
Refer to the FIXMEs in the code to see what changes need to be made to achieve
full functional semantics.

## Overview of transformations as a means of managing discounts and promotions

The TransactionBuilder class provides utilities to help manage promotions,
discounts, credits etc. Each transactionBuilder holds a snapshot of a
transaction. transactionBuilders can be finalized, which
basically means that the accounts are balanced, and any payments have been
accounted for.

For example, the most basic (finalized) transaction it can hold
would be:

| Description       | Debit        | Credit        |
|-------------------|--------------|---------------|
| Sale of ticket(1) |              | 10            |
| Sale of ticket(2) |              | 10            |
| Sale of ticket(3) |              | 10            |
| Payment Received  | 30           |               |

In addition, the transactionBalance will hold references to the Sequelize
instances of tickets (1), (2) and (3).

Every operation you apply on a transactionBuilder returns you a **new**
transactionBuilder. For example, here's an unfinalized transaction:

| Description       | Debit        | Credit        |
|-------------------|--------------|---------------|
| Sale of ticket(1) |              | 10            |
| Sale of ticket(2) |              | 10            |
| Sale of ticket(3) |              | 10            |

Say we want to apply a 10% discount. We write:

```js
transactionBuilder = applyDiscount10Perc(transactionBuilder)
```

The new transactionBuilder will look like:

| Description       | Debit        | Credit        |
|-------------------|--------------|---------------|
| Sale of ticket(1) |              | 10            |
| Sale of ticket(2) |              | 10            |
| Sale of ticket(3) |              | 10            |
| 10% discount      | 3            |               |

The intention of this class is so that we can write something like:
```js

// Initialize
const initialTransaction = await initBuilderWithTicketSale(connection, lineItems)

// Apply discounts
const transactionAfterDiscounts = wantApplyDiscounts ?
  await applyDiscounts(initialTransaction) : initialTransaction;

// Apply credits
const transactionAfterCredits = wantApplyCredits ?
  await applyCredits(transactionAfterDiscounts) : transactionAfterDiscounts;

// Seal for payment
const sealed = await transactionsAfterCredits.finalizeForPayment(companyId)

// Charge stripe
stripe.charges.create({
  ...
  amount: Math.round(sealed.transactionItems.find(i => i.itemType === 'payment').debit * 100)
  ...
})

```

IMPORTANT CAVEAT: Although this class is used as if it were immutable, it is still not
100% side-effect free. DO NOT REUSE instances that have been previously transformed.
Refer to the FIXMEs in the code to see what changes need to be made to achieve
full functional semantics.

## API Documentation

transactionBuilder

### Properties:
- items : Array[{
    ticket : models.Ticket
    trip : models.Trip (with Route and TripStop included)
    price : number (should be equal to trip.price),
    transactionItem: object (references to the entry in ticketSale)
  }]
- transactionItemsByType : { [itemType : string] -> Array[TransactionItemData] }

  TransactionItemData is an object that can be passed into
  models.TransactionItem.create() to create the transactionItem.

  transactionItemData.itemType should equal to itemType. If it isn't the build()
  checks will throw an error.

- dryRun : boolean
  Determines whether database entries will actually be created. If true,
  database entries will **not** be created. This is useful if you are just
  interested in the final price calculation.

- lineItems : Array[{
    userId: number -- ID of user who should receive the ticket
    tripId: number -- TripID of ticket to buy
    boardStopId: number
    alightStopId: number
    (other options)
  }]

- trips : Array[models.Trip]
- tripsById : {[tripId : number] -> models.Trip}

  An array of trip data of all the trips requested.
  tripsById is _.groupBy(trips, 'id') for convenience.

- models : object
- db : object
  Alias of connection.db, connection.models.

  Cache of the Sequelize schema
- transaction : Sequelize.Transaction
  Alias of connection.transaction

  Pass this into sequelize queries to ensure that the queries are executed as
  part of a transaction.
- connection : {
    db: object
    models: object
    dryRun: boolean
    committed: boolean
    transaction: object
    creator: {
      type: string,
      id: string
    }
  }
  The same connection object passed into the constructor.

  @prop committed : boolean
    Sets whether the transactions should be created with committed = true,
    and the tickets with status = 'valid'. If false, committed = false, and
    status = 'pending'.

- undoFunctions : Array[(Sequelize.Transaction) => any]

  Actions to undo this transaction, for example, when charging the credit card
  fails.

  Examples of actions that might be performed:

  * Setting status of tickets to 'failed'.
  * Setting transaction committed status to false.
  * Restoring credits that were deducted.

- creator: {
    type: 'string',
    id: 'id of creator'
  }

  Populates the creatorType and creatorId column of in the db
  Refer to transaction model for allowed creatorType

### Important subproperties that are used elsewhere in the system

- items[].ticket.notes.discountValue : number
  This is used to track SUM(refundable deductions) applied onto this ticket.
  This will be saved in the database and used for refund calculations.

- transactionsItemsByType.ticketSale.notes.outstanding
- items[].transactionItem.notes.outstanding
  (These are aliases of each other)

  The outstanding value of this ticket that remains to be paid. This is
  trip.price - SUM(non-refundable deductions) - SUM(refundable deductions)

- transactionItemsByType.{payment, credits, routeCredits, ...}.notes.tickets :
    { [ticketId: number] -> number }

  Payment, credits and route passes are all payment methods.
  note.tickets indicates the amount of funds from this payment method was used
  to pay for each ticket. This will be used during refunds.

  e.g. Two $8 tickets were purchased (total $16). $10 was paid via Stripe and
  $6 via credits. Only the first ticket was refunded.

  Supposing their ticket ids are 101, 102, then:

  transactionsItemsByType.payment.notes.tickets = {101: 5, 102: 5}
  transactionsItemsByType.credits.notes.tickets = {101: 3, 102: 3}

  Therefore, when "refunding" ticket 101, we refund $5 via Stripe, and add
  $3 to the user's credit balance.

- transactionsItemsByType.ticketSale.notes.ticket : object
  A .toJSON() representation of the models.Ticket when it was purchased. Has
  no effect on the running of the program, but is used to keep a record of what
  was originally purchased.

### Methods:
- build : () => Promise[models.Transaction]

  Creates a models. Transaction with all the transactionItems specified in this
  transactionBuilder (if dryRun == false), or creates a plain-old-data (POD) object
  with the same properties as the transaction that would have been created.

  If the models.Ticket instances in items have been updated, they will be also saved.

- finalizeForPayment : (companyId: number) => TransactionBuilder
  Returns a new, balanced transactionBuilder with a payment entry.

- _excessCredit : () => number
  Returns SUM(credits) - SUM(debits). This is equivalent to the amount that
  has to be paid in an unfinalized transactionBuilder, after deducting discounts,
  credits etc.

Constructor:
- TransactionBuilder(connection)
  @arg connection. An object containing references to {db, models, transaction, dryRun}

- TransactionBuilder(transactionBuilder)
  Constructs a clone of transanctionBuilder.

### Helper functions
- outstandingAmounts : (items : typeof(transactionBuilder.items)) => Array[number]

  (Self-documenting -- see source code)

- updateTicketsWithDiscounts :
    (items: typeof(transactionBuilder.items), code : string, quanta : Array[number], refundable : boolean)
      => void

  Updates `items[].transactionItem.notes.outstanding` (always) and
  `items[].ticket.notes.discountValue` (only if refundable == true) if the
  discount values specified in quanta are applied to the items.

  Discount of amount quanta[0] will be applied to items[0], and quanta[1] to
  items[1] etc., so the two arrays should have the same length.

## Writing transforms

Each transform should perform the following:

1. Clone the transactionBuilder
2. Modify **only** the clone
 a) Update transactionItemsByType
 b) Update undoFunctions
 c) Update `items[].transactionItem.notes.outstanding` and
    `items[].ticket.notes.discountValue`. (You can use the `updateTicketsWithDiscounts`
    helper function to help)
 c) Update items[].ticket
3. Return the clone

DO NOT:
1. Modify previous entries unless you have good accounting reasons to do so.
   As far as possible, only append to the entries in transactionItemsByType.

For examples, refer to:
- transactionBuilder.finalizeForPayment
- Credits.applyCredits
- [util/transactions].absorbSmallPayments

  This is an *immutable collection*. Do not mutate the collections
  on this object (e.g. via Array.push).
**/
export class TransactionBuilder {
  constructor(connection) {
    // Clone type
    if (connection instanceof TransactionBuilder) {
      const propertiesToClone = [
        "lineItems",
        "items",
        "transactionItemsByType",
        "tripsPromise",
        "trips",
        "transaction",
        "db",
        "models",
        "dryRun",
        "tripsById",
        "connection",
        "undoFunctions",
        "postTransactionHooks",
        "description",
        "committed",
      ]

      // FIXME: obviously you will need deepClone to achieve
      // full functional.
      for (let propToClone of propertiesToClone) {
        this[propToClone] = _.clone(connection[propToClone])
      }

      // Further properties to clone more deeply
      for (let key in this.transactionItemsByType) {
        this.transactionItemsByType[key] = _.clone(
          this.transactionItemsByType[key]
        )
      }
    } else {
      this.transaction = connection.transaction
      this.db = connection.db
      this.models = connection.models
      this.dryRun = connection.dryRun
      this.committed = connection.committed
      this.connection = connection
      this.undoFunctions = []
      this.postTransactionHooks = []
      this.transactionItemsByType = {}
      this.trips = this.tripsById = this.lineItems = this.items = null

      assert(this.models, "connection.models not set")
      assert(typeof this.dryRun === "boolean", "connection.dryRun not set")
      assert(
        typeof this.connection.committed === "boolean",
        "connection.committed not set"
      )
      assert(this.db, "connection.db not set")
      if (!this.dryRun && !this.transaction) {
        console.error(
          "A live transaction was requested, but no database transaction issued. Are you sure this is correct"
        )
      }
    }
  }

  /**
   * Seal up the imbalance in credits as payment to ourselves
   * @param destinationCompanyId - the company to make the payment to
   * @param makeNotes - a callback generates notes for the payment to be made
   */
  async finalizeForPayment(
    destinationCompanyId,
    makeNotes = this._mapTicketToOutstandingAmount
  ) {
    let clone = new TransactionBuilder(this)

    assert(
      !clone.transactionItemsByType.payment,
      "Transaction has already been sealed for payment"
    )

    const excessCredit = this._excessCredit()
    const notes = makeNotes(this.items, excessCredit)

    clone.transactionItemsByType.payment = [
      {
        itemType: "payment",
        payment: {
          incoming: excessCredit,
        },
        debit: excessCredit,
        notes,
      },
    ]

    if (destinationCompanyId) {
      return clone.transferToCompany(destinationCompanyId, excessCredit)
    } else {
      return clone
    }
  }

  _mapTicketToOutstandingAmount(items, excessCredit) {
    let ticketSplit
    if (items) {
      ticketSplit = _.fromPairs(
        _.zip(items.map(i => i.ticket.id), outstandingAmounts(items))
      )

      assert(
        Math.abs(_.sum(_.values(ticketSplit)) - excessCredit) < 0.0001,
        "Some discounts were not recorded on tickets"
      )
    } else {
      ticketSplit = null
    }
    return {
      tickets: ticketSplit,
    }
  }

  /* Transfer received payments to company */
  async transferToCompany(destinationCompanyId, amount) {
    let clone = new TransactionBuilder(this)

    assert(destinationCompanyId)

    clone.transactionItemsByType.transfer =
      clone.transactionItemsByType.transfer || []

    clone.transactionItemsByType.transfer = clone.transactionItemsByType.transfer.concat(
      [
        {
          itemType: "transfer",
          transfer: {
            transportCompanyId: destinationCompanyId,
            outgoing: amount,
          },
          credit: amount,
        },
      ]
    )

    /* Dummy account because we are too lazy to actually track the
      amounts owed to the company due to discounts on OUR part,
      and the discounts offered by the company to the user via
      us
    */
    const cogsAccount = await this.models.Account.getByName(
      "Cost of Goods Sold",
      {
        transaction: this.transaction,
      }
    )

    clone.transactionItemsByType.account =
      clone.transactionItemsByType.account || []

    const [cogsAccountItems, nonCogsAccountItems] = _.partition(
      clone.transactionItemsByType.account,
      a => a.itemId === cogsAccount.id
    )

    const newCogsAccountItem = {
      debit: _.sum(cogsAccountItems.map(i => i.debit)) + amount,
      itemId: cogsAccount.id,
      itemType: "account",
    }

    clone.transactionItemsByType.account = nonCogsAccountItems.concat(
      newCogsAccountItem
    )

    return clone
  }

  _excessCredit() {
    let netCredit = 0.0
    _.forEach(this.transactionItemsByType, tis => {
      _.forEach(tis, ti => {
        let credit =
          typeof ti.credit === "number" && isFinite(ti.credit)
            ? ti.credit
            : typeof ti.credit === "string"
              ? parseFloat(ti.credit)
              : typeof ti.debit === "number" && isFinite(ti.debit)
                ? -ti.debit
                : typeof ti.debit === "string"
                  ? -parseFloat(ti.debit)
                  : undefined

        assert(
          credit !== undefined,
          `No suitable credit/debit: ${ti.credit}, ${ti.debit}`
        )
        netCredit += credit
      })
    })
    return netCredit
  }

  _checkBalanced() {
    assert(
      Math.abs(this._excessCredit()) < 0.0001,
      "Debits and credits should balance"
    )
  }

  _checkConsistency() {
    _.forEach(this.transactionItemsByType, (v, k) => {
      v.forEach(ti =>
        assert(
          ti.itemType === k,
          `"itemType" of ${JSON.stringify(ti)} is not ${k}`
        )
      )
    })
  }

  /**
   * Save the tickets, if they have changed
   */
  async _saveChangesToTickets() {
    if (this.items) {
      await Promise.all(
        this.items.map(it => it.ticket.save({ transaction: this.transaction }))
      )
    }
  }

  /**
   * Save the tickets, if they have changed
   */
  async _saveChangesToRoutePasses() {
    if (this.items) {
      await Promise.all(
        this.items.map(it =>
          it.routePass.save({ transaction: this.transaction })
        )
      )
    }
  }

  /**
   * Create a new Transaction instance and the corresponding
   * TransactionItems that relate to it
   *
   * @param options - an object holding options that influence transaction insertion.
   * Currently only supports one field - `type`, the type of the transaction made
   * @param postTransactionHooks - an array of callbacks invoked after an accounting
   * transaction has been created. Each callback will take in two parameters:
   * <ul>
   *   <li> `items` - the list of items held by transactionBuilder on initialization
   *   <li> `transaction` - the Sequelize transaction
   * </ul>
   */
  async build(options = {}) {
    let { type } = options

    // Ensure we have somewhat sane values
    this._checkConsistency()
    this._checkBalanced()

    // Sync to database
    const transactionItems = _.flatten(_.values(this.transactionItemsByType))

    const transactionData = {
      transactionItems,
      committed: this.connection.committed, // not committed unless payment completed
      description: this.description, // generic description
      creatorType: this.connection.creator && this.connection.creator.type,
      creatorId: this.connection.creator && this.connection.creator.id,
      type: type || "ticketPurchase",
    }

    if (this.dryRun) {
      return [transactionData, null]
    } else {
      const dbTransactionInstance = this.dryRun
        ? transactionData
        : await this.models.Transaction.create(transactionData, {
            transaction: this.transaction,
            include: this.models.Transaction.allTransactionTypes(),
          })

      for (const hook of this.postTransactionHooks) {
        await hook.apply(this) // eslint-disable-line no-await-in-loop
      }

      this.undoFunctions.push(t =>
        dbTransactionInstance.update({ committed: false }, { transaction: t })
      )

      const undoFn = async () => {
        try {
          await this.db.transaction(t =>
            Promise.all(_.reverse(this.undoFunctions).map(fn => fn(t)))
          )
        } catch (err) {
          console.log(err.stack)
          throw err
        }
      }

      return [dbTransactionInstance, undoFn]
    }
  }
}

function _makeTickets(tb, lineItems) {
  const { models, transaction, committed, dryRun } = tb.connection

  let data = lineItems.map(lineItem => ({
    userId: lineItem.userId,
    boardStopId: lineItem.boardStopId,
    alightStopId: lineItem.alightStopId,
    status: committed ? "valid" : "pending",
    notes: {},
  }))

  if (dryRun) {
    return Promise.resolve(
      data.map((ticketData, index) => _.assign(ticketData, { id: index }))
    )
  } else {
    const ticketCreationPromise = Promise.all(
      data.map(item => models.Ticket.create(item, { transaction }))
    )

    tb.undoFunctions.push(t =>
      ticketCreationPromise.then(ticketInstances =>
        Promise.all(
          ticketInstances.map(ticket =>
            ticket.update({ status: "failed" }, { transaction: t })
          )
        )
      )
    )

    return ticketCreationPromise.then(async tickets => {
      const exhaustedTrip = await models.Trip.find({
        where: {
          id: { $in: lineItems.map(li => li.tripId) },
          seatsAvailable: { $lt: 0 },
        },
        transaction,
      })

      if (exhaustedTrip) {
        throw new TransactionError(
          `Tickets for ` +
            `${formatDateUTC(
              tb.tripsById[exhaustedTrip.id].date
            )} are sold out.`
        )
      }

      return tickets
    })
  }
}

export async function initBuilderWithTicketSale(connection, lineItems) {
  const transactionBuilder = new TransactionBuilder(connection)
  const { models, transaction } = connection

  // Construct from raw data
  const items = lineItems.map(item => ({
    item,
    trip: null,
    discount: null,
    price: undefined,
  }))

  // Fetch data about the tickets
  const trips = await models.Trip.findAll({
    where: { id: { $in: lineItems.map(item => item.tripId) } },
    transaction,
    include: [
      {
        model: models.TripStop,
        include: [
          {
            model: models.Ticket,
            where: {
              userId: { $in: lineItems.map(item => item.userId) },
              status: { $in: ["valid", "pending", "bidded"] },
            },
            required: false,
          },
        ],
      },
      {
        model: models.Route,
        attributes: { exclude: ["path"] },
      },
    ],
  })

  const tripsById = _.keyBy(trips, "id")

  _.assign(transactionBuilder, { tripsById, trips })

  const ticketInsts = await _makeTickets(transactionBuilder, lineItems)

  for (let [item, ticket] of _.zip(items, ticketInsts)) {
    item.trip = tripsById[item.item.tripId]
    item.price = item.trip.price
    item.ticket = ticket
    item.id = ticket.id
    item.userId = item.item.userId
    item.type = "ticket"

    // FIXME: This creates an internal pointer which makes the object
    // difficult to clone correctly.
    item.transactionItem = {
      itemType: "ticketSale",
      itemId: item.ticket.id,
      credit: item.trip.price,
      notes: {
        ticket: item.ticket.toJSON ? item.ticket.toJSON() : item.ticket,
        outstanding: parseFloat(item.trip.price),
      },
    }
  }

  // Build the descriptions:
  // Example: B01 1,2,3 Mar; 4,5,6 Apr. B02 3 Feb
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ]
  const tripDescriptions =
    "Purchase: " +
    _(items)
      .map(it => it.trip)
      .groupBy(trip => trip.route && trip.route.id)
      .values()
      .map(trips => {
        const routeDescription = trips[0].route
          ? trips[0].route.label
          : "[No Route]"
        const datesDescription = _(trips)
          .groupBy(t => t.date.getUTCMonth())
          .toPairs()
          .map(([month, trips]) => {
            const daysString = trips
              .map(t => `${t.date.getUTCDate()}`)
              .join(",")
            return `${daysString} ${monthNames[month]}`
          })
          .join("; ")

        return `${routeDescription} ${datesDescription}`
      })
      .join(". ")

  _.assign(transactionBuilder, {
    items,
    lineItems,
    description: tripDescriptions,
  })

  transactionBuilder.transactionItemsByType = {
    ticketSale: items.map(item => item.transactionItem),
  }

  return transactionBuilder
}

export function outstandingAmounts(items) {
  return items.map(item => parseFloat(item.transactionItem.notes.outstanding))
}

export function updateTicketsWithDiscounts(
  items,
  code,
  quanta,
  refundable = true
) {
  return updateItemsWithDiscounts(items, code, quanta, refundable, "ticket")
}

function updateItemsWithDiscounts(
  items,
  code,
  quanta,
  refundable,
  sequelizeType
) {
  // Add it to the discounted value of the item
  for (let [item, quantum] of _.zip(items, quanta)) {
    if (!refundable) {
      item[sequelizeType].notes = _.clone(item[sequelizeType].notes) // force update
      item[sequelizeType].notes.discountCodes =
        item[sequelizeType].notes.discountCodes || []
      item[sequelizeType].notes.discountCodes.push(code)
      item[sequelizeType].notes.discountValue =
        item[sequelizeType].notes.discountValue || 0
      item[sequelizeType].notes.discountValue += quantum
    }
    item.transactionItem.notes.outstanding =
      Math.round(item.transactionItem.notes.outstanding * 100 - quantum * 100) /
      100
  }
}

/**
 * Inspect the discount transaction items held in transaction builder,
 * extracting their `notes.tickets` field (named so for historical reasons)
 *
 * Use this to look up the transaction items holding tickets or
 * similar Sequelize objects, and update such transaction items
 * with discounts
 */
export function updateTransactionBuilderWithPromoDiscounts(
  transactionBuilder,
  promoCode,
  sequelizeType = "ticket"
) {
  for (const d of transactionBuilder.transactionItemsByType.discount) {
    const discountedSales = []
    const discountAmounts = []
    for (const [id, discountAmount] of Object.entries(d.notes.tickets)) {
      discountedSales.push(
        transactionBuilder.items.find(i => i.id === +id && i[sequelizeType])
      )
      discountAmounts.push(discountAmount)
    }
    updateItemsWithDiscounts(
      discountedSales,
      promoCode.code,
      discountAmounts,
      false,
      sequelizeType
    )
  }
}
