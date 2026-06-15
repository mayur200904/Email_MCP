import { getDbPool } from '../db/client.js';
import { decryptSecret, encryptSecret } from '../utils/encryption.js';

function mapConnection(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    connectionType: row.connection_type,
    yahooEmail: row.yahoo_email,
    encryptedAppPassword: row.encrypted_app_password,
    status: row.status,
    lastVerifiedAt: row.last_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getActiveMailConnection() {
  const pool = getDbPool();
  const result = await pool.query(
    `SELECT * FROM mail_connections ORDER BY updated_at DESC LIMIT 1`
  );
  return mapConnection(result.rows[0]);
}

export async function saveMailConnection({ yahooEmail, appPassword, status = 'active', lastVerifiedAt = new Date() }) {
  const pool = getDbPool();
  const encryptedAppPassword = encryptSecret(appPassword);

  const result = await pool.query(
    `INSERT INTO mail_connections (yahoo_email, encrypted_app_password, status, last_verified_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING *`,
    [yahooEmail, encryptedAppPassword, status, lastVerifiedAt]
  );

  return mapConnection(result.rows[0]);
}

export async function replaceActiveMailConnection({ yahooEmail, appPassword, status = 'active', lastVerifiedAt = new Date() }) {
  const pool = getDbPool();
  const encryptedAppPassword = encryptSecret(appPassword);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM mail_connections');
    const result = await client.query(
      `INSERT INTO mail_connections (yahoo_email, encrypted_app_password, status, last_verified_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *`,
      [yahooEmail, encryptedAppPassword, status, lastVerifiedAt]
    );
    await client.query('COMMIT');
    return mapConnection(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteAllMailConnections() {
  const pool = getDbPool();
  await pool.query('DELETE FROM mail_connections');
}

export async function getDecryptedMailConnection() {
  const connection = await getActiveMailConnection();
  if (!connection) {
    return null;
  }

  return {
    ...connection,
    appPassword: decryptSecret(connection.encryptedAppPassword),
  };
}

export async function recordConnectionEvent({ mailConnectionId = null, eventType, message = null }) {
  const pool = getDbPool();
  await pool.query(
    `INSERT INTO connection_events (mail_connection_id, event_type, message)
     VALUES ($1, $2, $3)`,
    [mailConnectionId, eventType, message]
  );
}
