const { getMessaging } = require('../src/config/firebase');

async function main() {
  const token = process.argv[2];

  if (!token) {
    console.error('Usage: node scripts/test-fcm.js <FCM_TOKEN>');
    process.exit(1);
  }

  const message = {
    token,
    notification: {
      title: 'DXSun',
      body: 'Prueba de notificación push',
    },
    data: {
      type: 'test',
    },
  };

  try {
    const response = await getMessaging().send(message);
    console.log('Push sent:', response);
  } catch (error) {
    console.error('Push failed:', error);
    process.exit(1);
  }
}

main();