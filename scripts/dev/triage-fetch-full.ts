import { gmailClient, accountForId } from '../../src/google/gmail';
import { TextDecoder } from 'util';

async function main() {
  try {
    const id = '19faeaf31f9e3f49';
    const account = await accountForId(id);
    
    const g = gmailClient(account);
    const msg = await g.users.messages.get({ userId: 'me', id, format: 'full' });
    
    // Extract headers
    const headers = msg.data.payload?.headers || [];
    const from = headers.find(h => h.name === 'From')?.value || '';
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const date = headers.find(h => h.name === 'Date')?.value || '';
    const messageId = headers.find(h => h.name === 'Message-ID')?.value || '';
    
    // Extract body - handle both plain body and parts
    let body = '';
    if (msg.data.payload?.body?.data) {
      body = Buffer.from(msg.data.payload.body.data, 'base64').toString('utf-8');
    } else if (msg.data.payload?.parts) {
      // Find the first text/plain or text/html part
      const textPart = msg.data.payload.parts.find(p => p.mimeType?.includes('text/'));
      if (textPart?.body?.data) {
        body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
      }
    }
    
    // Get Gmail link
    const gmailLink = `https://mail.google.com/mail/u/0/#inbox/${id}`;
    
    console.log(JSON.stringify({
      id,
      threadId: msg.data.threadId,
      account,
      from,
      subject,
      date,
      messageId,
      body: body.substring(0, 5000), // First 5000 chars to avoid too much output
      bodyTruncated: body.length > 5000,
      fullBodyLength: body.length,
      gmailLink,
      labels: msg.data.labelIds || [],
    }, null, 2));
  } catch(e) {
    console.error('Error:', (e as Error).message);
    process.exit(1);
  }
}

main();
