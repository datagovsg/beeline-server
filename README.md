How to start using the server
=============

Install dependencies
----------
Go to the root directory of this project and run

    $ npm install

In addition, you will find it useful to install the following globally:

This gives you `babel-node` which you need to run scripts (e.g. `db_init`,
`login-as`):

    $ npm install -g babel-cli

Edit config file
----------

Edit the config file at `config.js`

1. `tls: false` to disable HTTPS while testing
2. SSL Certificates

Create the postgres database
----------

(Not necessary for running tests -- the test database is created automatically)
To create a working postgres database, call:

    $ export DATABASE_URL=postgres://user:password@localhost/database
    $ babel-node scripts/db_init

Run server
----------

    $ npm start

Run tests
----------

Run the tests on a database initialized with `db_init`

    $ npm run test

OR: Run tests on a database dump previously downloaded

    $ npm run test_cached

OR: Run tests on a database dump downloaded from `staging.beeline.sg`

    $ npm run test_current

The test script is `setup_virtualenv.sh`.

Environment variables that affect tests:

    TEST_STRIPE=1 -- Executes stripe charges (using fake credit card number 4242 4242 4242 4242)
    LAB_OPTIONS -- Specifies options to lab, the test framework (try `--inspect`)

Useful scripts
--------------

Generate session token as a driver, admin, user or superadmin.

Example:

    $ babel-node scripts/login-as.js superadmin
    $ babel-node scripts/login-as.js driver 1
    
Contributing
============
We welcome contributions to code open sourced by the Government Technology Agency of Singapore. All contributors will be asked to sign a Contributor License Agreement (CLA) in order to ensure that everybody is free to use their contributions.
