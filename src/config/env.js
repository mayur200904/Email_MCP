import dotenv from 'dotenv';

let loaded = false;
let cachedConfig = null;

export function loadEnv() {
  if (!loaded) {
    dotenv.config();
    loaded = true;
  }
}

export function getConfig() {
  loadEnv();

  if (cachedConfig) {
    return cachedConfig;
  }

  cachedConfig = {
    nodeEnv: process.env.NODE_ENV || 'development',
    transportMode: process.env.TRANSPORT_MODE || 'stdio',
    port: Number(process.env.PORT || 3000),
    publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim() || '',
    yahooClientId: process.env.YAHOO_CLIENT_ID || '',
    yahooClientSecret: process.env.YAHOO_CLIENT_SECRET || '',
    yahooScopes: process.env.YAHOO_SCOPES || 'openid mail-r mail-w',
    yahooEmail: process.env.YAHOO_EMAIL || '',
    yahooAppPassword: process.env.YAHOO_APP_PASSWORD || '',
    mcpStateSecret: process.env.MCP_STATE_SECRET || '',
    databaseUrl: process.env.DATABASE_URL || '',
    appEncryptionKey: process.env.APP_ENCRYPTION_KEY || '',
    sessionSecret: process.env.SESSION_SECRET || '',
  };

  return cachedConfig;
}
