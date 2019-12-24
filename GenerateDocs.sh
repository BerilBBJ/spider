#!/bin/bash
# ============ preamble ================== #
set -o errexit
set -o pipefail
set -o nounset

printf "Generating JSDocs...\n"

jsdoc --access all --verbose -r -d docs/ -r ./server/app/
