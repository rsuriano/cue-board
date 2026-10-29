// @ts-check
/* Numbers the media relay (media-relay.mjs) and the clients (packages/collab-client) must agree on (docs/media-p2p.md).
   Imported by both, so the relay's per-file cap and what a client asks for over the relay can't drift apart. */

/** Size of one chunk of a file on the wire (the last one may be shorter). */
export const MEDIA_CHUNK = 64 * 1024;

/** The largest file the relay carries by default: covers the biggest automatic per-file limit the app offers
    ("Files up to 2 GB"). Bigger files (only fetched through "Download all now") need a direct connection. The server
    sends its own value, which an operator may lower (RELAY_MAX_TRANSFER_BYTES), to each client in WELCOME. */
export const RELAY_MAX_FILE = 2 * 1024 * 1024 * 1024;

/** Whether a file of `size` bytes fits through a relay whose cap is `cap`: the relay forwards a file's chunk `i` only
    if `i < ceil(cap / MEDIA_CHUNK)`, however often it is re-sent. */
export const relayable = (/** @type {number} */ size, /** @type {number} */ cap) =>
  Math.max(1, Math.ceil(size / MEDIA_CHUNK)) <= Math.ceil(cap / MEDIA_CHUNK);
