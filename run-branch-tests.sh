#!/bin/sh

if [ "$1" = "" ]
then
    echo "Please specify the branch whose tests you want to run"
fi

if [ "$2" = "" ]
then
    TEST_WHAT=test
else
    TEST_WHAT="$2"
fi

mkdir -p test-old

git archive "$1" ./test | tar -x -C test-old --strip-components=1 test

TESTS=test-old npm run "$TEST_WHAT"

