'use strict'

const meta = require('./models/meta')
const metaView = require('./views/meta')

module.exports = async function metaPage ({ theme }) {
  const status = await meta.status()
  const peers = await meta.peers()

  console.log(JSON.stringify(peers, null, 1))

  const { themeNames } = require('@fraction/base16-css')

  return metaView({ status, peers, theme, themeNames })
}
