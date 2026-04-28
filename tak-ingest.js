/**
 * @file tak-ingest.js
 * @description Node-RED node for ingesting TAK (Team Awareness Kit) messages.
 * Accepts incoming CoT (Cursor on Target) data as raw UDP/TCP buffers or XML strings,
 * decodes both plain-text XML and protobuf-encoded payloads, maintains global callsign/UUID
 * lookup maps, and automatically fetches data packages attached to fileshare events.
 */

const { XMLParser } = require("fast-xml-parser");
const axios = require('axios').default;
var Long = require('long').Long;
var protobuf = require('protobufjs');
var path = require('path');

// Configure protobufjs to use the Long library for 64-bit integer support
protobuf.util.Long = Long;
protobuf.configure();

module.exports = function(RED) {
    "use strict";

    /**
     * Options for the fast-xml-parser instance.
     * Attributes are kept inline (not grouped) and are not prefixed.
     *
     * @type {import('fast-xml-parser').X2jOptions}
     */
    const fastXmlOptions = {
        attributeNamePrefix: "",
        // attributesGroupName: "attr",
        ignoreAttributes: false,
    };

    /**
     * TAK Ingest Node constructor. Creates a Node-RED node that receives raw TAK
     * network traffic (UDP buffers or TCP strings) and parses it into structured
     * CoT event objects for downstream nodes.
     *
     * @constructor
     * @param {object} n - Node configuration object provided by Node-RED
     */
    function TakIngestNode(n) {
        RED.nodes.createNode(this, n);
        var node = this;
        var globalContext = this.context().global;

        /** @type {XMLParser} Shared XML parser instance configured for CoT attribute handling */
        const parser = new XMLParser(fastXmlOptions);

        /**
         * Decodes a protobuf-encoded TAK message buffer and emits the parsed cotEvent
         * object to the node's output. Also updates the global callsign↔UUID lookup maps
         * if contact information is present in the decoded event.
         *
         * @param {object} msg - Node-RED message whose `payload` is a protobuf Buffer
         * @param {Buffer} msg.payload - Raw protobuf bytes representing a TakMessage
         * @returns {void}
         */
        var handleProtoBuf = function(msg) {
            protobuf.load(path.join(__dirname, "proto/takmessage.proto"), function (err, root) {
                if (err) { node.error(err); return; }

                var m = root.lookupType("atakmap.commoncommo.protobuf.v1.TakMessage");
                var m3;
                try {
                    var m2 = m.decode(msg.payload);
                    m3 = m.toObject(m2, { longs: String, enums: String, bytes: String }).cotEvent;
                }
                catch (e) { node.error("Protobuf decode " + e, msg); return; }

                if (!m3) { node.error("Protobuf: no cotEvent in decoded message", msg); return; }

                // Update global callsign↔UUID maps so other nodes can resolve TAK identities
                if (m3.detail?.contact?.callsign && m3.uid) {
                    var a = globalContext.get("_takgatewaycs") || {};
                    var c = a[m3.detail.contact.callsign];
                    a[m3.detail.contact.callsign] = m3.uid;
                    globalContext.set("_takgatewaycs", a);
                    var b = globalContext.get("_takgatewayid") || {};
                    if (c) { delete b[c]; }   // remove stale UUID entry if callsign changed UID
                    b[m3.uid] = m3.detail.contact.callsign;
                    globalContext.set("_takgatewayid", b);
                }

                node.send({
                    topic: m3.type,
                    payload: { cotEvent: m3 }
                });
            });
        }

        /**
         * Main input handler. Accepts TAK traffic in several forms and normalises it
         * into a parsed CoT event object on `msg.payload`.
         *
         * Supported input formats:
         * - **TAK UDP frame** (Buffer starting with magic bytes `0xBF ?? 0xBF`):
         *   - Header byte `0x01` → protobuf payload, decoded via `handleProtoBuf`
         *   - Header byte `0x00` → plain-text XML, falls through to the XML parser
         * - **Raw XML string** — trimmed, whitespace-normalised, and parsed with fast-xml-parser
         *
         * After parsing XML, the handler also:
         * - Updates global `_takgatewaycs` (callsign→UID) and `_takgatewayid` (UID→callsign) maps
         * - Sets `msg.topic` to the CoT event type string
         * - For `fileshare` events, fetches the data package ZIP from the `senderUrl` and
         *   attaches it as a Buffer on `msg.datapackage` before sending
         *
         * @param {object}          msg            - Incoming Node-RED message
         * @param {Buffer|string}   msg.payload    - Raw TAK UDP/TCP buffer or CoT XML string
         */
        node.on("input", function(msg) {
            if (Buffer.isBuffer(msg.payload)) {
                // Handle UDP packet — check for TAK magic byte framing (0xBF <type> 0xBF)
                if (msg.payload[0] === 191 && msg.payload[2] === 191) {
                    var head = msg.payload[1];
                    msg.payload = msg.payload.slice(3);  // strip the 3-byte header

                    // type 1 = protobuf
                    if (head === 1) {
                        handleProtoBuf(msg);
                        return;
                    }
                    // type 0 = plain text
                    else if (head === 0) {
                        msg.payload = msg.payload.toString();
                    }
                    else {
                        node.error("Unknown CoT packet type", msg);
                        return;
                    }
                }
                // ideally need to check if tcp and streaming protobuf...
                // else if (msg.payload[0] === 191 && !msg.hasOwnProperty("fromip")) {
                //     var l = msg.payload[1] + msg.payload[2] * 256;
                //     msg.payload = msg.payload.slice(3,l+3);
                //     handleProtoBuf(msg);
                //     return;
                // }
                else {
                    node.error("Unknown buffer type", msg);
                    return;
                }
            }
            else if (typeof msg.payload !== "string") {
                node.error("Input is not a string.", msg);
                return;
            }

            // Normalise whitespace between XML tags and seek the start of the <event> element,
            // discarding any preceding data (e.g. stream headers or partial frames)
            msg.payload = msg.payload.trim().replace(/>\s+</g, "><");
            var p = msg.payload.indexOf("<event");
            if (p >= 0) {
                msg.payload = msg.payload.substr(p);
            }
            if (msg.payload.indexOf("<event") !== 0) {
                if (msg.payload.trim().length > 0 && msg.payload !== '</event>') { // ignore blank lines
                    node.error("Input is not an XML event string.", msg);
                }
                return;
            }

            // Parse the CoT XML into a plain object
            msg.payload = parser.parse(msg.payload);

            // Update global callsign↔UUID maps if this event carries contact information
            if (msg.payload?.event?.detail?.contact?.callsign && msg.payload?.event?.uid) {
                var a = globalContext.get("_takgatewaycs") || {};
                var c = a[msg.payload.event.detail.contact.callsign];
                a[msg.payload.event.detail.contact.callsign] = msg.payload.event.uid;
                globalContext.set("_takgatewaycs", a);
                var b = globalContext.get("_takgatewayid") || {};
                if (c) { delete b[c]; }   // remove stale UUID entry if callsign changed UID
                b[msg.payload.event.uid] = msg.payload.event.detail.contact.callsign;
                globalContext.set("_takgatewayid", b);
            }

            // Propagate the CoT type as the message topic for downstream routing
            if (msg.payload?.event?.type) { msg.topic = msg.payload.event.type; }

            if (msg.payload?.event?.detail?.fileshare) {
                // This is a file-share CoT event — fetch the referenced data package ZIP
                msg.filename = msg.payload.event.detail.fileshare.filename;
                if (msg.payload.event.detail.fileshare.senderUrl.indexOf("http") === 0) {
                    axios({
                        method: 'get',
                        url: msg.payload.event.detail.fileshare.senderUrl,
                        headers: { 'Accept': 'application/zip' },
                        responseType: 'arraybuffer'
                    })
                        .then(function (response) {
                            /** @type {Buffer} Downloaded data package ZIP bytes */
                            msg.datapackage = Buffer.from(response.data);
                            node.send(msg);
                        })
                        .catch(function (error) {
                            node.error(error.message, error);
                            node.send(msg);  // send without datapackage on download failure
                        })
                }
                else {
                    node.error("fileshare senderUrl is not a valid http URL", msg);
                    node.send(msg); // send the message anyway but without the datapackage
                }
            }
            else {
                node.send(msg);
            }
        });
    }

    RED.nodes.registerType("tak ingest", TakIngestNode);
};
