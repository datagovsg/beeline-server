module.exports = (server, options, next) => {
  server
    .register([
      require("./core/auth"),
      require("./core/download"),
      require("./core/version"),
      require("./core/sequelize"),
      require("./endpoints/assets"),
      require("./endpoints/companies"),
      require("./endpoints/companyPromos"),
      require("./endpoints/companyContactLists"),
      require("./endpoints/drivers"),
      require("./endpoints/onemap"),
      require("./endpoints/eventSubscriptions"),
      require("./endpoints/liteRoutes"),
      require("./endpoints/routes"),
      require("./endpoints/stops"),
      require("./endpoints/suggestedRoutes"),
      require("./endpoints/suggestions"),
      require("./endpoints/suggestionsWeb"),
      require("./endpoints/tickets"),
      require("./endpoints/transactions"),
      require("./endpoints/transactionItems"),
      require("./endpoints/trips"),
      require("./endpoints/tripStatuses"),
      require("./endpoints/users"),
      require("./endpoints/userPaymentInfo"),
      require("./endpoints/admins"),
      require("./endpoints/vehicles"),
      require("./endpoints/routePassAdmin"),
      require("./endpoints/crowdstart"),
      require("./custom/wrs"),
      require("./custom/userSuggestedRoutes"),
      require("./daemons/eventSubscriptions"),
      require("./daemons/smoketest"),
    ])
    .then(next, err => {
      console.warn(err)
      next(err)
    })
}

module.exports.attributes = {
  name: "setup",
}
