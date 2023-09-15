const { XMLParser, XMLBuilder, XMLValidator} = require("fast-xml-parser");
const axios = require('axios').default;
var Long = require('long').Long;
var protobuf = require('protobufjs');
var path = require('path');
protobuf.util.Long = Long;
protobuf.configure();

module.exports = function(RED) {
    "use strict";
    const fastXmlOptions = {
        attributeNamePrefix: "",
        // attributesGroupName: "attr",
        ignoreAttributes: false,
    };

    function TakIngestNode(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        var global = this.context().global;
        const parser = new XMLParser(fastXmlOptions);

        node.on("input",function(msg) {
            if (Buffer.isBuffer(msg.payload)) {
                if (msg.payload[0] === 191 && msg.payload[2] === 191) {
                    var head = msg.payload[1];
                    msg.payload = msg.payload.slice(3);
                    if (head === 1) {
                        protobuf.load(path.join(__dirname,"proto/takmessage.proto"), function (err, root) {
                            if (err) { node.error(err); }
                            var m = root.lookupType("atakmap.commoncommo.protobuf.v1.TakMessage");
                            var m2 = m.decode(msg.payload);
                            var m3 = m.toObject(m2, { longs:String, enums:String, bytes:String } ).cotEvent;

                            // Add any unique ID/callsigns to some global variables just in case it's useful for later.
                            if (m3.detail?.contact?.callsign && m3.uid) {
                                var a = global.get("_takgatewaycs") || {};
                                var c = a[m3.detail.contact.callsign];
                                a[m3.detail.contact.callsign] = m3.uid;
                                global.set("_takgatewaycs", a);
                                var b = global.get("_takgatewayid") || {};
                                if (c) { delete b[c]; }
                                b[m3.uid] = m3.detail.contact.callsign;
                                global.set("_takgatewayid", b);
                            }

                            node.send({
                                topic: m3.type,
                                payload: { cotEvent: m3 }
                            });
                        });
                        return;
                    }
                    else if (head === 0) {
                        msg.payload = msg.payload.toString();
                    }
                    else {
                        node.error("Unknown CoT packet type",msg);
                        return;
                    }
                }
                else {
                    node.error("Unknown buffer type",msg);
                    return;
                }
            }
            else if (typeof(msg.payload) !== "string") {
                node.error("Input is not a string.",msg);
                return;
            }
            if (msg.payload.indexOf("<event") !== 0) {
                if (msg.payload.trim().length > 0 && msg.payload !== '</event>') { // ignore blank lines
                    node.error("Input is not an XML event string.",msg);
                }
                return;
            }
            msg.payload = parser.parse(msg.payload);
            // Add any unique ID/callsigns to some global variables just in case it's useful for later.
            if (msg.payload?.event?.detail?.contact?.callsign && msg.payload?.event?.uid) {
                var a = global.get("_takgatewaycs") || {};
                var c = a[msg.payload.event.detail.contact.callsign];
                a[msg.payload.event.detail.contact.callsign] = msg.payload.event.uid;
                global.set("_takgatewaycs", a);
                var b = global.get("_takgatewayid") || {};
                if (c) { delete b[c]; }
                b[msg.payload.event.uid] = msg.payload.event.detail.contact.callsign;
                global.set("_takgatewayid", b);
            }
            if (msg.payload?.event?.type) { msg.topic = msg.payload?.event?.type; }
            if (msg.payload?.event?.detail?.fileshare) {
                msg.filename = msg.payload.event.detail.fileshare.filename;
                axios({
                    method: 'get',
                    url: msg.payload.event.detail.fileshare.senderUrl,
                    headers: { 'Accept': 'application/zip' },
                    responseType: 'arraybuffer'
                    })
                    .then(function (response) {
                        msg.datapackage = Buffer.from(response.data);
                        node.send(msg);
                    })
                    .catch(function (error) {
                        node.error(error.message, error);
                        node.send(msg);
                    })
            }
            else {
                node.send(msg);
            }
        });

        node.on("close", function() {
        });
    }

    RED.nodes.registerType("tak ingest", TakIngestNode);
};
