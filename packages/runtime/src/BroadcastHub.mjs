// Laravel broadcasting over Durable Object WebSockets: a hub speaking enough
// of the Pusher protocol that Laravel Echo (pusher-js) connects unmodified.
// PHP publishes through the broadcast outbox -> Worker -> publish() RPC here;
// nothing leaves Cloudflare. WebSocket Hibernation keeps sockets alive without
// keeping the isolate resident; per-socket state rides in attachments.
//
// Wire format notes (Pusher protocol 7): the `data` field of server frames is
// a JSON-encoded STRING (double encoding is the protocol, not an accident).
import { DurableObject } from 'cloudflare:workers';

const encoder = new TextEncoder();

async function hmacHex(secret, message) {
	const key = await crypto.subtle.importKey(
		'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const frame = (event, data, channel) =>
	JSON.stringify({ event, ...(channel ? { channel } : {}), data: JSON.stringify(data ?? {}) });

export function createBroadcastHubClass() {
	return class BroadcastHub extends DurableObject {
		async fetch(request) {
			if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
				return new Response('websocket endpoint', { status: 426 });
			}
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);
			this.ctx.acceptWebSocket(server);
			const socketId = `${Math.floor(Math.random() * 1e9)}.${Math.floor(Math.random() * 1e9)}`;
			server.serializeAttachment({ socketId, channels: [], presence: {} });
			server.send(frame('pusher:connection_established', { socket_id: socketId, activity_timeout: 120 }));
			return new Response(null, { status: 101, webSocket: client });
		}

		#sockets() {
			return this.ctx.getWebSockets().map((ws) => {
				let state = null;
				try {
					state = ws.deserializeAttachment();
				} catch {
					// Socket accepted but attachment lost; treat as unsubscribed.
				}
				return { ws, state: state ?? { socketId: '?', channels: [], presence: {} } };
			});
		}

		#sendToChannel(channel, payload, { exceptSocketId = null } = {}) {
			for (const { ws, state } of this.#sockets()) {
				if (!state.channels.includes(channel)) continue;
				if (exceptSocketId && state.socketId === exceptSocketId) continue;
				try {
					ws.send(payload);
				} catch {
					// Socket on its way out; close handler does the bookkeeping.
				}
			}
		}

		#presenceMembers(channel) {
			const members = new Map();
			for (const { state } of this.#sockets()) {
				const data = state.presence[channel];
				if (data) {
					const parsed = JSON.parse(data);
					members.set(String(parsed.user_id), parsed.user_info ?? {});
				}
			}
			return members;
		}

		async webSocketMessage(ws, raw) {
			let message;
			try {
				message = JSON.parse(raw);
			} catch {
				return;
			}
			const state = ws.deserializeAttachment();
			const { event } = message;

			if (event === 'pusher:ping') {
				ws.send(frame('pusher:pong', {}));
				return;
			}

			if (event === 'pusher:subscribe') {
				const { channel, auth, channel_data: channelData } = message.data ?? {};
				if (!channel) return;
				const guarded = channel.startsWith('private-') || channel.startsWith('presence-');
				if (guarded) {
					// Laravel's /broadcasting/auth signed socket_id:channel[:channel_data]
					// with the shared secret; verify the same MAC here.
					const signed = channel.startsWith('presence-')
						? `${state.socketId}:${channel}:${channelData}`
						: `${state.socketId}:${channel}`;
					const expected = await hmacHex(this.env.APP_KEY, signed);
					const given = (auth ?? '').split(':').pop();
					if (given !== expected) {
						ws.send(frame('pusher:error', { code: 4009, message: 'Subscription auth invalid' }));
						return;
					}
				}
				if (!state.channels.includes(channel)) {
					state.channels.push(channel);
				}
				if (channel.startsWith('presence-')) {
					state.presence[channel] = channelData;
					ws.serializeAttachment(state);
					const member = JSON.parse(channelData);
					this.#sendToChannel(channel, frame('pusher_internal:member_added', member, channel), {
						exceptSocketId: state.socketId,
					});
					const members = this.#presenceMembers(channel);
					ws.send(frame('pusher_internal:subscription_succeeded', {
						presence: {
							ids: [...members.keys()],
							hash: Object.fromEntries(members),
							count: members.size,
						},
					}, channel));
				} else {
					ws.serializeAttachment(state);
					ws.send(frame('pusher_internal:subscription_succeeded', {}, channel));
				}
				return;
			}

			if (event === 'pusher:unsubscribe') {
				const { channel } = message.data ?? {};
				this.#leave(ws, state, channel);
				return;
			}

			// Client events (Echo whispers): guarded channels only, fan to peers.
			if (event?.startsWith('client-')) {
				const channel = message.channel;
				if (!channel || !state.channels.includes(channel)) return;
				if (!channel.startsWith('private-') && !channel.startsWith('presence-')) return;
				this.#sendToChannel(
					channel,
					JSON.stringify({ event, channel, data: JSON.stringify(message.data ?? {}) }),
					{ exceptSocketId: state.socketId },
				);
			}
		}

		#leave(ws, state, channel) {
			if (!channel) return;
			state.channels = state.channels.filter((c) => c !== channel);
			const memberData = state.presence[channel];
			delete state.presence[channel];
			ws.serializeAttachment(state);
			if (memberData) {
				const { user_id: userId } = JSON.parse(memberData);
				this.#sendToChannel(channel, frame('pusher_internal:member_removed', { user_id: userId }, channel));
			}
		}

		webSocketClose(ws) {
			let state;
			try {
				state = ws.deserializeAttachment();
			} catch {
				return;
			}
			for (const channel of [...state.channels]) {
				this.#leave(ws, state, channel);
			}
		}

		/**
		 * RPC publish from the Worker's broadcast-outbox flush.
		 * @param {Array<{channels: string[], event: string, data: object, socket?: string}>} events
		 */
		publish(events) {
			let delivered = 0;
			for (const entry of events) {
				for (const channel of entry.channels) {
					const payload = JSON.stringify({
						event: entry.event,
						channel,
						data: JSON.stringify(entry.data ?? {}),
					});
					for (const { ws, state } of this.#sockets()) {
						if (!state.channels.includes(channel)) continue;
						if (entry.socket && state.socketId === entry.socket) continue;
						try {
							ws.send(payload);
							delivered++;
						} catch {
							// Dropped socket; close handler cleans up.
						}
					}
				}
			}
			return { delivered };
		}
	};
}
