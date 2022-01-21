node-red-contrib-tak-registration
=================================

A <a href="http://nodered.org" target="_new">Node-RED</a> node to register to a TAK server,
and to help send wrap files as datapackages for TAK.

**NOTE**: NOT yet for production use.

Install
-------

Run the following command in your Node-RED user directory - typically `~/.node-red`

    npm i node-red-contrib-tak-registration

Usage
-----

Registers a TAK gateway node and sets up a heartbeat.

Must be used in conjunction with a TCP request node, set to point to the TAK server tcp address and port
(usually 8087 or 8089), set to return strings, <i>keep connection open</i> mode, and split on "&lt;/event&gt;".

It can also accepts files to be sent to the TAK server by sending a msg as follows:

### Input properties required

 -  **sendTo** - *string|array* - can either be an individual TAK callsign, an array of callsigns, or **broadcast**
to send to all users, or **public** to just upload the package to the TAK server.
 - **topic** - *string* - the overall package name - IE what you want it to be called on the TAK device (keep it short).
 - **attachments** - *array of objects* - each object must contain at least a **filename** (string) and *content** a buffer of the file/data, for example `[{filename:"foo.kml", content: <buffer of the file>}]`

### Details

This should work almost directly with messages received from an email-in node for example - but you will need to add the recipients in the sendTo property and may need to filter out unwanted messages first.