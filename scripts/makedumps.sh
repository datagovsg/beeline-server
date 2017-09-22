#!/bin/sh

pg_dump beeline2 --no-owner --no-acl > dbdump.sql
pg_dump beeline2 -F tar --no-owner --no-acl > dbdump.tar
