# Product Feedback

Feedback on every tool, API and SDK used to build TripRescue. Detailed reproduction steps for each problem are in [FRICTION_LOG.md](FRICTION_LOG.md).

## Model Context Protocol TypeScript SDK (`@modelcontextprotocol/sdk` 1.32)

- **Used for:** the TripRescue server: 12 tools over Streamable HTTP (protocol 2025-11-25), plus an in-process client in the simulated Alexa page.
- **Worked well:**
  - `McpServer.registerTool` with zod schemas is short and readable, and invalid input is rejected for free.
  - Stateless Streamable HTTP takes about ten lines with Express.
  - `InMemoryTransport.createLinkedPair()` made it easy to reuse the same server inside the chat backend.
  - The client SDK made an end-to-end test simple.
- **Needs work:**
  - Behind `serverless-http` on Lambda, the Node transport returned 415 because it reads `req.rawHeaders`.
  - There is no official serverless or Lambda example for Streamable HTTP.
  - Per-request context (who is calling) is not obvious in stateless mode, so we added our own `x-session-id` header.
- **Onboarding:** good. The README example got a working server running quickly.
- **Would build with it again:** yes.

## MCP Inspector (2.12)

- **Used for:** connecting to the local and deployed server, listing tools, calling them by hand, and its CLI mode for scripted checks.
- **Worked well:**
  - The server list, the tool forms generated from the schema, and the message log with timings.
  - CLI mode (`--cli --method tools/call`) was great for quick checks without a browser.
- **Needs work:**
  - The new server-list layout made "where do I add my URL" less obvious than the old single form.
  - The Add server dialog briefly showed a "server already exists" error after a successful add.
- **Onboarding:** easy once the server was added.
- **Would use again:** yes.

## Amazon Bedrock (Converse API, Nova Lite and Nova Pro)

- **Used for:**
  - Nova Lite: a deep read of the 12 most important social posts (sentiment and topic) and rewording the verdict for voice.
  - Nova Pro: the simulated Alexa, which reasons about the conversation and calls the MCP tools.
- **Worked well:**
  - The Converse API is model-agnostic, so moving from Claude to Nova was a one-line change.
  - Tool calling with `toolConfig` mapped directly from MCP tool schemas.
  - Bedrock API keys made local development simple, with no IAM user or CLI needed.
  - Nova Lite answers in about 400 ms.
- **Needs work:**
  - New accounts were blocked during verification with no time estimate.
  - Claude models said "not available for this account, contact Sales" with no self-serve path.
  - Nova Lite sometimes ended a turn with only `<thinking>` text.
  - Model access rules differ by account and region in ways the console does not explain.
- **Onboarding:** the playground is a good first check. Account verification and model availability were the slowest part of the whole project.
- **Would build with it again:** yes, with Nova. We would like clearer access rules for third-party models.

## AWS Lambda (Node.js 22, Function URL)

- **Used for:** hosting the whole app (MCP endpoint, chat page and Bedrock calls) at a public HTTPS URL.
- **Worked well:**
  - A Function URL gives HTTPS with no API Gateway or certificate setup.
  - The execution role let the app call Bedrock with no keys deployed.
  - The new code editor showed the uploaded tree clearly.
- **Needs work:**
  - Zips made with Windows PowerShell `Compress-Archive` upload fine but fail at runtime because of backslash paths. A warning on upload would help.
  - The upload option is now under "Update", which was hard to find at first.
  - "Edit runtime management configuration" sits right next to "Edit" in Runtime settings and is easy to click by mistake.
- **Onboarding:** about 10 minutes in the console with step-by-step guidance.
- **Would use again:** yes.

## AWS console and account setup

- **Used for:** account creation, Bedrock access, IAM, Lambda.
- **Needs work:** account verification blocked Bedrock for hours with no status page. Account-specific console URLs (`<account>-<id>.<region>.console.aws.amazon.com`) were confusing when switching between browsers and accounts.

## Google News RSS and Open-Meteo (third-party, no key)

- **Google News RSS:** about 0.6 s for 30 relevant headlines, with no key. Used as the live news source after GDELT rate limited us. It works well. Its terms are for personal, non-commercial feed reading, so a commercial version would move to a licensed news API.
- **Open-Meteo:** free, fast and no key. It forecasts only about 16 days ahead, which is documented.

## Feature requests

| Request | Why it matters | Urgency |
|---|---|---|
| Official Streamable HTTP example for AWS Lambda in the MCP SDK, with a `rawHeaders` fallback | Lambda is the obvious way to self-host an Alexa+ MCP server, and it fails silently today | Critical |
| Built-in confirmation for tools marked `destructiveHint` in Alexa+ | Every developer otherwise has to build their own guard against booking or paying without a yes | Important |
| Self-serve access requests and clear reasons when a Bedrock model is unavailable | "Contact Sales" stalls hackathon and indie projects | Important |
| Warn about backslash paths when uploading a Lambda .zip | Saves Windows developers a confusing runtime failure | Nice-to-have |
| Session or caller identity passed to tools in stateless MCP | Needed for per-user state without inventing headers | Important |
