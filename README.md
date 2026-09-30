# Link registry for Cloudflare

A server list for a Link network, running on Cloudflare Workers with one Durable Object.

Cost: each server sends a heartbeat every 10 seconds, about 8,640 requests per server per day. The
free plan's 100k requests a day covers about 10 servers. Workers Paid ($5 a month) includes 10M
Worker requests and 1M Durable Object requests a month; past that, each server adds roughly
$0.20 a month.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/HiveScaleSystems/link/tree/main/cloudflare-registry)

The button forks this folder into your account, creates the Durable Object, and asks for
`LINK_TOKEN`. Or deploy by hand:

```bash
npm install
npx wrangler login
npx wrangler secret put LINK_TOKEN   # paste a long random string, e.g. from `openssl rand -hex 32`
npx wrangler deploy
```

Put the printed `https://link-registry.<you>.workers.dev` URL and the token in every server's
`link.json` (see the main README). One deployment is one network.

## Run locally

```bash
echo "LINK_TOKEN=dev-token" > .dev.vars
npx wrangler dev
```

## Protocol

Every request needs `Authorization: Bearer <LINK_TOKEN>`.

| Request | Response |
|---|---|
| `GET /v1/secret` | `{"secret": "..."}`, created on the first call |
| `PUT /v1/servers/{id}` with the server as JSON, including its `online` players | `{"servers": [...]}`, the live network including you |
| `DELETE /v1/servers/{id}` | `204` |

A server that has not sent a heartbeat for 30 seconds drops out of the list. Anything that speaks
this protocol works as a Link registry.
