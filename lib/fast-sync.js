/*
* Refactor as a node module.
*/

/* eslint-env es6 */
/* eslint no-console: 0 */
'use strict';

const WebSocketServer = require('uws').Server;
const SYNC_INTERVAL = 1000 / 30;
let wsServers = new Map();
const extend = require('util')._extend;
const express = require('express');
const path = require('path');

// 0th entry is always filled
let ids = [true];

function wsHandleErr(e) {
	if (e) {
		console.log('Fast-Sync error:' + Date.now() + ' ' + e.message);
	}
}

function getWebSocketServer(server, options) {
	const rooms = {};
	if (wsServers.has(server)) {
		return wsServers.get(server);
	}
	const wss = new WebSocketServer(extend({ server: server }, options));
	wsServers.set(server, wss);
	wss.on('connection', function connection(ws) {
		let id = ids.indexOf(false);
		if (id === -1) {
			id = ids.push(true) - 1;
		}
		ws.id = id;
		ws._size = 0;

		ws.on('close', function close() {
			const roomies = [];
			wss.clients.forEach(
				function(ws) {
					if (ws._room === this._room) roomies.push(ws);
				}.bind(this)
			);

			const roomiesIds = roomies.map(ws => ws.id);

			roomies.forEach(function(ws) {
				ws.send(JSON.stringify(['UPDATE_USERS', roomiesIds]), wsHandleErr);
			});

			if (!!options.debug)
				console.log('user with id', id, 'left room', ws._room);
			if (rooms[ws._room]) rooms[ws._room].removeWs(ws);
		});

		ws.on('message', function incoming(message) {
			// Rebroadcast any string messages
			if (typeof message === 'string') {
				if (message === '__ping__') {
					return ws.send('__pong__', wsHandleErr);
				}
				let data;
				try {
					data = JSON.parse(message);
				} catch (e) {
					if (!!options.debug) console.log('INVALID JSON:' + message);
					return;
				}
				if (data[0] === 'HANDSHAKE') {
					if (!!options.debug)
						console.log('user with id', id, 'joined room', data[1]);

					ws._room = data[1];
					const room = rooms[ws._room] || new Room(options.debug);
					rooms[ws._room] = room;
					if (!room.hasWs()) {
						room.addWs(ws);
					}

					const roomies = [];
					wss.clients.forEach(function(ws) {
						if (ws._room === data[1]) roomies.push(ws);
					});

					const roomiesIds = roomies.map(ws => ws.id);
					roomiesIds.push(id);
					roomies.forEach(function(ws) {
						ws.send(JSON.stringify(['UPDATE_USERS', roomiesIds]), wsHandleErr);
					});

					return;
				}

				// By default rebroadcast

				// send to specific user
				if (data.length === 3) {
					message = JSON.stringify([data[0], id, data[2]]);
					wss.clients.forEach(function(otherWs) {
						otherWs.send(message);
					});
					return;
				}

				// send to everyone
				if (data.length === 2) {
					message = JSON.stringify([data[0], id, data[1]]);
					wss.clients.forEach(function(otherWs) {
						otherWs.send(message);
					});
					return;
				}
			} else {
				if (!ws._room) return;

				const room = rooms[ws._room];

				// if the size of the data from this ws grows then update it
				if (ws._size < message.byteLength) {
					ws._size = message.byteLength;
					room.updateSize();
				}

				room.set(ws, Buffer.from(message));
			}
		});

		ws.isAlive = true;
		ws.on('pong', heartbeat);

		ws.send(JSON.stringify(['HANDSHAKE', id]), wsHandleErr);
	});

	setInterval(function ping() {
		wss.clients.forEach(function each(ws) {
			if (ws.isAlive === false) {
				return ws.terminate();
			}

			ws.isAlive = false;
			ws.ping('', false, true);
		});
	}, 5000);

	setInterval(function() {
		const roomKeys = Object.keys(rooms);
		for (const roomKey of roomKeys) {
			const room = rooms[roomKey];
			if (room._clean) continue;
			for (const ws of room.webSockets) {
				ws.send(new Buffer(room._buffer.buffer, room._start), function() {
					room.clean();
				});
			}
		}
	}, SYNC_INTERVAL);

	wss.dist = express();

	wss.dist.use(
		options.path,
		express.static(path.resolve(path.join(__dirname, '../', 'dist')))
	);

	return wss;
}

/*
* Used to maintain a Buffer for the room which grows as needed
*/
class Room {
	constructor(debug) {
		this.webSockets = [];
		this._buffer = Buffer.alloc(1);
		this.clean();
		this.debug = !!debug;
	}

	hasWs(ws) {
		return this.webSockets.indexOf(ws) !== -1;
	}

	addWs(ws) {
		if (this.webSockets.indexOf(ws) === -1) {
			this.webSockets.push(ws);
			this.updateSize();
		}
	}

	removeWs(ws) {
		if (this.webSockets.indexOf(ws) !== -1) {
			// Pull out the old websockets and filter to remove the one that left
			// Then put them back
			const old = this.webSockets.splice(0).filter(testWs => testWs !== ws);
			this.webSockets.push(...old);
			this.updateSize();
		}
	}

	updateSize() {
		this._size = this.webSockets.reduce((a, b) => a + b._size, 0);
		this._buffer = Buffer.alloc(this._size);
		if (this.debug) console.log('Buffer Update', this._size);
		this.clean();
	}

	clean() {
		this._buffer.fill(0);
		this._clean = true;
		this._start = Infinity;
	}

	set(ws, data) {
		let offset = 0;
		for (let i = 0; i < this.webSockets.length; i++) {
			const testWs = this.webSockets[i];
			if (ws === testWs) break;
			offset += testWs._size;
		}
		if (this._start > offset) this._start = offset;
		this._clean = false;
		data.copy(this._buffer, offset);
	}
}

function heartbeat() {
	this.isAlive = true;
}

module.exports = getWebSocketServer;
