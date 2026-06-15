import Imap from 'imap';

export function buildXoauth2Token(email, accessToken) {
  return Buffer.from(`user=${email}\u0001auth=Bearer ${accessToken}\u0001\u0001`).toString('base64');
}

export async function createImapConnection({ authContext, resolveImapCredentials }) {
  const credentials = await resolveImapCredentials(authContext);

  return new Promise((resolve, reject) => {
    const imapConfig = {
      user: credentials.email,
      host: 'imap.mail.yahoo.com',
      port: 993,
      tls: true,
      autotls: 'always',
      authTimeout: 30000,
      connTimeout: 30000,
      tlsOptions: {
        rejectUnauthorized: true,
        servername: 'imap.mail.yahoo.com',
        minVersion: 'TLSv1.2'
      }
    };

    if (credentials.mode === 'oauth') {
      imapConfig.xoauth2 = buildXoauth2Token(credentials.email, credentials.accessToken);
    } else {
      imapConfig.password = credentials.appPassword;
    }

    const imap = new Imap(imapConfig);

    const connectionTimeout = setTimeout(() => {
      imap.end();
      reject(new Error('Connection timed out. Service may have been sleeping (Render spindown). Please try again.'));
    }, 35000);

    imap.once('ready', () => {
      clearTimeout(connectionTimeout);
      resolve(imap);
    });

    imap.once('error', (err) => {
      clearTimeout(connectionTimeout);

      let errorMessage = err.message;
      if (
        err.message.includes('Invalid credentials') ||
        err.message.includes('authentication failed') ||
        err.message.includes('AUTHENTICATIONFAILED')
      ) {
        errorMessage = credentials.mode === 'oauth'
          ? `Yahoo mailbox OAuth failed: ${err.message}. This usually means the Yahoo app does not have Mail scopes/approval for IMAP access. Confirm your Yahoo app has mail access permissions (for example mail-r and mail-w) and any required Yahoo developer approval, then reconnect the Claude connector.`
          : `Authentication failed: ${err.message}. Please check Yahoo Mail app password. Regenerate at https://login.yahoo.com/account/security`;
      } else if (
        err.message.includes('ENOTFOUND') ||
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('ETIMEDOUT') ||
        err.message.includes('getaddrinfo')
      ) {
        errorMessage = `Cannot connect to Yahoo Mail servers: ${err.message}. Check internet connection.`;
      } else if (err.message.includes('Timed out') || err.message.includes('timeout')) {
        errorMessage = `Connection timed out: ${err.message}. Service may have been sleeping (Render spindown). Please try again.`;
      }

      reject(new Error(errorMessage));
    });

    imap.connect();
  });
}
