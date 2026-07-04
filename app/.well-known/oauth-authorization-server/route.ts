import { getPublicOrigin } from "mcp-handler";
import { authorizationServerMetadata } from "@/app/lib/mcp/oauth";

// RFC 8414 Authorization Server Metadata — advertises the authorize / token /
// registration endpoints and the supported flows (auth code + PKCE S256, public
// clients). Public + CORS-open.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

export function GET(request: Request) {
  return Response.json(authorizationServerMetadata(getPublicOrigin(request)), { headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
