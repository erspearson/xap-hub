"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const os = require("os");
const dgram = require("dgram");
const xap_framework_1 = require("xap-framework");
const xap_net_address_1 = require("xap-net-address");
const minimist_1 = __importDefault(require("minimist"));
var xaphub;
(function (xaphub) {
    let platform = os.platform();
    let clientSock;
    let txSock;
    let rxSock;
    let rxSock2;
    let hbTimer;
    let connected = false;
    let actVerbose = false;
    let actHighlyVerbose = false;
    let logLevel = 0;
    let defaultIP = '';
    let broadcastIP = '';
    let localIP = '127.0.0.1';
    let clients = [];
    function buildHubHeartbeat(hbStatus = 'alive') {
        const hbClass = `xap-hbeat.${hbStatus}`;
        const hbSource = `xFx.HubJS.${os.hostname}`;
        const hbUID = xap_framework_1.xAP.generateUID13(hbSource);
        return new xap_framework_1.xAP.block('xap-hbeat', {
            v: 13,
            hop: 1,
            uid: hbUID,
            class: hbClass,
            source: hbSource,
            interval: 60
        }).toString();
    }
    let hubHeartbeat = buildHubHeartbeat();
    function maintainClientList(heartbeat) {
        let port = heartbeat.port;
        if (port) {
            let interval = heartbeat.interval;
            let hbClass = heartbeat.class;
            let c = clients.find((c) => { return c.port == port; });
            if (c) {
                if (hbClass == 'xap-hbeat.alive') {
                    // refresh client entry
                    c.lastseen = Date.now();
                    c.interval = interval;
                    c.active = true;
                    log(2, `client ${heartbeat.source} refresh on port ${c.port}`);
                }
                else if (hbClass == 'xap-hbeat.stopped') {
                    // client stopped
                    c.lastseen = Date.now();
                    c.active = false;
                    log(1, `client ${heartbeat.source} on port ${c.port} stopped`);
                }
            }
            else {
                if (hbClass == 'xap-hbeat.alive') {
                    // new client entry
                    let now = Date.now();
                    log(1, `new client ${heartbeat.source} on port ${port}`);
                    clients.push({ port: port, interval: interval, lastseen: now, active: true });
                }
            }
        }
    }
    function forwardMessageToClients(buffer) {
        return __awaiter(this, void 0, void 0, function* () {
            let now = Date.now();
            clients.forEach((c) => {
                if (c.active) {
                    if (now - c.lastseen < c.interval * 2000) {
                        clientSock.send(buffer, c.port, 'localhost');
                    }
                    else {
                        // stale client entry
                        let d = new Date(c.lastseen);
                        log(1, `client on port ${c.port} last seen at ${d.toLocaleTimeString()} marked inactive`);
                        c.active = false;
                    }
                }
            });
        });
    }
    function sockSend(sock, msg, addr, port, sent) {
        sock.send(msg, 0, msg.length, port, addr, (e, b) => { sent(b); });
    }
    function sendHubHeartbeat() {
        let promise = new Promise(resolve => { sockSend(txSock, hubHeartbeat, broadcastIP, 3639, resolve); });
        return promise;
    }
    function log(level, msg) {
        if (level <= logLevel) {
            console.log(`${new Date().toLocaleString()} xAP hub: ${msg}`);
        }
    }
    function start() {
        function onSockListening() {
            const address = this.address();
            log(1, `socket bound to ${address.address}:${address.port}`);
        }
        function onRxSockListening() {
            onSockListening.call(this);
            connected = true;
            sendHubHeartbeat();
            hbTimer = setInterval(sendHubHeartbeat, 60000);
        }
        function onClientReceive(rawMsg, remote) {
            const localAddress = this.address();
            log(3, `forward msg from ${remote.address}:${remote.port} on ${localAddress.address}:${localAddress.port} to ${broadcastIP}:3639`);
            txSock.send(rawMsg, 3639, broadcastIP);
        }
        function onNetReceive(rawMsg, remote) {
            const address = this.address();
            log(3, `got msg from ${remote.address}:${remote.port} on ${address.address}:${address.port}`);
            if (remote.address == defaultIP) {
                // parse the received text into xAP message blocks
                let blocks = xap_framework_1.xAP.parseBlocks(rawMsg.toString());
                if (blocks.length > 0) {
                    // get the name of the first block, the header
                    let headerName = blocks[0].name.toLowerCase();
                    if (headerName == 'xap-hbeat') {
                        let hb = xap_framework_1.xAP.parseHeartbeatItems(blocks[0]);
                        if (hb != null) {
                            maintainClientList(hb);
                        }
                    }
                }
            }
            forwardMessageToClients(rawMsg);
        }
        function onSocketError(err) {
            if (err.code == 'EADDRINUSE') {
                console.error(`xAP hub: The xAP port ${err.port} on ${err.address} is already in use. Is there another hub running?`);
                process.exit(1);
            }
            else {
                console.error(`${err.code} ${err.message}`);
                process.exit(1);
            }
        }
        // All set up. Now start listening for xAP messages on the local and network ports
        // Configuration differs by platform
        if (platform == 'win32') {
            // Sockets bind to a port on a network interface
            clientSock = dgram.createSocket('udp4');
            rxSock = dgram.createSocket('udp4');
            txSock = rxSock;
            clientSock.on('error', onSocketError);
            clientSock.on('listening', onSockListening);
            clientSock.on('message', onClientReceive);
            rxSock.on('error', onSocketError);
            rxSock.on('listening', onRxSockListening); // send heartbeat
            rxSock.on('message', onNetReceive);
            clientSock.bind(3639, 'localhost');
            rxSock.bind(3639, defaultIP);
        }
        else if (platform == 'linux') {
            // sockets bind to a port on an IP address
            clientSock = dgram.createSocket('udp4');
            txSock = dgram.createSocket('udp4');
            rxSock = dgram.createSocket('udp4');
            rxSock2 = dgram.createSocket('udp4');
            clientSock.on('error', onSocketError);
            clientSock.on('listening', onSockListening);
            clientSock.on('message', onClientReceive);
            txSock.on('error', onSocketError);
            txSock.on('listening', onSockListening);
            rxSock.on('error', onSocketError);
            rxSock.on('listening', onRxSockListening); // send heartbeat
            rxSock.on('message', onNetReceive);
            rxSock2.on('error', onSocketError);
            rxSock2.on('listening', onSockListening);
            rxSock2.on('message', onNetReceive);
            clientSock.bind(3639, 'localhost');
            txSock.bind(0, defaultIP, function () { this.setBroadcast(true); });
            rxSock.bind(3639, broadcastIP);
            rxSock2.bind(3639, '255.255.255.255');
        }
    }
    xaphub.start = start;
    function stop() {
        return __awaiter(this, void 0, void 0, function* () {
            if (connected) {
                clearInterval(hbTimer);
                hubHeartbeat = buildHubHeartbeat('stopped');
                yield sendHubHeartbeat().then(() => {
                    forwardMessageToClients(new Buffer(hubHeartbeat));
                    connected = false;
                });
            }
        });
    }
    xaphub.stop = stop;
    const argv = minimist_1.default(process.argv.slice(2)); // parse arguments using Minimist library
    if (argv.v) {
        logLevel = 0 + argv.v;
    }
    try {
        // get the default IP address (receive)
        const addr = xap_net_address_1.xAPnetAddress.defaultIP();
        if (addr) {
            defaultIP = addr.toString();
        }
        // get the default broadcast IP address (transmit)
        const broadcast = xap_net_address_1.xAPnetAddress.defaultBroadcastIP();
        if (broadcast) {
            broadcastIP = broadcast.toString();
        }
        if (!addr || !broadcast) {
            console.error('xAP hub: Could not determine network address to use - is there a network?');
            process.exit(1);
        }
    }
    catch (_a) {
        console.error('xAP hub: Exception thrown: default gateway could not be determined - is there a network?');
        process.exit(1);
    }
    process.on('SIGINT', () => {
        console.log('xAP hub: Received SIGINT. Stopping.');
        xaphub.stop().then(() => { process.exit(0); });
    });
    xaphub.start();
})(xaphub = exports.xaphub || (exports.xaphub = {}));
//# sourceMappingURL=xap-hub.js.map