# [Loom.js](https://loomx.io) Plasma Cash E2E Tests

NodeJS & browser tests for Loom Plama Cash implementation.

## Development

The e2e test environment can be configured by changing `.env.test` (see `.env.test.example` for
default values).

```shell
# build for NodeJS
yarn build
# build for Browser (TBD!)
yarn build:browser
# run e2e tests using NodeJS
yarn test
# auto-format source files
yarn format
# run e2e tests with the built-in Plasma Cash contract
yarn tape:honest
# run e2e challenge tests with a hostile Plasma Cash contract
yarn tape:hostile
# Same as above but for Jenkins 
yarn jenkins:tape:honest
yarn jenkins:tape:hostile
```
