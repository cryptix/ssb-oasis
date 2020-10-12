"use strict";

// This module exports a function that connects to SSB and returns an interface
// to call methods over MuxRPC. It's a thin wrapper around SSB-Client, which is
// a thin wrapper around the MuxRPC module.

const { promisify } = require("util");
const ssbClient = require("ssb-client");
const ssbConfig = require("ssb-config");
const flotilla = require("@fraction/flotilla");
const ssbTangle = require("ssb-tangle");
const debug = require("debug")("oasis");
const path = require("path");
const lodash = require("lodash");

const socketPath = path.join(ssbConfig.path, "socket");
const publicInteger = ssbConfig.keys.public.replace(".ed25519", "");
const remote = `unix:${socketPath}~noauth:${publicInteger}`;

/**
 * @param formatter {string} input
 * @param args {any[]} input
 */
const log = (formatter, ...args) => {
  const isDebugEnabled = debug.enabled;
  debug.enabled = true;
  debug(formatter, ...args);
  debug.enabled = isDebugEnabled;
};

/**
 * @param [options] {object} - options to pass to SSB-Client
 * @returns Promise
 */
const connect = (options) =>
  new Promise((resolve, reject) => {
    const onSuccess = (api) => {
      log('connected')
      resolve(api);
    };

    ssbClient(null, options).then(onSuccess).catch(reject);
  });

let closing = false;
let clientHandle;

/**
 * Attempts connection over Unix socket, falling back to TCP socket if that
 * fails. If the TCP socket fails, the promise is rejected.
 * @returns Promise
 */
const attemptConnection = () =>
  new Promise((resolve, reject) => {
    connect({ remote })
      .then((ssb) => {
        debug("Connected to existing Scuttlebutt service over Unix socket");
        resolve(ssb);
      })
      .catch((e) => {
        if (closing) return;
        debug("Unix socket failed");
        if (e.message !== "could not connect to sbot") {
          throw e;
        }
        connect()
          .then((ssb) => {
            log("Connected to existing Scuttlebutt service over TCP socket");
            resolve(ssb);
          })
          .catch((e) => {
            if (closing) return;
            debug("TCP socket failed");
            if (e.message !== "could not connect to sbot") {
              throw e;
            }
            reject(new Error("Both connection options failed"));
          });
      });
  });

let pendingConnection = null;

const ensureConnection = (customConfig) => {
  if (pendingConnection === null) {
    pendingConnection = new Promise((resolve) => {
      attemptConnection()
            .then((ssb) => {
          resolve(ssb);
        })
        .catch(() => {
          debug("Connection attempts to existing Scuttlebutt services failed");
          log("Starting Scuttlebutt service");


          // Give the server a moment to start. This is a race condition. :/
            setTimeout(() => {
               log('timeout, reconnecting..');
            attemptConnection()
              .then(resolve)
              .catch((e) => {
                throw new Error(e);
              });
          }, 100);
        });
    });

    const cancel = () => (pendingConnection = null);
    pendingConnection.then(cancel, cancel);
  }

  return pendingConnection;
};

module.exports = ({ offline }) => {
  if (offline) {
    log("Offline mode activated - not connecting to scuttlebutt peers or pubs");
    log(
      "WARNING: Oasis can connect to the internet through your other SSB apps if they're running."
    );
  }

  // Make a copy of `ssbConfig` to avoid mutating.
  const customConfig = JSON.parse(JSON.stringify(ssbConfig));

  // This is unnecessary when https://github.com/ssbc/ssb-config/pull/72 is merged
  customConfig.connections.incoming.unix = [
    { scope: "device", transform: "noauth" },
  ];

  // Only change the config if `--offline` is true.
  if (offline === true) {
    lodash.set(customConfig, "conn.autostart", false);
  }

  // Use `conn.hops`, or default to `friends.hops`, or default to `0`.
  lodash.set(
    customConfig,
    "conn.hops",
    lodash.get(ssbConfig, "conn.hops", lodash.get(ssbConfig.friends.hops, 0))
  );

  /**
   * This is "cooler", a tiny interface for opening or reusing an instance of
   * SSB-Client.
   */
  const cooler = {
    open() {
      // This has interesting behavior that may be unexpected.
      //
      // If `clientHandle` is already an active [non-closed] connection, return that.
      //
      // If the connection is closed, we need to restart it. It's important to
      // note that if we're depending on an external service (like Patchwork) and
      // that app is closed, then Oasis will seamlessly start its own SSB service.
      return new Promise((resolve, reject) => {
        if (clientHandle && clientHandle.closed === false) {
          resolve(clientHandle);
        } else {
          ensureConnection(customConfig).then((ssb) => {
            clientHandle = ssb;
            if (closing) {
              cooler.close();
              reject(new Error("Closing Oasis"));
            } else {
              resolve(ssb);
            }
          });
        }
      });
    },
    close() {
      closing = true;
      if (clientHandle && clientHandle.closed === false) {
        clientHandle.close();
      }
    },
  };

  // Important: This ensures that we have an SSB connection as soon as Oasis
  // starts. If we don't do this, then we don't even attempt an SSB connection
  // until we receive our first HTTP request.
  cooler.open();

  return cooler;
};
