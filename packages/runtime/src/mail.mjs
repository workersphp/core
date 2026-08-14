// Outbox delivery through Cloudflare Email Sending. The OutboxTransport wrote
// each message as {from, to[], mime} with bare envelope addresses and the full
// RFC 5322 body Symfony Mailer produced; EmailMessage takes that raw MIME
// directly, one send per envelope recipient (as SMTP would RCPT TO).
import { EmailMessage } from 'cloudflare:email';

export async function deliverOutbox(binding, messages) {
	if (!binding) {
		console.log('[mail] send_email binding missing — outbox dropped');
		return;
	}
	for (const message of messages) {
		for (const to of message.to) {
			try {
				await binding.send(new EmailMessage(message.from, to, message.mime));
			} catch (error) {
				// Mail must never fail the response; surface and move on.
				console.log(`[mail] delivery to ${to} failed: ${error.message}`);
			}
		}
	}
}
