import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { friendlyError } from "../accounts.js";

export const ok = (data: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

export const fail = (e: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: friendlyError(e) }],
});

/** Wrap a handler so errors come back as readable tool errors rather than protocol errors. */
export const safe =
  <A>(fn: (args: A) => Promise<CallToolResult>) =>
  async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };

export const accountArg = z
  .string()
  .optional()
  .describe("Account label, full address, or domain. Omit for the default account.");

export const accountOrAllArg = z
  .string()
  .optional()
  .describe('Account label, full address, domain, or "all" to query every connected account. Omit for the default account.');

export const emailList = z.array(z.string()).describe("Email addresses");
