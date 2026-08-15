import { gmailClient, accountForId } from '../../src/google/gmail';

async function main() {
  try {
    const id = '19faeaf31f9e3f49';
    const account = await accountForId(id);
    console.log('Account:', account);
    
    const g = gmailClient(account);
    const msg = await g.users.messages.get({ userId: 'me', id, format: 'full' });
    
    console.log(JSON.stringify({
      id: msg.data.id,
      threadId: msg.data.threadId,
      from: msg.data.payload?.headers?.find(h => h.name === 'From')?.value,
      subject: msg.data.payload?.headers?.find(h => h.name === 'Subject')?.value,
      date: msg.data.payload?.headers?.find(h => h.name === 'Date')?.value,
      snippet: msg.data.snippet,
      body: msg.data.payload?.body?.data,
    }, null, 2));
  } catch(e) {
    console.error('Error:', (e as Error).message);
    process.exit(1);
  }
}

main();
