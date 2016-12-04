/// <reference path='../../../third_party/wrtc/wrtc.d.ts' />

/*
 * Pure Node implementation of zork (no freedomjs).
 * Rough lifecycle is to process single word commands such as "ping" until
 * "get" or "give" is received, at which point a p2p proxy session is
 * established and further input is treated as signaling channel messages.
 */

import * as constants from '../../generic_core/constants';
import * as net from 'net';
import * as node_server from '../socks/node/server';
import * as node_socket from '../socks/node/socket';
import * as socks_session from '../socks/session';
import * as wrtc from 'wrtc';

const RTC_PEER_CONFIG = {
  iceServers: [
    {url: 'stun:stun.l.google.com:19302'},
    {url: 'stun:stun1.l.google.com:19302'},
    {url: 'stun:stun.services.mozilla.com'}
  ]
};

// The delimiter for Zork messages is just \n, but using \r?\n allows us to
// handle clients like telnet as well as clients that just use \n.
const MSG_DELIM_RE = /\r?\n/;

const SOCKS_HOST = '0.0.0.0';
const SOCKS_PORT = 9999;

const ZORK_SERVER_PORT_START = 9000;
const ZORK_SERVER_PORT_INCREMENT = 10;
const ZORK_SERVER_BIND_MAXTRIES = 3;
let zorkServerPort = ZORK_SERVER_PORT_START;
let zorkServerBindNtries = 0;
let nconnectionsMade = 0;
let npeersGetting = 0;

interface ParsedCmd {
  id: string;        // e.g. 'ping', 'give', 'get', 'transform', etc.
  source: string;    // e.g. 'transform with caesar'
  tokens: string[];  // e.g. ['transform', 'with', 'caesar']
}

interface Context {
  clientId: number;
  socket: net.Socket;
  mode: string;  // 'give', 'get', or null (still awaiting a 'give' or 'get' command)
  peerConn: any; // using wrtc.RTCPeerConnection upsets tsc
  transformer: any;
}

// Command handlers:

const handleCmdInvalid = (ctx: Context, cmd: ParsedCmd) => {
  ctx.socket.write(`I don't understand that command. (${cmd.id})\n`);
};

const handleCmdPing = (ctx: Context) => {
  ctx.socket.write(`ping\n`);
};

const handleCmdXyzzy = (ctx: Context) => {
  ctx.socket.write(`Nothing happens.\n`);
};

const handleCmdVersion = (ctx: Context) => {
  ctx.socket.write(`${constants.MESSAGE_VERSION}\n`);
};

const handleCmdQuit = (ctx: Context) => {
  ctx.socket.end();
};

const handleCmdGetters = (ctx: Context) => {
  ctx.socket.write(`${npeersGetting}\n`);
};

const handleCmdTransform = (ctx: Context, cmd: ParsedCmd) => {
  const t1 = cmd.tokens[1];
  if (t1 === 'with') {
    ctx.transformer = {name: cmd.tokens[2]};
  } else if (t1 === 'config') {
    const idx = cmd.source.indexOf(' config ') + ' config '.length;
    const config = cmd.source.substring(idx);
    ctx.transformer = {config: config};
  } else {
    ctx.socket.write(`usage: transform (with name|config json)\n`);
  }
};

/*
 * Start giving access to the peer.
 * Create a local socks server and connect it to the peer connection.
 */
const handleCmdGive = (ctx: Context) => {
  console.info(`Got "give" command`);
  ctx.mode = 'give';
  npeersGetting++;
  console.info(`incremented npeersGetting to ${npeersGetting}`);
  ctx.peerConn = new wrtc.RTCPeerConnection(RTC_PEER_CONFIG);
  ctx.peerConn.onicecandidate = (event: any) => {
    const json = JSON.stringify(event);
    console.info(`[give] icecandidate from peerConn`);//: ${json}`);
    if (event.candidate) {
      console.info(`[give] event.candidate -> sending event`);
      ctx.socket.write(`${json}\n`);
    } else {
      console.error(`[give] event.candidate missing, ignoring`);
    }
  }
  // TODO: is it necessary to create initial IGNORED data channel?
  // If so, call it something else? (e.g. DUMMY_CHANNEL_JUST_FOR_INIT?)
  ctx.peerConn.createDataChannel('IGNORED').onopen = () => {
    console.info(`[give] ${ctx.clientId}: datachannel opened`);
    const socksServer = new node_server.NodeSocksServer(SOCKS_HOST, SOCKS_PORT);
    socksServer.onConnection((sessionId: any) => {
      console.info(`[give] ${ctx.clientId}: new socks server connection: ${sessionId}`);
      const channel = ctx.peerConn.createDataChannel(sessionId);
      channel.onclose = () => {
        console.info(`[give] ${sessionId}: datachannel closed (zork client ${ctx.clientId})`);
      };
      return {
        // SOCKS client -> datachannel
        handleDataFromSocksClient: (bytes: ArrayBuffer) => {
          channel.send(bytes);
        },
        // SOCKS client <- datachannel
        onDataForSocksClient: (callback: (buffer: ArrayBuffer) => void) => {
          channel.onmessage = (event: any) => {
            callback(event.data);
          };
          return this;
        },
        handleDisconnect: () => {
          console.info(`[give] ${sessionId}: socks client disconnected, closing datachannel (zork client ${ctx.clientId})`);
          channel.close();
        },
        onDisconnect: (callback: () => void) => {
          // why have both onDisconnect and handleDisconnect? just log this for now:
          console.info(`[give] ${sessionId}: onDisconnect (zork client ${ctx.clientId})`);
          return this;
        }
      };
    }).listen().then(() => {
      console.info(`socks server listening on ${SOCKS_HOST}:${SOCKS_PORT}`);
      console.info(`e.g. curl -x socks5h://${SOCKS_HOST}:${SOCKS_PORT} www.example.com`);
    }, (e: any) => {
      console.error('failed to start SOCKS server', e);
    });
  };
  ctx.peerConn.createOffer((offer: any) => {
    const json = JSON.stringify(offer);
    console.info(`created offer`);//: ${json}`);
    ctx.peerConn.setLocalDescription(offer);
    ctx.socket.write(`${json}\n`);
  }, console.error);
};

/*
 * Start getting access from the peer.
 * Create a socks client and connect it to the peer connection.
 */
const handleCmdGet = (ctx: Context) => {
  console.info(`Got "get" command`);
  ctx.mode = 'get';
  ctx.peerConn = new wrtc.RTCPeerConnection(RTC_PEER_CONFIG);
  ctx.peerConn.onicecandidate = (event: any) => {
    const json = JSON.stringify(event);
    console.info(`[get] icecandidate from peerConn`);//: ${json}`);
    if (event.candidate) {
      console.info('[get] event.candidate -> TODO');
    } else {
      console.error(`[get] event.candidate missing, ignoring`);
    }
  };
  ctx.peerConn.ondatachannel = (event: any) => {
    console.info(`[get] ${ctx.clientId}: ondatachannel`);
    const channel: any = event.channel;
    const sessionId = channel.label;
    const socksSession = new socks_session.SocksSession(sessionId);
    socksSession.onForwardingSocketRequired((host, port) => {
      const forwardingSocket = new node_socket.NodeForwardingSocket();
      return forwardingSocket.connect(host, port).then(() => {
        return forwardingSocket;
      });
    });
    // datachannel -> SOCKS session
    channel.onmessage = (event: any) => {
      socksSession.handleDataFromSocksClient(event.data);
    };
    // datachannel <- SOCKS session
    socksSession.onDataForSocksClient((bytes) => {
      // When too much is buffered, the channel closes/fails.
      // TODO: backpressure!
      const BUFFTHRESHOLD = 16000000;  // 16 megabytes
      if (channel.bufferedAmount < BUFFTHRESHOLD) {
        channel.send(bytes);
      } else {
        console.warn('channel congested, dropping bytes')
      }
    });
    socksSession.onDisconnect(() => {
      console.info(`[get] ${sessionId}: socks session disconnected`);
    });
    channel.onclose = () => {
      console.info(`[get] ${sessionId}: channel closed (giver side)`);
    };
  };
};

const cmdHandlerByCmdId: {[cmdId: string]: (ctx: Context, cmd?: ParsedCmd) => void} = {
  'ping': handleCmdPing,
  'xyzzy': handleCmdXyzzy,
  'version': handleCmdVersion,
  'quit': handleCmdQuit,
  'getters': handleCmdGetters,
  'transform': handleCmdTransform,
  'give': handleCmdGive,
  'get': handleCmdGet
};

const parseCmd = (cmdline: string) : ParsedCmd => {
  const tokens = cmdline.split(/\W+/);
  const cmdId = tokens[0].toLowerCase();
  const parsed = {id: cmdId, tokens: tokens, source: cmdline};
  return parsed;
};


// Message handlers:

const handleMsgForModeGive = (ctx: Context, msg: string) => {
  const parsed = JSON.parse(msg);
  if (parsed.sdp) {
    console.info(`[give] got sdp`);//: ${msg}`);
    ctx.peerConn.setRemoteDescription(parsed);
  } else {
    console.info(`[give] parsed.sdp missing, ignoring msg`);//: ${msg}`);
  }
};

const handleMsgForModeGet = (ctx: Context, msg: string) => {
  const parsed = JSON.parse(msg);
  if (parsed.type === 'icecandidate') {
    console.info(`[get] icecandidate from client ${ctx.clientId}`);//: ${msg}`);
    ctx.peerConn.addIceCandidate(parsed.candidate);
  } else if (parsed.type === 'offer') {
    console.info(`[get] got offer`);//: ${msg}`);
    ctx.peerConn.setRemoteDescription(parsed);
    ctx.peerConn.createAnswer((answer: any) => {
      const answerJson = JSON.stringify(answer);
      console.info(`[get] created answer`);//: ${answerJson}`);
      ctx.peerConn.setLocalDescription(answer);
      ctx.socket.write(`${JSON.stringify(answer)}\n`);
    }, console.error);
  } else {
    console.error(`[get] unexpected msg: ${msg}`);
  }
};

const msgHandlerByMode: {[mode: string]: (ctx: Context, msg: string) => void} = {
  'give': handleMsgForModeGive,
  'get': handleMsgForModeGet
};

const handleMsg = (ctx: Context, msg: string) => {
  if (ctx.mode) {
    const msgHandler = msgHandlerByMode[ctx.mode];
    if (msgHandler) {
      //console.info(`dispatching msg to ${ctx.mode} handler`);//: ${msg}`);
      msgHandler(ctx, msg);
    } else {
      console.error(`no message handler for mode: ${ctx.mode}`);
    }
  } else {
    // Not yet in 'give' or 'get' mode. Treat msg as command.
    const cmd = parseCmd(msg);
    const cmdHandler = cmdHandlerByCmdId[cmd.id] || handleCmdInvalid;
    cmdHandler(ctx, cmd);
  }
};

const zorkServer = net.createServer((client) => {

  const ctx: Context = {
    clientId: nconnectionsMade++,
    socket: client,
    mode: null,
    transformer: null,
    peerConn: null
  };

  console.info(`client ${ctx.clientId} connected`);

  // Handle receiving data from this client.
  // Buffer for partially transmitted messages.
  let buffer = '';

  client.on('data', (data) => {
    const chunk = data.toString();
    const msgs = chunk.split(MSG_DELIM_RE);
    const msgDelimNotFound = msgs.length === 1;
    if (msgDelimNotFound) {
      // No delimiter found means we only have part of a message. Continue
      // adding it to `buffer` (potentially in subsequent callbacks as well)
      // until we do reach a delimiter.
      buffer += chunk;
      return;
    }
    // Message delimiter found. After adding any message parts we buffered
    // previously, we should now have at least one complete message.
    msgs[0] = buffer + msgs[0];
    // If the data we've read off the socket ended with the message delimiter,
    // the last element of `msgs` is empty string.
    // Otherwise, the last element is only part of a message which we will have
    // to reconstruct in a future callback once more data is available.
    // Popping off this last element and setting `buffer` to it handles both
    // cases.
    buffer = msgs.pop();
    // Process the complete messages we've received.
    for (let msg of msgs) {
      handleMsg(ctx, msg);
    }
  });

  client.on('end', () => {
    console.info(`client ${ctx.clientId} disconnected`);
    if (ctx.mode === 'give') {
      npeersGetting--;
      console.info('decremented npeersGetting to', npeersGetting);
    }
    // TODO: any further cleanup necessary to make sure resources allocated
    // for this client will be reclaimed?
  });
});


const tryToBindZorkServerToNextPort = (lastError?: any) => {
  if (lastError) {
    // Handle EADDRINUSE errors by trying to bind to a new port.
    // Don't respond to any other errors.
    if (lastError.errno !== 'EADDRINUSE') {
      return;
    }
    zorkServerPort += ZORK_SERVER_PORT_INCREMENT;
  }
  if (zorkServerBindNtries >= ZORK_SERVER_BIND_MAXTRIES) {
    console.error('Reached ZORK_SERVER_BIND_MAXTRIES, giving up.');
    return;
  }
  console.info('Attempting to bind zork server to port', zorkServerPort);
  zorkServerBindNtries++;
  zorkServer.listen(zorkServerPort);
}
zorkServer.on('error', tryToBindZorkServerToNextPort);
zorkServer.on('listening', () => {
  console.info('zork server listening on port', zorkServerPort);
});
tryToBindZorkServerToNextPort();
