'use strict';

var pg = require('pg');
var client = new pg.Client(process.env.DATABASE_URL);

client.connect(function (err) {
  if (err) throw err;

  client.query('SELECT relname FROM pg_class WHERE relkind=\'S\'', function (err, result) {
    if (err) throw err;

    updateSequences(result.rows);
  });

  function updateSequences (rows) {
    var updates = [];

    for (let row of rows) {
      var match = row.relname.match(/^(.*)_id_seq/);
      if (match) {
        var sequenceName = match[0];
        var tableName = match[1];
        var query = `SELECT setval('"${sequenceName}"', (SELECT MAX(id) FROM "${tableName}"), true);`;
        console.log(query);
        updates.push(query);
      }
    }

    updates = updates.map(upd => new Promise((resolve, reject) => {
      client.query(upd, (err, res) => {
        if (err) { return reject(err); } else { return resolve(); }
      });
    }));

    Promise.all(updates)
    .then(() => {
      process.exit(0);
      console.log('DONE!');
    })
    .catch((err) => console.log(err));
  }
});
