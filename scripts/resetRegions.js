import toGeoJSON from '@mapbox/togeojson';
import xmlDOM from 'xmldom';
import fs from 'fs';
import path from 'path';

const {
  db: sequelize,
  models,
} = require('../src/lib/core/dbschema')();

var xmltext = fs.readFileSync(path.join(__dirname, '..', 'data', 'regions.kml'));
var xmlroot = (new xmlDOM.DOMParser()).parseFromString(xmltext.toString('utf8'));
var predefinedRegions = toGeoJSON.kml(xmlroot);

export async function resetRegions () {
  function toTitleCase (str) {
    if (str === 'NTU') return str;
    if (str === 'Cbd') return str;

    return str.replace(/\w\S*/g,
      txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
  }
  try {
    return await sequelize.transaction(async txn => {
      await models.Region.destroy({
        where: {
          name: {$not: null},
        }
      }, {transaction: txn});
      // Load the predefined features
      let regions = predefinedRegions.features.map((feature) => {
        for (let paths of feature.geometry.coordinates) {
          // Truncate the 3D point to 2D (the third dimension is meaningless
          // for this dataset)
          for (let point of paths) {
            point.length = 2;
          }
        }
        var data = {
          areaName: toTitleCase(feature.properties.description),
          name: toTitleCase(feature.properties.name),
          polygon: feature.geometry
        };
        return models.Region.create(data);
      });

      Promise.all(regions).then((results) => {
        console.log(`Created ${results.length} regions`);
      });

      return Promise.all(regions);
    });
  } catch (err) {
    console.log(err.stack);
    throw err;
  }
}

if (require.main === module) {
  Promise.resolve(null)
    .then(resetRegions)
    .then(() => {
      process.exit();
    })
    .catch(err => {
      console.log(err.stack);
      process.exit(1);
    });
}
