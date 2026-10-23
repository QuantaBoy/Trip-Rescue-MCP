// AWS Lambda entry point (handler: lambda.handler). Same Express app as `npm start`, served through a Function URL.
import serverless from "serverless-http";
import { app } from "./server.js";

export const handler = serverless(app, {
  // the MCP SDK reads req.rawHeaders, which serverless-http leaves empty; rebuild it from req.headers
  request(req) {
    req.rawHeaders = Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.flatMap((x) => [k, x]) : [k, String(v)]));
  },
});
