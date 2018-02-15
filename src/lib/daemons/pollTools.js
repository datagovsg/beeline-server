const AWS = require("aws-sdk")
const geohash = require("ngeohash")

const dynamoDb = new AWS.DynamoDB.DocumentClient()

/**
 * Decode the geohash embedded within the given ping, and
 * inject the corresponding GeoJSON point coordinates
 * @param {Object} ping - an object where `location` is set to a geohash
 * @return {Object} the ping, with an additional data field - `coordinates`,
 * a GeoJSON object whose coordinates match `ping.location`
 */
function injectGeoJSON(ping) {
  const { latitude, longitude } = geohash.decode(ping.location)
  ping.coordinates = {
    type: "Point",
    coordinates: [longitude, latitude],
  }
  return ping
}

const queryPingsFor = tripId => (resolve, reject) => {
  const params = {
    KeyConditionExpression: "tripId = :v1",
    TableName: process.env.TRACKING_TABLE,
    ExpressionAttributeValues: { ":v1": tripId },
  }
  dynamoDb.query(params, (error, data) => {
    if (error) {
      reject(error)
    } else {
      resolve(data.Items || [])
    }
  })
}

module.exports.findAllPings = async tripIds => {
  let result = []
  for (const tripId of tripIds) {
    const pings = await new Promise(queryPingsFor(tripId))
      .then(data => data.map(injectGeoJSON))
      .catch(error => {
        console.error(error)
        return []
      })
    result = result.concat(pings)
  }
  return result
}
