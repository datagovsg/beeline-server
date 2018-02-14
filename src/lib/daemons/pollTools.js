const today0000 = () => {
  let now = new Date()
  now.setHours(0, 0, 0, 0)
  return now
}

module.exports.findAllPings = (tripIds, m) =>
  m.Ping.findAll({
    where: {
      time: {
        $gte: today0000(),
      },
      tripId: { $in: tripIds },
    },
    raw: true,
  })
