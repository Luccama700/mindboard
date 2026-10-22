import { NextResponse } from "next/server";

import { authenticateDevice, handleDeviceOp } from "@/app/lib/urc/device";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// The URC agent's only door into the app (worker/urc-agent.mjs). Auth is the
// per-device token from urc_devices — NOT the static MCP bearer and NOT a PAT,
// so a leaked device token can do nothing except heartbeat and move that one
// device's own jobs. Every op resolves the device first and is scoped to its
// user id and its device id inside app/lib/urc/device.ts.
//
// Deliberately separate from /api/worker: that endpoint authenticates with the
// shared MCP_BEARER_TOKEN and its jobs table lets any signed-in user insert any
// kind of job, neither of which is acceptable for starting an interactive
// session on the PC.

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

export async function POST(request: Request) {
  let device;
  try {
    device = await authenticateDevice(bearer(request));
  } catch {
    return NextResponse.json({ error: "device lookup failed" }, { status: 500 });
  }
  if (!device) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  try {
    const result = await handleDeviceOp(device, body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json(result.value);
  } catch (e) {
    const message = e instanceof Error ? e.message : "urc device op failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
