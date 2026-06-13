#!/usr/bin/env node

/**
 * Yahoo Mail MCP Server with OAuth2 - A beginner-friendly introduction to MCP
 * This server provides read-only access to Yahoo Mail via OAuth2 and IMAP
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createHash, randomBytes } from 'crypto';

// Load environment variables from .env file (for local development)
dotenv.config();

const MCP_SERVER_INFO = {
    name: 'email-mcp',
    version: '4.0.0',
};

const YAHOO_AUTH_ENDPOINT = 'https://api.login.yahoo.com/oauth2/request_auth';
const YAHOO_TOKEN_ENDPOINT = 'https://api.login.yahoo.com/oauth2/get_token';
const YAHOO_USERINFO_ENDPOINT = 'https://api.login.yahoo.com/openid/v1/userinfo';
const MCP_SCOPE = 'mcp';
const CLAUDE_REDIRECT_PATTERN = /^https:\/\/([a-z0-9-]+\.)?claude\.(ai|com)(\/|$)/i;
const LOCALHOST_REDIRECT_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i;

class YahooMailMCPServer {
    constructor() {
        this.transports = new Map();
        this.registeredClients = new Map();
        this.pendingYahooAuthorizations = new Map();
        this.mcpAuthCodes = new Map();
        this.mcpAccessTokens = new Map();
        this.mcpRefreshTokens = new Map();
        this.yahooSessions = new Map();
        this.stdioServer = null;

        process.on('SIGINT', async () => {
            try {
                if (this.stdioServer) {
                    await this.stdioServer.close();
                }

                for (const { server } of this.transports.values()) {
                    if (server?.close) {
                        await server.close();
                    }
                }
            } finally {
                process.exit(0);
            }
        });
    }

    getToolDefinitions() {
        return [
            {
                name: 'list_emails',
                description: 'List recent emails from a Yahoo Mail folder. Returns UIDs (permanent identifiers) and enriched metadata including size, flags, and attachment status.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        count: {
                            type: 'number',
                            description: 'Number of emails to retrieve (default: 10, max: 50)',
                            default: 10
                        },
                        folder: {
                            type: 'string',
                            description: 'Folder to list emails from (default: INBOX). Use list_folders to see available folders.',
                            default: 'INBOX'
                        },
                        offset: {
                            type: 'number',
                            description: 'Number of emails to skip (for pagination, default: 0)',
                            default: 0
                        }
                    }
                }
            },
            {
                name: 'read_email',
                description: 'Read email content using UIDs (permanent identifiers). UIDs don\'t change when emails are deleted. Get UIDs from list_emails or search_emails.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        uids: {
                            type: 'array',
                            items: { type: 'number' },
                            description: 'Array of UIDs to read. UIDs are permanent identifiers from list_emails.',
                            minItems: 1
                        },
                        folder: {
                            type: 'string',
                            description: 'Folder containing the emails (default: INBOX)',
                            default: 'INBOX'
                        }
                    },
                    required: ['uids']
                }
            },
            {
                name: 'search_emails',
                description: 'Search emails using UIDs with advanced filters. Returns UIDs which are permanent identifiers that don\'t change when emails are deleted. Get UIDs from results for subsequent operations.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Search term for subject or sender (can be empty for date-only searches)',
                            default: ''
                        },
                        count: {
                            type: 'number',
                            description: 'Number of results to return (default: 10, max: 50)',
                            default: 10
                        },
                        dateFrom: {
                            type: 'string',
                            description: 'Filter emails from this date onwards (ISO 8601 or RFC 2822 format)',
                            default: null
                        },
                        dateTo: {
                            type: 'string',
                            description: 'Filter emails up to this date (ISO 8601 or RFC 2822 format)',
                            default: null
                        },
                        sender: {
                            type: 'string',
                            description: 'Filter by specific sender email address or name',
                            default: null
                        },
                        unreadOnly: {
                            type: 'boolean',
                            description: 'Only return unread emails (default: false)',
                            default: false
                        },
                        folder: {
                            type: 'string',
                            description: 'Folder to search in (default: INBOX). Use list_folders to see available folders.',
                            default: 'INBOX'
                        }
                    },
                    required: []
                }
            },
            {
                name: 'delete_emails',
                description: 'Move emails to Trash folder using UIDs (soft delete, recoverable). UIDs are permanent identifiers.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        uids: {
                            type: 'array',
                            items: { type: 'number' },
                            description: 'Array of UIDs to delete',
                            minItems: 1
                        },
                        folder: {
                            type: 'string',
                            description: 'Source folder (default: INBOX)',
                            default: 'INBOX'
                        }
                    },
                    required: ['uids']
                }
            },
            {
                name: 'archive_emails',
                description: 'Move emails to Archive folder using UIDs for long-term storage. UIDs are permanent identifiers.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        uids: {
                            type: 'array',
                            items: { type: 'number' },
                            description: 'Array of UIDs to archive',
                            minItems: 1
                        },
                        folder: {
                            type: 'string',
                            description: 'Source folder (default: INBOX)',
                            default: 'INBOX'
                        }
                    },
                    required: ['uids']
                }
            },
            {
                name: 'mark_as_read',
                description: 'Mark emails as read using UIDs. UIDs are permanent identifiers.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        uids: {
                            type: 'array',
                            items: { type: 'number' },
                            description: 'Array of UIDs to mark as read',
                            minItems: 1
                        },
                        folder: {
                            type: 'string',
                            description: 'Folder containing emails (default: INBOX)',
                            default: 'INBOX'
                        }
                    },
                    required: ['uids']
                }
            },
            {
                name: 'mark_as_unread',
                description: 'Mark emails as unread using UIDs. UIDs are permanent identifiers.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        uids: {
                            type: 'array',
                            items: { type: 'number' },
                            description: 'Array of UIDs to mark as unread',
                            minItems: 1
                        },
                        folder: {
                            type: 'string',
                            description: 'Folder containing emails (default: INBOX)',
                            default: 'INBOX'
                        }
                    },
                    required: ['uids']
                }
            },
            {
                name: 'flag_emails',
                description: 'Flag emails as important/starred using UIDs. UIDs are permanent identifiers.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        uids: {
                            type: 'array',
                            items: { type: 'number' },
                            description: 'Array of UIDs to flag',
                            minItems: 1
                        },
                        folder: {
                            type: 'string',
                            description: 'Folder containing emails (default: INBOX)',
                            default: 'INBOX'
                        }
                    },
                    required: ['uids']
                }
            },
            {
                name: 'unflag_emails',
                description: 'Remove flag/star from emails using UIDs. UIDs are permanent identifiers.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        uids: {
                            type: 'array',
                            items: { type: 'number' },
                            description: 'Array of UIDs to unflag',
                            minItems: 1
                        },
                        folder: {
                            type: 'string',
                            description: 'Folder containing emails (default: INBOX)',
                            default: 'INBOX'
                        }
                    },
                    required: ['uids']
                }
            },
            {
                name: 'move_emails',
                description: 'Move emails to a specified folder using UIDs. UIDs are permanent identifiers. Use list_folders to see available folders.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        uids: {
                            type: 'array',
                            items: { type: 'number' },
                            description: 'Array of UIDs to move',
                            minItems: 1
                        },
                        folderName: {
                            type: 'string',
                            description: 'Name of the destination folder (e.g., "Work", "Personal"). Use list_folders to see available folders.'
                        },
                        sourceFolder: {
                            type: 'string',
                            description: 'Source folder containing the emails (default: INBOX)',
                            default: 'INBOX'
                        }
                    },
                    required: ['uids', 'folderName']
                }
            },
            {
                name: 'list_folders',
                description: 'List all available IMAP folders/mailboxes in your Yahoo Mail account',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'draft_email',
                description: 'Draft a new email and save it to the Drafts folder. Does not send the email.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        to: {
                            type: 'string',
                            description: 'Recipient email address(es)'
                        },
                        subject: {
                            type: 'string',
                            description: 'Email subject'
                        },
                        text: {
                            type: 'string',
                            description: 'Plain text email body'
                        },
                        html: {
                            type: 'string',
                            description: 'Optional HTML email body'
                        }
                    },
                    required: ['to', 'subject', 'text']
                }
            }
        ];
    }

    createMcpServer(authContext) {
        const server = new Server(
            MCP_SERVER_INFO,
            {
                capabilities: {
                    tools: {},
                },
            }
        );

        server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: this.getToolDefinitions()
            };
        });

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            try {
                switch (name) {
                    case 'list_emails':
                        return await this.listEmails(authContext, args?.count || 10, args?.folder || 'INBOX', args?.offset || 0);

                    case 'read_email':
                        return await this.readEmail(authContext, args.uids, args.folder);

                    case 'search_emails':
                        return await this.searchEmails(authContext, args?.query || '', {
                            count: args?.count || 10,
                            dateFrom: args?.dateFrom || null,
                            dateTo: args?.dateTo || null,
                            sender: args?.sender || null,
                            unreadOnly: args?.unreadOnly || false,
                            folder: args?.folder || 'INBOX'
                        });

                    case 'delete_emails':
                        return await this.deleteEmails(authContext, args.uids, args.folder);

                    case 'archive_emails':
                        return await this.archiveEmails(authContext, args.uids, args.folder);

                    case 'mark_as_read':
                        return await this.markAsRead(authContext, args.uids, args.folder);

                    case 'mark_as_unread':
                        return await this.markAsUnread(authContext, args.uids, args.folder);

                    case 'flag_emails':
                        return await this.flagEmails(authContext, args.uids, args.folder);

                    case 'unflag_emails':
                        return await this.unflagEmails(authContext, args.uids, args.folder);

                    case 'move_emails':
                        return await this.moveEmails(authContext, args.uids, args.folderName, args.sourceFolder);

                    case 'list_folders':
                        return await this.listFolders(authContext);

                    case 'draft_email':
                        return await this.draftEmail(authContext, args.to, args.subject, args.text, args.html);

                    default:
                        throw new Error(`Unknown tool: ${name}`);
                }
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error: ${error.message}`
                        }
                    ]
                };
            }
        });

        server.onerror = (error) => {
            console.error('[MCP Error]', error);
        };

        return server;
    }

    isLegacyAppPasswordConfigured() {
        return Boolean(process.env.YAHOO_EMAIL && process.env.YAHOO_APP_PASSWORD);
    }

    isYahooOAuthConfigured() {
        return Boolean(process.env.YAHOO_CLIENT_ID && process.env.YAHOO_CLIENT_SECRET);
    }

    isMcpAuthorizationEnabled() {
        return this.isYahooOAuthConfigured();
    }

    getLocalAuthContext() {
        if (!this.isLegacyAppPasswordConfigured()) {
            throw new Error('Local app-password mode requires YAHOO_EMAIL and YAHOO_APP_PASSWORD.');
        }

        return {
            mode: 'app_password',
            email: process.env.YAHOO_EMAIL,
            appPassword: process.env.YAHOO_APP_PASSWORD,
        };
    }

    getYahooScopes() {
        return process.env.YAHOO_SCOPES || 'openid email mail-r mail-w';
    }

    getExternalBaseUrl(req) {
        const configuredBaseUrl = process.env.PUBLIC_BASE_URL?.trim();
        if (configuredBaseUrl) {
            return configuredBaseUrl.replace(/\/+$/, '');
        }

        const forwardedProto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim();
        const protocol = forwardedProto || req.protocol || 'https';
        return `${protocol}://${req.get('host')}`;
    }

    getYahooCallbackUrl(req) {
        return `${this.getExternalBaseUrl(req)}/oauth/callback`;
    }

    getProtectedResourceMetadataUrl(req) {
        return `${this.getExternalBaseUrl(req)}/.well-known/oauth-protected-resource/mcp/sse`;
    }

    generateOpaqueToken(prefix = 'tok') {
        return `${prefix}_${randomBytes(24).toString('base64url')}`;
    }

    parseBasicAuthCredentials(authHeader) {
        if (!authHeader?.startsWith('Basic ')) {
            return { clientId: null, clientSecret: null };
        }

        const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
        const separatorIndex = credentials.indexOf(':');
        if (separatorIndex === -1) {
            return { clientId: null, clientSecret: null };
        }

        return {
            clientId: credentials.slice(0, separatorIndex),
            clientSecret: credentials.slice(separatorIndex + 1),
        };
    }

    decodeJwtPayload(token) {
        try {
            const parts = token.split('.');
            if (parts.length < 2) {
                return null;
            }

            return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        } catch {
            return null;
        }
    }

    async parseResponseBody(response) {
        const text = await response.text();

        if (!text) {
            return {};
        }

        try {
            return JSON.parse(text);
        } catch {
            return { raw: text };
        }
    }

    isAllowedRedirectUri(redirectUri) {
        if (!redirectUri) {
            return false;
        }

        return CLAUDE_REDIRECT_PATTERN.test(redirectUri) || LOCALHOST_REDIRECT_PATTERN.test(redirectUri);
    }

    registerClient({ clientId, redirectUris, tokenEndpointAuthMethod = 'none' }) {
        const supportedAuthMethods = ['none', 'client_secret_post', 'client_secret_basic'];
        if (!supportedAuthMethods.includes(tokenEndpointAuthMethod)) {
            throw new Error(`Unsupported token_endpoint_auth_method: ${tokenEndpointAuthMethod}`);
        }

        const normalizedRedirectUris = [...new Set(redirectUris || [])];
        if (normalizedRedirectUris.length === 0) {
            throw new Error('redirect_uris must include at least one redirect URI');
        }

        for (const redirectUri of normalizedRedirectUris) {
            if (!this.isAllowedRedirectUri(redirectUri)) {
                throw new Error(`Unsupported redirect URI: ${redirectUri}`);
            }
        }

        const resolvedClientId = clientId || this.generateOpaqueToken('mcp_client');
        const client = {
            clientId: resolvedClientId,
            clientSecret: tokenEndpointAuthMethod === 'none' ? null : this.generateOpaqueToken('mcp_secret'),
            redirectUris: normalizedRedirectUris,
            tokenEndpointAuthMethod,
            grantTypes: ['authorization_code', 'refresh_token'],
            responseTypes: ['code'],
            createdAt: Date.now(),
        };

        this.registeredClients.set(resolvedClientId, client);
        return client;
    }

    getOrCreatePublicClient(clientId, redirectUri) {
        if (!clientId) {
            throw new Error('client_id is required');
        }

        let client = this.registeredClients.get(clientId);
        if (!client) {
            client = this.registerClient({
                clientId,
                redirectUris: [redirectUri],
                tokenEndpointAuthMethod: 'none',
            });
        }

        if (!client.redirectUris.includes(redirectUri)) {
            throw new Error('redirect_uri is not registered for this client');
        }

        return client;
    }

    serializeClient(client) {
        return {
            client_id: client.clientId,
            client_secret: client.clientSecret || undefined,
            client_id_issued_at: Math.floor(client.createdAt / 1000),
            token_endpoint_auth_method: client.tokenEndpointAuthMethod,
            grant_types: client.grantTypes,
            response_types: client.responseTypes,
            redirect_uris: client.redirectUris,
        };
    }

    buildXoauth2Token(email, accessToken) {
        return Buffer.from(`user=${email}\u0001auth=Bearer ${accessToken}\u0001\u0001`).toString('base64');
    }

    async exchangeYahooAuthorizationCode(code, redirectUri) {
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
            code,
        });

        const authHeader = Buffer.from(`${process.env.YAHOO_CLIENT_ID}:${process.env.YAHOO_CLIENT_SECRET}`).toString('base64');
        const response = await fetch(YAHOO_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${authHeader}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
        });

        const data = await this.parseResponseBody(response);
        if (!response.ok) {
            throw new Error(data.error_description || data.error || 'Yahoo token exchange failed');
        }

        return data;
    }

    async refreshYahooSession(session) {
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            redirect_uri: session.redirectUri,
            refresh_token: session.refreshToken,
        });

        const authHeader = Buffer.from(`${process.env.YAHOO_CLIENT_ID}:${process.env.YAHOO_CLIENT_SECRET}`).toString('base64');
        const response = await fetch(YAHOO_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${authHeader}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
        });

        const data = await this.parseResponseBody(response);
        if (!response.ok) {
            throw new Error(data.error_description || data.error || 'Yahoo token refresh failed');
        }

        return data;
    }

    async fetchYahooUserInfo(accessToken) {
        const response = await fetch(YAHOO_USERINFO_ENDPOINT, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });

        const data = await this.parseResponseBody(response);
        if (!response.ok) {
            throw new Error(data.error_description || data.error || 'Failed to fetch Yahoo user info');
        }

        return data;
    }

    async createYahooSession(tokenResponse, redirectUri, expectedNonce = null) {
        const idTokenClaims = tokenResponse.id_token ? this.decodeJwtPayload(tokenResponse.id_token) : null;
        if (expectedNonce && idTokenClaims?.nonce && idTokenClaims.nonce !== expectedNonce) {
            throw new Error('Yahoo ID token nonce validation failed');
        }

        let email = idTokenClaims?.email || null;
        if (!email) {
            const userInfo = await this.fetchYahooUserInfo(tokenResponse.access_token);
            email = userInfo.email || userInfo?.emails?.[0]?.handle || null;
        }

        if (!email) {
            throw new Error('Yahoo did not return an email address. Enable the Yahoo OpenID "Email" permission for your app.');
        }

        const yahooSessionId = this.generateOpaqueToken('yahoo_session');
        const session = {
            yahooSessionId,
            email,
            accessToken: tokenResponse.access_token,
            refreshToken: tokenResponse.refresh_token,
            accessTokenExpiresAt: Date.now() + ((tokenResponse.expires_in || 3600) * 1000),
            scope: tokenResponse.scope || this.getYahooScopes(),
            idToken: tokenResponse.id_token || null,
            redirectUri,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };

        this.yahooSessions.set(yahooSessionId, session);
        return session;
    }

    async ensureYahooSession(yahooSessionId) {
        const session = this.yahooSessions.get(yahooSessionId);
        if (!session) {
            throw new Error('Yahoo session not found. Please reconnect the Claude connector.');
        }

        if (session.accessTokenExpiresAt > (Date.now() + 60_000)) {
            return session;
        }

        if (!session.refreshToken) {
            throw new Error('Yahoo session cannot be refreshed. Please reconnect the Claude connector.');
        }

        const tokenResponse = await this.refreshYahooSession(session);
        const refreshedClaims = tokenResponse.id_token ? this.decodeJwtPayload(tokenResponse.id_token) : null;

        const updatedSession = {
            ...session,
            accessToken: tokenResponse.access_token,
            refreshToken: tokenResponse.refresh_token || session.refreshToken,
            accessTokenExpiresAt: Date.now() + ((tokenResponse.expires_in || 3600) * 1000),
            scope: tokenResponse.scope || session.scope,
            idToken: tokenResponse.id_token || session.idToken,
            updatedAt: Date.now(),
            email: refreshedClaims?.email || session.email,
        };

        this.yahooSessions.set(yahooSessionId, updatedSession);
        return updatedSession;
    }

    issueMcpTokens({ clientId, yahooSessionId, scope = MCP_SCOPE, rotateRefreshToken = null }) {
        const accessToken = this.generateOpaqueToken('mcp_at');
        const refreshToken = this.generateOpaqueToken('mcp_rt');
        const expiresIn = 3600;

        this.mcpAccessTokens.set(accessToken, {
            clientId,
            yahooSessionId,
            scope,
            expiresAt: Date.now() + (expiresIn * 1000),
            createdAt: Date.now(),
        });

        if (rotateRefreshToken) {
            this.mcpRefreshTokens.delete(rotateRefreshToken);
        }

        this.mcpRefreshTokens.set(refreshToken, {
            clientId,
            yahooSessionId,
            scope,
            expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000),
            createdAt: Date.now(),
        });

        return {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: expiresIn,
            refresh_token: refreshToken,
            scope,
        };
    }

    async resolveImapCredentials(authContext) {
        const effectiveAuthContext = authContext || this.getLocalAuthContext();

        if (effectiveAuthContext.mode === 'oauth') {
            const session = await this.ensureYahooSession(effectiveAuthContext.yahooSessionId);
            return {
                mode: 'oauth',
                email: session.email,
                accessToken: session.accessToken,
            };
        }

        return {
            mode: 'app_password',
            email: effectiveAuthContext.email,
            appPassword: effectiveAuthContext.appPassword,
        };
    }

    async getAuthenticatedEmail(authContext) {
        const credentials = await this.resolveImapCredentials(authContext);
        return credentials.email;
    }

    async createImapConnection(authContext) {
        return new Promise(async (resolve, reject) => {
            let credentials;

            try {
                credentials = await this.resolveImapCredentials(authContext);
            } catch (error) {
                console.error('[IMAP] Configuration error:', error.message);
                reject(error);
                return;
            }

            const imapConfig = {
                user: credentials.email,
                host: 'imap.mail.yahoo.com',
                port: 993,
                tls: true,
                authTimeout: 30000,
                connTimeout: 30000,
                tlsOptions: {
                    rejectUnauthorized: true,
                    servername: 'imap.mail.yahoo.com',
                    minVersion: 'TLSv1.2'
                }
            };

            if (credentials.mode === 'oauth') {
                imapConfig.xoauth2 = this.buildXoauth2Token(credentials.email, credentials.accessToken);
            } else {
                imapConfig.password = credentials.appPassword;
            }

            const imap = new Imap(imapConfig);

            const connectionTimeout = setTimeout(() => {
                console.error('[IMAP] Connection timeout after 35 seconds');
                imap.end();
                reject(new Error('Connection timed out. Service may have been sleeping (Render spindown). Please try again.'));
            }, 35000);

            imap.once('ready', () => {
                clearTimeout(connectionTimeout);
                resolve(imap);
            });

            imap.once('error', (err) => {
                clearTimeout(connectionTimeout);
                console.error('[IMAP] Connection error:', err.message);

                let errorMessage = err.message;

                if (err.message.includes('Invalid credentials') ||
                    err.message.includes('authentication failed') ||
                    err.message.includes('AUTHENTICATIONFAILED')) {
                    errorMessage = credentials.mode === 'oauth'
                        ? `Yahoo OAuth authentication failed: ${err.message}. Please reconnect the Claude connector so Yahoo access can be granted again.`
                        : `Authentication failed: ${err.message}. Please check Yahoo Mail app password. Regenerate at https://login.yahoo.com/account/security`;
                } else if (err.message.includes('ENOTFOUND') ||
                           err.message.includes('ECONNREFUSED') ||
                           err.message.includes('ETIMEDOUT') ||
                           err.message.includes('getaddrinfo')) {
                    errorMessage = `Cannot connect to Yahoo Mail servers: ${err.message}. Check internet connection.`;
                } else if (err.message.includes('Timed out') ||
                           err.message.includes('timeout')) {
                    errorMessage = `Connection timed out: ${err.message}. Service may have been sleeping (Render spindown). Please try again.`;
                }

                reject(new Error(errorMessage));
            });

            imap.connect();
        });
    }

    /**
     * List recent emails with enriched metadata
     */
    async listEmails(authContext, count = 10, folder = 'INBOX', offset = 0) {
        // Validate count parameter
        if (count < 1) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: count must be at least 1'
                }]
            };
        }

        if (count > 50) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: count cannot exceed 50 (use search or filters for larger results)'
                }]
            };
        }

        // Validate offset
        if (offset < 0) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: offset must be non-negative'
                }]
            };
        }

        const imap = await this.createImapConnection(authContext);

        return new Promise((resolve, reject) => {
            imap.openBox(folder, true, (err, box) => {
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                const total = box.messages.total;

                if (total === 0) {
                    imap.end();
                    resolve({
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                emails: [],
                                totalCount: 0,
                                offset: 0,
                                limit: count,
                                folder: folder
                            }, null, 2)
                        }]
                    });
                    return;
                }

                // Calculate range with offset
                // If total=100, offset=10, count=10: fetch messages 81-90 (reversed for newest first)
                const startSeq = Math.max(1, total - offset - count + 1);
                const endSeq = Math.max(1, total - offset);

                if (startSeq > endSeq) {
                    imap.end();
                    resolve({
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                emails: [],
                                totalCount: total,
                                offset: offset,
                                limit: count,
                                folder: folder,
                                message: 'Offset exceeds available messages'
                            }, null, 2)
                        }]
                    });
                    return;
                }

                // Fetch with struct for attachments and size
                const fetch = imap.seq.fetch(`${startSeq}:${endSeq}`, {
                    bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)',
                    struct: true
                });

                const emails = [];

                fetch.on('message', (msg, seqno) => {
                    let header = '';
                    let attrs = null;

                    msg.on('body', (stream, info) => {
                        stream.on('data', (chunk) => {
                            header += chunk.toString('ascii');
                        });
                    });

                    msg.once('attributes', (attributes) => {
                        attrs = attributes;
                    });

                    msg.once('end', () => {
                        const parsed = Imap.parseHeader(header);

                        emails.push({
                            uid: attrs.uid,                          // NEW: Permanent UID
                            sequenceNumber: seqno,                   // Legacy reference
                            from: parsed.from?.[0] || 'Unknown',
                            subject: parsed.subject?.[0] || 'No Subject',
                            date: parsed.date?.[0] || 'Unknown Date',
                            size: attrs.size || 0,                   // NEW: Message size in bytes
                            flags: attrs.flags || [],                // NEW: IMAP flags
                            hasAttachments: this.hasAttachments(attrs.struct) // NEW
                        });
                    });
                });

                fetch.once('error', (err) => {
                    imap.end();
                    reject(err);
                });

                fetch.once('end', () => {
                    imap.end();

                    // Sort by sequence number (newest first)
                    emails.sort((a, b) => b.sequenceNumber - a.sequenceNumber);

                    resolve({
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                emails: emails,
                                totalCount: total,
                                offset: offset,
                                limit: count,
                                folder: folder
                            }, null, 2)
                        }]
                    });
                });
            });
        });
    }

    /**
     * Read specific emails by UIDs (supports batch reading)
     */
    async readEmail(authContext, uids, folder = 'INBOX') {
        // Support both single number and array for backward compatibility
        if (!Array.isArray(uids)) {
            uids = [uids];
        }

        return this.readEmails(authContext, uids, folder);
    }

    /**
     * Search emails with advanced filters
     */
    async searchEmails(authContext, query, options = {}) {
        const {
            count = 10,
            dateFrom = null,
            dateTo = null,
            sender = null,
            unreadOnly = false,
            folder = 'INBOX'
        } = options;

        // Validate query parameter (allow empty for date-only searches)
        if (query === undefined || query === null) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: query is required (use empty string "" for searches without text criteria)'
                }]
            };
        }

        // Validate count parameter
        if (count < 1) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: count must be at least 1'
                }]
            };
        }

        const imap = await this.createImapConnection(authContext);

        return new Promise((resolve, reject) => {
            imap.openBox(folder, true, (err, box) => {
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                // Build search criteria
                const criteria = [];

                // Text search (subject or from)
                if (query && query.trim().length > 0) {
                    criteria.push([
                        'OR',
                        ['HEADER', 'SUBJECT', query],
                        ['HEADER', 'FROM', query]
                    ]);
                }

                // Sender filter
                if (sender && sender.trim().length > 0) {
                    criteria.push(['HEADER', 'FROM', sender]);
                }

                // Date range filters
                if (dateFrom) {
                    try {
                        const fromDate = new Date(dateFrom);
                        if (!isNaN(fromDate.getTime())) {
                            criteria.push(['SINCE', fromDate]);
                        }
                    } catch (e) {
                        imap.end();
                        reject(new Error(`Invalid dateFrom format: ${dateFrom}. Use ISO 8601 format.`));
                        return;
                    }
                }

                if (dateTo) {
                    try {
                        const toDate = new Date(dateTo);
                        if (!isNaN(toDate.getTime())) {
                            criteria.push(['BEFORE', toDate]);
                        }
                    } catch (e) {
                        imap.end();
                        reject(new Error(`Invalid dateTo format: ${dateTo}. Use ISO 8601 format.`));
                        return;
                    }
                }

                // Unread only filter
                if (unreadOnly) {
                    criteria.push('UNSEEN');
                }

                // If no criteria, search all
                if (criteria.length === 0) {
                    criteria.push('ALL');
                }

                // CRITICAL: imap.search() returns UIDs by default (NOT sequence numbers)
                imap.search(criteria, (err, results) => {
                    if (err) {
                        imap.end();
                        reject(err);
                        return;
                    }

                    if (!results || results.length === 0) {
                        imap.end();
                        resolve({
                            content: [{
                                type: 'text',
                                text: JSON.stringify({
                                    emails: [],
                                    totalMatches: 0,
                                    query: query,
                                    filters: options,
                                    folder: folder
                                }, null, 2)
                            }]
                        });
                        return;
                    }

                    // Get the most recent results (UIDs are already sorted)
                    const limitedResults = results.slice(-count);

                    // Fetch details for these UIDs
                    const fetch = imap.fetch(limitedResults, {
                        bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)',
                        struct: true
                    });

                    const emails = [];

                    fetch.on('message', (msg, seqno) => {
                        let header = '';
                        let attrs = null;

                        msg.on('body', (stream, info) => {
                            stream.on('data', (chunk) => {
                                header += chunk.toString('ascii');
                            });
                        });

                        msg.once('attributes', (attributes) => {
                            attrs = attributes;
                        });

                        msg.once('end', () => {
                            const parsed = Imap.parseHeader(header);
                            emails.push({
                                uid: attrs.uid,
                                sequenceNumber: seqno,
                                from: parsed.from?.[0] || 'Unknown',
                                subject: parsed.subject?.[0] || 'No Subject',
                                date: parsed.date?.[0] || 'Unknown Date',
                                size: attrs.size || 0,
                                flags: attrs.flags || [],
                                hasAttachments: this.hasAttachments(attrs.struct)
                            });
                        });
                    });

                    fetch.once('error', (err) => {
                        imap.end();
                        reject(err);
                    });

                    fetch.once('end', () => {
                        imap.end();

                        // Sort by UID (newest first typically)
                        emails.sort((a, b) => b.uid - a.uid);

                        resolve({
                            content: [{
                                type: 'text',
                                text: JSON.stringify({
                                    emails: emails,
                                    totalMatches: results.length,
                                    returned: emails.length,
                                    query: query,
                                    filters: options,
                                    folder: folder
                                }, null, 2)
                            }]
                        });
                    });
                });
            });
        });
    }

    /**
     * Validate sequence numbers array for all email operations
     * @returns {string|null} Error message if invalid, null if valid
     */
    validateSequenceNumbers(sequenceNumbers) {
        if (!sequenceNumbers) {
            return 'sequenceNumbers is required';
        }

        if (!Array.isArray(sequenceNumbers)) {
            return 'sequenceNumbers must be an array';
        }

        if (sequenceNumbers.length === 0) {
            return 'sequenceNumbers cannot be empty';
        }

        const invalidValues = sequenceNumbers.filter(n => n === undefined || n === null || typeof n !== 'number');
        if (invalidValues.length > 0) {
            return 'sequenceNumbers contains invalid values (must be numbers)';
        }

        return null;
    }

    /**
     * Helper method for batch email modification operations using UIDs
     */
    async modifyEmails(authContext, uids, operation, operationName, folder = 'INBOX') {
        // Validate input
        const validationError = this.validateUIDs(uids);
        if (validationError) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${validationError}`
                }]
            };
        }

        const imap = await this.createImapConnection(authContext);

        return new Promise((resolve, reject) => {
            imap.openBox(folder, false, (err, box) => {  // false = read-write mode
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                const successfulUIDs = [];
                const failedUIDs = [];
                let processedCount = 0;

                // Process each UID individually to ensure all are processed
                const processNextUID = () => {
                    if (processedCount >= uids.length) {
                        // All UIDs processed
                        imap.end();

                        if (failedUIDs.length === uids.length) {
                            // All failed
                            reject(new Error(`Failed to ${operationName} ${failedUIDs.length} email(s). UIDs may not exist: ${failedUIDs.join(', ')}`));
                        } else if (successfulUIDs.length > 0) {
                            // At least some succeeded
                            const message = failedUIDs.length > 0
                                ? `Successfully ${operationName} ${successfulUIDs.length} of ${uids.length} email(s). ` +
                                  `Successful: ${successfulUIDs.join(', ')}. Failed: ${failedUIDs.join(', ')}`
                                : `Successfully ${operationName} ${successfulUIDs.length} email(s) with UIDs: ${successfulUIDs.join(', ')}`;

                            resolve({
                                content: [{
                                    type: 'text',
                                    text: message
                                }]
                            });
                        } else {
                            reject(new Error(`Failed to ${operationName} any emails`));
                        }
                        return;
                    }

                    const uid = uids[processedCount];
                    processedCount++;

                    // Execute the UID-based operation for this single UID
                    operation(imap, uid.toString(), (err) => {
                        if (err) {
                            console.error(`[UID ${uid}] Failed to ${operationName}:`, err.message);
                            failedUIDs.push(uid);
                        } else {
                            successfulUIDs.push(uid);
                        }

                        // Continue to next UID (don't stop on errors)
                        processNextUID();
                    });
                };

                // Start processing
                processNextUID();
            });
        });
    }

    /**
     * Helper method for reading multiple emails using UIDs
     */
    async readEmails(authContext, uids, folder = 'INBOX') {
        // Validate input
        const validationError = this.validateUIDs(uids);
        if (validationError) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${validationError}`
                }]
            };
        }

        const imap = await this.createImapConnection(authContext);

        return new Promise((resolve, reject) => {
            imap.openBox(folder, true, (err, box) => {  // true = read-only mode
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                const source = uids.join(',');

                // CRITICAL: Use imap.fetch() (NOT imap.seq.fetch) for UID-based fetch
                const fetch = imap.fetch(source, {
                    bodies: '',
                    struct: true
                });

                const emails = [];
                const foundUIDs = new Set();

                fetch.on('message', (msg, seqno) => {
                    let buffer = '';
                    let attrs = null;

                    msg.on('body', (stream, info) => {
                        stream.on('data', (chunk) => {
                            buffer += chunk.toString('ascii');
                        });
                    });

                    msg.once('attributes', (attributes) => {
                        attrs = attributes;
                        foundUIDs.add(attributes.uid);
                    });

                    msg.once('end', () => {
                        simpleParser(buffer, (err, parsed) => {
                            if (err) {
                                console.error('Error parsing email:', err);
                                return;
                            }

                            emails.push({
                                uid: attrs.uid,
                                sequenceNumber: seqno,  // Still include for reference
                                from: parsed.from?.text || 'Unknown',
                                to: parsed.to?.text || 'Unknown',
                                subject: parsed.subject || 'No Subject',
                                date: parsed.date || 'Unknown Date',
                                size: attrs.size || 0,
                                flags: attrs.flags || [],
                                hasAttachments: this.hasAttachments(attrs.struct),
                                content: parsed.text || parsed.html || 'No content available'
                            });
                        });
                    });
                });

                fetch.once('error', (err) => {
                    imap.end();
                    reject(err);
                });

                fetch.once('end', () => {
                    imap.end();

                    // Check for missing UIDs
                    const missingUIDs = uids.filter(uid => !foundUIDs.has(uid));
                    if (missingUIDs.length > 0) {
                        reject(new Error(
                            `UIDs not found: ${missingUIDs.join(', ')}. ` +
                            `Found ${emails.length} of ${uids.length} requested emails. ` +
                            `Missing UIDs may have been deleted or moved to another folder.`
                        ));
                        return;
                    }

                    // Sort by UID for consistent output
                    emails.sort((a, b) => a.uid - b.uid);

                    // Format output
                    const emailContent = emails.map(email =>
                        `📧 Email UID: ${email.uid} (Seq #${email.sequenceNumber})\n\n` +
                        `From: ${email.from}\n` +
                        `To: ${email.to}\n` +
                        `Subject: ${email.subject}\n` +
                        `Date: ${email.date}\n` +
                        `Size: ${email.size} bytes\n` +
                        `Flags: ${email.flags.join(', ') || 'None'}\n` +
                        `Has Attachments: ${email.hasAttachments ? 'Yes' : 'No'}\n\n` +
                        `--- Content ---\n` +
                        `${email.content}`
                    ).join('\n\n' + '='.repeat(80) + '\n\n');

                    resolve({
                        content: [{
                            type: 'text',
                            text: emailContent
                        }]
                    });
                });
            });
        });
    }

    /**
     * Mark emails as read
     */
    async markAsRead(authContext, uids, folder = 'INBOX') {
        return this.modifyEmails(
            authContext,
            uids,
            (imap, source, callback) => imap.addFlags(source, '\\Seen', callback),  // NO .seq
            'marked as read',
            folder
        );
    }

    /**
     * Mark emails as unread
     */
    async markAsUnread(authContext, uids, folder = 'INBOX') {
        return this.modifyEmails(
            authContext,
            uids,
            (imap, source, callback) => imap.delFlags(source, '\\Seen', callback),  // NO .seq
            'marked as unread',
            folder
        );
    }

    /**
     * Flag emails as important/starred
     */
    async flagEmails(authContext, uids, folder = 'INBOX') {
        return this.modifyEmails(
            authContext,
            uids,
            (imap, source, callback) => imap.addFlags(source, '\\Flagged', callback),  // NO .seq
            'flagged',
            folder
        );
    }

    /**
     * Remove flag/star from emails
     */
    async unflagEmails(authContext, uids, folder = 'INBOX') {
        return this.modifyEmails(
            authContext,
            uids,
            (imap, source, callback) => imap.delFlags(source, '\\Flagged', callback),  // NO .seq
            'unflagged',
            folder
        );
    }

    /**
     * Delete emails (move to Trash)
     */
    async deleteEmails(authContext, uids, folder = 'INBOX') {
        return this.modifyEmails(
            authContext,
            uids,
            (imap, source, callback) => imap.move(source, 'Trash', callback),  // NO .seq
            'moved to Trash',
            folder
        );
    }

    /**
     * Archive emails
     */
    async archiveEmails(authContext, uids, folder = 'INBOX') {
        return this.modifyEmails(
            authContext,
            uids,
            (imap, source, callback) => imap.move(source, 'Archive', callback),  // NO .seq
            'archived',
            folder
        );
    }

    /**
     * Move emails to a specific folder
     */
    async moveEmails(authContext, uids, folderName, sourceFolder = 'INBOX') {
        return this.modifyEmails(
            authContext,
            uids,
            (imap, source, callback) => imap.move(source, folderName, callback),  // NO .seq
            `moved to ${folderName}`,
            sourceFolder
        );
    }

    /**
     * Helper: Detect if email has attachments from BODYSTRUCTURE
     */
    hasAttachments(struct) {
        if (!struct || !Array.isArray(struct)) return false;

        // Recursive check for attachment disposition
        const checkPart = (part) => {
            if (!part) return false;

            // Check if this part is an attachment
            if (part.disposition && part.disposition.type === 'attachment') {
                return true;
            }

            // Recursively check sub-parts
            if (Array.isArray(part)) {
                return part.some(p => checkPart(p));
            }

            return false;
        };

        return checkPart(struct);
    }

    /**
     * Helper: Flatten nested folder structure for list_folders
     */
    flattenFolders(boxes, parent = null) {
        const result = [];

        for (const [name, box] of Object.entries(boxes)) {
            const fullName = parent ? `${parent}/${name}` : name;

            // Skip NOSELECT folders (can't select them)
            const isNoSelect = box.attribs && box.attribs.includes('\\Noselect');

            result.push({
                name: fullName,
                delimiter: box.delimiter || '/',
                flags: box.attribs || [],
                selectable: !isNoSelect
            });

            // Recursively process children
            if (box.children) {
                result.push(...this.flattenFolders(box.children, fullName));
            }
        }

        return result;
    }

    /**
     * Helper: Validate UIDs array
     */
    validateUIDs(uids) {
        if (!uids) {
            return 'uids is required';
        }

        if (!Array.isArray(uids)) {
            return 'uids must be an array';
        }

        if (uids.length === 0) {
            return 'uids cannot be empty';
        }

        const invalidValues = uids.filter(n =>
            n === undefined ||
            n === null ||
            typeof n !== 'number' ||
            n <= 0 ||
            !Number.isInteger(n)
        );

        if (invalidValues.length > 0) {
            return 'uids contains invalid values (must be positive integers)';
        }

        return null;
    }

    /**
     * List all available IMAP folders
     */
    async listFolders(authContext) {
        const imap = await this.createImapConnection(authContext);

        return new Promise((resolve, reject) => {
            imap.getBoxes((err, boxes) => {
                imap.end();

                if (err) {
                    reject(new Error(`Failed to retrieve folders: ${err.message}`));
                    return;
                }

                const folders = this.flattenFolders(boxes);

                resolve({
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            folders: folders,
                            count: folders.length
                        }, null, 2)
                    }]
                });
            });
        });
    }

    /**
     * Draft a new email and save it to the Drafts folder
     */
    async draftEmail(authContext, to, subject, text, html = null) {
        if (!to || !subject || !text) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: "to", "subject", and "text" are required to draft an email'
                }]
            };
        }

        const senderEmail = await this.getAuthenticatedEmail(authContext);
        const imap = await this.createImapConnection(authContext);

        return new Promise((resolve, reject) => {
            // Yahoo Mail's Drafts folder is typically named 'Draft'
            const draftsFolder = 'Draft';
            
            // Construct RFC 822 message
            const boundary = `----=_Part_${Date.now()}`;
            let message = `From: ${senderEmail}\r\n`;
            message += `To: ${to}\r\n`;
            message += `Subject: ${subject}\r\n`;
            message += `Date: ${new Date().toUTCString()}\r\n`;
            message += 'MIME-Version: 1.0\r\n';

            if (html) {
                message += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`;
                message += `--${boundary}\r\n`;
                message += 'Content-Type: text/plain; charset=UTF-8\r\n\r\n';
                message += `${text}\r\n\r\n`;
                message += `--${boundary}\r\n`;
                message += 'Content-Type: text/html; charset=UTF-8\r\n\r\n';
                message += `${html}\r\n\r\n`;
                message += `--${boundary}--\r\n`;
            } else {
                message += 'Content-Type: text/plain; charset=UTF-8\r\n\r\n';
                message += `${text}\r\n`;
            }

            imap.append(message, { mailbox: draftsFolder, flags: ['\\Draft'] }, (appendErr) => {
                imap.end();
                if (appendErr) {
                    reject(new Error(`Failed to save draft: ${appendErr.message}`));
                    return;
                }
                
                resolve({
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            message: `Email draft saved successfully to the ${draftsFolder} folder.`,
                            draftDetails: {
                                to,
                                subject,
                                textPreview: text.substring(0, 100) + (text.length > 100 ? '...' : '')
                            }
                        }, null, 2)
                    }]
                });
            });
        });
    }

    async run() {
        const transportMode = process.env.TRANSPORT_MODE || 'stdio';

        if (transportMode === 'sse') {
            await this.runSSE();
        } else {
            await this.runStdio();
        }
    }

    async runStdio() {
        this.stdioServer = this.createMcpServer(this.getLocalAuthContext());
        const transport = new StdioServerTransport();
        await this.stdioServer.connect(transport);
        console.error('Yahoo Mail MCP server running on stdio');
    }

    async runSSE() {
        const app = express();
        const port = process.env.PORT || 3000;

        app.set('trust proxy', true);

        console.error('[Server] Starting in SSE mode');
        console.error('[Server] Port:', port);
        console.error('[Server] Node version:', process.version);
        console.error('[Server] Environment:', process.env.NODE_ENV || 'development');
        console.error('[Server] Legacy app-password configured:', this.isLegacyAppPasswordConfigured());
        console.error('[Server] Yahoo OAuth configured:', this.isYahooOAuthConfigured());

        app.use(cors({
            origin: true,
            credentials: true,
            methods: ['GET', 'POST', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
            exposedHeaders: ['Content-Type'],
            maxAge: 86400
        }));

        app.use((req, res, next) => {
            if (req.path === '/mcp/message') {
                return next();
            }

            if (req.path === '/oauth/token') {
                express.json()(req, res, (jsonErr) => {
                    if (jsonErr) {
                        return next(jsonErr);
                    }

                    express.urlencoded({ extended: true })(req, res, next);
                });
                return;
            }

            express.json()(req, res, next);
        });

        app.use((req, res, next) => {
            console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
            next();
        });

        const getOAuthMetadata = (req) => {
            const baseUrl = this.getExternalBaseUrl(req);
            return {
                issuer: baseUrl,
                authorization_endpoint: `${baseUrl}/oauth/authorize`,
                token_endpoint: `${baseUrl}/oauth/token`,
                registration_endpoint: `${baseUrl}/register`,
                grant_types_supported: ['authorization_code', 'refresh_token'],
                response_types_supported: ['code'],
                token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
                code_challenge_methods_supported: ['S256'],
                scopes_supported: [MCP_SCOPE],
            };
        };

        const getProtectedResourceMetadata = (req, resourcePath = '/mcp/sse') => {
            const baseUrl = this.getExternalBaseUrl(req);
            return {
                resource: `${baseUrl}${resourcePath}`,
                authorization_servers: [baseUrl],
                scopes_supported: [MCP_SCOPE],
            };
        };

        const sendAuthChallenge = (req, res, error, description, status = 401) => {
            res.setHeader(
                'WWW-Authenticate',
                `Bearer realm="email-mcp", resource_metadata="${this.getProtectedResourceMetadataUrl(req)}", scope="${MCP_SCOPE}"`
            );

            return res.status(status).json({
                error,
                error_description: description,
            });
        };

        const authenticateMcpRequest = (req, res, next) => {
            if (!this.isMcpAuthorizationEnabled()) {
                try {
                    req.authContext = this.getLocalAuthContext();
                    return next();
                } catch (error) {
                    return res.status(500).json({
                        error: 'server_error',
                        error_description: error.message,
                    });
                }
            }

            const authHeader = req.headers.authorization;
            if (!authHeader?.startsWith('Bearer ')) {
                return sendAuthChallenge(req, res, 'unauthorized', 'Bearer access token required');
            }

            const accessToken = authHeader.slice(7);
            const tokenRecord = this.mcpAccessTokens.get(accessToken);
            if (!tokenRecord) {
                return sendAuthChallenge(req, res, 'invalid_token', 'The MCP access token is invalid');
            }

            if (tokenRecord.expiresAt <= Date.now()) {
                this.mcpAccessTokens.delete(accessToken);
                return sendAuthChallenge(req, res, 'invalid_token', 'The MCP access token has expired');
            }

            const yahooSession = this.yahooSessions.get(tokenRecord.yahooSessionId);
            if (!yahooSession) {
                return sendAuthChallenge(req, res, 'invalid_token', 'The Yahoo authorization session no longer exists');
            }

            req.authContext = {
                mode: 'oauth',
                yahooSessionId: tokenRecord.yahooSessionId,
                email: yahooSession.email,
            };

            req.mcpToken = tokenRecord;
            next();
        };

        app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                service: MCP_SERVER_INFO.name,
                version: MCP_SERVER_INFO.version,
                timestamp: new Date().toISOString(),
                environment: {
                    nodeVersion: process.version,
                    platform: process.platform,
                    transportMode: process.env.TRANSPORT_MODE || 'stdio',
                    legacyAppPasswordConfigured: this.isLegacyAppPasswordConfigured(),
                    yahooOAuthConfigured: this.isYahooOAuthConfigured(),
                    mcpAuthorizationEnabled: this.isMcpAuthorizationEnabled(),
                }
            });
        });

        app.get('/.well-known/openid-configuration', (req, res) => {
            if (!this.isMcpAuthorizationEnabled()) {
                return res.status(404).json({ error: 'not_enabled', error_description: 'MCP OAuth is not enabled on this server.' });
            }

            res.json(getOAuthMetadata(req));
        });

        app.get('/.well-known/oauth-authorization-server', (req, res) => {
            if (!this.isMcpAuthorizationEnabled()) {
                return res.status(404).json({ error: 'not_enabled', error_description: 'MCP OAuth is not enabled on this server.' });
            }

            res.json(getOAuthMetadata(req));
        });

        app.get('/.well-known/oauth-authorization-server/mcp/sse', (req, res) => {
            if (!this.isMcpAuthorizationEnabled()) {
                return res.status(404).json({ error: 'not_enabled', error_description: 'MCP OAuth is not enabled on this server.' });
            }

            res.json(getOAuthMetadata(req));
        });

        app.get('/.well-known/oauth-protected-resource', (req, res) => {
            if (!this.isMcpAuthorizationEnabled()) {
                return res.status(404).json({ error: 'not_enabled', error_description: 'MCP OAuth is not enabled on this server.' });
            }

            res.json(getProtectedResourceMetadata(req, ''));
        });

        app.get('/.well-known/oauth-protected-resource/mcp/sse', (req, res) => {
            if (!this.isMcpAuthorizationEnabled()) {
                return res.status(404).json({ error: 'not_enabled', error_description: 'MCP OAuth is not enabled on this server.' });
            }

            res.json(getProtectedResourceMetadata(req, '/mcp/sse'));
        });

        app.post('/register', (req, res) => {
            if (!this.isMcpAuthorizationEnabled()) {
                return res.status(404).json({ error: 'not_enabled', error_description: 'MCP OAuth is not enabled on this server.' });
            }

            try {
                const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
                const tokenEndpointAuthMethod = req.body?.token_endpoint_auth_method || 'none';
                const client = this.registerClient({
                    redirectUris,
                    tokenEndpointAuthMethod,
                });

                res.status(201).json(this.serializeClient(client));
            } catch (error) {
                res.status(400).json({
                    error: 'invalid_client_metadata',
                    error_description: error.message,
                });
            }
        });

        app.get('/oauth/authorize', (req, res) => {
            if (!this.isMcpAuthorizationEnabled()) {
                return res.status(404).json({ error: 'not_enabled', error_description: 'MCP OAuth is not enabled on this server.' });
            }

            const {
                response_type,
                client_id,
                redirect_uri,
                state,
                code_challenge,
                code_challenge_method,
                scope,
                prompt,
            } = req.query;

            if (response_type !== 'code') {
                return res.status(400).send('Unsupported response_type');
            }

            if (!redirect_uri || !this.isAllowedRedirectUri(redirect_uri)) {
                return res.status(400).send('Invalid redirect_uri');
            }

            if (!code_challenge || code_challenge_method !== 'S256') {
                return res.status(400).send('PKCE with S256 is required');
            }

            let client;
            try {
                client = this.getOrCreatePublicClient(client_id, redirect_uri);
            } catch (error) {
                return res.status(400).send(error.message);
            }

            const authorizationId = this.generateOpaqueToken('yahoo_auth');
            const nonce = this.generateOpaqueToken('nonce');
            const yahooCallbackUrl = this.getYahooCallbackUrl(req);

            this.pendingYahooAuthorizations.set(authorizationId, {
                clientId: client.clientId,
                redirectUri: redirect_uri,
                clientState: state,
                codeChallenge: code_challenge,
                codeChallengeMethod: code_challenge_method,
                scope: scope || MCP_SCOPE,
                nonce,
                yahooCallbackUrl,
                createdAt: Date.now(),
            });

            const yahooAuthorizeUrl = new URL(YAHOO_AUTH_ENDPOINT);
            yahooAuthorizeUrl.searchParams.set('client_id', process.env.YAHOO_CLIENT_ID);
            yahooAuthorizeUrl.searchParams.set('redirect_uri', yahooCallbackUrl);
            yahooAuthorizeUrl.searchParams.set('response_type', 'code');
            yahooAuthorizeUrl.searchParams.set('scope', this.getYahooScopes());
            yahooAuthorizeUrl.searchParams.set('state', authorizationId);
            yahooAuthorizeUrl.searchParams.set('nonce', nonce);
            yahooAuthorizeUrl.searchParams.set('language', 'en-us');

            if (prompt === 'consent' || prompt === 'login') {
                yahooAuthorizeUrl.searchParams.set('prompt', prompt);
            }

            res.redirect(yahooAuthorizeUrl.toString());
        });

        app.get('/oauth/callback', async (req, res) => {
            const { code, state, error, error_description } = req.query;
            const pendingAuthorization = state ? this.pendingYahooAuthorizations.get(state) : null;

            if (error) {
                if (pendingAuthorization) {
                    this.pendingYahooAuthorizations.delete(state);
                    const redirectUrl = new URL(pendingAuthorization.redirectUri);
                    redirectUrl.searchParams.set('error', error);
                    if (error_description) {
                        redirectUrl.searchParams.set('error_description', error_description);
                    }
                    if (pendingAuthorization.clientState) {
                        redirectUrl.searchParams.set('state', pendingAuthorization.clientState);
                    }
                    return res.redirect(redirectUrl.toString());
                }

                return res.status(400).send(error_description || error);
            }

            if (!pendingAuthorization) {
                return res.status(400).send('Authorization session not found or already used.');
            }

            this.pendingYahooAuthorizations.delete(state);

            try {
                const tokenResponse = await this.exchangeYahooAuthorizationCode(code, pendingAuthorization.yahooCallbackUrl);
                const yahooSession = await this.createYahooSession(
                    tokenResponse,
                    pendingAuthorization.yahooCallbackUrl,
                    pendingAuthorization.nonce
                );

                const mcpAuthorizationCode = this.generateOpaqueToken('mcp_code');
                this.mcpAuthCodes.set(mcpAuthorizationCode, {
                    clientId: pendingAuthorization.clientId,
                    redirectUri: pendingAuthorization.redirectUri,
                    codeChallenge: pendingAuthorization.codeChallenge,
                    codeChallengeMethod: pendingAuthorization.codeChallengeMethod,
                    scope: pendingAuthorization.scope || MCP_SCOPE,
                    yahooSessionId: yahooSession.yahooSessionId,
                    createdAt: Date.now(),
                });

                const redirectUrl = new URL(pendingAuthorization.redirectUri);
                redirectUrl.searchParams.set('code', mcpAuthorizationCode);
                if (pendingAuthorization.clientState) {
                    redirectUrl.searchParams.set('state', pendingAuthorization.clientState);
                }

                res.redirect(redirectUrl.toString());
            } catch (callbackError) {
                console.error('[OAuth] Yahoo callback failed:', callbackError);

                const redirectUrl = new URL(pendingAuthorization.redirectUri);
                redirectUrl.searchParams.set('error', 'server_error');
                redirectUrl.searchParams.set('error_description', callbackError.message);
                if (pendingAuthorization.clientState) {
                    redirectUrl.searchParams.set('state', pendingAuthorization.clientState);
                }

                res.redirect(redirectUrl.toString());
            }
        });

        app.post('/oauth/token', async (req, res) => {
            if (!this.isMcpAuthorizationEnabled()) {
                return res.status(404).json({ error: 'not_enabled', error_description: 'MCP OAuth is not enabled on this server.' });
            }

            const body = req.body || {};
            const grantType = body.grant_type;
            const basicAuth = this.parseBasicAuthCredentials(req.headers.authorization);
            const requestedClientId = basicAuth.clientId || body.client_id || null;

            if (grantType === 'authorization_code') {
                const authCode = this.mcpAuthCodes.get(body.code);
                if (!authCode) {
                    return res.status(400).json({
                        error: 'invalid_grant',
                        error_description: 'Invalid or expired authorization code',
                    });
                }

                const client = this.registeredClients.get(authCode.clientId);
                const effectiveClientId = requestedClientId || authCode.clientId;
                if (effectiveClientId !== authCode.clientId) {
                    return res.status(401).json({
                        error: 'invalid_client',
                        error_description: 'client_id does not match the authorization code',
                    });
                }

                if (body.redirect_uri !== authCode.redirectUri) {
                    return res.status(400).json({
                        error: 'invalid_grant',
                        error_description: 'redirect_uri does not match the authorization request',
                    });
                }

                if (client?.tokenEndpointAuthMethod && client.tokenEndpointAuthMethod !== 'none') {
                    if (!basicAuth.clientId && !body.client_secret) {
                        return res.status(401).json({
                            error: 'invalid_client',
                            error_description: 'Client authentication is required',
                        });
                    }

                    const providedClientSecret = basicAuth.clientSecret || body.client_secret;
                    if (providedClientSecret !== client.clientSecret) {
                        return res.status(401).json({
                            error: 'invalid_client',
                            error_description: 'Invalid client credentials',
                        });
                    }
                }

                if (!body.code_verifier) {
                    return res.status(400).json({
                        error: 'invalid_request',
                        error_description: 'code_verifier is required',
                    });
                }

                const expectedChallenge = createHash('sha256').update(body.code_verifier).digest('base64url');
                if (expectedChallenge !== authCode.codeChallenge) {
                    return res.status(400).json({
                        error: 'invalid_grant',
                        error_description: 'PKCE validation failed',
                    });
                }

                this.mcpAuthCodes.delete(body.code);
                return res.json(this.issueMcpTokens({
                    clientId: authCode.clientId,
                    yahooSessionId: authCode.yahooSessionId,
                    scope: authCode.scope || MCP_SCOPE,
                }));
            }

            if (grantType === 'refresh_token') {
                const refreshRecord = this.mcpRefreshTokens.get(body.refresh_token);
                if (!refreshRecord) {
                    return res.status(400).json({
                        error: 'invalid_grant',
                        error_description: 'Invalid refresh token',
                    });
                }

                if (refreshRecord.expiresAt <= Date.now()) {
                    this.mcpRefreshTokens.delete(body.refresh_token);
                    return res.status(400).json({
                        error: 'invalid_grant',
                        error_description: 'Refresh token has expired',
                    });
                }

                const client = this.registeredClients.get(refreshRecord.clientId);
                const effectiveClientId = requestedClientId || refreshRecord.clientId;
                if (effectiveClientId !== refreshRecord.clientId) {
                    return res.status(401).json({
                        error: 'invalid_client',
                        error_description: 'client_id does not match the refresh token',
                    });
                }

                if (client?.tokenEndpointAuthMethod && client.tokenEndpointAuthMethod !== 'none') {
                    const providedClientSecret = basicAuth.clientSecret || body.client_secret;
                    if (!providedClientSecret || providedClientSecret !== client.clientSecret) {
                        return res.status(401).json({
                            error: 'invalid_client',
                            error_description: 'Invalid client credentials',
                        });
                    }
                }

                try {
                    await this.ensureYahooSession(refreshRecord.yahooSessionId);
                } catch (refreshError) {
                    return res.status(400).json({
                        error: 'invalid_grant',
                        error_description: refreshError.message,
                    });
                }

                return res.json(this.issueMcpTokens({
                    clientId: refreshRecord.clientId,
                    yahooSessionId: refreshRecord.yahooSessionId,
                    scope: refreshRecord.scope || MCP_SCOPE,
                    rotateRefreshToken: body.refresh_token,
                }));
            }

            res.status(400).json({
                error: 'unsupported_grant_type',
                error_description: 'Supported grant types: authorization_code, refresh_token',
            });
        });

        app.get('/mcp/sse', async (req, res) => {
            authenticateMcpRequest(req, res, async () => {
            try {
                console.error('[SSE] New connection established from:', req.ip);
                console.error('[SSE] Origin:', req.headers.origin);
                console.error('[SSE] User-Agent:', req.headers['user-agent']);

                const transport = new SSEServerTransport('/mcp/message', res);
                const sessionId = transport.sessionId;
                console.error('[SSE] Session ID:', sessionId);

                const server = this.createMcpServer(req.authContext);
                this.transports.set(sessionId, {
                    transport,
                    server,
                    yahooSessionId: req.authContext?.yahooSessionId || null,
                });

                transport.onclose = async () => {
                    console.error('[SSE] Connection closed, cleaning up session:', sessionId);
                    if (server?.close) {
                        await server.close();
                    }
                    this.transports.delete(sessionId);
                };

                await server.connect(transport);
                console.error('[SSE] MCP server connected to transport');
            } catch (error) {
                console.error('[SSE] Error connecting transport:', error);
                if (!res.headersSent) {
                    res.status(500).json({ error: error.message });
                }
            }
            });
        });

        app.post('/mcp/message', async (req, res) => {
            authenticateMcpRequest(req, res, () => {
            console.error('[SSE] Received message on /mcp/message');
            console.error('[SSE] Active transports:', this.transports.size);

            const sessionId = req.query?.sessionId || req.headers['x-session-id'];
            console.error('[SSE] Session ID from request:', sessionId);

            if (sessionId && this.transports.has(sessionId)) {
                const transportEntry = this.transports.get(sessionId);
                console.error('[SSE] Routing message to transport:', sessionId);
                if (
                    req.authContext?.mode === 'oauth' &&
                    transportEntry.yahooSessionId &&
                    transportEntry.yahooSessionId !== req.authContext.yahooSessionId
                ) {
                    return sendAuthChallenge(req, res, 'invalid_token', 'The access token does not match this SSE session');
                }

                transportEntry.transport.handlePostMessage(req, res);
            } else {
                const firstTransport = Array.from(this.transports.values())[0];
                if (firstTransport) {
                    console.error('[SSE] No session ID, using first available transport');
                    firstTransport.transport.handlePostMessage(req, res);
                } else {
                    console.error('[SSE] No active transport found');
                    res.status(404).json({ error: 'No active SSE connection found' });
                }
            }
            });
        });

        app.use((err, req, res, next) => {
            console.error('[Express] Error:', err);
            res.status(500).json({
                error: 'Internal server error',
                message: err.message
            });
        });

        app.get('/', (req, res) => {
            res.json({
                name: 'Yahoo Mail MCP Server',
                version: MCP_SERVER_INFO.version,
                description: this.isMcpAuthorizationEnabled()
                    ? 'Remote MCP server for Yahoo Mail using delegated Yahoo OAuth and IMAP XOAUTH2'
                    : 'MCP server for Yahoo Mail using app-password IMAP authentication',
                endpoints: {
                    health: '/health',
                    sse: '/mcp/sse',
                    message: '/mcp/message',
                    authorize: '/oauth/authorize',
                    token: '/oauth/token',
                    register: '/register',
                },
                authorizationEnabled: this.isMcpAuthorizationEnabled(),
                tools: [
                    'list_emails',
                    'read_email',
                    'search_emails',
                    'delete_emails',
                    'archive_emails',
                    'mark_as_read',
                    'mark_as_unread',
                    'flag_emails',
                    'unflag_emails',
                    'move_emails',
                    'draft_email'
                ]
            });
        });

        app.listen(port, () => {
            console.error(`Yahoo Mail MCP server running on port ${port}`);
            console.error(`SSE endpoint: http://localhost:${port}/mcp/sse`);
            console.error(`Health check: http://localhost:${port}/health`);
            if (this.isMcpAuthorizationEnabled()) {
                console.error(`OAuth authorize endpoint: http://localhost:${port}/oauth/authorize`);
            }
        });
    }
}

// Start the server
const server = new YahooMailMCPServer();
server.run().catch(console.error);
