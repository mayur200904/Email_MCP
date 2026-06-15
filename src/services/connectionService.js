import {
  deleteAllMailConnections,
  getActiveMailConnection,
  getDecryptedMailConnection,
  recordConnectionEvent,
  replaceActiveMailConnection,
} from './credentialStoreService.js';
import { createImapConnection } from './yahooMailService.js';

function maskEmail(email) {
  if (!email || !email.includes('@')) {
    return email || '';
  }

  const [name, domain] = email.split('@');
  if (name.length <= 2) {
    return `${name[0] || '*'}*@${domain}`;
  }

  return `${name.slice(0, 2)}${'*'.repeat(Math.max(2, name.length - 2))}@${domain}`;
}

export async function verifyYahooAppPassword({ yahooEmail, appPassword }) {
  const imap = await createImapConnection({
    authContext: {
      mode: 'app_password',
      email: yahooEmail,
      appPassword,
    },
    resolveImapCredentials: async (authContext) => ({
      mode: 'app_password',
      email: authContext.email,
      appPassword: authContext.appPassword,
    }),
  });

  return await new Promise((resolve, reject) => {
    imap.openBox('INBOX', true, (err) => {
      imap.end();
      if (err) {
        reject(err);
        return;
      }
      resolve(true);
    });
  });
}

export async function upsertSingleUserConnection({ yahooEmail, appPassword }) {
  await verifyYahooAppPassword({ yahooEmail, appPassword });
  const connection = await replaceActiveMailConnection({
    yahooEmail,
    appPassword,
    status: 'active',
    lastVerifiedAt: new Date(),
  });

  await recordConnectionEvent({
    mailConnectionId: connection.id,
    eventType: 'connection_verified',
    message: 'Yahoo app password verified and stored.',
  });

  return connection;
}

export async function removeSingleUserConnection() {
  const activeConnection = await getActiveMailConnection();
  await deleteAllMailConnections();

  await recordConnectionEvent({
    mailConnectionId: activeConnection?.id || null,
    eventType: 'connection_removed',
    message: 'Stored Yahoo connection removed by user.',
  });
}

export async function getConnectionStatus() {
  const connection = await getActiveMailConnection();

  if (!connection) {
    return {
      isConnected: false,
      status: 'not_connected',
      maskedEmail: '',
      lastVerifiedAt: null,
    };
  }

  return {
    isConnected: connection.status === 'active',
    status: connection.status,
    maskedEmail: maskEmail(connection.yahooEmail),
    lastVerifiedAt: connection.lastVerifiedAt,
  };
}

export async function getStoredConnectionForRuntime() {
  return getDecryptedMailConnection();
}
