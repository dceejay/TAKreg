node-red-contrib-tak-registration
=================================

A <a href="http://nodered.org" target="_new">Node-RED</a> node to register to a TAK server, to help send wrap files as datapackages for TAK, and to create simple markers from json messages.

**NOTE**: NOT yet for production use.

## Install

Run the following command in your Node-RED user directory - typically `~/.node-red`

    npm i node-red-contrib-tak-registration

## Usage

Registers a TAK gateway node and sets up a heartbeat.

Works in conjunction with a TCP request node, set to point to the TAK server tcp address and port
(usually 8087 or 8089), set to return strings, <i>keep connection open</i> mode, and split on "&lt;/event&gt;".

It can send various types of messages to TAK.

### Standard COT event

If the `msg.payload` is an XML string it will be passed directly though.

### Sending data packages...

requires a msg containing the following properties

 - **sendTo** - *string|array* - can either be an individual TAK callsign, an array of callsigns, or **broadcast**
to send to all users, or **public** to just upload the package to the TAK server.
 - **topic** - *string* - the overall package name - IE what you want it to be called on the TAK device (keep it short).
 - **attachments** - *array of objects* - each object must contain at least a **filename** (string) and **content** a buffer of the file/data, for example `[{filename:"foo.kml", content: <buffer of the file>}]`

### Sending marker position...

To create or update a simple marker send a msg with the following property

 - **payload** - *object* - a "standard" node-red worldmap format msg.payload containing `name, lat, lon, cottype or SIDC, (alt), (speed), (bearing), (layer)`, where `cottype` is the CoT type eg a-f-g-u, or `SIDC` is the standard mil 2525C code, eg SFGPU. The `layer` will get turned into a hashtag which can then be selected on/off in the TAK app layers control.

### Updating gateway position...

To update the location of the gateway dynamically the node can accept a payload

 - **payload** - *string|object* - Either a string starting `$GPGGA` (for example from a locally attached serial GPS device) - or an object containing `lat` and `lon` and optional `alt` properties (but no name property).

### Details

This should work almost directly with messages received from an email-in node for example - but you will need to add the recipients in the sendTo property and may need to filter out unwanted messages first.

As well as accepting simple worldmap type marker object it will accept "draw" actions from the
worldmap drawing layer and convert them to CoT objects for display.
