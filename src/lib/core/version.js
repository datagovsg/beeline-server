const _ = require("lodash")
const { getModels, defaultErrorHandler } = require("../util/common")

module.exports = (server, options, next) => {
  server.route({
    method: "GET",
    path: "/versionRequirements",
    config: {
      description: `Returns the minimum version requirements for known apps.
Apps are responsible for prompting the user to upgrade`,
      tags: ["api", "service"],
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)
        let wantedAssetNames = [
          "driverApp.minVersion",
          "driverApp.upgradeUrl.iOS",
          "driverApp.upgradeUrl.Android",
          "commuterApp.upgradeUrl.iOS",
          "commuterApp.upgradeUrl.Android",
          "commuterApp.minVersion",
        ]

        let assets = await m.Asset.findAll({
          where: { id: { $in: wantedAssetNames } },
        })

        let requirements = {
          driverApp: {
            minVersion: "1.0.0",
            upgradeUrl: {},
          },
          commuterApp: {
            minVersion: "1.0.0",
            upgradeUrl: {},
          },
        }

        for (let asset of assets) {
          _.set(requirements, asset.id, asset.data.trim())
        }

        reply(requirements)
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  next()
}

module.exports.attributes = {
  name: "version",
}
