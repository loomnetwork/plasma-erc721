// This config is used to run tests in the browser.

const path = require('path');
const WebpackTapeRun = require('webpack-tape-run');
const WebpackDotEnv = require('dotenv-webpack');

module.exports = {
  mode: 'production',
  entry: './dist/tests/e2e_tests.js',
  output: {
    path: path.resolve(__dirname, './dist'),
    filename: 'browser_e2e_tests.js',
    libraryTarget: 'umd',
    globalObject: 'this',
    // libraryExport: 'default',
    library: 'loom_e2e_tests'
  },
  node: {
    fs: 'empty',
    crypto: true,
    util: true,
    stream: true,
  },
  module: {
    rules: [
      {
        test: /\.(js)$/,
        exclude: /(node_modules)/,
        use: 'babel-loader'
      }
    ]
  },
  plugins: [
    new WebpackDotEnv({
      path: './.env.test',
      safe: './.env.test.example'
    }),
    // Be default tests will run in Electron, but can use other browsers too,
    // see https://github.com/syarul/webpack-tape-run for plugin settings.
    new WebpackTapeRun()
  ],
  // silence irrelevant messages
  performance: {
    hints: false
  },
  stats: 'errors-only'
};