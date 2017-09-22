var proj4 = require("proj4")

proj4.defs([
  ["epsg:3414",
    "+proj=tmerc +lat_0=1.366666666666667 +lon_0=103.8333333333333 +k=1 +x_0=28001.642 +y_0=38744.572 +ellps=WGS84 +units=m +no_defs "]
])

module.exports.toSVY = proj4("epsg:3414").forward
module.exports.toWGS = proj4("epsg:3414").inverse

