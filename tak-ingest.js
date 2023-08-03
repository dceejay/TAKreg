var fastXmlParser = require('fast-xml-parser');

module.exports = function(RED) {
    "use strict";
    const fastXmlOptions = {
        attributeNamePrefix: "",
        attrNodeName: "attr",
        ignoreAttributes: false,
    };

    function TakIngestNode(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        var global = this.context().global;

        node.on("input",function(msg) {
            if (typeof(msg.payload) !== "string") {
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
