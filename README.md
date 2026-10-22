# Monopl WebSocket server

## Run locally

Install Node.js LTS, open PowerShell in this folder, and run:

```powershell
npm install
npm start
```

The server listens on `127.0.0.1:8080` by default and serves the game at
`http://localhost:8080/`. Check server status at `http://localhost:8080/health`.
WebSocket clients connect to `ws://localhost:8080`.

Open `http://localhost:8080/` in each browser on this computer. In the game,
choose **بازی آنلاین با دوستان** to create or join a room, or choose
**مسابقه با بازیکنان تصادفی** to wait for a four-player match.

To change the local port:

```powershell
$env:PORT = "9000"
npm start
```

The default bind address is loopback-only; other devices cannot connect to it.
For LAN testing, start with `$env:HOST = "0.0.0.0"` and allow the port in the
firewall. For internet play, deploy behind HTTPS/WSS and add authentication
and production protections before exposing the service.

## WebSocket protocol

Messages are JSON objects with a `type` field. A new connection receives:

```json
{"type":"connected","protocolVersion":1,"maxPlayers":4}
```

| Client message | Server behavior |
| --- | --- |
| `{"type":"create_room","username":"Name"}` | Create a private room; reply with `room_created` and `room_state`. |
| `{"type":"join_room","roomCode":"AB12","username":"Name"}` | Join a private room; notify its players and send `room_state`. |
| `{"type":"find_match","username":"Name"}` | Join a random-match queue. The match starts when four players are present. |
| `{"type":"start_game"}` | Start a private room with at least two players; host only. |
| `{"type":"roll_dice"}` | Roll on the active player's turn; position, start bonus, tax, rent, chance, and jail are handled by the server. |
| `{"type":"buy_property","spaceIndex":1}` | Buy the property currently offered on the active player's turn. |
| `{"type":"skip_purchase"}` | Decline the offered property. |
| `{"type":"end_turn"}` | Finish the active player's turn after resolving the landing and purchase. |
| `{"type":"chat","text":"Hello"}` | Send a text chat message to room members. |
| `{"type":"leave_room"}` | Leave the current room. |
| `{"type":"ping"}` | Receive a `pong` response. |

Room updates are sent as `room_state`. Invalid messages and actions receive an
`error` message with a machine-readable `code` and a Persian explanation.

## Current scope

This is a lightweight online game server. It synchronizes rooms, players,
turns, server-generated dice rolls, property purchases, rent, taxes, chance
cards, jail turns, and chat. Rooms live in memory, so restarting the server
clears them. House-building, money transfers, and property trades are not yet
synchronized online. The default server is accessible only from this computer;
remote play requires a LAN or internet deployment.
