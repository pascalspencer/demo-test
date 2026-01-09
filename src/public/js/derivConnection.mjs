import { getCurrentToken } from './popupMessages.mjs';

const APP_ID = 120308;
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

class DerivConnection {
  constructor() {
    if (DerivConnection.instance) {
      return DerivConnection.instance;
    }

    this.ws = null;
    this.reqId = 1;
    this.pendingRequests = new Map(); // req_id -> {resolve, reject, timeout}
    this.subscriptions = new Map();   // req_id -> callback 
    this.bufferedRequests = [];       // Requests queued while offline
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.token = null;
    this.pingInterval = null;
    this.tickSubscribers = new Map(); // symbol -> Set of callbacks
    this.activeTickStreams = new Map(); // symbol -> req_id
    this.pocSubscribers = new Map(); // contract_id -> callback

    DerivConnection.instance = this;
    this.connect();
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    console.log(`[DerivConnection] Connecting to ${WS_URL}...`);
    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = this.onOpen.bind(this);
    this.ws.onmessage = this.onMessage.bind(this);
    this.ws.onerror = this.onError.bind(this);
    this.ws.onclose = this.onClose.bind(this);
  }

  onOpen() {
    console.log('[DerivConnection] Connected.');
    this.isConnected = true;
    this.reconnectAttempts = 0;
    this.startPing();

    // Auto-authorize if we have a token
    const storedToken = getCurrentToken();
    if (storedToken) {
      this.authorize(storedToken);
    }

    // Process buffered requests
    if (this.bufferedRequests.length > 0) {
      console.log(`[DerivConnection] Flushing ${this.bufferedRequests.length} queued requests.`);
      while (this.bufferedRequests.length > 0) {
        const { data, resolve, reject, isSubscription } = this.bufferedRequests.shift();
        this.sendRaw(data, resolve, reject, isSubscription);
      }
    }

    // Resubscribe to active tick streams
    this.activeTickStreams.forEach((_, symbol) => {
      console.log(`[DerivConnection] Resubscribing ticks for ${symbol}`);
      this.sendRaw({ ticks: symbol, subscribe: 1 }, null, null, true);
    });
  }

  onMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.error('[DerivConnection] JSON parse error:', e);
      return;
    }

    const reqId = msg.req_id;

    // Handle generic errors
    if (msg.error) {
      // If it's a specific request error, reject the promise
      if (reqId && this.pendingRequests.has(reqId)) {
        const { reject, timeout } = this.pendingRequests.get(reqId);
        clearTimeout(timeout);
        this.pendingRequests.delete(reqId);
        reject(msg.error);
      } else {
        console.warn('[DerivConnection] API Error:', msg.error);
      }
      // Don't return yet, subscriptions might need error context (though usually specific req_id handles it)
    }

    // Handle Ticks
    if (msg.tick) {
      const symbol = msg.tick.symbol;
      // 1. Notify generic subscribers (via subscribeTicks)
      if (this.tickSubscribers.has(symbol)) {
        this.tickSubscribers.get(symbol).forEach(cb => cb(msg.tick));
      }

      // 2. Handle specific subscription promise (if this was the first tick response)
      if (reqId && this.pendingRequests.has(reqId)) {
        const { resolve, timeout } = this.pendingRequests.get(reqId);
        clearTimeout(timeout);
        this.pendingRequests.delete(reqId);
        resolve(msg); // Resolve the initial subscription call with the first tick
      }
      return;
    }

    // Handle Standard Responses
    if (reqId && this.pendingRequests.has(reqId)) {
      const { resolve, timeout } = this.pendingRequests.get(reqId);
      clearTimeout(timeout);
      this.pendingRequests.delete(reqId);
      resolve(msg);
    }
  }

  onError(error) {
    console.error('[DerivConnection] WebSocket Error:', error);
  }

  onClose(event) {
    console.warn('[DerivConnection] Disconnected.', event.reason);
    this.isConnected = false;
    this.stopPing();
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    const delay = Math.min(1000 * (2 ** this.reconnectAttempts), 10000); // Max 10s wait
    console.log(`[DerivConnection] Reconnecting in ${delay}ms...`);
    setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  startPing() {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.isConnected) {
        this.ws.send(JSON.stringify({ ping: 1 }));
      }
    }, 15000);
  }

  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  send(data) {
    return new Promise((resolve, reject) => {
      if (this.isConnected) {
        this.sendRaw(data, resolve, reject, false);
      } else {
        console.warn(`[DerivConnection] Offline. Queuing request:`, data);
        this.bufferedRequests.push({ data, resolve, reject, isSubscription: false });
      }
    });
  }

  sendRaw(data, resolve, reject, isSubscription) {
    const reqId = this.reqId++;
    data.req_id = reqId;

    if (resolve) {
      // Set timeout for 30s
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(reqId)) {
          this.pendingRequests.delete(reqId);
          if (reject) reject(new Error('Request Timeout'));
        }
      }, 30000);

      this.pendingRequests.set(reqId, { resolve, reject, timeout });
    }

    // Track active tick streams for auto-resubscribe
    if (data.ticks && data.subscribe) {
      this.activeTickStreams.set(data.ticks, reqId);
    }

    try {
      this.ws.send(JSON.stringify(data));
    } catch (e) {
      console.error('[DerivConnection] Send failed:', e);
      if (reject) reject(e);
      this.pendingRequests.delete(reqId);
    }
  }

  async authorize(token) {
    this.token = token;
    try {
      const resp = await this.send({ authorize: token });
      console.log('[DerivConnection] Authorized:', resp.authorize?.loginid);
      return resp;
    } catch (e) {
      console.error('[DerivConnection] Auth failed:', e);
      throw e; // Propagate so caller knows
    }
  }

  // Optimized tick subscription that allows multiple listeners for the same symbol
  subscribeTicks(symbol, callback) {
    if (!this.tickSubscribers.has(symbol)) {
      this.tickSubscribers.set(symbol, new Set());
      // Only send the subscribe request if we aren't already listening (or if we are resubscribing)
      this.send({ ticks: symbol, subscribe: 1 }).catch(e => console.warn('Tick sub failed', e));
    }

    this.tickSubscribers.get(symbol).add(callback);

    // Return unsubscribe function
    return () => {
      const subs = this.tickSubscribers.get(symbol);
      if (subs) {
        subs.delete(callback);
        if (subs.size === 0) {
          this.tickSubscribers.delete(symbol);
          this.activeTickStreams.delete(symbol); // Stop auto-resubscribe
          if (this.isConnected) {
            this.send({ forget_all: 'ticks' }).catch(() => { }); // Generic forget for simplicity, or track exact tick ID
          }
        }
      }
    };
  }

  // Subscribe to Proposal Open Contract stream for a specific contract ID
  subscribePOC(contractId, callback) {
    this.pocSubscribers.set(contractId, callback);

    // Send subscription request
    this.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 })
      .catch(e => console.warn('POC sub failed', e));

    return () => {
      this.pocSubscribers.delete(contractId);
      // We don't strictly need to forget_all here if contracts are short-lived, 
      // but good practice might be to send a forget. 
      // For now, relies on server closing finished contracts or explicit forget if added.
      // To be safe we could:
      // this.send({ forget_all: 'proposal_open_contract' ... }) but that kills ALL.
      // Better to just stop listening client side.
    };
  }
}

// Export singleton
const connection = new DerivConnection();
export default connection;
