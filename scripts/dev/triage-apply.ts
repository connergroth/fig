import { gmailClient, accountForId } from '../../src/google/gmail';

async function main() {
  try {
    const id = '19faeaf31f9e3f49';
    const account = await accountForId(id);
    
    const g = gmailClient(account);
    
    // Label as Promos
    await g.users.messages.modify({
      userId: 'me',
      id,
      requestBody: {
        addLabelIds: ['CATEGORY_PROMOTIONS'],
        removeLabelIds: ['INBOX'],
      }
    });
    
    console.log('Applied Promos label and archived email');
  } catch(e) {
    console.error('Error:', (e as Error).message);
    process.exit(1);
  }
}

main();
