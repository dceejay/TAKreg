const { methodToString } = require('adm-zip/util');
const { isArray } = require('util');

module.exports = function (RED) {
    "use strict";
    const os = require('os');
    const AdmZip = require('adm-zip');
    const axios = require('axios').default;
    const crypto = require("crypto");
    const FormData = require('form-data')
    const { v4: uuidv4 } = require('uuid');
    const uuid = require('uuid');
    const turf = require("@turf/turf");
    const ver = require('./package.json').version;
    const teamList = ["Cyan", "Red", "Green", "Blue", "Magenta", "Yellow", "Orange", "Maroon", "Purple", "Dark Blue", "Dark Green", "Teal", "Brown"];

    function TakRegistrationNode(n) {
        RED.nodes.createNode(this, n);
        const invalid = "9999999.0";
        this.group = n.group;
        this.role = n.role || "Gateway";
        this.ntype = n.ntype || "a-f-G-I-B";
        this.lat = n.latitude;
        this.lon = n.longitude;
        this.callsign = n.callsign;
        this.repeat = n.repeat;
        this.host = n.dphost;
        this.uuid = "GATEWAY-" + (crypto.createHash('md5').update(Buffer.from(this.id)).digest('hex')).slice(0, 16);
        var node = this;
        node.alt = invalid;
        var globalContext = this.context().global;
        var g = {};
        g[node.uuid] = node.callsign;
        globalContext.set("_takgatewayid", g);
        var gr = {};
        gr[node.callsign] = node.uuid;
        globalContext.set("_takgatewaycs", gr);
        globalContext.set("_takdphost", node.host);

        if (node.role !== "Gateway") { node.ntype = "a-f-G-U-C" }

        if (node.repeat > 2147483) {
            node.error("TAK Heartbeat interval is too long.");
            delete node.repeat;
        }

        var convertWMtoKMLColour = function (colour, opacity) {
            if (opacity == undefined) { opacity = 100; }
            var alfa = parseInt(opacity * 255 / 100).toString(16);
            return alfa + colour;
        };

        var convertWMtoCOTColour = function (colour, opacity) {
            var c;
            if (opacity != undefined) {
                c = Buffer.from(parseInt(opacity * 255 / 100).toString(16) + colour, "hex");
            }
            else {
                c = Buffer.from("FF" + colour, "hex");
            }
            return c.readInt32BE()
        };

        var findCentroidOfPoints = function (points) {
            if (points.length < 4) { // pad if necessary (needs 4 points minimum)
                points.push(points[2]);
                points.unshift(points[0]);
            }
            var poly = turf.polygon([points]);
            var centroid = turf.centroid(poly);
            return centroid;
        };

        var sendIt = function () {
            node.emit("input", {
                time: new Date().toISOString(),
                etime: new Date(Date.now() + (2 * node.repeat)).toISOString(),
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

        node.repeaterSetup = function () {
            node.repeat = node.repeat * 1000;
            if (RED.settings.verbose) {
                node.log(RED._("inject.repeat", node));
            }
            node.interval_id = setInterval(sendIt, node.repeat);
        };

        node.repeaterSetup();
        setTimeout(sendIt, 2500);

        node.on("input", function (msg) {
            if (msg.heartbeat) {  // Register gateway and do the heartbeats
                var template = `<event version="2.0" uid="${node.uuid}" type="${msg.type}" how="h-e" time="${msg.time}" start="${msg.time}" stale="${msg.etime}"><point lat="${msg.lat}" lon="${msg.lon}" hae="${msg.alt}" ce="9999999" le="9999999"/><detail><takv device="${os.hostname()}" os="${os.platform()}" platform="NRedTAK" version="${ver}"/><contact endpoint="*:-1:stcp" callsign="${msg.callsign}"/><uid Droid="${msg.callsign}"/><__group name="${msg.group}" role="${msg.role}"/><status battery="99"/><track course="9999999.0" speed="0"/></detail></event>`;
                node.send({ payload: template, topic: "TAKreg" });
                node.status({ fill: "green", shape: "dot", text: node.repeat / 1000 + "s - " + node.callsign });
                return;
            }
            // if it's just a simple filename and buffer payload then make it look like an attachment etc...
            if (msg.hasOwnProperty("filename") && Buffer.isBuffer(msg.payload) && !msg.hasOwnProperty("attachments")) {
                msg.attachments = [{
                    filename: msg.filename.split('/').pop(),
                    content: msg.payload
                }]
                if (!msg.hasOwnProperty("topic")) { msg.topic = "File - " + msg.filename.split('/').pop(); }
                delete msg.filename;
                delete msg.payload;
            }
            // If there are attachments handle them first. (Datapackage)
            if (msg.hasOwnProperty("attachments") && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
                if (!msg.sendTo) { node.error("Missing 'sendTo' user TAK callsign property.", msg); return; }
                var UUID = uuid.v5(msg.topic, 'd5d4a57d-48fb-58b6-93b8-d9fde658481a');
                var fnam = msg.topic || msg.attachments[0].filename.split('.')[0];
                var fname = fnam + '.zip';
                var da = new Date();
                var dn = da.toISOString().split('-')[2].split('.')[0];
                var calls = msg.from || node.callsign;
                calls = calls + '.' + dn.split('T')[0] + '.' + dn.split('T')[1].split(':').join('');
                var mf = `<MissionPackageManifest version="2"><Configuration>
                <Parameter name="uid" value="${UUID}"/>
                <Parameter name="name" value="${msg.topic}"/>
                <Parameter name="onReceiveImport" value="true"/>
                <Parameter name="callsign" value="${calls}"/>
                </Configuration><Contents>\n`;
                var zip = new AdmZip();
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

                if (msg.hasOwnProperty("lat") && msg.hasOwnProperty("lon")) {
                    var timeo = new Date(Date.now() + (1000*60*60*4)).toISOString(); // stale time to 4 hours
                    var cott = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                    <event version="2.0" uid="${UUID}" type="b-i-x-i" time="${da.toISOString()}" start="${da.toISOString()}" stale="${timeo}" how="h-g-i-g-o">
                        <point lat="${msg.lat}" lon="${msg.lon}" hae="${msg.alt || "9999999.0"}" ce="9999999.0" le="9999999.0" />
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

                let formData = new FormData();
                const opts = { filename: fname, contentType: 'application/x-zip-compressed' };
                formData.append('assetfile', zipbuff, opts);

                const url = encodeURI(node.host + '/Marti/sync/missionupload?hash=' + msg.hash + '&filename=' + fname + '&creatorUid=' + node.uuid);
                axios({
                    method: 'post',
                    url: url,
                    headers: formData.getHeaders(),
                    data: formData
                })
                    .then(function (response) {
                        const urlp = encodeURI(node.host + '/Marti/api/sync/metadata/' + msg.hash + '/tool');
                        var priv = (msg.sendTo === "public") ? "public" : "private";
                        axios({
                            method: 'put',
                            url: urlp,
                            data: priv
                        })
                            .then(function (response) {
                                if (priv === "private") {
                                    const start = new Date().toISOString();
                                    const stale = new Date(new Date().getTime() + (10000)).toISOString();

                                    var m = `<event version="2.0" uid="${uuidv4()}" type="b-f-t-r" how="h-e" time="${start}" start="${start}" stale="${stale}">
                                        <point lat="${msg.lat}" lon="${msg.lon}" hae="${msg.alt || 9999999.0}" ce="9999999.0" le="9999999.0" />
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
            // Otherwise if it's a string maybe it's raw cot xml - or NMEA from GPS - or maybe a simple chat message
            else if (typeof msg.payload === "string") {
                if (msg.payload.trim().startsWith('<') && msg.payload.trim().endsWith('>')) { // Assume it's proper XML event so pass straight through
                    msg.topic = msg.payload.split('type="')[1].split('"')[0];
                    node.send(msg);
                }
                else if (msg.payload.trim().startsWith('$GPGGA')) { // maybe it's an NMEA string
                    // console.log("It's NMEA",msg.payload);
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
                    // simple text payload and no attachments so guess it's a chat message...
                    // node.log("Geochat to " + msg.sendTo);
                    if (!Array.isArray(msg.sendTo)) { msg.sendTo = msg.sendTo.split(','); }
                    const start = new Date().toISOString();
                    const stale = new Date(new Date().getTime() + (10000)).toISOString();
                    const mid = uuidv4();
                    var type = "a-f-G-I-B";
                    var par = '';

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
        <point lat="${node.lat}" lon="${node.lon}" hae="9999999.0" ce="9999999.0" le="9999999.0"/>
        <detail>
            <__chat ${par} groupOwner="false" messageId="${mid}" chatroom="${m.sendTo}" id="${toid}" senderCallsign="${node.callsign}">
                <chatgrp uid0="${node.uuid}" uid1="${toid}" id="${toid}"/>
            </__chat>
            <link uid="${node.uuid}" type="${type}" relation="p-p"/>
            <remarks source="BAO.F.ATAK.${node.uuid}" to="${toid}" time="${start}">${msg.payload}</remarks>
            ${ma}
            <track speed="0.0" course="0.0"/>
        </detail>
    </event>`;
                        // console.log(xm);
                        m.payload = xm.replace(/>\s+</g, "><");
                        m.topic = "b-t-f";
                        node.send(m);
                    }
                }
            }
            // Just has lat, lon (and alt) but no name - assume it's our local position we're updating
            else if (typeof msg.payload === "object" && !msg.payload.hasOwnProperty("name") && msg.payload.hasOwnProperty("lat") && msg.payload.hasOwnProperty("lon")) {
                node.lat = msg.payload.lat;
                node.lon = msg.payload.lon;
                if (msg.payload.hasOwnProperty("alt")) { node.alt = parseInt(msg.payload.alt); }
            }
            // Handle a generic worldmap style object
            else if (typeof msg.payload === "object" && msg.payload.hasOwnProperty("name")) {
                var shapeXML = ``;
                var d = new Date();
                var st = d.toISOString();
                var ttl = ((msg.payload.ttl || 0) * 1000) || 60000;
                var tag = msg.payload.remarks || "";
                if (msg.payload.tag) { tag += " " + msg.payload.tag }
                if (msg.payload.layer) { tag += " #" + msg.payload.layer }
                else { tag += " #Worldmap"; }

                // Handle simple markers
                if (msg.payload.hasOwnProperty("lat") && msg.payload.hasOwnProperty("lon")) {
                    var type = msg.payload.cottype || "a-u-g-u";
                    if (!msg.payload.cottype && !msg.payload.SIDC && msg.payload.aistype) {
                        msg.payload.SIDC = ais2sidc(msg.payload.aistype);
                    }
                    if (!msg.payload.cottype && msg.payload.SIDC) {
                        var s = msg.payload.SIDC.split('-')[0].toLowerCase();
                        if (s.startsWith('s')) {
                            type = s.split('').join('-').replace('s-', 'a-').replace('-p-', '-');
                        }
                    }
                    if (msg.payload.icon === 'fa-circle fa-fw') {
                        type = 'b-m-p-s-m';
                        shapeXML = '<color argb="' + convertWMtoCOTColour(msg.payload.iconColor.replace('#', '')) + '"/>';
                        shapeXML = shapeXML + '<usericon iconsetpath="COT_MAPPING_SPOTMAP/b-m-p-s-m/-16711681"/>';
                    }
                }

                // Handle Worldmap drawing shapes
                if (msg.payload.hasOwnProperty("action") && msg.payload.action === "draw") {
                    ttl = 24 * 60 * 60 * 1000;  /// set TTL to 1 day for shapes...

                    var shape = {
                        "strokeColor": (msg.payload.options.color || "910000").replace('#', ''),
                        "fillColor": (msg.payload.options.color || "910000").replace('#', ''),
                        "fillOpacity": msg.payload.options.opacity * 100 || 50,
                        "strokeWeight": msg.payload.options.weight || 2
                    };

                    if ("radius" in msg.payload) {
                        // Ellipse
                        shape.type = "ellipse";
                        shape.radius = {
                            "major": msg.payload.radius,
                            "minor": msg.payload.radius
                        };
                    }
                    else if ("line" in msg.payload) {
                        // Line
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
                        msg.payload.lat = lineCent.geometry.coordinates[0];
                        msg.payload.lon = lineCent.geometry.coordinates[1];
                    }
                    else if ("area" in msg.payload) {
                        // Polygon / Rectangle
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
                        msg.payload.lat = polyCent.geometry.coordinates[0];
                        msg.payload.lon = polyCent.geometry.coordinates[1];
                    }
                    // console.log("SHAPE",shape)
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

                        for (var l = 0; l < shape.points.length; l++) {
                            // linkArrayXML += `<link uid="${msg.payload.name}.l" point="${shape.points[l].lat},${shape.points[l].lon},${shape.points[l].alt || invalid}"/>\n`;
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
                            shapeXML += `<fillColor value="${convertWMtoCOTColour(shape.fillColor, shape.fillOpacity)}"/>`;
                            type = "u-d-f";
                            if (shape.points.length === 4) {
                                type = "u-d-r";
                            }
                        }
                    }
                }

                var et = Date.now() + ttl;
                et = (new Date(et)).toISOString();

                msg.payload = `<event version="2.0" uid="${msg.payload.name}" type="${type}" time="${st}" start="${st}" stale="${et}" how="h-e">
                    <point lat="${msg.payload.lat || 0}" lon="${msg.payload.lon || 0}" hae="${parseInt(msg.payload.alt || invalid)}" le="9999999.0" ce="9999999.0"/>
                    <detail>
                        <takv device="${os.hostname()}" os="${os.platform()}" platform="NRedTAK" version="${ver}"/>
                        <track course="${msg.payload.bearing || 9999999.0}" speed="${parseInt(msg.payload.speed) || 0}"/>
                        <contact callsign="${msg.payload.name}"/>
                        <remarks source="${node.callsign}">${tag}</remarks>
                        ${shapeXML}
                    </detail>
                </event>`
                msg.payload = msg.payload.replace(/>\s+</g, "><");
                msg.topic = type;
                node.send(msg);
            }

            // Maybe a simple event json update (eg from an ingest - tweak and send back)
            // Note this is not 100% reverse of the ingest... but seems to work mostly...
            else if (typeof msg.payload === "object" && msg.payload.hasOwnProperty("event")) {
                const ev = msg.payload.event;
                msg.topic = ev.type;
                msg.payload = `<event version="${ev.version}" uid="${ev.uid}" type="${ev.type}" time="${ev.time}" start="${ev.start}" stale="${ev.stale}" how="${ev.how}">
                    <point lat="${ev.point.lat || 0}" lon="${ev.point.lon || 0}" hae="${ev.detail?.height?.value || ev.point.hae || 9999999.0}" le="${ev.point.le}" ce="${ev.point.ce}"/>
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
                node.log("Dropped: " + JSON.stringify(msg.payload));
            }
        });

        node.on("close", function() {
            // var tim = new Date().toISOString();
            // var template = `<?xml version="1.0" encoding="utf-8" standalone="yes"?><event version="2.0" uid="${node.uuid}" type="t-x-d-d" how="h-g-i-g-o" time="${tim}" start="${tim}" stale="${tim}"><detail><link uid="${node.uuid}" relation="p-p" type="a-f-G-I-B" /></detail><point le="9999999.0" ce="9999999.0" hae="9999999.0" lon="0" lat="0" /></event>"`;
            // node.send({payload:template});  // This never happens in time so not useful
            clearInterval(this.interval_id);
            if (RED.settings.verbose) { this.log(RED._("inject.stopped")); }
        });
    }

    var aisToSidc1 = {
        4: "SFSPXA------",
        5: "SFSPXM------",
        6: "SFSPXMP-----",
        7: "SFSPXMC-----",
        8: "SFSPXMO-----",
        9: "SFSPXM------"
    }

    var aisToSidc2 = {
        30: "SFSPXF------",
        31: "SFSPXMTO----",
        32: "SFSPXMTO--NS",
        33: "SFSPXFDR----",
        34: "SFUPND------",
        35: "SFSP--------",
        36: "SFSPXR------",
        37: "SFSPXA------",
        40: "SFSPXA------", //-
        50: "SFSPXM------", //-
        52: "SFSPXMTU----",
        53: "SFSPNS------",
        55: "SFSPXL------",
        58: "SFSPNM------",
        60: "SFSPXMP-----", //-
        70: "SFSPXMC-----", //-
        71: "SFSPXMH-----",
        72: "SFSPXMH-----",
        73: "SFSPXMH-----",
        74: "SFSPXMH-----",
        80: "SFSPXMO-----", //-
        90: "SFSPXM------", //-
    }

    var ais2sidc = function (aisType) {
        //aisType = Number(aisType);
        if (aisType >= 100) { return "GNMPOHTH----"; }
        aisType = aisToSidc2[aisType];
        if (aisType && isNaN(aisType)) { return aisType; }
        aisType = parseInt(aisType / 10);
        aisType = aisToSidc1[aisType];
        if (aisType && isNaN(aisType)) { return aisType; }
        return "SFSPXM------";
    }

    RED.nodes.registerType("tak registration", TakRegistrationNode);
};
