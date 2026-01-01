process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1'

// Suppress punycode deprecation warning
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning' && warning.message.includes('punycode')) {
    return
  }
  console.warn(warning.name + ':', warning.message)
})

import './config.js'

import dotenv from 'dotenv'
import { existsSync, readFileSync, readdirSync, unlinkSync, watch, mkdirSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import path, { join } from 'path'
import { platform } from 'process'
import { fileURLToPath, pathToFileURL } from 'url'
import * as ws from 'ws'
import zlib from 'zlib'
import { EventEmitter } from 'events'
import clearTmp from './lib/tempclear.js'

EventEmitter.defaultMaxListeners = 20

global.__filename = function filename(pathURL = import.meta.url, rmPrefix = platform !== 'win32') {
  return rmPrefix
    ? /file:\/\/\//.test(pathURL)
      ? fileURLToPath(pathURL)
      : pathURL
    : pathToFileURL(pathURL).toString()
}
global.__dirname = function dirname(pathURL) {
  return path.dirname(global.__filename(pathURL, true))
}
global.__require = function require(dir = import.meta.url) {
  return createRequire(dir)
}

import chalk from 'chalk'
import { spawn } from 'child_process'
import lodash from 'lodash'
import NodeCache from 'node-cache'
import { default as Pino, default as pino } from 'pino'
import syntaxerror from 'syntax-error'
import { format } from 'util'
import yargs from 'yargs'
import { makeWASocket, protoType, serialize } from './lib/simple.js'

// ========================================
// ROBUST BAILEYS IMPORT
// ========================================
console.log('🔧 Loading @whiskeysockets/baileys...')

let baileys
try {
  baileys = await import('@whiskeysockets/baileys')
  console.log('✅ Baileys module loaded')
} catch (error) {
  console.error('❌ Failed to load @whiskeysockets/baileys:', error.message)
  console.error('💡 Run: npm install @whiskeysockets/baileys@6.7.7')
  process.exit(1)
}

// Extract components with multiple fallback strategies
let DisconnectReason, useMultiFileAuthState, MessageRetryMap, fetchLatestWaWebVersion
let makeCacheableSignalKeyStore, proto, delay, jidNormalizedUser, PHONENUMBER_MCC, makeInMemoryStore

// Strategy 1: Try named exports directly
DisconnectReason = baileys.DisconnectReason
useMultiFileAuthState = baileys.useMultiFileAuthState
MessageRetryMap = baileys.MessageRetryMap
fetchLatestWaWebVersion = baileys.fetchLatestWaWebVersion
makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore
proto = baileys.proto
delay = baileys.delay
jidNormalizedUser = baileys.jidNormalizedUser
PHONENUMBER_MCC = baileys.PHONENUMBER_MCC
makeInMemoryStore = baileys.makeInMemoryStore

// Strategy 2: Try default export if direct access failed
if (!useMultiFileAuthState && baileys.default) {
  console.log('📦 Trying default export...')
  DisconnectReason = baileys.default.DisconnectReason
  useMultiFileAuthState = baileys.default.useMultiFileAuthState
  MessageRetryMap = baileys.default.MessageRetryMap
  fetchLatestWaWebVersion = baileys.default.fetchLatestWaWebVersion
  makeCacheableSignalKeyStore = baileys.default.makeCacheableSignalKeyStore
  proto = baileys.default.proto
  delay = baileys.default.delay
  jidNormalizedUser = baileys.default.jidNormalizedUser
  PHONENUMBER_MCC = baileys.default.PHONENUMBER_MCC
  makeInMemoryStore = baileys.default.makeInMemoryStore
}

// Verify critical components
if (!useMultiFileAuthState || typeof useMultiFileAuthState !== 'function') {
  console.error('❌ CRITICAL: useMultiFileAuthState not found')
  console.error('📋 Available exports:', Object.keys(baileys).slice(0, 20).join(', '))
  if (baileys.default) {
    console.error('📋 Default exports:', Object.keys(baileys.default).slice(0, 20).join(', '))
  }
  console.error('💡 Solution:')
  console.error('   1. Remove node_modules: rm -rf node_modules package-lock.json')
  console.error('   2. Install: npm install @whiskeysockets/baileys@6.7.7')
  console.error('   3. Verify: npm list @whiskeysockets/baileys')
  process.exit(1)
}

if (!DisconnectReason) {
  console.error('❌ CRITICAL: DisconnectReason not found')
  process.exit(1)
}

if (!proto) {
  console.error('❌ CRITICAL: proto not found')
  process.exit(1)
}

console.log('✅ All critical Baileys components loaded')
if (!makeInMemoryStore) {
  console.warn('⚠️ makeInMemoryStore not available (store disabled)')
}

import readline from 'readline'

dotenv.config()

// ============================== 
// SESSION MANAGEMENT 
// ============================== 
const botLogger = {
  log: (type, message) => {
    const timestamp = new Date().toLocaleString()
    console.log(`[${timestamp}] [${type}] ${message}`)
  }
}

async function loadSession() {
  try {
    const credsPath = './session/creds.json'
    
    if (!existsSync('./session')) {
      mkdirSync('./session', { recursive: true })
    }
    
    if (existsSync(credsPath)) {
      try {
        const credsData = JSON.parse(readFileSync(credsPath, 'utf8'))
        if (!credsData || !credsData.me) {
          unlinkSync(credsPath)
          botLogger.log('INFO', "♻️ Invalid session removed")
        } else {
          botLogger.log('INFO', "✅ Valid session found")
          return true
        }
      } catch (e) {
        try {
          unlinkSync(credsPath)
          botLogger.log('INFO', "♻️ Corrupted session removed")
        } catch (err) {}
      }
    }
    
    if (!process.env.SESSION_ID || typeof process.env.SESSION_ID !== 'string') {
      botLogger.log('WARNING', "⚠️ SESSION_ID missing")
      return false
    }
    
    const [header, b64data] = process.env.SESSION_ID.split('~')
    if (header !== "Silva" || !b64data) {
      botLogger.log('ERROR', "❌ Invalid session format. Expected: Silva~base64data")
      return false
    }
    
    const cleanB64 = b64data.replace(/\.\.\./g, '')
    const compressedData = Buffer.from(cleanB64, 'base64')
    const decompressedData = zlib.gunzipSync(compressedData)
    
    const jsonData = JSON.parse(decompressedData.toString('utf8'))
    if (!jsonData.me || !jsonData.me.id) {
      botLogger.log('ERROR', "❌ Session data invalid")
      return false
    }
    
    writeFileSync(credsPath, decompressedData, "utf8")
    botLogger.log('SUCCESS', "✅ Session loaded")
    return true
  } catch (e) {
    botLogger.log('ERROR', "❌ Session Error: " + e.message)
    return false
  }
}

async function main() {
  if (!process.env.SESSION_ID) {
    console.error('❌ SESSION_ID not found')
    return
  }

  try {
    const loaded = await loadSession()
    if (!loaded) {
      console.error('❌ Failed to load session')
      process.exit(1)
    }
    console.log('✅ Session ready')
  } catch (error) {
    console.error('❌ Error:', error.message)
    process.exit(1)
  }
}

main()

// ============================== 
// AUTHOR VERIFICATION 
// ============================== 
async function verifyAuthor() {
  try {
    const packageJson = readFileSync('package.json', 'utf8')
    const packageData = JSON.parse(packageJson)
    const authorName = packageData.author && packageData.author.name

    if (!authorName) {
      console.log(chalk.red('❌ Author information missing'))
      process.exit(1)
    }

    const expectedAuthor = Buffer.from('c2lsdmE=', 'base64').toString()
    if (authorName.trim().toLowerCase() !== expectedAuthor.toLowerCase()) {
      console.log(chalk.red('❌ Unauthorized copy detected'))
      process.exit(1)
    }
    
    console.log(chalk.green('✅ Security check passed - Unicorn MD by Silva Tech Inc'))
    console.log(chalk.bgBlack(chalk.cyan('🦄 Starting Unicorn MD Bot...\n')))
  } catch (error) {
    console.error(chalk.red('Error during verification:'), error)
    process.exit(1)
  }
}

verifyAuthor()

const pairingCode = !!global.pairingNumber || process.argv.includes('--pairing-code')
const useQr = process.argv.includes('--qr')
const useStore = true

const MAIN_LOGGER = pino({ timestamp: () => `,"time":"${new Date().toJSON()}"` })
const logger = MAIN_LOGGER.child({})
logger.level = 'fatal'

let store = undefined
let storeInterval = null

if (useStore && makeInMemoryStore) {
    try {
        store = makeInMemoryStore({ logger })
        store?.readFromFile('./session.json')
        storeInterval = setInterval(() => {
            store?.writeToFile('./session.json')
        }, 60000)
    } catch (error) {
        console.warn('Store init failed:', error.message)
        store = undefined
    }
} else if (useStore) {
    console.warn('Store disabled - makeInMemoryStore unavailable')
}

const msgRetryCounterCache = new NodeCache()

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})
const question = text => new Promise(resolve => rl.question(text, resolve))

const { CONNECTING } = ws
const { chain } = lodash
const PORT = process.env.PORT || process.env.SERVER_PORT || 3000

protoType()
serialize()

global.API = (name, path = '/', query = {}, apikeyqueryname) =>
  (name in global.APIs ? global.APIs[name] : name) +
  path +
  (query || apikeyqueryname
    ? '?' +
      new URLSearchParams(
        Object.entries({
          ...query,
          ...(apikeyqueryname
            ? {
                [apikeyqueryname]: global.APIKeys[name in global.APIs ? global.APIs[name] : name],
              }
            : {}),
        })
      )
    : '')

global.timestamp = { start: new Date() }

const __dirname = global.__dirname(import.meta.url)
global.opts = new Object(yargs(process.argv.slice(2)).exitProcess(false).parse())
global.prefix = new RegExp(
  '^[' +
    (process.env.PREFIX || '*/i!#$%+£¢€¥^°=¶∆×÷π√✓©®:;?&.\\-.@').replace(
      /[|\\{}()[\]^$+*?.\-\^]/g,
      '\\$&'
    ) +
    ']'
)

global.db = {
  data: {
    users: {},
    chats: {},
    stats: {},
    msgs: {},
    sticker: {},
    settings: {},
  },
  chain: null,
  READ: false,
  write: async function() { return Promise.resolve() },
  read: async function() { return Promise.resolve() }
}

global.db.chain = chain(global.db.data)
global.DATABASE = global.db

global.loadDatabase = async function loadDatabase() {
  if (global.db.data !== null) return global.db.data
  return global.db.data
}

loadDatabase()

global.authFolder = `session`

const { state, saveCreds } = await useMultiFileAuthState(global.authFolder)

const connectionOptions = {
  version: [2, 3000, 1015901307],
  logger: Pino({ level: 'fatal' }),
  printQRInTerminal: !pairingCode,
  browser: ['chrome (linux)', '', ''],
  auth: {
    creds: state.creds,
    keys: makeCacheableSignalKeyStore(state.keys, Pino().child({ level: 'fatal', stream: 'store' })),
  },
  markOnlineOnConnect: true,
  generateHighQualityLinkPreview: true,
  getMessage: async key => {
    let jid = jidNormalizedUser(key.remoteJid)
    let msg = await store?.loadMessage(jid, key.id)
    return msg?.message || ''
  },
  patchMessageBeforeSending: message => {
    const requiresPatch = !!(
      message.buttonsMessage ||
      message.templateMessage ||
      message.listMessage
    )
    if (requiresPatch) {
      message = {
        viewOnceMessage: {
          message: {
            messageContextInfo: {
              deviceListMetadataVersion: 2,
              deviceListMetadata: {},
            },
            ...message,
          },
        },
      }
    }
    return message
  },
  msgRetryCounterCache,
  defaultQueryTimeoutMs: undefined,
  syncFullHistory: false,
}

global.conn = makeWASocket(connectionOptions)
conn.isInit = false
if (store && typeof store.bind === 'function') {
  store.bind(conn.ev)
}

if (pairingCode && !conn.authState.creds.registered) {
  let phoneNumber
  if (!!global.pairingNumber) {
    phoneNumber = global.pairingNumber.replace(/[^0-9]/g, '')
    if (!Object.keys(PHONENUMBER_MCC).some(v => phoneNumber.startsWith(v))) {
      console.log(chalk.bgBlack(chalk.redBright("Start with country code, Example: 254xxx")))
      process.exit(0)
    }
  } else {
    phoneNumber = await question(chalk.bgBlack(chalk.greenBright(`WhatsApp number: `)))
    phoneNumber = phoneNumber.replace(/[^0-9]/g, '')
    if (!Object.keys(PHONENUMBER_MCC).some(v => phoneNumber.startsWith(v))) {
      console.log(chalk.bgBlack(chalk.redBright("Start with country code, Example: 254xxx")))
      phoneNumber = await question(chalk.bgBlack(chalk.greenBright(`WhatsApp number: `)))
      phoneNumber = phoneNumber.replace(/[^0-9]/g, '')
      rl.close()
    }
  }

  setTimeout(async () => {
    let code = await conn.requestPairingCode(phoneNumber)
    code = code?.match(/.{1,4}/g)?.join('-') || code
    console.log(chalk.bold.greenBright('Pairing Code: ') + chalk.bgGreenBright(chalk.black(code)))
  }, 3000)
}

conn.logger.info('\n🦄 Waiting for login...\n')

if (global.opts['server']) (await import('./server.js')).default(global.conn, PORT)

let cleanupTimeout
function runCleanup() {
  clearTmp()
    .then(() => console.log('✅ Temp cleanup done'))
    .catch(error => console.error('⚠️ Cleanup error:', error.message))
    .finally(() => {
      cleanupTimeout = setTimeout(runCleanup, 120000)
    })
}

runCleanup()

function clearsession() {
  try {
    const directorio = readdirSync('./session')
    const filesFolderPreKeys = directorio.filter(file => file.startsWith('pre-key-'))
    filesFolderPreKeys.forEach(files => unlinkSync(`./session/${files}`))
  } catch (error) {}
}

let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 5
let reconnectTimeout = null

async function connectionUpdate(update) {
  const { connection, lastDisconnect, isNewLogin, qr } = update
  global.stopped = connection

  if (isNewLogin) conn.isInit = true

  const code =
    lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.output?.payload?.statusCode
  
  const reason = lastDisconnect?.error?.message || 'Unknown'

  if (!pairingCode && useQr && qr !== 0 && qr !== undefined) {
    conn.logger.info(chalk.yellow('🔐 QR ready'))
  }

  if (connection === 'open') {
    reconnectAttempts = 0
    const { jid, name } = conn.user
    const msg = `🦄 *Unicorn MD is Live!*\n\nHello ${name}! ✅\n\n📅 Jan 2026\n🔧 Silva Tech Inc.\n\n📢 Updates:\nhttps://whatsapp.com/channel/0029VaAkETLLY6d8qhLmZt2v`

    try {
      await conn.sendMessage(jid, { text: msg, mentions: [jid] }, { quoted: null })
      conn.logger.info(chalk.green('\n✅ UNICORN 🦄 ONLINE!\n'))
    } catch (error) {
      conn.logger.error('Welcome msg error:', error.message)
    }
  }

  if (connection === 'close') {
    console.log(chalk.yellow(`\n⚠️ Closed. Code: ${code}, Reason: ${reason}`))
    
    if (code === DisconnectReason.loggedOut) {
      console.error(chalk.red('\n❌ LOGGED OUT! Generate NEW session ID\n'))
      return
    }
    
    if (code === DisconnectReason.badSession) {
      console.error(chalk.red('\n❌ BAD SESSION! Generate NEW session ID\n'))
      return
    }

    if (code === DisconnectReason.connectionReplaced) {
      console.error(chalk.red('\n❌ CONNECTION REPLACED!\n'))
      return
    }
    
    if (code === DisconnectReason.restartRequired) {
      console.log(chalk.yellow('🔄 Restart in 3s'))
      if (reconnectTimeout) clearTimeout(reconnectTimeout)
      reconnectTimeout = setTimeout(async () => {
        await global.reloadHandler(true)
      }, 3000)
      return
    }

    if (code === DisconnectReason.connectionClosed || code === DisconnectReason.connectionLost) {
      reconnectAttempts++
      if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
        const backoff = 3000 * reconnectAttempts
        console.log(chalk.yellow(`🔄 Reconnect ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${backoff/1000}s`))
        if (reconnectTimeout) clearTimeout(reconnectTimeout)
        reconnectTimeout = setTimeout(async () => {
          await global.reloadHandler(true)
        }, backoff)
        return
      } else {
        console.error(chalk.red('\n❌ Max reconnects reached\n'))
        return
      }
    }

    if (code === DisconnectReason.timedOut) {
      console.log(chalk.yellow('⏱️ Timeout. Reconnect in 2s'))
      if (reconnectTimeout) clearTimeout(reconnectTimeout)
      reconnectTimeout = setTimeout(async () => {
        await global.reloadHandler(true)
      }, 2000)
      return
    }

    if (code === 401 || code === 403 || !code) {
      console.error(chalk.red('\n❌ AUTH FAILED! Generate NEW session ID\n'))
      return
    }

    console.error(chalk.yellow(`⚠️ Unexpected disconnect: ${code}`))
  }
}

process.on('uncaughtException', (error) => {
  console.error(chalk.red('❌ Exception:'), error.message)
})

process.on('unhandledRejection', (reason) => {
  console.error(chalk.red('❌ Rejection:'), reason)
})

let isInit = true
let handler = await import('./handler.js')

global.reloadHandler = async function (restatConn) {
  try {
    const Handler = await import(`./handler.js?update=${Date.now()}`).catch(console.error)
    if (Object.keys(Handler || {}).length) handler = Handler
  } catch (error) {
    console.error('Handler reload error:', error)
  }
  
  if (restatConn) {
    const oldChats = global.conn.chats
    try { global.conn.ws.close() } catch {}
    
    conn.ev.removeAllListeners()
    
    global.conn = makeWASocket(connectionOptions, { chats: oldChats })
    isInit = true
  }
  
  if (!isInit) {
    conn.ev.off('messages.upsert', conn.handler)
    conn.ev.off('messages.update', conn.pollUpdate)
    conn.ev.off('group-participants.update', conn.participantsUpdate)
    conn.ev.off('groups.update', conn.groupsUpdate)
    conn.ev.off('message.delete', conn.onDelete)
    conn.ev.off('presence.update', conn.presenceUpdate)
    conn.ev.off('connection.update', conn.connectionUpdate)
    conn.ev.off('creds.update', conn.credsUpdate)
  }

  conn.welcome = `🦄✨ Welcome @user to *@group*!`
  conn.bye = `💨 @user left`
  conn.spromote = `🛡️ *@user* is now Admin!`
  conn.sdemote = `⚔️ *@user* demoted`
  conn.sDesc = `📝 Desc: @desc`
  conn.sSubject = `🔮 Name: @group`
  conn.sIcon = `🖼️ New icon!`
  conn.sRevoke = `🔗 Link: @revoke`
  conn.sAnnounceOn = `🚪 CLOSED - Admins only`
  conn.sAnnounceOff = `🎊 OPEN - Everyone can speak`
  conn.sRestrictOn = `🛠️ Admins only edit`
  conn.sRestrictOff = `🛠️ All can edit`

  conn.handler = handler.handler.bind(global.conn)
  conn.pollUpdate = handler.pollUpdate.bind(global.conn)
  conn.participantsUpdate = handler.participantsUpdate.bind(global.conn)
  conn.groupsUpdate = handler.groupsUpdate.bind(global.conn)
  conn.onDelete = handler.deleteUpdate.bind(global.conn)
  conn.presenceUpdate = handler.presenceUpdate.bind(global.conn)
  conn.connectionUpdate = connectionUpdate.bind(global.conn)
  conn.credsUpdate = saveCreds.bind(global.conn, true)

  conn.ev.on('messages.upsert', conn.handler)
  conn.ev.on('messages.update', conn.pollUpdate)
  conn.ev.on('group-participants.update', conn.participantsUpdate)
  conn.ev.on('groups.update', conn.groupsUpdate)
  conn.ev.on('message.delete', conn.onDelete)
  conn.ev.on('presence.update', conn.presenceUpdate)
  conn.ev.on('connection.update', conn.connectionUpdate)
  conn.ev.on('creds.update', conn.credsUpdate)
  isInit = false
  return true
}

const pluginFolder = global.__dirname(join(__dirname, './unicorn-md/index'))
const pluginFilter = filename => /\.js$/.test(filename)
global.plugins = {}

async function filesInit() {
  for (const filename of readdirSync(pluginFolder).filter(pluginFilter)) {
    try {
      const file = global.__filename(join(pluginFolder, filename))
      const module = await import(file)
      global.plugins[filename] = module.default || module
    } catch (e) {
      conn.logger.error(e)
      delete global.plugins[filename]
    }
  }
}

filesInit().then(_ => Object.keys(global.plugins)).catch(console.error)

let pluginWatcher
global.reload = async (_ev, filename) => {
  if (pluginFilter(filename)) {
    const dir = global.__filename(join(pluginFolder, filename), true)
    if (filename in global.plugins) {
      if (existsSync(dir)) conn.logger.info(`\n🦄 Updated: '${filename}'`)
      else {
        conn.logger.warn(`\n🦄 Deleted: '${filename}'`)
        return delete global.plugins[filename]
      }
    } else conn.logger.info(`\n🦄 New: '${filename}'`)
    const err = syntaxerror(readFileSync(dir), filename, {
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
    })
    if (err) conn.logger.error(`\n🦄 Syntax error: '${filename}'\n${format(err)}`)
    else {
      try {
        const module = await import(`${global.__filename(dir)}?update=${Date.now()}`)
        global.plugins[filename] = module.default || module
      } catch (e) {
        conn.logger.error(`\n🦄 Error: '${filename}\n${format(e)}'`)
      } finally {
        global.plugins = Object.fromEntries(
          Object.entries(global.plugins).sort(([a], [b]) => a.localeCompare(b))
        )
      }
    }
  }
}

Object.freeze(global.reload)
pluginWatcher = watch(pluginFolder, global.reload)
await global.reloadHandler()

async function _quickTest() {
  const test = await Promise.all(
    [
      spawn('ffmpeg'),
      spawn('ffprobe'),
      spawn('ffmpeg', ['-hidebanner', '-loglevel', 'error', '-filter_complex', 'color', '-frames:v', '1', '-f', 'webp', '-']),
      spawn('convert'),
      spawn('magick'),
      spawn('gm'),
      spawn('find', ['--version']),
    ].map(p => {
      return Promise.race([
        new Promise(resolve => p.on('close', code => resolve(code !== 127))),
        new Promise(resolve => p.on('error', _ => resolve(false))),
      ])
    })
  )
  const [ffmpeg, ffprobe, ffmpegWebp, convert, magick, gm, find] = test
  global.support = { ffmpeg, ffprobe, ffmpegWebp, convert, magick, gm, find }
  Object.freeze(global.support)
}

let sessionCleanupInterval
async function saafsafai() {
  if (global.stopped === 'close' || !conn || !conn.user) return
  clearsession()
  console.log(chalk.cyanBright('♻️ Session cleaned'))
}

sessionCleanupInterval = setInterval(saafsafai, 600000)

_quickTest().catch(console.error)

async function gracefulShutdown() {
  console.log('\n🦄 Shutting down...')
  
  if (storeInterval) clearInterval(storeInterval)
  if (sessionCleanupInterval) clearInterval(sessionCleanupInterval)
  if (cleanupTimeout) clearTimeout(cleanupTimeout)
  if (reconnectTimeout) clearTimeout(reconnectTimeout)
  if (pluginWatcher) pluginWatcher.close()
  if (rl) rl.close()
  
  if (global.conn?.ws) {
    try { global.conn.ws.close() } catch (e) {}
  }
  
  if (global.conn?.ev) {
    global.conn.ev.removeAllListeners()
  }
  
  console.log('✅ Cleanup done')
  process.exit(0)
}

process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT', gracefulShutdown)
