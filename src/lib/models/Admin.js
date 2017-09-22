import * as auth from "../core/auth"

export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('admin', {
    email: {
      type: DataTypes.STRING,
      allowNull: false
    },
    /* Name provided by Gmail */
    emailName: DataTypes.STRING,
    /* Name provided by creator */
    name: DataTypes.STRING,
    receiveAlerts: DataTypes.BOOLEAN,
    telephone: DataTypes.STRING,
    notes: DataTypes.JSONB,
  }, {
    classMethods: {
      allFromCompany (id) {
        var companyIdList = [0]
        if (id) companyIdList.push(id)

        return this.findAll({
          where: {
            transportCompanyId: {
              $in: companyIdList,
            },
          },
        })
      },
      allToAlertFromCompany (id) {
        var companyIdList = [0]
        if (id) companyIdList.push(id)

        return this.findAll({
          include: [
            {
              model: modelCache.models.TransportCompany,
              where: {id: {$in: companyIdList}},
            }
          ],
          where: {
            receiveAlerts: true,
            telephone: {$ne: null},
          }
        })
      },
    },
    instanceMethods: {
      makeToken () {
        return auth.signSession({
          email: this.email,
          app_metadata: {
            roles: ["admin"],
            lastUpdated: this.updatedAt.getTime()
          }
        })
      },
    }
  })
}
