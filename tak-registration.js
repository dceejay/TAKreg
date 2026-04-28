/**
 * @file tak-registration.js
 * @description Node-RED node for TAK (Team Awareness Kit) gateway registration and message handling.
 * Manages heartbeat registration, data package uploads, geochat messages, CoT (Cursor on Target)
 * XML generation, and Worldmap object conversion for TAK-compatible clients.
 */

module.exports = function (RED) {
    "use strict";
    const os = require('os');
    const AdmZip = require('adm-zip');
    const axios = require('axios').default;
    const crypto = require("crypto");
    const FormData = require('form-data')
    const { v4: uuidv4, v5: uuidv5 } = require('uuid');
    const turfpolygon = require("@turf/helpers").polygon;
    const turfcentroid = require("@turf/centroid");
    const ver = require('./package.json').version;

    /** @type {string[]} Valid TAK team/group colour names */
    const teamList = ["Cyan", "Red", "Green", "Blue", "Magenta", "Yellow", "Orange", "Maroon", "Purple", "Dark Blue", "Dark Green", "Teal", "Brown"];

    /**
     * TAK Registration Node constructor. Sets up a Node-RED node that acts as a TAK gateway,
     * handling heartbeat registration, CoT message generation, data package uploads, and geochat.
     *
     * @constructor
     * @param {object} n - Node configuration object provided by Node-RED
     * @param {string} n.group - TAK team/group name
     * @param {string} [n.role="Gateway"] - Role of this node on the TAK network (e.g. "Gateway", "Team Member")
     * @param {string} [n.ntype="a-f-G-I-B"] - CoT type string for gateway nodes
     * @param {number} n.latitude - Latitude of this gateway
     * @param {number} n.longitude - Longitude of this gateway
     * @param {string} n.callsign - TAK callsign for this gateway
     * @param {number} n.repeat - Heartbeat interval in seconds
     * @param {string} n.dphost - TAK server host URL for data package uploads
     */
    function TakRegistrationNode(n) {
        RED.nodes.createNode(this, n);

        /** @type {number} Sentinel value used for unknown/invalid altitude or error coordinates */
        const invalid = 9999999;

        this.group = n.group;
        this.role = n.role || "Gateway";
        this.ntype = n.ntype || "a-f-G-I-B";
        this.lat = n.latitude;
        this.lon = n.longitude;
        this.callsign = n.callsign;
        this.repeat = n.repeat;
        this.host = n.dphost;

        /**
         * Unique gateway UUID derived from the node ID using MD5, prefixed with "GATEWAY-".
         * Used to identify this node on the TAK network.
         * @type {string}
         */
        this.uuid = "GATEWAY-" + (crypto.createHash('md5').update(Buffer.from(this.id)).digest('hex')).slice(0, 16);

        var node = this;

        /** @type {number} Current altitude in metres; initialised to the invalid sentinel value */
        node.alt = invalid;

        var globalContext = this.context().global;

        // Store gateway UUID→callsign and callsign→UUID mappings in global context
        // so other nodes can look up gateway identities.
        var g = {};
        g[node.uuid] = node.callsign;
        globalContext.set("_takgatewayid", g);

        var gr = {};
        gr[node.callsign] = node.uuid;
        globalContext.set("_takgatewaycs", gr);

        globalContext.set("_takdphost", node.host);

        // Non-gateway roles use the individual/crew member CoT type
        if (node.role !== "Gateway") { node.ntype = "a-f-G-U-C" }

        // Guard against excessively long heartbeat intervals (setInterval max safe value)
        if (node.repeat > 2147483) {
            node.error("TAK Heartbeat interval is too long.");
            delete node.repeat;
        }

        /**
         * Converts a web-map hex colour and optional opacity into a KML-compatible ARGB hex string.
         *
         * @param {string} colour - Hex colour string without leading '#' (e.g. "FF0000")
         * @param {number} [opacity=100] - Opacity as a percentage (0–100)
         * @returns {string} KML ARGB hex string (e.g. "ff910000")
         */
        var convertWMtoKMLColour = function (colour, opacity) {
            if (opacity === undefined) { opacity = 100; }
            var alfa = parseInt(opacity * 255 / 100).toString(16);
            return alfa + colour;
        };

        /**
         * Converts a web-map hex colour and optional opacity into a signed 32-bit integer
         * as used by CoT (Cursor on Target) colour fields.
         *
         * @param {string} colour - Hex colour string without leading '#' (e.g. "FF0000")
         * @param {number} [opacity] - Opacity as a percentage (0–100); defaults to fully opaque (0xFF) if omitted
         * @returns {number} Signed 32-bit integer ARGB colour value
         */
        var convertWMtoCOTColour = function (colour, opacity) {
            var c;
            if (opacity !== undefined) {
                c = Buffer.from(parseInt(opacity * 255 / 100).toString(16) + colour, "hex");
            }
            else {
                c = Buffer.from("FF" + colour, "hex");
            }
            return c.readInt32BE()
        };

        /**
         * Calculates the geographic centroid of an array of [lat, lng] coordinate pairs.
         * Pads the array to at least 4 points (by repeating the first point) if necessary,
         * as required by the Turf.js polygon helper.
         *
         * @param {Array<[number, number]>} points - Array of [latitude, longitude] pairs
         * @returns {import('@turf/helpers').Feature<import('@turf/helpers').Point>} GeoJSON Point feature at the centroid
         */
        var findCentroidOfPoints = function (points) {
            while (points.length < 4) { points.push(points[0]); } // pad if necessary (needs 4 points minimum)
            var poly = turfpolygon([points]);
            var centroid = turfcentroid(poly);
            return centroid;
        };

        /**
         * Emits a synthetic input event on this node to trigger the heartbeat registration handler.
         * The event payload includes current position, group, role, and a `heartbeat: true` flag
         * so the input handler knows to generate a TAK registration CoT message.
         *
         * @returns {void}
         */
        var sendIt = function () {
            node.emit("input", {
                time: new Date().toISOString(),
                etime: new Date(Date.now() + (2 * node.repeat * 1000)).toISOString(),
                lat: node.lat,
                lon: node.lon,
                alt: node.alt,
                callsign: node.callsign,
                group: node.group,
                role: node.role,
                type: node.ntype,
                heartbeat: true
            });
        };

        /**
         * Starts the periodic heartbeat interval that broadcasts this gateway's presence
         * to the TAK network at the configured repeat interval.
         *
         * @returns {void}
         */
        node.repeaterSetup = function () {
            const intervalMs = node.repeat * 1000;
            if (RED.settings.verbose) {
                node.log(RED._("inject.repeat", node));
            }
            node.interval_id = setInterval(sendIt, intervalMs);
        };

        // Start the heartbeat repeater and send an initial registration after a short delay
        node.repeaterSetup();
        setTimeout(sendIt, 2500);

        /**
         * Main input handler. Processes incoming Node-RED messages and routes them based
         * on their content to one of several TAK output formats:
         *
         * - `msg.heartbeat === true`       → CoT gateway registration/heartbeat XML
         * - `msg.filename` + Buffer payload → Normalised to attachment format, then falls through
         * - `msg.attachments`              → TAK Data Package (ZIP + manifest), uploaded via Marti API
         * - `msg.payload` is XML string    → Passed through directly as CoT
         * - `msg.payload` starts `$GPGGA` → NMEA GPS sentence; updates node lat/lon/alt
         * - `msg.payload` string + sendTo  → GeoChat message(s) to specified callsign(s)
         * - `msg.payload` object, no name  → Position update for this gateway node
         * - `msg.payload` object with name → Worldmap-style marker/shape → CoT XML
         * - `msg.payload` object with event→ Round-trip CoT JSON back to XML
         *
         * @param {object} msg - Node-RED message object
         * @param {boolean} [msg.heartbeat] - Set to true for internal heartbeat messages
         * @param {Buffer}  [msg.payload] - Raw file buffer (when used with msg.filename)
         * @param {string}  [msg.filename] - File path; triggers single-attachment normalisation
         * @param {Array}   [msg.attachments] - Array of `{filename, content}` objects for data packages
         * @param {string}  [msg.sendTo] - Target TAK callsign(s) for chat or data package delivery
         * @param {string}  [msg.from] - Sender callsign override (defaults to node callsign)
         * @param {string}  [msg.topic] - Message topic / data package name
         * @param {number}  [msg.lat] - Latitude override
         * @param {number}  [msg.lon] - Longitude override
         * @param {number}  [msg.alt] - Altitude override in metres
         * @param {string}  [msg.remarks] - Freetext remarks to include in CoT detail
         */
        node.on("input", function (msg) {
            if (msg?.heartbeat) {  // Register gateway and do the heartbeats
                var template = `<event version="2.0" uid="${node.uuid}" type="${msg.type}" how="h-e" time="${msg.time}" start="${msg.time}" stale="${msg.etime}"><point lat="${msg.lat}" lon="${msg.lon}" hae="${msg.alt}" ce="9999999" le="9999999"/><detail><takv device="${os.hostname()}" os="${os.platform()}" platform="NRedTAK" version="${ver}"/><contact endpoint="*:-1:stcp" callsign="${msg.callsign}"/><uid Droid="${msg.callsign}"/><__group name="${msg.group}" role="${msg.role}"/><status battery="99"/><track course="0" speed="0"/></detail></event>`;
                node.send({ payload: template, topic: "TAKreg" });
                node.status({ fill: "green", shape: "dot", text: node.repeat + "s - " + node.callsign });
                return;
            }

            // if it's just a simple filename and buffer payload then make it look like an attachment etc...
            if (msg?.payload && msg.hasOwnProperty("filename") && Buffer.isBuffer(msg.payload) && !msg.hasOwnProperty("attachments")) {
                msg.attachments = [{
                    filename: msg.filename.split('/').pop(),
                    content: msg.payload
                }]
                if (!msg.hasOwnProperty("topic")) { msg.topic = "File - " + msg.filename.split('/').pop(); }
                delete msg.filename;
                delete msg.payload;
            }

            // If there are attachments handle them first. (Datapackage)
            if (msg?.attachments && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
                if (!msg.sendTo) { node.error("Missing 'sendTo' user TAK callsign property.", msg); return; }

                // Generate a deterministic UUID for this data package based on the topic string
                var UUID = uuidv5(msg.topic, 'd5d4a57d-48fb-58b6-93b8-d9fde658481a');
                var fnam = msg.topic || msg.attachments[0].filename.split('.')[0];
                var fname = fnam + '.zip';
                var da = new Date();

                // Build a timestamp-based sender callsign suffix (DDTHHMMSS)
                var dn = da.toISOString().split('-')[2].split('.')[0];
                var calls = msg.from || node.callsign;
                calls = calls + '.' + dn.split('T')[0] + '.' + dn.split('T')[1].split(':').join('');

                // Begin building the Mission Package Manifest XML
                var mf = `<MissionPackageManifest version="2"><Configuration>
                <Parameter name="uid" value="${UUID}"/>
                <Parameter name="name" value="${msg.topic}"/>
                <Parameter name="onReceiveImport" value="true"/>
                <Parameter name="callsign" value="${calls}"/>
                </Configuration><Contents>\n`;

                var zip = new AdmZip();

                // Add each attachment to the ZIP, keyed by its MD5 hash
                for (var i = 0; i < msg.attachments.length; i++) {
                    var data;
                    if (Buffer.isBuffer(msg.attachments[i].content)) {
                        data = msg.attachments[i].content;
                    }
                    else if (Array.isArray(msg.attachments[i].content)) {
                        data = Buffer.from(msg.attachments[i].content);
                    }
                    else if (!Array.isArray(msg.attachments[i].content) && msg.attachments[i].content.hasOwnProperty("data")) {
                        data = Buffer.from(msg.attachments[i].content.data);
                    }
                    var hash = crypto.createHash('md5').update(data).digest('hex');
                    var fhash = hash + '/' + msg.attachments[i].filename;
                    zip.addFile(fhash, data, "Added by Node-RED");
                    mf += `<Content ignore="false" zipEntry="${fhash}"><Parameter name="uid" value="${UUID}"/></Content>\n`;
                }

                // If coordinates are provided, embed a CoT item CoT XML inside the package
                if (msg.hasOwnProperty("lat") && msg.hasOwnProperty("lon")) {
                    var timeo = new Date(Date.now() + (1000*60*60*4)).toISOString(); // stale time to 4 hours
                    var cott = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                    <event version="2.0" uid="${UUID}" type="b-i-x-i" time="${da.toISOString()}" start="${da.toISOString()}" stale="${timeo}" how="h-g-i-g-o">
                        <point lat="${msg.lat}" lon="${msg.lon}" hae="${msg.alt || "9999999"}" ce="9999999" le="9999999" />
                        <detail>
                            <status readiness="true" />
                            <contact callsign="${calls}" />
                            <remarks>${msg.remarks || ''}</remarks>
                            <color argb="-1" />
                            <link uid="${node.uuid}" production_time="${da.toISOString()}" type="a-f-G-U-C" parent_callsign="${msg.from || node.callsign}" relation="p-p" />
                            <archive />
                        </detail>
                    </event>`

                    cott = cott.replace(/>\s+</g, "><");
                    var hsh = crypto.createHash('md5').update(cott).digest('hex');
                    zip.addFile(hsh+'/'+hsh+'.cot', cott, "Added by Node-RED");
                    mf += `<Content ignore="false" zipEntry="${hsh+'/'+hsh+'.cot'}"><Parameter name="uid" value="${UUID}"/></Content>\n`;
                }

                mf += `</Contents></MissionPackageManifest>`;
                mf = mf.replace(/>\s+</g, "><");
                zip.addFile('MANIFEST/manifest.xml', Buffer.from(mf, 'utf8'), msg.topic);
                var zipbuff = zip.toBuffer();

                // Build the upload metadata object
                msg = {
                    from: msg.from || node.callsign || "Anonymous",
                    sendTo: msg.sendTo,
                    lat: msg.lat || node.lat || 0,
                    lon: msg.lon || node.lon || 0,
                    assetfile: fname,
                    len: zipbuff.length,
                    uid: node.uuid,
                    hash: crypto.createHash('sha256').update(zipbuff).digest('hex')
                }
                const al = msg.alt || node?.alt;
                if (al) { msg.alt = parseInt(al); }

                let formData = new FormData();
                const opts = { filename: fname, contentType: 'application/x-zip-compressed' };
                formData.append('assetfile', zipbuff, opts);

                if (node?.host !== undefined && node?.host !== "") {
                    // Upload the data package ZIP to the TAK server via the Marti sync API
                    const url = encodeURI(node.host + '/Marti/sync/missionupload?hash=' + msg.hash + '&filename=' + fname + '&creatorUid=' + node.uuid);
                    axios({
                        method: 'post',
                        url: url,
                        headers: formData.getHeaders(),
                        data: formData
                    })
                        .then(function (response) {
                            // Set the visibility (public / private) of the uploaded package
                            const urlp = encodeURI(node.host + '/Marti/api/sync/metadata/' + msg.hash + '/tool');
                            var priv = (msg.sendTo === "public") ? "public" : "private";
                            axios({
                                method: 'put',
                                url: urlp,
                                data: priv
                            })
                                .then(function (response) {
                                    if (priv === "private") {
                                        // Send a file-share CoT event to notify the recipient(s)
                                        const start = new Date().toISOString();
                                        const stale = new Date(new Date().getTime() + (10000)).toISOString();

                                        var m = `<event version="2.0" uid="${uuidv4()}" type="b-f-t-r" how="h-e" time="${start}" start="${start}" stale="${stale}">
                                            <point lat="${msg.lat}" lon="${msg.lon}" hae="${msg.alt || 9999999}" ce="9999999" le="9999999" />
                                            <detail>
                                            <fileshare filename="${fname}" senderUrl="${node.host}/Marti/sync/content?hash=${msg.hash}" sizeInBytes="${msg.len}" sha256="${msg.hash}" senderUid="${msg.uid}" senderCallsign="${msg.from}" name="${fnam}" />`
                                        if (msg.sendTo !== "broadcast") {
                                            var t = msg.sendTo;
                                            if (!Array.isArray(t)) { t = [t]; }
                                            m += '<marti>' + t.map(v => '<dest callsign="' + v + '"/>') + '</marti>';
                                        }
                                        m += '</detail></event>';
                                        node.log("DP: " + node.host + "/Marti/sync/content?hash=" + msg.hash);
                                        msg.payload = m.replace(/>\s+</g, "><");
                                        msg.topic = "b-f-t-r";
                                        node.send(msg);
                                    }
                                })
                                .catch(function (error) {
                                    node.error(error.message, error);
                                })
                        })
                        .catch(function (error) {
                            node.error(error.message, error);
                        })
                }
                else { node.error("TAK server host is undefined or empty", new Error("Invalid node host")); }
            }

            // Otherwise if it's a string maybe it's raw cot xml - or NMEA from GPS - or maybe a simple chat message
            else if (msg?.payload && typeof msg.payload === "string") {
                if (msg.payload.trim().startsWith('<') && msg.payload.trim().endsWith('>')) {
                    // Assume it's proper XML event so pass straight through
                    msg.topic = msg.payload.split('type="')[1].split('"')[0];
                    node.send(msg);
                }
                else if (msg.payload.trim().startsWith('$GPGGA')) {
                    // Parse an NMEA GGA sentence and update the node's current position
                    var nm = msg.payload.trim().split(',');
                    if (nm[0] === '$GPGGA' && nm[6] > 0) {
                        const la = parseInt(nm[2].substr(0, 2)) + parseFloat(nm[2].substr(2)) / 60;
                        node.lat = ((nm[3] === "N") ? la : -la).toFixed(6);
                        const lo = parseInt(nm[4].substr(0, 3)) + parseFloat(nm[4].substr(3)) / 60;
                        node.lon = ((nm[5] === "E") ? lo : -lo).toFixed(6);
                        node.alt = nm[9];
                    }
                }
                else if (msg.hasOwnProperty("sendTo")) {
                    // Simple text payload with no attachments — treat as a geochat message
                    if (!Array.isArray(msg.sendTo)) { msg.sendTo = msg.sendTo.split(','); }
                    const start = new Date().toISOString();
                    const stale = new Date(new Date().getTime() + (10000)).toISOString();
                    const mid = uuidv4();
                    const type = "a-f-G-I-B";
                    var par = '';

                    // Send an individual chat CoT event for each recipient in sendTo
                    for (var t = 0; t < msg.sendTo.length; t++) {
                        var m = RED.util.cloneMessage(msg);
                        const to = m.sendTo[t];
                        m.sendTo = to;
                        const toid = globalContext.get("_takgatewaycs")[m.sendTo] || m.sendTo;
                        var ma = `<marti><dest callsign="${m.sendTo}"/></marti>`;
                        if (m.sendTo === "broadcast") { m.sendTo = "All Chat Rooms"; }
                        if (m.sendTo === "All Chat Rooms") { ma = ""; }
                        if (teamList.includes(m.sendTo)) { par = 'parent="TeamGroups"'; }

                        var xm = `<event version="2.0" uid="GeoChat.${node.uuid}.${toid}.${mid}" type="b-t-f" time="${start}" start="${start}" stale="${stale}" how="h-g-i-g-o">
        <point lat="${node.lat}" lon="${node.lon}" hae="9999999" ce="9999999" le="9999999"/>
        <detail>
            <__chat ${par} groupOwner="false" messageId="${mid}" chatroom="${m.sendTo}" id="${toid}" senderCallsign="${node.callsign}">
                <chatgrp uid0="${node.uuid}" uid1="${toid}" id="${toid}"/>
            </__chat>
            <link uid="${node.uuid}" type="${type}" relation="p-p"/>
            <remarks source="BAO.F.ATAK.${node.uuid}" to="${toid}" time="${start}">${msg.payload}</remarks>
            ${ma}
            <track speed="0" course="0"/>
        </detail>
    </event>`;
                        m.payload = xm.replace(/>\s+</g, "><");
                        m.topic = "b-t-f";
                        node.send(m);
                    }
                }
            }

            // Just has lat, lon (and alt) but no name - assume it's our local position we're updating
            else if (msg?.payload && typeof msg.payload === "object" && !msg.payload.hasOwnProperty("name") && msg.payload.hasOwnProperty("lat") && msg.payload.hasOwnProperty("lon")) {
                node.lat = msg.payload.lat;
                node.lon = msg.payload.lon;
                if (msg.payload.hasOwnProperty("altft")) { node.alt = parseInt(msg.payload.altft * 0.3048); }
                if (msg.payload.hasOwnProperty("alt")) { node.alt = parseInt(msg.payload.alt); }
            }

            // Handle a generic worldmap style object
            else if (msg?.payload && typeof msg.payload === "object" && msg.payload.hasOwnProperty("name")) {
                var shapeXML = ``;
                var linkXML = ``;
                var userIcon = ``;
                var d = new Date();
                var st = d.toISOString();
                var ttl = ((msg.payload.ttl || 0) * 1000) || 60000;
                var tag = msg.payload.remarks || "";
                if (msg.payload.tag) { tag += " " + msg.payload.tag }
                if (msg.payload.layer) { tag += " #" + msg.payload.layer.replace(/ /g,'_') }
                else { tag += " #Worldmap"; }
                if (!msg.payload?.alt && msg.payload?.altft) { msg.payload.alt = msg.payload.altft * 0.3048}

                // Handle simple markers
                if (msg.payload.hasOwnProperty("lat") && msg.payload.hasOwnProperty("lon")) {
                    var type = msg.payload.cottype || "a-u-g-u";

                    // Convert AIS vessel type to SIDC symbol code if no CoT type or SIDC given
                    if (!msg.payload.cottype && !msg.payload.SIDC && msg.payload.hasOwnProperty("aistype")) {
                        msg.payload.SIDC = ais2sidc(msg.payload.aistype);
                    }

                    // Convert SIDC symbol code to CoT type and build military symbol XML
                    if (!msg.payload.cottype && msg.payload.SIDC) {
                        if (msg.payload.SIDC.substr(3,1) === '-') {
                            msg.payload.SIDC = msg.payload.SIDC.substring(0, 3) + "P" + msg.payload.SIDC.substring(4);
                        }
                        var s = msg.payload.SIDC.split('-')[0].toUpperCase();
                        var t = s.substr(2,1);
                        var r = s.substr(4);
                        s = s.substr(1,1).toLowerCase();
                        type = 'a-' + s + '-' + t + '-' + r.split('').join('-');
                        if (type.endsWith('-')) { type = type.slice(0, -1); }
                        if (msg.payload.SIDC.length < 12) { msg.payload.SIDC = (msg.payload.SIDC + '----------').substr(0, 12); }
                        userIcon = '<__milsym id="'+msg.payload.SIDC.substr(0,12)+'***">';
                        userIcon += '<unitmodifier code="T">' + msg.payload.name + '</unitmodifier>';
                        if (msg.payload?.COG) { userIcon += '<unitmodifier code="Q">' + msg.payload.COG + '</unitmodifier>'; }
                        if (msg.payload?.model) { userIcon += '<unitmodifier code="V">' + msg.payload.model + '</unitmodifier>'; }
                        if (msg.payload?.dtg) { userIcon += '<unitmodifier code="W">' + msg.payload.dtg + '</unitmodifier>'; }
                        userIcon += '</__milsym>';
                    }
                    else if (msg.payload.hasOwnProperty("icon")) {
                        // Map specific Worldmap icon names to TAK spot-map or custom iconset paths
                        if (msg.payload.icon === 'fa-circle fa-fw') {
                            type = 'b-m-p-s-m';
                            if (!msg.payload?.iconColor) { msg.payload.iconColor = "FFFF00"; }
                            shapeXML = '<color argb="' + convertWMtoCOTColour(msg.payload.iconColor.replace('#', '')) + '"/>';
                            shapeXML = shapeXML + '<usericon iconsetpath="COT_MAPPING_SPOTMAP/b-m-p-s-m/-16711681"/>';
                        }
                        else {
                            userIcon = `<usericon iconsetpath="${msg.payload.icon}"/>`;
                        }
                    }
                }

                // For markers that aren't us, add a link tag back to this gateway
                if (msg.payload.hasOwnProperty("name")) {
                    linkXML = `<link uid="${node.uuid}" production_time="${st}" type="${node.ntype}" parent_callsign="${node.callsign}" relation="p-p"/>`;
                }

                // Handle Worldmap drawing shapes (ellipse, line, polygon/rectangle)
                if (msg.payload.hasOwnProperty("action") && msg.payload.action === "draw") {
                    ttl = 24 * 60 * 60 * 1000;  /// set TTL to 1 day for shapes...

                    /** @type {{type: string, strokeColor: string, fillColor: string, fillOpacity: number, strokeWeight: number, radius?: object, points?: Array}} */
                    var shape = {
                        "strokeColor": (msg.payload.options.color || "910000").replace('#', ''),
                        "fillColor": (msg.payload.options.color || "910000").replace('#', ''),
                        "fillOpacity": msg.payload.options.opacity * 100 || 50,
                        "strokeWeight": msg.payload.options.weight || 2
                    };

                    if ("radius" in msg.payload) {
                        // Ellipse: use the radius value for both major and minor axes (circle)
                        shape.type = "ellipse";
                        shape.radius = {
                            "major": msg.payload.radius,
                            "minor": msg.payload.radius
                        };
                    }
                    else if ("line" in msg.payload) {
                        // Polyline: collect points and calculate centroid for the CoT anchor
                        delete shape.fillColor;
                        delete shape.fillOpacity;
                        shape.type = "line";
                        shape.points = [];
                        var lineCentPoints = [];

                        for (var p = 0; p < msg.payload.line.length; p++) {
                            shape.points.push({
                                lat: msg.payload.line[p].lat,
                                lon: msg.payload.line[p].lng
                            });
                            lineCentPoints.push([msg.payload.line[p].lat, msg.payload.line[p].lng]);
                        }
                        // Find the Centroid of the object.
                        lineCentPoints.push([msg.payload.line[0].lat, msg.payload.line[0].lng]);
                        var lineCent = findCentroidOfPoints(lineCentPoints);
                        msg.payload.lat = lineCent.geometry.coordinates[1];
                        msg.payload.lon = lineCent.geometry.coordinates[0];
                    }
                    else if ("area" in msg.payload) {
                        // Polygon or rectangle: collect points and calculate centroid
                        shape.type = "poly";
                        shape.points = [];
                        var polyCentPoints = [];
                        for (var a = 0; a < msg.payload.area.length; a++) {
                            shape.points.push({
                                lat: msg.payload.area[a].lat,
                                lon: msg.payload.area[a].lng
                            });
                            polyCentPoints.push([msg.payload.area[a].lat, msg.payload.area[a].lng]);
                        }
                        shape.points.push({
                            lat: msg.payload.area[0].lat,
                            lon: msg.payload.area[0].lng
                        });
                        // Find the Centroid of the object.
                        polyCentPoints.push([msg.payload.area[0].lat, msg.payload.area[0].lng]);
                        var polyCent = findCentroidOfPoints(polyCentPoints);
                        msg.payload.lat = polyCent.geometry.coordinates[1];
                        msg.payload.lon = polyCent.geometry.coordinates[0];
                    }

                    if (shape.type === 'ellipse') {
                        type = "u-d-c-c";

                        shapeXML = `
                        <shape>
                        <ellipse major="${shape.radius.major}" minor="${shape.radius.minor}" angle="360" />
                        <link relation="p-c" uid="${msg.payload.name}.Style" type="b-x-KmlStyle">
                        <Style>
                        <LineStyle>
                            <color>${convertWMtoKMLColour(shape.strokeColor)}</color>
                            <width>${shape.weight || 2.0}</width>
                        </LineStyle>
                        <PolyStyle>
                            <color>${convertWMtoKMLColour(shape.fillColor, shape.fillOpacity)}</color>
                        </PolyStyle>
                        </Style>
                        </link>
                        </shape>`;
                    }
                    else if (shape.type === 'line' || shape.type === 'poly') {
                        var linkArrayXML = "";

                        // Build link point elements for each vertex of the shape
                        for (var l = 0; l < shape.points.length; l++) {
                            linkArrayXML += `<link point="${shape.points[l].lat},${shape.points[l].lon}"/>\n`;
                        }

                        shapeXML = `
                        ${linkArrayXML}
                        <strokeColor value="${convertWMtoCOTColour(shape.strokeColor)}"/>
                        <strokeWeight value="${shape.weight || 2.0}"/>
                        <strokeStyle value="solid"/>
                        <color value="${convertWMtoCOTColour(shape.strokeColor)}"/>
                        <labels_on value="false"/>`;

                        if (shape.type === 'line') {
                            type = "u-d-f";
                        }

                        if (shape.type === 'poly') {
                            type = "u-d-f";
                            // Use rectangle type for 4-sided polygons
                            if (shape.points.length === 4) {
                                type = "u-d-r";
                            }
                            shapeXML += `<fillColor value="${convertWMtoCOTColour(shape.fillColor, shape.fillOpacity)}"/>`;
                        }
                    }
                }

                var et = Date.now() + ttl;
                et = (new Date(et)).toISOString();

                // Normalise altitude: convert feet suffix strings and altft property to metres
                if (msg.payload?.alt && typeof msg.payload.alt === "string" && msg.payload.alt.indexOf("ft") > -1) { msg.payload.alt = parseInt(msg.payload.alt) * 0.3048; }
                if (msg.payload?.altft && !msg.payload.alt) { msg.payload.alt = parseInt(msg.payload.altft) * 0.3048; }

                // Build and emit the final CoT event XML for the worldmap object
                msg.payload = `<event version="2.0" uid="NRC-${msg.payload.name}" type="${type}" time="${st}" start="${st}" stale="${et}" how="h-e">
                    <point lat="${msg.payload.lat || 0}" lon="${msg.payload.lon || 0}" hae="${parseInt(msg.payload.alt || invalid)}" le="9999999" ce="9999999"/>
                    <detail>
                        <takv device="${os.hostname()}" os="${os.platform()}" platform="NRedTAK" version="${ver}"/>
                        <track course="${msg.payload?.bearing || msg.payload?.hdg || 0}" speed="${parseInt(msg.payload?.speed) || 0}"/>
                        <contact callsign="${msg.payload.name}"/>
                        ${linkXML}
                        <remarks source="${node.callsign}">${tag}</remarks>
                        ${userIcon}
                        ${shapeXML}
                    </detail>
                </event>`
                msg.payload = msg.payload.replace(/>\s+</g, "><");
                msg.topic = type;
                node.send(msg);
            }

            // Maybe a simple event json update (eg from an ingest - tweak and send back)
            // Note this is not 100% reverse of the ingest... but seems to work mostly...
            else if (msg?.payload && typeof msg.payload === "object" && msg.payload.hasOwnProperty("event")) {
                // Reconstruct CoT XML from a parsed event object (e.g. from the TAK ingest node)
                const ev = msg.payload.event;
                msg.topic = ev.type;
                msg.payload = `<event version="${ev.version}" uid="${ev.uid}" type="${ev.type}" time="${ev.time}" start="${ev.start}" stale="${ev.stale}" how="${ev.how}">
                    <point lat="${ev.point.lat || 0}" lon="${ev.point.lon || 0}" hae="${ev.detail?.height?.value || ev.point.hae || 9999999}" le="${ev.point.le}" ce="${ev.point.ce}"/>
                    <detail>
                    <takv device="${os.hostname()}" os="${os.platform()}" platform="NRedTAK" version="${ver}"/>`
                if (ev.detail?.track) {
                    msg.payload += `<track speed="${ev.detail.track.speed}" course="${ev.detail.track.course}"/>`;
                }
                if (ev.detail?.color) {
                    msg.payload += `<color argb="${ev.detail.color.argb}"/>`;
                }
                msg.payload += `<contact callsign="${ev.detail?.contact?.callsign}"/>
                    <remarks source="${node.callsign}">${msg.remarks || ev.detail?.remarks}</remarks>
                    </detail>
                    </event>`
                msg.payload = msg.payload.replace(/>\s+</g, "><");
                node.send(msg);
            }

            // Drop anything we don't handle yet.
            else {
                node.log("Dropped: " + JSON.stringify(msg?.payload || "msg"));
            }
        });

        /**
         * Cleanup handler called when the node is stopped or redeployed.
         * Clears the heartbeat interval timer.
         */
        node.on("close", function() {
            clearInterval(this.interval_id);
            if (RED.settings.verbose) { this.log(RED._("inject.stopped")); }
        });
    }

    /**
     * Lookup table mapping AIS vessel type codes (single-digit / tens-digit bucket)
     * to their corresponding SIDC symbol codes for general vessel classes.
     * Used as a fallback when `aisToSidc2` has no exact match.
     *
     * @type {Object.<number, string>}
     */
    var aisToSidc1 = {
        0: "SASPX-------",
        4: "SASPXA------",
        5: "SASPXM------",
        6: "SASPXMP-----",
        7: "SASPXMC-----",
        8: "SASPXMO-----",
        9: "SASPXM------"
    }

    /**
     * Lookup table mapping specific AIS vessel type codes to their SIDC symbol codes.
     * Covers common vessel categories (fishing, tug, cargo, tanker, etc.).
     * Consulted before `aisToSidc1` for more precise classification.
     *
     * @type {Object.<number, string>}
     */
    var aisToSidc2 = {
        0: "SASPX-------",
        30: "SASPXF------",
        31: "SASPXMTO----",
        32: "SASPXMTO--NS",
        33: "SASPXFDR----",
        34: "SAUPND------",
        35: "SASP--------",
        36: "SASPXR------",
        37: "SASPXA------",
        40: "SASPXA------",
        50: "SASPXM------",
        52: "SASPXMTU----",
        53: "SASPNS------",
        55: "SASPXL------",
        58: "SASPNM------",
        60: "SASPXMP-----",
        70: "SASPXMC-----",
        71: "SASPXMH-----",
        72: "SASPXMH-----",
        73: "SASPXMH-----",
        74: "SASPXMH-----",
        80: "SASPXMO-----",
        90: "SASPXM------",
    }

    /**
     * Converts an AIS vessel type integer to a MIL-STD-2525 SIDC symbol code string.
     * Codes ≥ 100 are treated as non-standard/other and mapped to a generic symbol.
     * First checks `aisToSidc2` for an exact match, then falls back to `aisToSidc1`
     * using the tens digit, and finally returns a default unknown surface symbol.
     *
     * @param {number} aisType - AIS vessel type code (0–255)
     * @returns {string} 12-character SIDC symbol code
     */
    var ais2sidc = function (aisType) {
        if (aisType >= 100) { return "GNMPOHTH----"; }
        var aisType2 = aisToSidc2[aisType];
        if (aisType2 !== undefined) { return aisType2; }
        aisType = parseInt(aisType / 10);
        var aisType3 = aisToSidc1[aisType];
        if (aisType3 !== undefined) { return aisType3; }
        return "SASPX-------";
    }

    RED.nodes.registerType("tak registration", TakRegistrationNode);
};
