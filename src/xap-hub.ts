#! /usr/bin/env node
import os = require('os')
import dgram = require('dgram')

import { xAP } from 'xap-framework'
import { xAPnetAddress } from 'xap-net-address'
import minimist from 'minimist'

export module xaphub {

  let platform = os.platform()

  let clientSock: dgram.Socket
  let txSock: dgram.Socket
  let rxSock: dgram.Socket
  let rxSock2: dgram.Socket

  let hbTimer: NodeJS.Timer
  let connected: boolean = false
  let logLevel = 0

  let defaultIP = ''
  let broadcastIP = ''
  let localIP = '127.0.0.1'

  //
  // Build the xAP Heartbeat message for the hub itself
  // Sent out at regular intervals
  //
  function buildHubHeartbeat(hbStatus: 'alive' | 'stopped' = 'alive') {

    const hbClass = `xap-hbeat.${hbStatus}`
    const hbSource = `xFx.HubJS.${os.hostname}`
    const hbUID = xAP.generateUID13(hbSource)

    return new xAP.block(
      'xap-hbeat',
      {
        v: 13,
        hop: 1,
        uid: hbUID,
        class: hbClass,
        source: hbSource,
        interval: 60
      }
    ).toString()
  }

  let hubHeartbeat = buildHubHeartbeat()

  //
  // Add, refresh and prune the client list based on incoming heartbeats
  //
  function maintainClientList(heartbeat: xAP.heartbeatItems) {
    let port = heartbeat.port
    if(port) {
      let interval = heartbeat.interval
      let hbClass = heartbeat.class
      let c = clients.find((c) => { return c.port == port })
      if(c) {
        if(hbClass == 'xap-hbeat.alive') {
          // refresh client entry
          c.lastSeen = Date.now()
          c.interval = interval
          c.active = true
          log(2, `client ${heartbeat.source} refresh on port ${c.port}`)
        }
        else if(hbClass == 'xap-hbeat.stopped') {
          // client stopped
          c.lastSeen = Date.now()
          c.active = false
          log(1, `client ${heartbeat.source} on port ${c.port} stopped`)
        }
      } else {
        if(hbClass == 'xap-hbeat.alive') {
          // new client entry
          let now = Date.now()
          log(1, `new client ${heartbeat.source} on port ${port}`)
          clients.push( { port: port, interval: interval, lastSeen: now, active: true } )
          sendHeartbeatClient(port)        }
      }
    }
  }

  //
  // Pass on a received xAP message to all connected clients
  //
  async function forwardMessageToClients(buffer: Buffer) {
    let now = Date.now()
    clients.forEach(
      (c) => { 
        if(c.active) {
          if(now - c.lastSeen < c.interval * 2000) {
            log(4, `  forward to client on port ${c.port}`)
            clientSock.send(buffer, c.port, 'localhost', (error, bytesSent) => {
              if(error) { console.error(error.message) } else { log(5, `    sent ${bytesSent} bytes`) }
            })
          } else {
            // stale client entry
            let d = new Date(c.lastSeen)
            log(1, `client on port ${c.port} last seen at ${d.toLocaleTimeString()} marked inactive`)
            c.active = false
          }
        }
      }
    )
  }

  function sendNetworkAsync(buf: Buffer): Promise<number> {
    // Wrap send in a promise so that it can be awaited if required
    const promise = new Promise<number>((resolve, reject) => {
      txSock.send(buf, 3639, broadcastIP, (error, bytesSent) => {
        if(error) { reject(error) } else { resolve(bytesSent) }
      })
    })
    return promise
  }

  function sendClientAsync(buf: Buffer, port: number): Promise<number> {
    // Wrap send in a promise so that it can be awaited if required
    const promise = new Promise<number>((resolve, reject) => {
      clientSock.send(buf, port, 'localhost', (error, bytesSent) => {
        if(error) { reject(error) } else { resolve(bytesSent) }
      })
    })
    return promise
  }

  function sendHeartbeat() {
    sendNetworkAsync(Buffer.alloc(hubHeartbeat.length, hubHeartbeat))
  }

  function sendHeartbeatClient(port: number) {
    sendClientAsync(Buffer.alloc(hubHeartbeat.length, hubHeartbeat), port)
  }

  function log(level: number, msg: string) : void {
    if(level <= logLevel) { console.log(`${new Date().toLocaleString()} xAP hub: ${msg}`) }
  }

  export function start() {

    function onSockListening(this: dgram.Socket): void {
      const address = this.address()
      log(1, `socket bound to ${address.address}:${address.port}`)
    }

    function onRxSockListening(this: dgram.Socket): void {
      onSockListening.call(this)
      connected = true
      sendHeartbeat()
      hbTimer = setInterval(sendHeartbeat, 60000)
    }

    function onClientReceive(this: dgram.Socket, rawMsg: Buffer, remote: dgram.AddressInfo): void {
      if(connected) {
        const localAddress = this.address()
        log(3, `forward msg from ${remote.address}:${remote.port} on ${localAddress.address}:${localAddress.port} to ${broadcastIP}:3639`)
        txSock.send(rawMsg, 3639, broadcastIP, (error, bytesSent) => {
          if(error) { console.error(error.message) } else { log(5, `    sent ${bytesSent} bytes`) }
        })
      }
    }

    function onNetReceive(this: dgram.Socket, rawMsg: Buffer, remote: dgram.AddressInfo): void {
      if(connected) {
        const address = this.address()
        log(3, `got msg from ${remote.address}:${remote.port} on ${address.address}:${address.port}`)

        if(remote.address == defaultIP) {
          // parse the received text into xAP message blocks
          let blocks = xAP.parseBlocks(rawMsg.toString())

          if(blocks.length > 0) {
            // get the name of the first block, the header
            let headerName = blocks[0].name.toLowerCase()

            if (headerName == 'xap-hbeat') { 
              let hb = xAP.parseHeartbeatItems(blocks[0])
              if(hb != null) { maintainClientList(hb) }
            }
          }
        }
        forwardMessageToClients(rawMsg)
      }
    }

    function onSocketError(err: any): void {
      if(err.code == 'EADDRINUSE') {
        console.error(`xAP hub: The xAP port ${err.port} on ${err.address} is already in use. Is there another hub running?`)
        process.exit(1)
      }
      else {
        console.error(`${err.code} ${err.message}`)
        process.exit(1)
      }      
    }


    // All set up. Now start listening for xAP messages on the local and network ports
    // Configuration differs by platform

    if(platform == 'win32') {
      // Sockets bind to a port on a network interface

      clientSock = dgram.createSocket('udp4')
      rxSock = dgram.createSocket('udp4')
      txSock = rxSock

      clientSock.on('error', onSocketError)
      clientSock.on('listening', onSockListening)
      clientSock.on('message', onClientReceive)

      rxSock.on('error', onSocketError)
      rxSock.on('listening', onRxSockListening) // send heartbeat
      rxSock.on('message', onNetReceive)

      clientSock.bind(3639, 'localhost')
      rxSock.bind(3639, defaultIP)
    }

    else if(platform == 'linux') {
      // sockets bind to a port on an IP address

      clientSock = dgram.createSocket('udp4')
      txSock = dgram.createSocket('udp4')
      rxSock = dgram.createSocket('udp4')
      rxSock2 = dgram.createSocket('udp4')

      clientSock.on('error', onSocketError)
      clientSock.on('listening', onSockListening)
      clientSock.on('message', onClientReceive)

      txSock.on('error', onSocketError)
      txSock.on('listening', onSockListening)

      rxSock.on('error', onSocketError)
      rxSock.on('listening', onRxSockListening) // send heartbeat
      rxSock.on('message', onNetReceive)
      
      rxSock2.on('error', onSocketError)
      rxSock2.on('listening', onSockListening)
      rxSock2.on('message', onNetReceive)

      clientSock.bind(3639, 'localhost')
      txSock.bind(0, defaultIP, function(this: dgram.Socket) { this.setBroadcast(true) } )
      rxSock.bind(3639, broadcastIP)
      rxSock2.bind(3639, '255.255.255.255')

    }    
  }

  export async function stop() {
    if (connected) {
      connected = false // stop processing incoming messages
      clearInterval(hbTimer) // stop sending heartbeats

      hubHeartbeat = buildHubHeartbeat('stopped') // reconfigure our heartbeat with class 'stopped'
      const hbBuf = Buffer.alloc(hubHeartbeat.length, hubHeartbeat)

      try {
        log(4, `sending closing heartbeat on network`)
        let n = await sendNetworkAsync(hbBuf)
        log(5, `  sent ${n} bytes`)
      } catch(e) {
        console.error(e)
      }

      for await (const c of clients) {
        if(c.active) {
          try {
            log(4, `sending closing heartbeat to client on port ${c.port}`)
            let n = await sendClientAsync(hbBuf, c.port)
            log(5, `  sent ${n} bytes`)
          } catch(e) {
            console.error(e)
          }
        }
      }
    }
  }

  /////////////////////////////////////////////////////////////////////////////

  //
  // Record to hold details of each client
  //
  interface clientRecord {
    port: number,
    interval: number,
    lastSeen: number,
    active: boolean
  }

  //
  // Array of client records
  //
  let clients: clientRecord[] = [];

  //
  // parse command line arguments using Minimist library
  //
  const argv = minimist(process.argv.slice(2)) 

  //
  // One command line option -v, the log level (verbosity)
  //
  if(argv.v) {
    logLevel = 0 + argv.v
  }

  //
  // Calculate the addresses for the hub to use
  //
  try {
    // get the default IP address (receive)
    const addr = xAPnetAddress.defaultIP()
    if(addr) { defaultIP = addr.toString() }

    // get the default broadcast IP address (transmit)
    const broadcast = xAPnetAddress.defaultBroadcastIP()
    if(broadcast) { broadcastIP = broadcast.toString() }

    if(!addr || !broadcast) {
      console.error('xAP hub: Could not determine network address to use - is there a network?')
      process.exit(1)
    }
  } catch {
    console.error('xAP hub: Exception thrown: default gateway could not be determined - is there a network?')
    process.exit(1)
  }

  //
  // Catch SIGINT (ctrl-C) to stop the hub
  //
  process.on('SIGINT', () => {
    console.log('xAP hub: Received SIGINT. Stopping...')
    xaphub.stop().then(() => { process.exit(0) })
  })

  //
  // Setup and start hub operations
  // This will continue until SIGINT is received
  //
  xaphub.start()
}
