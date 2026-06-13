# Yahoo Mail MCP Server

Yahoo Mail MCP server for Claude and other MCP clients.

This server supports two modes:

- `stdio` + Yahoo app password for local desktop use
- `sse` + delegated Yahoo OAuth for remote Claude connector use

The remote OAuth flow is the important part here: the user connects your MCP URL in Claude, Claude starts MCP OAuth, your server redirects the user to Yahoo consent, Yahoo redirects back to your server, and your server finishes the MCP OAuth flow back to Claude. The user never has to paste a Yahoo app password into Claude.

## What’s included

- Yahoo IMAP access with OAuth-backed remote auth
- MCP OAuth endpoints for remote connector login
- Yahoo consent redirect flow
- IMAP XOAUTH2 login for per-user mailbox access
- UID-based email operations
- Tools:
  - `list_emails`
  - `read_email`
  - `search_emails`
  - `list_folders`
  - `delete_emails`
  - `archive_emails`
  - `mark_as_read`
  - `mark_as_unread`
  - `flag_emails`
  - `unflag_emails`
  - `move_emails`
  - `draft_email`

## Auth model

### 1. Local mode

Use this when running through `stdio`.

- Requires `YAHOO_EMAIL`
- Requires `YAHOO_APP_PASSWORD`

### 2. Remote Claude connector mode

Use this when hosting the server over HTTP/SSE.

- Requires `YAHOO_CLIENT_ID`
- Requires `YAHOO_CLIENT_SECRET`
- User signs into Yahoo in the browser
- User grants Yahoo Mail permissions
- Claude receives MCP access/refresh tokens from this server
- This server stores Yahoo refresh/access tokens in memory and uses IMAP XOAUTH2

## Important production note

Current token/session storage is in-memory.

That means:

- reconnect is required after process restart or redeploy
- multi-instance deployments need a shared store like Redis or a database

If you want true long-lived production sessions across deploys, move:

- `pendingYahooAuthorizations`
- `mcpAuthCodes`
- `mcpAccessTokens`
- `mcpRefreshTokens`
- `yahooSessions`

into a persistent shared store.

## Yahoo app setup

Create a Yahoo developer app and enable the permissions your server needs.

Recommended permissions:

- OpenID `Email`
- OpenID `Profile` (optional but useful)
- Yahoo Mail read access
- Yahoo Mail write access

Default requested scopes in this server:

```env
YAHOO_SCOPES="openid email mail-r mail-w"
```

If Yahoo requires approval for restricted mail scopes on your app, complete that in Yahoo Developer first.

Your Yahoo callback URL should point to:

```text
https://your-domain.com/oauth/callback
```

For local testing:

```text
http://localhost:3000/oauth/callback
```

## Environment variables

### Remote OAuth mode

```env
TRANSPORT_MODE=sse
PORT=3000

YAHOO_CLIENT_ID=your-yahoo-client-id
YAHOO_CLIENT_SECRET=your-yahoo-client-secret
YAHOO_SCOPES=openid email mail-r mail-w

# Optional but recommended behind proxies/platforms
PUBLIC_BASE_URL=https://your-domain.com
```

### Local stdio mode

```env
TRANSPORT_MODE=stdio

YAHOO_EMAIL=your.email@yahoo.com
YAHOO_APP_PASSWORD=your-yahoo-app-password
```

## Quick start

```bash
npm install
cp .env.example .env
```

### Run local stdio mode

```bash
npm run start:stdio
```

### Run remote SSE mode

```bash
npm run start:sse
```

## Claude remote connector setup

After deploying the server:

1. Deploy this repo on Render
2. In Render environment variables, set:

```env
TRANSPORT_MODE=sse
PUBLIC_BASE_URL=https://your-render-service.onrender.com
YAHOO_CLIENT_ID=...
YAHOO_CLIENT_SECRET=...
YAHOO_SCOPES=openid email mail-r mail-w
```

3. Add the remote MCP URL in Claude
4. Use your SSE endpoint:

```text
https://your-domain.com/mcp/sse
```

5. Claude discovers the MCP auth metadata
6. Claude opens the server authorization flow
7. Your server redirects the user to Yahoo
8. User approves Yahoo Mail permissions
9. Yahoo redirects back to your server
10. Your server completes MCP OAuth and Claude marks the connector connected

For your exact use case, yes — this is the intended path:

- deploy once on Render
- use the Render URL in Claude cloud connector
- user clicks connect
- user signs into Yahoo and accepts permissions
- Claude stores the connector session
- later tool calls use Yahoo OAuth without asking the user for an app password

## HTTP endpoints

- `GET /health`
- `GET /mcp/sse`
- `POST /mcp/message`
- `GET /.well-known/openid-configuration`
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-authorization-server/mcp/sse`
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp/sse`
- `POST /register`
- `GET /oauth/authorize`
- `POST /oauth/token`
- `GET /oauth/callback`

## Local smoke tests

```bash
npm run test:health
npm run test:sse
```

You can also inspect metadata in OAuth mode:

```bash
curl http://localhost:3000/.well-known/oauth-authorization-server
curl http://localhost:3000/.well-known/oauth-protected-resource/mcp/sse
```

## Deployment notes

### Render / Fly / any HTTPS host

- set `TRANSPORT_MODE=sse`
- set `YAHOO_CLIENT_ID`
- set `YAHOO_CLIENT_SECRET`
- set `PUBLIC_BASE_URL`
- set Yahoo app callback to `https://your-domain.com/oauth/callback`
- do not rely on in-memory sessions for multi-instance production

### CORS / proxies

The server already enables permissive CORS for remote MCP clients and respects proxy protocol headers.

## How the new remote auth works internally

1. Claude hits `/mcp/sse`
2. Server challenges with `WWW-Authenticate` and protected resource metadata
3. Claude discovers `/oauth/authorize`, `/oauth/token`, `/register`
4. Server receives MCP auth request
5. Server redirects user to Yahoo
6. Yahoo returns code to `/oauth/callback`
7. Server exchanges Yahoo code for Yahoo access/refresh tokens
8. Server creates its own MCP auth code for Claude
9. Claude exchanges that code at `/oauth/token`
10. Claude uses the returned MCP access token on future MCP requests
11. Tool calls use the mapped Yahoo session and IMAP XOAUTH2

## Files to check

- `server.js`
- `.env.example`
- `docker-compose.yml`
- `render.yaml`
- `fly.toml`

## Current limitations

- token/session storage is in-memory
- stdio mode still uses app password, not browser OAuth
- remote Yahoo OAuth depends on your Yahoo app having required mail scopes enabled

## Version

Current implementation version: `4.0.0`
