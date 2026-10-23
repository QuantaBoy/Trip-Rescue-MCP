# Friction Log

Problems we hit while building TripRescue, in the order they happened. Each entry gives the task, what we did, what we expected versus what happened, severity, the workaround, and a suggestion.

Severity: **High** blocked progress, **Medium** cost real time, **Low** was a minor annoyance.

---

## 1. Bedrock access blocked during account verification

- **Task:** Call a model in the Amazon Bedrock playground on a new AWS account.
- **Steps:** Created the account, opened Bedrock in `ap-southeast-2`, ran a prompt.
- **Expected:** A reply, or a clear setup step.
- **Actual:** `AccessDeniedException ... account is currently being verified`, with no estimate of how long verification takes.
- **Severity:** High
- **Workaround:** Built everything with plain-text fallbacks and came back after verification finished.
- **Suggestion:** Show verification status and an expected time on the Bedrock page, and say which features are blocked until it completes.

## 2. Claude models "not available for this account", Nova works

- **Task:** Use Claude Haiku or Claude Sonnet on Bedrock.
- **Steps:** Picked the model in the playground and ran "hi".
- **Expected:** A reply, or a model-access request flow.
- **Actual:** `anthropic.claude-sonnet-5-5 is not available for this account... contact AWS Sales`. The same happened with Haiku. Amazon Nova models worked immediately.
- **Severity:** Medium
- **Workaround:** Switched to Amazon Nova Lite and Nova Pro. The Converse API made this a one-line model id change.
- **Suggestion:** Explain why a model is unavailable (new account limits, region, use-case form) and link the exact way to request access instead of "contact Sales".

## 3. GDELT news API rate limited and slow

- **Task:** Fetch live news about a destination without an API key.
- **Steps:** Called the GDELT DOC 2.0 API.
- **Expected:** A JSON article list in about a second.
- **Actual:** HTTP 429 after about 11 seconds.
- **Severity:** Medium
- **Workaround:** Switched to Google News RSS: about 0.6 seconds, 30 headlines, no key. Added a 10-minute cache and a JSON fallback.
- **Suggestion:** (GDELT) Return 429 immediately with a Retry-After header instead of after a long wait.

## 4. Open-Meteo forecasts only about 16 days ahead

- **Task:** Get the forecast for a trip in December, about 7 weeks away.
- **Steps:** Called the forecast endpoint with the trip dates.
- **Expected:** A forecast, or a clear "too far ahead" signal.
- **Actual:** An error body: `Parameter 'start_date' is out of allowed range`. Our first version also spent about 660 ms on that failing call every time.
- **Severity:** Low
- **Workaround:** Skip the live call for dates more than 15 days out and use a saved scenario forecast.
- **Suggestion:** None needed for Open-Meteo; this is a documented limit. Noted for anyone planning trips further out.

## 5. Windows zip tool breaks Lambda packages

- **Task:** Upload the app to AWS Lambda as a .zip.
- **Steps:** Built the zip with PowerShell `Compress-Archive` and uploaded it in the console.
- **Expected:** Folders like `node_modules/express/...` in the Lambda file tree.
- **Actual:** File names like `node_modules\@aws-sdk\credential-provider...`. Windows PowerShell 5.1 writes backslash paths, which Lambda (Linux) treats as single file names, so imports fail at runtime.
- **Severity:** High
- **Workaround:** Built the zip with Windows' bundled `tar.exe -a -c -f deploy.zip ...`, which writes forward slashes.
- **Suggestion:** (Lambda console) Detect backslash paths on upload and warn. A one-line note in the "Upload .zip" dialog for Windows users would save a lot of confusion.

## 6. MCP SDK returns 415 behind serverless-http on Lambda

- **Task:** Serve the MCP Streamable HTTP endpoint from Lambda via `serverless-http`.
- **Steps:** Deployed the same Express app that works locally and called `/mcp` with `Content-Type: application/json`.
- **Expected:** The same responses as locally.
- **Actual:** `415 Unsupported Media Type: Content-Type must be application/json`, even though the header was sent. The SDK's Node transport reads `req.rawHeaders`, which `serverless-http` leaves empty.
- **Severity:** High
- **Workaround:** Rebuild `req.rawHeaders` from `req.headers` in serverless-http's `request` hook (see `lambda.js`).
- **Suggestion:** (MCP TypeScript SDK) Fall back to `req.headers` when `rawHeaders` is empty, or document serverless adapters. A first-party Lambda example for Streamable HTTP would help a lot.

## 7. Nova Lite leaked `<thinking>` text into replies

- **Task:** Use Nova Lite as the chat assistant with tool calling.
- **Steps:** Converse API with tools, then showed the final text.
- **Expected:** A spoken reply.
- **Actual:** Some turns ended with only `<thinking>...</thinking>` text and no answer, which the page displayed.
- **Severity:** Medium
- **Workaround:** Strip thinking blocks, fall back to the tool's own reply if nothing is left, and tell the model not to use the tags.
- **Suggestion:** (Bedrock) Return model reasoning in a separate content block for Nova, as is done for other reasoning models, so apps never show it by accident.

## 8. Nova Lite ran the whole plan in one turn and picked demo data on its own

- **Task:** Let the model call tools step by step.
- **Steps:** User said "Plan 5 days in Goa".
- **Expected:** One tool call, then a question.
- **Actual:** It called six tools at once, hit our step limit, and once chose the `normal` scenario itself, which flipped the verdict.
- **Severity:** Medium
- **Workaround:** Tighter instructions, fixed the scenario on the server and hid that parameter from the model, and used the tool's reply if the step limit is reached.
- **Suggestion:** None for the platform; worth knowing that smaller models need tighter tool scopes.

## 9. A larger model booked without confirmation

- **Task:** Switch the chat to Nova Pro for better reasoning.
- **Steps:** User said "Build the plan".
- **Expected:** `build_itinerary`.
- **Actual:** It called `confirm_booking` and booked the trip without a yes.
- **Severity:** High (a real product would have charged money)
- **Workaround:** A code-level guard: `confirm_booking` is blocked unless the user's latest message contains a clear yes, and the model is told to ask.
- **Suggestion:** (Alexa+ / MCP) First-class support for confirmation on destructive tools, for example honouring `destructiveHint` with a built-in confirm step, so every developer doesn't have to build this.

## 10. Developer tooling friction

- **Task:** Day-to-day building with an AI coding assistant.
- **What happened:**
  - A plugin hook failed on every prompt (`Executable not found in $PATH: "claude-mem"`).
  - The assistant's safety checks blocked a git history rewrite and a file deletion.
  - The browser automation extension disconnected several times and worked only in Chrome while our AWS session was in Edge, so console steps were done by hand.
- **Severity:** Low
- **Workaround:** Disabled the broken plugin, did the blocked steps manually, and followed step-by-step console guidance.
- **Suggestion:** Clearer messages when an extension is disconnected, and support for Chromium browsers like Edge.
