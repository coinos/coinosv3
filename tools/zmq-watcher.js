// Standalone ZMQ-backed address-notification service for halwallet.
//
// Subscribes to Bitcoin Core's ZMQ rawtx/rawblock streams and pushes a
// `blockchain.scripthash.subscribe` notification to any WebSocket client that
// subscribed to a scripthash a new tx (mempool or block) pays. No historical
// index — just the live tx firehose plus an in-memory map of subscriptions. It
// speaks just enough of the Electrum protocol that the halwallet realtime client
// works against it unchanged (it treats any scripthash notification as "refresh
// authoritative state over REST"). A drop-in stand-in for Fulcrum's push.
//
// The ZMTP 3.0 (NULL) subscriber is adapted from coinos-server lib/zmq.ts, which
// implements the wire protocol directly over a TCP socket (no native zeromq dep).

import net from 'node:net';
import { Transaction } from '@scure/btc-signer';
import { concatBytes } from '@scure/btc-signer/utils.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils.js';

const BC_HOST = process.env.BC_HOST || 'bc';
const RAWTX_PORT = Number(process.env.RAWTX_PORT || 18503);
const RAWBLOCK_PORT = Number(process.env.RAWBLOCK_PORT || 18502);
const WS_PORT = Number(process.env.WS_PORT || 50010);

const enc = new TextEncoder();
const dec = new TextDecoder();

// scripthash (hex) -> Set<ws> of clients watching it.
const subs = new Map();

// Electrum scripthash: sha256(scriptPubKey), reversed, hex.
const scripthashOf = (script) => {
  const h = sha256(script);
  h.reverse();
  return bytesToHex(h);
};

// ---- ZMTP 3.0 NULL SUB (adapted from coinos lib/zmq.ts) -------------------
const greeting = () => {
  const b = new Uint8Array(64);
  b[0] = 0xff; b[9] = 0x7f; b[10] = 3; b[11] = 0;
  b.set(enc.encode('NULL'), 12);
  return b;
};
const frame = (flags, body) => {
  if (body.length <= 0xff) {
    const b = new Uint8Array(2 + body.length);
    b[0] = flags; b[1] = body.length; b.set(body, 2);
    return b;
  }
  const b = new Uint8Array(9 + body.length);
  b[0] = flags | 0x02;
  new DataView(b.buffer).setBigUint64(1, BigInt(body.length));
  b.set(body, 9);
  return b;
};
const command = (name, props = {}) => {
  const parts = [Uint8Array.of(name.length), enc.encode(name)];
  for (const [k, v] of Object.entries(props)) {
    const kb = enc.encode(k), vb = enc.encode(v);
    parts.push(Uint8Array.of(kb.length), kb);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, vb.length);
    parts.push(len, vb);
  }
  return frame(0x04, concatBytes(...parts));
};
const subscribeCommand = (topic) => {
  const t = enc.encode(topic);
  return frame(0x04, concatBytes(Uint8Array.of(9), enc.encode('SUBSCRIBE'), Uint8Array.of(t.length), t));
};
const legacySubscribe = (topic) => frame(0x00, concatBytes(Uint8Array.of(1), enc.encode(topic)));

const startSub = (host, port, topic, onMessage) => new Promise((resolve) => {
  const socket = net.connect({ host, port });
  let buffer = new Uint8Array(0);
  let handshakeDone = false;
  let frames = [];
  let closed = false;
  const done = () => { if (!closed) { closed = true; resolve(); } };

  const processBuffer = () => {
    if (!handshakeDone) {
      if (buffer.length < 64) return;
      buffer = buffer.slice(64);
      handshakeDone = true;
      socket.write(command('READY', { 'Socket-Type': 'SUB' }));
      socket.write(subscribeCommand(topic));
      socket.write(legacySubscribe(topic));
      console.log('zmq subscribed', topic, host + ':' + port);
    }
    while (buffer.length >= 2) {
      const flags = buffer[0];
      let size, header;
      if (flags & 0x02) {
        if (buffer.length < 9) return;
        const v = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        size = Number(v.getBigUint64(1)); header = 9;
      } else {
        size = buffer[1]; header = 2;
      }
      if (buffer.length < header + size) return;
      const body = buffer.slice(header, header + size);
      buffer = buffer.slice(header + size);
      if (flags & 0x04) continue; // command frame (e.g. READY)
      frames.push(body);
      if (flags & 0x01) continue; // more frames follow
      // frames must reset BEFORE delivery: a throwing handler once left the
      // array to swallow the whole firehose (one poisoned tx re-delivered per
      // message, ~170MB/h until the OOM killer took the box's biggest process).
      const msg = frames;
      frames = [];
      if (msg.length >= 2 && dec.decode(msg[0]) === topic) {
        try { onMessage(msg[1]); } catch (e) { console.error('zmq handler error', e.message); }
      }
    }
  };

  socket.on('connect', () => socket.write(greeting()));
  socket.on('data', (d) => {
    buffer = concatBytes(buffer, new Uint8Array(d));
    try { processBuffer(); } catch (e) { console.error('zmq parse error', e.message); }
  });
  socket.on('error', done);
  socket.on('close', done);
});

const TX_OPTS = { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true };

// Push a data-carrying notification to every client watching a scripthash this
// tx pays. The notification includes the matched outputs (vout + value) and the
// confirmed flag, so the client can credit the payment WITHOUT a REST round-trip
// — keeping the rate-limited explorer off the critical path. `confirmed` is true
// when the tx came from a block (rawblock), false from the mempool (rawtx).
const notifyForTx = (raw, confirmed, blockTime) => {
  let tx;
  try { tx = Transaction.fromRaw(raw, TX_OPTS); } catch { return; }
  // btc-signer's .id getter throws "Transaction is not finalized" for inputs
  // it can't classify — the tx is final (it came off the wire), so fall back
  // to hashing the raw bytes ourselves rather than dropping the notification.
  let txid;
  try { txid = tx.id; } catch { try { txid = txidOf(raw); } catch { return; } }
  const byScript = new Map(); // scripthash -> [{ vout, value }]
  for (let i = 0; i < tx.outputsLength; i++) {
    let o;
    try { o = tx.getOutput(i); } catch { continue; }
    if (!o || !o.script) continue;
    const sh = scripthashOf(o.script);
    if (!subs.has(sh)) continue;
    if (!byScript.has(sh)) byScript.set(sh, []);
    byScript.get(sh).push({ vout: i, value: Number(o.amount) });
  }
  for (const [sh, outputs] of byScript) {
    const set = subs.get(sh);
    if (!set) continue;
    const note = JSON.stringify({
      jsonrpc: '2.0',
      method: 'blockchain.scripthash.subscribe',
      params: [sh, txid],
      data: { txid, confirmed: !!confirmed, blockTime: blockTime || 0, outputs },
    }) + '\n';
    let sent = 0;
    for (const ws of set) { try { ws.send(note); sent++; } catch {} }
    console.log(new Date().toISOString(), 'notify', sh.slice(0, 12), 'tx', txid.slice(0, 12), confirmed ? '(conf)' : '(mempool)', '->', sent);
  }
};

// Block parsing (varint + tx-size walk) — also from coinos lib/zmq.ts.
const readVarInt = (data, offset) => {
  const first = data[offset];
  if (first < 0xfd) return { value: first, size: 1 };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (first === 0xfd) return { value: view.getUint16(offset + 1, true), size: 3 };
  if (first === 0xfe) return { value: view.getUint32(offset + 1, true), size: 5 };
  return { value: Number(view.getBigUint64(offset + 1, true)), size: 9 };
};
const rawTxSize = (buf, start) => {
  let o = start;
  o += 4; // version
  const marker = buf[o], flag = buf[o + 1];
  const segwit = marker === 0x00 && flag !== 0x00;
  if (segwit) o += 2;
  const vin = readVarInt(buf, o); o += vin.size;
  for (let i = 0; i < vin.value; i++) { o += 36; const sl = readVarInt(buf, o); o += sl.size + sl.value + 4; }
  const vout = readVarInt(buf, o); o += vout.size;
  for (let i = 0; i < vout.value; i++) { o += 8; const sl = readVarInt(buf, o); o += sl.size + sl.value; }
  if (segwit) {
    for (let i = 0; i < vin.value; i++) {
      const ic = readVarInt(buf, o); o += ic.size;
      for (let j = 0; j < ic.value; j++) { const il = readVarInt(buf, o); o += il.size + il.value; }
    }
  }
  o += 4; // locktime
  return o - start;
};
// txid = sha256d of the tx serialized WITHOUT witness data (BIP-141): for
// segwit txs, excise the marker/flag pair and the witness section.
const stripWitness = (buf) => {
  if (!(buf[4] === 0x00 && buf[5] !== 0x00)) return buf;
  let o = 6;
  const vin = readVarInt(buf, o); o += vin.size;
  for (let i = 0; i < vin.value; i++) { o += 36; const sl = readVarInt(buf, o); o += sl.size + sl.value + 4; }
  const vout = readVarInt(buf, o); o += vout.size;
  for (let i = 0; i < vout.value; i++) { o += 8; const sl = readVarInt(buf, o); o += sl.size + sl.value; }
  const witnessStart = o;
  for (let i = 0; i < vin.value; i++) {
    const ic = readVarInt(buf, o); o += ic.size;
    for (let j = 0; j < ic.value; j++) { const il = readVarInt(buf, o); o += il.size + il.value; }
  }
  return concatBytes(buf.subarray(0, 4), buf.subarray(6, witnessStart), buf.subarray(o));
};
const txidOf = (raw) => bytesToHex(Uint8Array.from(sha256(sha256(stripWitness(raw)))).reverse());

const handleRawBlock = (raw) => {
  // A new block confirms watched txs: walk its txs and notify matching
  // scripthashes with confirmed=true + the block time (header bytes 68..71, LE).
  const blockTime = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(68, true);
  let offset = 80; // skip header
  const txCount = readVarInt(raw, offset);
  offset += txCount.size;
  for (let i = 0; i < txCount.value; i++) {
    const size = rawTxSize(raw, offset);
    const txRaw = raw.subarray(offset, offset + size);
    offset += size;
    try { notifyForTx(txRaw, true, blockTime); } catch {}
  }
};

const retry = async (host, port, topic, handler) => {
  let delay = 2000;
  for (;;) {
    await startSub(host, port, topic, handler);
    console.warn('zmq disconnected, retrying', topic);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(30000, Math.floor(delay * 1.5));
  }
};

retry(BC_HOST, RAWTX_PORT, 'rawtx', (raw) => notifyForTx(raw, false));
retry(BC_HOST, RAWBLOCK_PORT, 'rawblock', handleRawBlock);

// ---- minimal Electrum WS server -------------------------------------------
const reply = (ws, id, result) => {
  try { ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); } catch {}
};
const handleReq = (ws, line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg || {};
  if (method === 'server.version') return reply(ws, id, ['halwallet-zmq 1.0', '1.4']);
  if (method === 'server.ping') return reply(ws, id, null);
  if (method === 'blockchain.scripthash.subscribe') {
    const sh = params && params[0];
    if (typeof sh === 'string') {
      ws.data.shes.add(sh);
      let set = subs.get(sh);
      if (!set) { set = new Set(); subs.set(sh, set); }
      set.add(ws);
    }
    return reply(ws, id, null); // no real status; notifications drive the refresh
  }
  if (method === 'blockchain.scripthash.unsubscribe') {
    const sh = params && params[0];
    if (sh) {
      ws.data.shes.delete(sh);
      const set = subs.get(sh);
      if (set) { set.delete(ws); if (!set.size) subs.delete(sh); }
    }
    return reply(ws, id, true);
  }
  return reply(ws, id, null);
};

Bun.serve({
  port: WS_PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response('halwallet zmq-electrum watcher\n');
  },
  websocket: {
    open(ws) { ws.data = { buf: '', shes: new Set() }; },
    message(ws, message) {
      ws.data.buf += (typeof message === 'string' ? message : new TextDecoder().decode(message));
      let nl;
      while ((nl = ws.data.buf.indexOf('\n')) >= 0) {
        const line = ws.data.buf.slice(0, nl).trim();
        ws.data.buf = ws.data.buf.slice(nl + 1);
        if (line) handleReq(ws, line);
      }
    },
    close(ws) {
      for (const sh of ws.data.shes) {
        const set = subs.get(sh);
        if (set) { set.delete(ws); if (!set.size) subs.delete(sh); }
      }
    },
  },
});
console.log('halwallet zmq-electrum watcher: ws listening on', WS_PORT, '| bc', BC_HOST + ':' + RAWTX_PORT + '/' + RAWBLOCK_PORT);
