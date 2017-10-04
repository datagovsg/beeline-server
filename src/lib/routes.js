module.exports = (server, options, next) => {
  server.register([
    require("./core/auth"),
    require("./core/download"),
    require("./core/version"),
    require("./core/sequelize"),
    require("./endpoints/assets"),
    require("./endpoints/companies"),
    require("./endpoints/companyPromos"),
    require("./endpoints/companyContactLists"),
    require("./endpoints/monitoring"),
    require("./endpoints/drivers"),
    require("./endpoints/onemap"),
    require("./endpoints/eventSubscriptions"),
    require("./endpoints/pings"),
    require("./endpoints/promotions"),
    require("./endpoints/regions"),
    require("./endpoints/routes"),
    require("./endpoints/stops"),
    require("./endpoints/suggestions"),
    require("./endpoints/suggestionsWeb"),
    require("./endpoints/tickets"),
    require("./endpoints/transactions"),
    require("./endpoints/transactionItems"),
    require("./endpoints/trips"),
    require("./endpoints/tripStatuses"),
    require("./endpoints/users"),
    require("./endpoints/userReferrals"),
    require("./endpoints/userPaymentInfo"),
    require("./endpoints/admins"),
    require("./endpoints/vehicles"),
    require("./endpoints/routePassAdmin"),
    require("./endpoints/credits"),
    require("./endpoints/loader"),
    require("./endpoints/crowdstart"),
    require("./custom/wrs"),
    require("./custom/userSuggestedRoutes"),
    require("./daemons/eventSubscriptions"),
    require("./daemons/smoketest"),
    // daemons/monitoring is loaded by endpoints/monitoring
  ]).then(next, (err) => {
    console.log(err)
    next(err)
  })
}

module.exports.attributes = {
  name: "setup"
}
