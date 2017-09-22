#!/bin/bash
# this script is meant to be run using `pg_virtualenv`

export DATABASE_URL=postgres://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE
export PGSSLMODE=allow

# Fake credentials for the other services
# (should not affect testing since we have dryRun=1)
export SMTP_HOST=localhost
export SMTP_PORT=25
export SMTP_SECURE=0
export SMTP_USER=username
export SMTP_PASSWORD=password

export TWILIO_ACCOUNT_SID="FAKE TWILIO SID"
export TWILIO_AUTH_TOKEN="FAKE TWILIO AUTH"

export WEB_DOMAIN=testing.beeline.sg
export EMAIL_DOMAIN=testing.beeline.sg

export STRIPE_PK=pk_test_QLotzyBvP72TlRJN6JbF5rF2
export STRIPE_CID=ca_7LJOw1zPE4ZuiWfoJ5LVIdiIs1b7w8w5
export STRIPE_SK=sk_test_rPpgKrMO8mO5p7ke76nP1NIR
export STRIPE_MICRO_RATES=true
export STRIPE_TEST_DESTINATION=acct_17zcVUIt6Q7WukI6

export GOOGLE_MAPS_API_KEY=AIzaSyB7YgUElOrvSlUvdML67lTYouScsQ0TYeQ

export AUTH0_CID=BslsfnrdKMedsmr9GYkTv7ejJPReMgcE
export AUTH0_DOMAIN=beeline.au.auth0.com
export AUTH0_SECRET=what
export PUBLIC_AUTH0_SECRET=whatwhatwhatwhat
export AUTH0_TOKEN_USERREAD=what

export TEST_IDEMPOTENCY=$(date '+%s')

export NO_DAEMON_MONITORING=1
export ROUTES_REFRESH_INTERVAL=1 # cache routes only for 1 ms

# Import the live data for testing
refresh_cache() {
  if [ -z "$DATABASE_SOURCE" ]; then
      DATABASE_SOURCE='postgres://postgres:SePRSWpG+ER6NTGoCH1vBUf15IA@staging.beeline.sg:5432/beelinetest'
  fi
  echo "Updating database dump"
  pg_dump -x -O "$DATABASE_SOURCE" > database_dump.sql
}
if [ "$PULL_DATABASE" = "live" ]
then
  refresh_cache
  [ "$?" = 0 ] || exit 1

  cat database_dump.sql | psql $DATABASE_URL
  [ "$?" = 0 ] || exit 1
  cat scripts/post_dump.sql | psql $DATABASE_URL
  [ "$?" = 0 ] || exit 1
  node scripts/update_sequences.js
  [ "$?" = 0 ] || exit 1
elif [ "$PULL_DATABASE" = "cache" ]
then
  if [ ! -e database_dump.sql ]
  then
    refresh_cache
    [ "$?" = 0 ] || exit 1
  fi
  cat database_dump.sql | psql $DATABASE_URL
  [ "$?" = 0 ] || exit 1
  cat scripts/post_dump.sql | psql $DATABASE_URL
  [ "$?" = 0 ] || exit 1
  node scripts/update_sequences.js
  [ "$?" = 0 ] || exit 1
else
  echo "CREATE EXTENSION postgis" | psql $DATABASE_URL
  [ "$?" = 0 ] || exit 1
  babel-node scripts/db_init.js
  [ "$?" = 0 ] || exit 1
fi
echo 'Database initialized'

if [ "$TESTS" = "" ]
then
  TESTS=test/
fi

# npm run actual_test
node_modules/lab/bin/lab $LAB_OPTIONS -T node_modules/lab-babel --globals __core-js_shared__ -S $TESTS

# if [ "$INTERACTIVE" = "1" ]
# then
#     PS1="DBG> $PS1" bash
# fi
