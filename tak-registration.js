const { methodToString } = require('adm-zip/util');

module.exports = function(RED) {
    "use strict";
    const os = require('os');
    const AdmZip = require('adm-zip');
    const axios = require('axios').default;
    const crypto = require("crypto");
    const FormData = require('form-data')
    const { v4: uuidv4 } = require('uuid');
    const uuid = require('uuid');
    const ver = require('./package.json').version;

    function TakRegistrationNode(n) {
        RED.nodes.createNode(this,n);
        this.group = n.group;
        this.role = n.role || "Gateway";
        this.type = n.type || "a-f-G-I-B";
        this.lat = n.latitude;
        this.lon = n.longitude;
        this.alt = 9999999;
        this.callsign = n.callsign;
        this.repeat = n.repeat;
        this.host = n.dphost;
        this.uuid = "GATEWAY-"+(crypto.createHash('md5').update(Buffer.from(os.hostname())).digest('hex')).slice(0,16);
        var node = this;

        if (node.repeat > 2147483) {
            node.error("TAK Heartbeat interval is too long.");
            delete node.repeat;
        }

        var sendIt = function() {
            node.emit("input", {
                time: new Date().toISOString(),
                etime: new Date(Date.now() + 2000 * node.repeat).toISOString(),
                lat: node.lat,
                lon: node.lon,
                alt: node.alt,
                callsign: node.callsign,
                group: node.group,
                role: node.role,
                type: node.type,
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

        node.on("input",function(msg) {
            if (msg.heartbeat) {  // Register gateway and do the heartbeats
                var template = `<event version="2.0" uid="${node.uuid}" type="${msg.type}" how="h-e" time="${msg.time}" start="${msg.time}" stale="${msg.etime}"><point lat="${msg.lat}" lon="${msg.lon}" hae="${msg.alt}" ce="9999999" le="9999999"/><detail><takv device="${os.hostname()}" os="${os.platform()}" platform="NRedTAK" version="${ver}"/><contact endpoint="*:-1:stcp" callsign="${msg.callsign}"/><uid Droid="${msg.callsign}"/><__group name="${msg.group}" role="${msg.role}"/><status battery="99"/></detail></event>`;
                node.send({payload:template});
                node.status({fill:"green", shape:"dot", text: node.repeat/1000+"s - "+node.callsign});
                return;
            }
            // If there are attachments handle them first.
            if (msg.hasOwnProperty("attachments") && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
                if (!msg.sendTo) { node.error("Missing 'sendTo' user TAK callsign property.",msg); return; }
                var UUID = uuid.v5(msg.topic,'d5d4a57d-48fb-58b6-93b8-d9fde658481a');
                var fnam = msg.topic;
                var fname = msg.topic+'.zip';
                var mf = `<MissionPackageManifest version="2"><Configuration>
                <Parameter name="uid" value="${UUID}"/>
                <Parameter name="name" value="${msg.topic}"/>
                </Configuration><Contents>`;
                var zip = new AdmZip();
                for (var i=0; i < msg.attachments.length; i++) {
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
                    mf +=`<Content ignore="false" zipEntry="${fhash}" />`;
                }
                mf +=`</Contents></MissionPackageManifest>`;
                mf = mf.replace(/>\s+</g, "><");
                zip.addFile('MANIFEST/manifest.xml', Buffer.from(mf,'utf8'), msg.topic);
                var zipbuff = zip.toBuffer();
                //zip.writeZip("/tmp/takfile")

                msg = {
                    from: node.callsign || msg.from || "Anonymous",
                    sendTo: msg.sendTo,
                    lat: node.lat || msg.lat || 0,
                    lon: node.lon || msg.lon || 0,
                    assetfile: fname,
                    len: zipbuff.length,
                    uid: node.uuid,
                    hash:  crypto.createHash('sha256').update(zipbuff).digest('hex')
                }

                let formData = new FormData();
                const opts = { filename:fname, contentType:'application/x-zip-compressed' };
                formData.append('assetfile', zipbuff, opts);

                const url = encodeURI(node.host+'/Marti/sync/missionupload?hash='+msg.hash+'&filename='+fname+'&creatorUid='+node.uuid);
                axios({
                    method: 'post',
                    url: url,
                    headers: formData.getHeaders(),
                    data: formData
                })
                    .then(function (response) {
                        const urlp = encodeURI(node.host+'/Marti/api/sync/metadata/'+msg.hash+'/tool');
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
                                        <point lat="${msg.lat}" lon="${msg.lon}" hae="9999999" ce="9999999" le="9999999" />
                                        <detail>
                                        <fileshare filename="${fname}" senderUrl="${node.host}/Marti/sync/content?hash=${msg.hash}" sizeInBytes="${msg.len}" sha256="${msg.hash}" senderUid="${msg.uid}" senderCallsign="${msg.from}" name="${fnam}" />`
                                    if (msg.sendTo !== "broadcast") {
                                        var t = msg.sendTo;
                                        if (!Array.isArray(t)) { t = [ t ]; }
                                        m += '<marti>' + t.map(v => '<dest callsign="' + v +'"/>') + '</marti>';
                                    }
                                    m += '</detail></event>';
                                    node.log( "DP: " + node.host + "/Marti/sync/content?hash=" + msg.hash );
                                    msg.payload = m.replace(/>\s+</g, "><");
                                    node.send(msg);
                                }
                            })
                            .catch(function (error) {
                                node.error(error.message,error);
                            })
                    })
                    .catch(function (error) {
                        node.error(error.message,error);
                    })
            }
            else if (typeof msg.payload === "string" ) {
                if (msg.payload.trim().startsWith('<') && msg.payload.trim().endsWith('>')) { // Assume it's proper XML event so pass straight through
                    node.send(msg);
                }
                else if (msg.payload.trim().startsWith('$GPGGA')) { // maybe it's an NMEA string
                    // console.log("It's NMEA",msg.payload);
                    var nm = msg.payload.trim().split(',');
                    if (nm[0] === '$GPGGA' && nm[6] > 0) {
                        const la = parseInt(nm[2].substr(0,2)) + parseFloat(nm[2].substr(2))/60;
                        node.lat = ((nm[3] === "N") ? la : -la).toFixed(6);
                        const lo = parseInt(nm[4].substr(0,3)) + parseFloat(nm[4].substr(3))/60;
                        node.lon = ((nm[5] === "E") ? lo : -lo).toFixed(6);
                        node.alt = nm[9];
                    }
                }
            }
            // Handle a generic worldmap marker style as a normal marker
            else if (typeof msg.payload === "object" && msg.payload.hasOwnProperty("name") && msg.payload.hasOwnProperty("lat") && msg.payload.hasOwnProperty("lon")) {
                var d = new Date();
                var st = d.toISOString();
                var ttl = ((msg.payload.ttl || 0) * 1000) || 60000;
                var et = Date.now() + ttl;
                et = (new Date(et)).toISOString();
                var tag ="#Worldmap";
                if (msg.payload.layer) { tag = "#" + msg.payload.layer }
                var type = msg.payload.type || "a-u-g-u";
                if (!msg.payload.type && msg.payload.SIDC) {
                    var s = msg.payload.SIDC.split('-')[0].toLowerCase();
                    if (s.startsWith('s')) {
                        type = s.split('').join('-').replace('s-','a-').replace('-p-','-');
                    }
                }
                // console.log("TYPE",type)
                msg.payload = `<event version="2.0" type="${type}" uid="${msg.payload.name}" time="${st}" start="${st}" stale="${et}" how="h-e">
                    <point lat="${msg.payload.lat || 0}" lon="${msg.payload.lon || 0}" hae="${parseInt(msg.payload.alt || 9999999.0)}" le="9999999.0" ce="9999999.0"/>
                    <detail>
                        <takv device="${os.hostname()}" os="${os.platform()}" platform="NRedTAK" version="${ver}"/>
                        <track course="${msg.payload.bearing || 0}" speed="${parseInt(msg.payload.speed) || 0}"/>
                        <contact callsign="${msg.payload.name}"/>
                        <remarks source="NRedTAK">${tag}</remarks>
                    </detail>
                </event>`
                msg.payload = msg.payload.replace(/>\s+</g, "><");
                node.send(msg);
            }
            // Just has lat, lon (and alt) but no name - assume it's our local position we're updating
            else if (typeof msg.payload === "object" && !msg.payload.hasOwnProperty("name") && msg.payload.hasOwnProperty("lat") && msg.payload.hasOwnProperty("lon")) {
                node.lat = msg.payload.lat;
                node.lon = msg.payload.lon;
                if (msg.payload.hasOwnProperty("alt")) { node.alt = parseInt(msg.payload.alt); }
            }
            // Drop anything we don't handle yet.
            else {
                node.log("Dropped: "+JSON.stringify(msg.payload));
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

    RED.nodes.registerType("tak registration",TakRegistrationNode);
};
