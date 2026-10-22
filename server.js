const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomInt } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_PLAYERS = 4;
const MAX_MESSAGE_BYTES = 4096;
const MAX_MESSAGES_PER_WINDOW = 30;
const MESSAGE_WINDOW_MS = 10_000;
const STARTING_MONEY = 800;
const BOARD_SIZE = 30;
const PROPERTIES = {
	1: { price: 60, rent: 8, group: 'coast' }, 2: { price: 80, rent: 10, group: 'coast' },
	4: { price: 150, rent: 4, kind: 'utility' }, 5: { price: 200, rent: 25, kind: 'transport' },
	6: { price: 100, rent: 12, group: 'cyan' }, 7: { price: 120, rent: 14, group: 'cyan' },
	9: { price: 140, rent: 16, group: 'orange' }, 10: { price: 160, rent: 19, group: 'orange' },
	11: { price: 180, rent: 25, kind: 'transport' }, 12: { price: 180, rent: 22, group: 'red' },
	13: { price: 200, rent: 24, group: 'red' }, 14: { price: 220, rent: 40, kind: 'transport' },
	16: { price: 220, rent: 26, group: 'yellow' }, 17: { price: 240, rent: 28, group: 'yellow' },
	19: { price: 260, rent: 31, group: 'green' }, 20: { price: 280, rent: 34, group: 'green' },
	21: { price: 150, rent: 4, kind: 'utility' },
	23: { price: 320, rent: 42, group: 'blue' }, 24: { price: 300, rent: 38, group: 'blue' },
	27: { price: 280, rent: 34, group: 'purple' }, 28: { price: 260, rent: 31, group: 'purple' }
};
const SPACE_NAMES = {
	1: 'قشم', 2: 'کیش', 4: 'شرکت آب', 5: 'شرکت راه‌آهن', 6: 'کاشان',
	7: 'یزد', 9: 'کرمان', 10: 'اصفهان', 11: 'مترو', 12: 'شیراز',
	13: 'بوشهر', 14: 'شرکت هواپیمایی', 16: 'تبریز', 17: 'رشت',
	18: 'عوارض', 19: 'ارومیه', 20: 'مشهد', 21: 'شرکت برق', 22: 'مالیات', 23: 'تهران', 24: 'کرج',
	27: 'اهواز', 28: 'سنندج'
};
const CHANCE_AMOUNTS = [100, -80, 50, -50, 120, -70];

const rooms = new Map();
const clients = new Map();

const server = http.createServer((request, response) => {
	if (request.url === '/health') {
		response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
		response.end(JSON.stringify({ status: 'ok', rooms: rooms.size, clients: clients.size }));
		return;
	}
	if (request.url === '/' || request.url === '/index.html') {
		fs.readFile(path.join(__dirname, 'index.html'), (error, contents) => {
			if (error) {
				response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
				response.end('Unable to load the game page.');
				console.error('Unable to load index.html:', error.message);
				return;
			}
			response.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store'
			});
			response.end(contents);
		});
		return;
	}

	response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
	response.end(JSON.stringify({ error: 'not_found' }));
});

const wss = new WebSocketServer({
	server,
	maxPayload: MAX_MESSAGE_BYTES,
	perMessageDeflate: false
});

function send(socket, message) {
	if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function fail(socket, code, message) {
	send(socket, { type: 'error', code, message });
}

function normalizeUsername(value) {
	if (typeof value !== 'string') return null;
	const username = value.trim().replace(/\s+/g, ' ').slice(0, 24);
	return username.length >= 2 ? username : null;
}

function createRoomCode() {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let code;
	do {
		code = Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
	} while (rooms.has(code));
	return code;
}

function roomFor(socket) {
	const client = clients.get(socket);
	return client?.roomCode ? rooms.get(client.roomCode) : null;
}

function roomSnapshot(room) {
	return {
		code: room.code,
		started: room.started,
		phase: room.phase,
		activePlayerId: room.started ? room.players[room.activeIndex]?.id ?? null : null,
		offeredProperty: room.offeredProperty,
		lastRoll: room.lastRoll,
		turnNumber: room.turnNumber,
		players: room.players.map((player) => ({
			id: player.id,
			username: player.username,
			position: player.position,
			money: player.money,
			properties: player.properties,
			jailed: player.jailed,
			connected: player.connected,
			isHost: player.id === room.hostId
		}))
	};
}

function broadcastRoom(room, message) {
	for (const player of room.players) {
		const socket = player.socket;
		if (player.connected && socket) send(socket, message);
	}
}

function broadcastSnapshot(room) {
	broadcastRoom(room, { type: 'room_state', room: roomSnapshot(room) });
}

function addPlayer(room, socket, username, isHost = false) {
	const player = {
		id: randomUUID(),
		username,
		position: 0,
		money: STARTING_MONEY,
		properties: [],
		jailed: false,
		connected: true,
		socket
	};
	room.players.push(player);
	clients.get(socket).roomCode = room.code;
	if (isHost) room.hostId = player.id;
	return player;
}

function leaveRoom(socket) {
	const client = clients.get(socket);
	const room = roomFor(socket);
	if (!client) return;
	client.roomCode = null;
	if (!room) return;

	const playerIndex = room.players.findIndex((player) => player.socket === socket);
	if (playerIndex === -1) return;
	const wasActivePlayer = room.started && playerIndex === room.activeIndex;
	const [player] = room.players.splice(playerIndex, 1);
	if (room.players.length === 0) {
		rooms.delete(room.code);
		return;
	}

	if (room.hostId === player.id) room.hostId = room.players[0].id;
	if (room.started && playerIndex < room.activeIndex) room.activeIndex -= 1;
	if (room.started && room.activeIndex >= room.players.length) room.activeIndex = 0;
	if (wasActivePlayer) {
		room.phase = 'roll';
		room.lastRoll = null;
		room.offeredProperty = null;
	}
	broadcastRoom(room, {
		type: 'player_left',
		playerId: player.id,
		username: player.username
	});
	broadcastSnapshot(room);
}

function handleCreateRoom(socket, message) {
	const username = normalizeUsername(message.username);
	if (!username) return fail(socket, 'invalid_username', 'نام کاربری باید بین ۲ تا ۲۴ نویسه باشد.');
	if (clients.get(socket).roomCode) return fail(socket, 'already_in_room', 'ابتدا از اتاق فعلی خارج شو.');

	const room = {
		code: createRoomCode(),
		hostId: null,
		players: [],
		started: false,
		phase: 'lobby',
		activeIndex: 0,
		turnNumber: 1,
		lastRoll: null,
		offeredProperty: null,
		createdAt: Date.now()
	};
	rooms.set(room.code, room);
	const player = addPlayer(room, socket, username, true);
	send(socket, { type: 'room_created', roomCode: room.code, playerId: player.id });
	broadcastSnapshot(room);
}

function handleJoinRoom(socket, message) {
	const username = normalizeUsername(message.username);
	const code = typeof message.roomCode === 'string' ? message.roomCode.trim().toUpperCase() : '';
	if (!username) return fail(socket, 'invalid_username', 'نام کاربری باید بین ۲ تا ۲۴ نویسه باشد.');
	if (!/^[A-HJ-NP-Z2-9]{4}$/.test(code)) return fail(socket, 'invalid_room_code', 'کد اتاق معتبر نیست.');
	if (clients.get(socket).roomCode) return fail(socket, 'already_in_room', 'ابتدا از اتاق فعلی خارج شو.');

	const room = rooms.get(code);
	if (!room) return fail(socket, 'room_not_found', 'اتاقی با این کد پیدا نشد.');
	if (room.started) return fail(socket, 'game_in_progress', 'بازی این اتاق شروع شده است.');
	if (room.players.length >= MAX_PLAYERS) return fail(socket, 'room_full', 'ظرفیت اتاق چهار بازیکن است.');

	const player = addPlayer(room, socket, username);
	send(socket, { type: 'room_joined', roomCode: room.code, playerId: player.id });
	broadcastRoom(room, { type: 'player_joined', player: { id: player.id, username: player.username } });
	broadcastSnapshot(room);
}

function handleFindMatch(socket, message) {
	const username = normalizeUsername(message.username);
	if (!username) return fail(socket, 'invalid_username', 'نام کاربری باید بین ۲ تا ۲۴ نویسه باشد.');
	if (clients.get(socket).roomCode) return fail(socket, 'already_in_room', 'ابتدا از اتاق فعلی خارج شو.');

	let room = [...rooms.values()].find((candidate) =>
		!candidate.started && candidate.matchmaking && candidate.players.length < MAX_PLAYERS
	);
	if (!room) {
		room = {
			code: createRoomCode(),
			hostId: null,
			players: [],
			started: false,
			matchmaking: true,
			phase: 'lobby',
			activeIndex: 0,
			turnNumber: 1,
			lastRoll: null,
			offeredProperty: null,
			createdAt: Date.now()
		};
		rooms.set(room.code, room);
	}

	const player = addPlayer(room, socket, username, room.players.length === 0);
	send(socket, { type: 'matchmaking', roomCode: room.code, playerId: player.id });
	broadcastRoom(room, { type: 'player_joined', player: { id: player.id, username: player.username } });
	if (room.players.length === MAX_PLAYERS) {
		room.started = true;
		room.phase = 'roll';
		broadcastRoom(room, { type: 'game_started', room: roomSnapshot(room) });
	}
	broadcastSnapshot(room);
}

function handleStartGame(socket) {
	const room = roomFor(socket);
	const player = room?.players.find((entry) => entry.socket === socket);
	if (!room || !player) return fail(socket, 'not_in_room', 'ابتدا وارد یک اتاق شو.');
	if (room.hostId !== player.id) return fail(socket, 'host_only', 'فقط سازنده‌ی اتاق می‌تواند بازی را شروع کند.');
	if (room.started) return fail(socket, 'already_started', 'بازی قبلاً شروع شده است.');
	if (room.players.length < 2) return fail(socket, 'not_enough_players', 'برای شروع بازی دست‌کم دو بازیکن لازم است.');

	room.started = true;
	room.phase = 'roll';
	room.activeIndex = 0;
	room.turnNumber = 1;
	room.lastRoll = null;
	broadcastRoom(room, { type: 'game_started', room: roomSnapshot(room) });
	broadcastSnapshot(room);
}

function handleRoll(socket) {
	const room = roomFor(socket);
	const player = room?.players[room.activeIndex];
	if (!room || !player || player.socket !== socket) return fail(socket, 'not_your_turn', 'الان نوبت تو نیست.');
	if (!room.started) return fail(socket, 'game_not_started', 'بازی هنوز شروع نشده است.');
	if (room.phase !== 'roll') return fail(socket, 'invalid_phase', 'در این مرحله نمی‌توان تاس انداخت.');

	const roll = randomInt(1, 7);
	if (player.jailed) {
		player.jailed = false;
		room.lastRoll = null;
		room.phase = 'end';
		broadcastRoom(room, { type: 'dice_rolled', playerId: player.id, roll: null, position: player.position, passedStart: false, money: player.money, landing: { type: 'jail_turn' }, turnNumber: room.turnNumber });
		broadcastSnapshot(room);
		return;
	}
	const previousPosition = player.position;
	player.position = (player.position + roll) % BOARD_SIZE;
	const passedStart = previousPosition + roll >= BOARD_SIZE;
	if (passedStart) player.money += 200;
	room.lastRoll = roll;
	room.offeredProperty = null;
	let landing = { type: 'space', name: player.position === 0 ? 'شروع' : `خانه‌ی ${player.position}` };
	const property = PROPERTIES[player.position];
	if (property) {
		const owner = room.players.find((candidate) => candidate.properties.includes(player.position));
		if (!owner) {
			room.offeredProperty = player.position;
			room.phase = 'buy';
			landing = { type: 'purchase_offer', spaceIndex: player.position, name: SPACE_NAMES[player.position], price: property.price };
		} else if (owner.id !== player.id) {
			let rent = property.rent;
			if (property.kind === 'utility') {
				const utilities = owner.properties.filter((ownedIndex) => PROPERTIES[ownedIndex]?.kind === 'utility').length;
				rent = roll * (utilities > 1 ? 10 : 4);
			} else if (property.kind === 'transport') {
				const transports = owner.properties.filter((ownedIndex) => PROPERTIES[ownedIndex]?.kind === 'transport').length;
				rent *= 2 ** Math.max(0, transports - 1);
			} else if (property.group) {
				const groupProperties = Object.entries(PROPERTIES).filter(([, entry]) => entry.group === property.group);
				if (groupProperties.length > 0 && groupProperties.every(([spaceIndex]) => owner.properties.includes(Number(spaceIndex)))) rent *= 2;
			}
			const paid = Math.min(player.money, rent);
			player.money -= paid;
			owner.money += paid;
			room.phase = 'end';
			landing = { type: 'rent_paid', spaceIndex: player.position, name: SPACE_NAMES[player.position], amount: paid, ownerId: owner.id };
		} else {
			room.phase = 'end';
		}
	} else if ([18, 22].includes(player.position)) {
		const tax = player.position === 18 ? 100 : 120;
		const paid = Math.min(player.money, tax);
		player.money -= paid;
		room.phase = 'end';
		landing = { type: 'tax_paid', spaceIndex: player.position, name: SPACE_NAMES[player.position] || 'مالیات', amount: paid };
	} else if ([3, 15, 25, 29].includes(player.position)) {
		const amount = CHANCE_AMOUNTS[randomInt(CHANCE_AMOUNTS.length)];
		player.money = Math.max(0, player.money + amount);
		room.phase = 'end';
		landing = { type: 'chance', amount };
	} else if (player.position === 26) {
		player.position = 8;
		player.jailed = true;
		room.phase = 'end';
		landing = { type: 'sent_to_jail', position: player.position };
	} else {
		room.phase = 'end';
	}
	broadcastRoom(room, {
		type: 'dice_rolled',
		playerId: player.id,
		roll,
		position: player.position,
		passedStart,
		money: player.money,
		landing,
		turnNumber: room.turnNumber
	});
	broadcastSnapshot(room);
}

function handlePurchase(socket, message, skip = false) {
	const room = roomFor(socket);
	const player = room?.players[room.activeIndex];
	if (!room || !player || player.socket !== socket) return fail(socket, 'not_your_turn', 'الان نوبت تو نیست.');
	if (!room.started) return fail(socket, 'game_not_started', 'بازی هنوز شروع نشده است.');
	if (room.phase !== 'buy' || room.offeredProperty === null) return fail(socket, 'invalid_phase', 'در حال حاضر پیشنهاد خریدی وجود ندارد.');

	const index = room.offeredProperty;
	if (skip) {
		room.offeredProperty = null;
		room.phase = 'end';
		broadcastRoom(room, { type: 'purchase_skipped', playerId: player.id, spaceIndex: index });
		broadcastSnapshot(room);
		return;
	}

	if (!Number.isInteger(message.spaceIndex) || message.spaceIndex !== index) return fail(socket, 'invalid_property', 'خانه‌ی پیشنهادی معتبر نیست.');
	const property = PROPERTIES[index];
	if (!property) return fail(socket, 'invalid_property', 'این خانه قابل خرید نیست.');
	if (player.money < property.price) return fail(socket, 'insufficient_funds', 'موجودی برای خرید این شهر کافی نیست.');
	if (room.players.some((candidate) => candidate.properties.includes(index))) return fail(socket, 'already_owned', 'این ملک قبلاً خریداری شده است.');

	player.money -= property.price;
	player.properties.push(index);
	room.offeredProperty = null;
	room.phase = 'end';
	broadcastRoom(room, {
		type: 'property_purchased',
		playerId: player.id,
		spaceIndex: index,
		name: SPACE_NAMES[index],
		price: property.price
	});
	broadcastSnapshot(room);
}

function handleEndTurn(socket) {
	const room = roomFor(socket);
	const player = room?.players[room.activeIndex];
	if (!room || !player || player.socket !== socket) return fail(socket, 'not_your_turn', 'الان نوبت تو نیست.');
	if (!room.started) return fail(socket, 'game_not_started', 'بازی هنوز شروع نشده است.');
	if (room.phase !== 'end') return fail(socket, 'invalid_phase', 'برای پایان نوبت ابتدا تاس بینداز.');

	room.activeIndex = (room.activeIndex + 1) % room.players.length;
	if (room.activeIndex === 0) room.turnNumber += 1;
	room.lastRoll = null;
	room.offeredProperty = null;
	room.phase = 'roll';
	broadcastRoom(room, { type: 'turn_changed', activePlayerId: room.players[room.activeIndex].id, turnNumber: room.turnNumber });
	broadcastSnapshot(room);
}

function handleChat(socket, message) {
	const room = roomFor(socket);
	const player = room?.players.find((entry) => entry.socket === socket);
	const text = typeof message.text === 'string' ? message.text.trim().slice(0, 280) : '';
	if (!room || !player) return fail(socket, 'not_in_room', 'برای چت باید وارد یک اتاق باشی.');
	if (!text) return fail(socket, 'empty_message', 'پیام خالی است.');
	broadcastRoom(room, {
		type: 'chat',
		playerId: player.id,
		username: player.username,
		text,
		sentAt: Date.now()
	});
}

function handleMessage(socket, message) {
	if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
		return fail(socket, 'invalid_message', 'پیام باید یک شیء JSON معتبر باشد.');
	}

	switch (message.type) {
		case 'create_room': return handleCreateRoom(socket, message);
		case 'join_room': return handleJoinRoom(socket, message);
		case 'find_match': return handleFindMatch(socket, message);
		case 'start_game': return handleStartGame(socket);
		case 'roll_dice': return handleRoll(socket);
		case 'buy_property': return handlePurchase(socket, message);
		case 'skip_purchase': return handlePurchase(socket, message, true);
		case 'end_turn': return handleEndTurn(socket);
		case 'chat': return handleChat(socket, message);
		case 'leave_room':
			leaveRoom(socket);
			return send(socket, { type: 'left_room' });
		case 'ping':
			return send(socket, { type: 'pong', at: Date.now() });
		default:
			return fail(socket, 'unknown_message', 'نوع پیام شناخته‌شده نیست.');
	}
}

wss.on('connection', (socket) => {
	clients.set(socket, { roomCode: null, windowStartedAt: Date.now(), messageCount: 0 });
	send(socket, { type: 'connected', protocolVersion: 1, maxPlayers: MAX_PLAYERS });

	socket.on('message', (rawMessage) => {
		const client = clients.get(socket);
		if (!client) return;
		const now = Date.now();
		if (now - client.windowStartedAt >= MESSAGE_WINDOW_MS) {
			client.windowStartedAt = now;
			client.messageCount = 0;
		}
		client.messageCount += 1;
		if (client.messageCount > MAX_MESSAGES_PER_WINDOW) {
			fail(socket, 'rate_limited', 'پیام‌ها بیش‌ازحد سریع ارسال شدند.');
			return;
		}

		let message;
		try {
			message = JSON.parse(rawMessage.toString());
		} catch {
			fail(socket, 'invalid_json', 'پیام JSON معتبر نیست.');
			return;
		}
		handleMessage(socket, message);
	});

	socket.on('close', () => {
		leaveRoom(socket);
		clients.delete(socket);
	});

	socket.on('error', (error) => {
		console.error('WebSocket client error:', error.message);
	});
});

const heartbeat = setInterval(() => {
	for (const socket of wss.clients) {
		if (socket.isAlive === false) {
			socket.terminate();
			continue;
		}
		socket.isAlive = false;
		socket.ping();
	}
}, 30_000);

wss.on('connection', (socket) => {
	socket.isAlive = true;
	socket.on('pong', () => {
		socket.isAlive = true;
	});
});

server.listen(PORT, HOST, () => {
	console.log(`Monopl WebSocket server listening at http://${HOST}:${PORT}`);
	console.log(`Health check: http://localhost:${PORT}/health`);
});

server.on('close', () => clearInterval(heartbeat));

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		clearInterval(heartbeat);
		for (const socket of wss.clients) socket.close(1001, 'Server shutting down');
		wss.close(() => server.close(() => process.exit(0)));
	});
}