import { getPublicOrigin } from "mcp-handler";
import { protectedResourceMetadata } from "@/app/lib/mcp/oauth";

// RFC 9728 Protected Resource Metadata — tells an MCP client which authorization
// server to use for this resource. Public + CORS-open (browser MCP clients read it).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

export function GET(request: Request) {
  return Response.json(protectedResourceMetadata(getPublicOrigin(request)), { headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
