var fastXmlParser = require('fast-xml-parser');
var Long = require('long').Long;
var protobuf = require('protobufjs');
var path = require('path');
protobuf.util.Long = Long;
protobuf.configure();

module.exports = function(RED) {
    "use strict";
    const fastXmlOptions = {
        attributeNamePrefix: "",
        // attrNodeName: "attr",
        ignoreAttributes: false,
    };

    function TakIngestNode(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        var global = this.context().global;

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
            msg.payload = fastXmlParser.parse(msg.payload, fastXmlOptions);
            // Add any unique ID/callsigns to some global variables just in case it's useful for later.
            if (msg.payload?.event?.detail?.contact?.attr?.callsign && msg.payload?.event?.attr?.uid) {
                var a = global.get("_takgatewaycs") || {};
                var c = a[msg.payload.event.detail.contact.attr.callsign];
                a[msg.payload.event.detail.contact.attr.callsign] = msg.payload.event.attr.uid;
                global.set("_takgatewaycs", a);
                var b = global.get("_takgatewayid") || {};
                if (c) { delete b[c]; }
                b[msg.payload.event.attr.uid] = msg.payload.event.detail.contact.attr.callsign;
                global.set("_takgatewayid", b);
            }
            if (msg.payload?.event?.attr?.type) { msg.topic = msg.payload?.event?.attr?.type; }
            node.send(msg);
        });

        node.on("close", function() {
        });
    }

    RED.nodes.registerType("tak ingest", TakIngestNode);
};
