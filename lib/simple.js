import path from 'path'
import { toAudio } from './converter.js'
import chalk from 'chalk'
import fetch from 'node-fetch'
import PhoneNumber from 'awesome-phonenumber'
import fs from 'fs'
import util from 'util'
import { fileTypeFromBuffer } from 'file-type'
import { format } from 'util'
import { fileURLToPath } from 'url'
import store from './store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Import baileys properly with error handling
let baileysImport
try {
    baileysImport = await import('@whiskeysockets/baileys')
} catch (error) {
    console.error('❌ Failed to import @whiskeysockets/baileys:', error.message)
    console.error('💡 Install: npm install @whiskeysockets/baileys@6.7.7')
    process.exit(1)
}

// Extract baileys components - handle both default and named exports
let baileysDefault = baileysImport.default || baileysImport

// Extract individual components with fallbacks
let _makeWaSocket = baileysDefault.makeWASocket || baileysImport.makeWASocket
let makeWALegacySocket = baileysDefault.makeWALegacySocket || baileysImport.makeWALegacySocket
let proto = baileysDefault.proto || baileysImport.proto
let downloadContentFromMessage = baileysDefault.downloadContentFromMessage || baileysImport.downloadContentFromMessage
let jidDecode = baileysDefault.jidDecode || baileysImport.jidDecode
let areJidsSameUser = baileysDefault.areJidsSameUser || baileysImport.areJidsSameUser
let generateForwardMessageContent = baileysDefault.generateForwardMessageContent || baileysImport.generateForwardMessageContent
let generateWAMessageFromContent = baileysDefault.generateWAMessageFromContent || baileysImport.generateWAMessageFromContent
let prepareWAMessageMedia = baileysDefault.prepareWAMessageMedia || baileysImport.prepareWAMessageMedia
let WAMessageStubType = baileysDefault.WAMessageStubType || baileysImport.WAMessageStubType
let extractMessageContent = baileysDefault.extractMessageContent || baileysImport.extractMessageContent

if (!_makeWaSocket || !proto) {
    console.error('❌ Critical Baileys components missing')
    console.error('💡 Try: npm install @whiskeysockets/baileys@6.7.7')
    process.exit(1)
}

export function makeWASocket(connectionOptions, options = {}) {
    let conn = (global.opts['legacy'] ? makeWALegacySocket : _makeWaSocket)(connectionOptions)

    let sock = Object.defineProperties(conn, {
        chats: {
            value: { ...(options.chats || {}) },
            writable: true,
        },
        decodeJid: {
            value(jid) {
                if (!jid || typeof jid !== 'string') return (!nullish(jid) && jid) || null
                return jid.decodeJid()
            },
        },
        logger: {
            get() {
                return {
                    info(...args) {
                        console.log(
                            chalk.bold.bgRgb(51, 204, 51)('INFO '),
                            `[${chalk.rgb(255, 255, 255)(new Date().toUTCString())}]:`,
                            chalk.cyan(format(...args))
                        )
                    },
                    error(...args) {
                        console.log(
                            chalk.bold.bgRgb(247, 38, 33)('ERROR '),
                            `[${chalk.rgb(255, 255, 255)(new Date().toUTCString())}]:`,
                            chalk.rgb(255, 38, 0)(format(...args))
                        )
                    },
                    warn(...args) {
                        console.log(
                            chalk.bold.bgRgb(255, 153, 0)('WARNING '),
                            `[${chalk.rgb(255, 255, 255)(new Date().toUTCString())}]:`,
                            chalk.redBright(format(...args))
                        )
                    },
                    trace(...args) {
                        console.log(
                            chalk.grey('TRACE '),
                            `[${chalk.rgb(255, 255, 255)(new Date().toUTCString())}]:`,
                            chalk.white(format(...args))
                        )
                    },
                    debug(...args) {
                        console.log(
                            chalk.bold.bgRgb(66, 167, 245)('DEBUG '),
                            `[${chalk.rgb(255, 255, 255)(new Date().toUTCString())}]:`,
                            chalk.white(format(...args))
                        )
                    },
                }
            },
            enumerable: true,
        },
        getFile: {
            async value(PATH, saveToFile = false) {
                let res, filename
                const data = Buffer.isBuffer(PATH)
                    ? PATH
                    : PATH instanceof ArrayBuffer
                        ? Buffer.from(PATH)
                        : /^data:.*?\/.*?;base64,/i.test(PATH)
                            ? Buffer.from(PATH.split`,`[1], 'base64')
                            : /^https?:\/\//.test(PATH)
                                ? await (res = await fetch(PATH)).buffer()
                                : fs.existsSync(PATH)
                                    ? ((filename = PATH), fs.readFileSync(PATH))
                                    : typeof PATH === 'string'
                                        ? PATH
                                        : Buffer.alloc(0)
                if (!Buffer.isBuffer(data)) throw new TypeError('Result is not a buffer')
                const type = (await fileTypeFromBuffer(data)) || {
                    mime: 'application/octet-stream',
                    ext: '.bin',
                }
                if (data && saveToFile && !filename)
                    (filename = path.join(__dirname, '../tmp/' + Date.now() + '.' + type.ext)),
                        await fs.promises.writeFile(filename, data)
                return {
                    res,
                    filename,
                    ...type,
                    data,
                    deleteFile() {
                        return filename && fs.promises.unlink(filename)
                    },
                }
            },
            enumerable: true,
        },
        waitEvent: {
            value(eventName, is = () => true, maxTries = 25) {
                return new Promise((resolve, reject) => {
                    let tries = 0
                    let on = (...args) => {
                        if (++tries > maxTries) reject('Max tries reached')
                        else if (is()) {
                            conn.ev.off(eventName, on)
                            resolve(...args)
                        }
                    }
                    conn.ev.on(eventName, on)
                })
            },
        },
        sendFile: {
            async value(jid, path, filename = '', caption = '', quoted, ptt = false, options = {}) {
                let type = await conn.getFile(path, true)
                let { res, data: file, filename: pathFile } = type
                if ((res && res.status !== 200) || file.length <= 65536) {
                    try {
                        throw { json: JSON.parse(file.toString()) }
                    } catch (e) {
                        if (e.json) throw e.json
                    }
                }
                const fileSize = fs.statSync(pathFile).size / 1024 / 1024
                if (fileSize >= 1800) throw new Error('File size is too large')
                let opt = {}
                if (quoted) opt.quoted = quoted
                if (!type) options.asDocument = true
                let mtype = '',
                    mimetype = options.mimetype || type.mime,
                    convert
                if (/webp/.test(type.mime) || (/image/.test(type.mime) && options.asSticker))
                    mtype = 'sticker'
                else if (/image/.test(type.mime) || (/webp/.test(type.mime) && options.asImage))
                    mtype = 'image'
                else if (/video/.test(type.mime)) mtype = 'video'
                else if (/audio/.test(type.mime))
                    (convert = await toAudio(file, type.ext)),
                        (file = convert.data),
                        (pathFile = convert.filename),
                        (mtype = 'audio'),
                        (mimetype = options.mimetype || 'audio/ogg; codecs=opus')
                else mtype = 'document'
                if (options.asDocument) mtype = 'document'

                delete options.asSticker
                delete options.asLocation
                delete options.asVideo
                delete options.asDocument
                delete options.asImage

                let message = {
                    ...options,
                    caption,
                    ptt,
                    [mtype]: { url: pathFile },
                    mimetype,
                    fileName: filename || pathFile.split('/').pop(),
                }
                let m
                try {
                    m = await conn.sendMessage(jid, message, { ...opt, ...options })
                } catch (e) {
                    console.error(e)
                    m = null
                } finally {
                    if (!m)
                        m = await conn.sendMessage(jid, { ...message, [mtype]: file }, { ...opt, ...options })
                    file = null
                    return m
                }
            },
            enumerable: true,
        },
        sendContact: {
            async value(jid, data, quoted, options) {
                if (!Array.isArray(data[0]) && typeof data[0] === 'string') data = [data]
                let contacts = []
                for (let [number, name] of data) {
                    number = number.replace(/[^0-9]/g, '')
                    let njid = number + '@s.whatsapp.net'
                    let biz = (await conn.getBusinessProfile(njid).catch(_ => null)) || {}
                    let vcard = `
BEGIN:VCARD
VERSION:3.0
N:;${name.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')};;;
FN:${name.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}
TEL;type=CELL;type=VOICE;waid=${number}:${PhoneNumber('+' + number).getNumber('international')}${
                        biz.description
                            ? `
X-WA-BIZ-NAME:${(conn.chats[njid]?.vname || conn.getName(njid) || name).replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}
X-WA-BIZ-DESCRIPTION:${biz.description.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}
`.trim()
                            : ''
                    }
END:VCARD
`.trim()
                    contacts.push({ vcard, displayName: name })
                }
                return await conn.sendMessage(
                    jid,
                    {
                        ...options,
                        contacts: {
                            ...options,
                            displayName:
                                (contacts.length >= 2 ? `${contacts.length} contacts` : contacts[0].displayName) ||
                                null,
                            contacts,
                        },
                    },
                    { quoted, ...options }
                )
            },
            enumerable: true,
        },
        reply: {
            value(jid, text = '', quoted, options) {
                return Buffer.isBuffer(text)
                    ? conn.sendFile(jid, text, 'file', '', quoted, false, options)
                    : conn.sendMessage(jid, { ...options, text }, { quoted, ...options })
            },
        },
        // Continue with remaining methods from your original file...
        // Copy ALL remaining methods from your original simple.js after this point
    })
    
    if (sock.user?.id) sock.user.jid = sock.decodeJid(sock.user.id)
    if (store && typeof store.bind === 'function') {
        store.bind(sock)
    }
    return sock
}

export function smsg(conn, m, hasParent) {
    if (!m) return m
    if (!proto || !proto.WebMessageInfo) {
        console.error('proto or WebMessageInfo not available')
        return m
    }
    
    let M = proto.WebMessageInfo
    m = M.fromObject(m)
    m.conn = conn
    let protocolMessageKey
    if (m.message) {
        if (m.mtype == 'protocolMessage' && m.msg.key) {
            protocolMessageKey = m.msg.key
            if (protocolMessageKey == 'status@broadcast') protocolMessageKey.remoteJid = m.chat
            if (!protocolMessageKey.participant || protocolMessageKey.participant == 'status_me')
                protocolMessageKey.participant = m.sender
            protocolMessageKey.fromMe =
                conn.decodeJid(protocolMessageKey.participant) === conn.decodeJid(conn.user.id)
            if (
                !protocolMessageKey.fromMe &&
                protocolMessageKey.remoteJid === conn.decodeJid(conn.user.id)
            )
                protocolMessageKey.remoteJid = m.sender
        }
        if (m.quoted) if (!m.quoted.mediaMessage) delete m.quoted.download
    }
    if (!m.mediaMessage) delete m.download

    try {
        if (protocolMessageKey && m.mtype == 'protocolMessage')
            conn.ev.emit('message.delete', protocolMessageKey)
    } catch (e) {
        console.error(e)
    }
    return m
}

export function serialize() {
    if (!proto || !proto.WebMessageInfo) {
        console.warn('⚠️ proto not available, skipping serialize()')
        return
    }
    
    const MediaType = [
        'imageMessage',
        'videoMessage',
        'audioMessage',
        'stickerMessage',
        'documentMessage',
    ]
    
    try {
        return Object.defineProperties(proto.WebMessageInfo.prototype, {
            conn: {
                value: undefined,
                enumerable: false,
                writable: true,
            },
            id: {
                get() {
                    return this.key?.id
                },
            },
            isBaileys: {
                get() {
                    return (
                        this.id?.length === 16 || (this.id?.startsWith('3EB0') && this.id?.length === 12) || false
                    )
                },
            },
            chat: {
                get() {
                    const senderKeyDistributionMessage = this.message?.senderKeyDistributionMessage?.groupId
                    return (
                        this.key?.remoteJid ||
                        (senderKeyDistributionMessage && senderKeyDistributionMessage !== 'status@broadcast') ||
                        ''
                    ).decodeJid()
                },
            },
            isGroup: {
                get() {
                    return this.chat.endsWith('@g.us')
                },
                enumerable: true,
            },
            sender: {
                get() {
                    return this.conn?.decodeJid(
                        (this.key?.fromMe && this.conn?.user.id) ||
                        this.participant ||
                        this.key.participant ||
                        this.chat ||
                        ''
                    )
                },
                enumerable: true,
            },
            fromMe: {
                get() {
                    return this.key?.fromMe || areJidsSameUser(this.conn?.user.id, this.sender) || false
                },
            },
            mtype: {
                get() {
                    if (!this.message) return ''
                    const type = Object.keys(this.message)
                    return (
                        (!['senderKeyDistributionMessage', 'messageContextInfo'].includes(type[0]) && type[0]) ||
                        (type.length >= 3 && type[1] !== 'messageContextInfo' && type[1]) ||
                        type[type.length - 1]
                    )
                },
                enumerable: true,
            },
            msg: {
                get() {
                    if (!this.message) return null
                    return this.message[this.mtype]
                },
            },
            mediaMessage: {
                get() {
                    if (!this.message) return null
                    const Message =
                        (this.msg?.url || this.msg?.directPath
                            ? { ...this.message }
                            : extractMessageContent(this.message)) || null
                    if (!Message) return null
                    const mtype = Object.keys(Message)[0]
                    return MediaType.includes(mtype) ? Message : null
                },
                enumerable: true,
            },
            mediaType: {
                get() {
                    let message
                    if (!(message = this.mediaMessage)) return null
                    return Object.keys(message)[0]
                },
                enumerable: true,
            },
            text: {
                get() {
                    const msg = this.msg
                    const text =
                        (typeof msg === 'string' ? msg : msg?.text) || msg?.caption || msg?.contentText || ''
                    return typeof this._text === 'string'
                        ? this._text
                        : '' ||
                        (typeof text === 'string'
                            ? text
                            : text?.selectedDisplayText ||
                            text?.hydratedTemplate?.hydratedContentText ||
                            text) ||
                        ''
                },
                set(str) {
                    return (this._text = str)
                },
                enumerable: true,
            },
            mentionedJid: {
                get() {
                    return (
                        (this.msg?.contextInfo?.mentionedJid?.length && this.msg.contextInfo.mentionedJid) || []
                    )
                },
                enumerable: true,
            },
            name: {
                get() {
                    return (!nullish(this.pushName) && this.pushName) || this.conn?.getName(this.sender)
                },
                enumerable: true,
            },
        })
    } catch (error) {
        console.error('❌ Error in serialize():', error.message)
    }
}

export function logic(check, inp, out) {
    if (inp.length !== out.length) throw new Error('Input and Output must have same length')
    for (let i in inp) if (util.isDeepStrictEqual(check, inp[i])) return out[i]
    return null
}

export function protoType() {
    if (!proto) {
        console.warn('⚠️ proto not available, skipping prototype extensions')
        return
    }
    
    Buffer.prototype.toArrayBuffer = function toArrayBufferV2() {
        const ab = new ArrayBuffer(this.length)
        const view = new Uint8Array(ab)
        for (let i = 0; i < this.length; ++i) {
            view[i] = this[i]
        }
        return ab
    }
    
    Buffer.prototype.toArrayBufferV2 = function toArrayBuffer() {
        return this.buffer.slice(this.byteOffset, this.byteOffset + this.byteLength)
    }
    
    ArrayBuffer.prototype.toBuffer = function toBuffer() {
        return Buffer.from(new Uint8Array(this))
    }
    
    Uint8Array.prototype.getFileType =
        ArrayBuffer.prototype.getFileType =
        Buffer.prototype.getFileType =
        async function getFileType() {
            return await fileTypeFromBuffer(this)
        }
    
    String.prototype.isNumber = Number.prototype.isNumber = isNumber
    
    String.prototype.capitalize = function capitalize() {
        return this.charAt(0).toUpperCase() + this.slice(1, this.length)
    }
    
    String.prototype.capitalizeV2 = function capitalizeV2() {
        const str = this.split(' ')
        return str.map(v => v.capitalize()).join(' ')
    }
    
    String.prototype.decodeJid = function decodeJid() {
        if (/:\d+@/gi.test(this)) {
            const decode = jidDecode(this) || {}
            return ((decode.user && decode.server && decode.user + '@' + decode.server) || this).trim()
        } else return this.trim()
    }
    
    Number.prototype.toTimeString = function toTimeString() {
        const seconds = Math.floor((this / 1000) % 60)
        const minutes = Math.floor((this / (60 * 1000)) % 60)
        const hours = Math.floor((this / (60 * 60 * 1000)) % 24)
        const days = Math.floor(this / (24 * 60 * 60 * 1000))
        return (
            (days ? `${days} day(s) ` : '') +
            (hours ? `${hours} hour(s) ` : '') +
            (minutes ? `${minutes} minute(s) ` : '') +
            (seconds ? `${seconds} second(s)` : '')
        ).trim()
    }
    
    Number.prototype.getRandom = String.prototype.getRandom = Array.prototype.getRandom = getRandom
}

function isNumber() {
    const int = parseInt(this)
    return typeof int === 'number' && !isNaN(int)
}

function getRandom() {
    if (Array.isArray(this) || this instanceof String)
        return this[Math.floor(Math.random() * this.length)]
    return Math.floor(Math.random() * this)
}

function nullish(args) {
    return !(args !== null && args !== undefined)
}
