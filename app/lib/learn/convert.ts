import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";
import type { SupabaseClient } from "@supabase/supabase-js";

import { readProviderKey } from "@/app/lib/connections/keys";
import { readVaultCredentials } from "@/app/lib/brain/vault";
import {
  createVaultFileWithRetry,
  VAULT_NOT_CONFIGURED_MESSAGE,
} from "@/app/lib/mcp/capture";
import {
  buildSourceDocument,
  courseSourcePath,
  vancouverStamp,
} from "@/app/lib/mcp/course-ops";
import type { Result } from "@/app/lib/mcp/validate";
import { SOURCE_COLUMNS, type CourseSource } from "@/app/_components/learn-types";
import {
  conversionSystemPrompt,
  conversionUserPrompt,
  planSlices,
  stitchConverted,
  type PageSlice,
} from "./convert-plan";

// Path 3 of the ingestion design (docs/education-plan.md): convert a stored
// PDF to vault markdown on the user's own Anthropic key. unpdf probes the
// page count, pdf-lib slices ~20-page chunks (each its own Claude request,
// under the per-request limits), and the stitched result rides the same
// create-only Courses/ vault writer as the MCP path.

export const CONVERT_MODELS: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  opus: "claude-opus-4-8",
};
export const DEFAULT_CONVERT_MODEL = "sonnet";

const MAX_PAGES = 600;
const MAX_OUTPUT_TOKENS = 32_000;

async function probePageCount(bytes: Uint8Array): Promise<number> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  return pdf.numPages;
}

async function slicePdf(
  source: PDFDocument,
  slice: PageSlice,
): Promise<string> {
  const out = await PDFDocument.create();
  const indices = [];
  for (let page = slice.from; page <= slice.to; page++) indices.push(page - 1);
  const pages = await out.copyPages(source, indices);
  for (const page of pages) out.addPage(page);
  return out.saveAsBase64();
}

async function convertSlice(
  client: Anthropic,
  model: string,
  sliceBase64: string,
  slice: PageSlice,
  totalPages: number,
  title: string,
): Promise<string> {
  const message = await client.messages
    .stream({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: conversionSystemPrompt(),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: sliceBase64,
              },
            },
            {
              type: "text",
              text: conversionUserPrompt(slice, totalPages, title),
            },
          ],
        },
      ],
    })
    .finalMessage();

  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export async function runPdfConversion(input: {
  supabase: SupabaseClient;
  userId: string;
  sourceId: string;
  model?: string;
}): Promise<Result<{ vault_path: string; pages: number }>> {
  const { supabase, userId, sourceId } = input;

  const modelKey = input.model ?? DEFAULT_CONVERT_MODEL;
  const model = CONVERT_MODELS[modelKey];
  if (!model) return { ok: false, error: "unknown model" };

  const { data: sourceRow } = await supabase
    .from("course_sources")
    .select(SOURCE_COLUMNS)
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!sourceRow) return { ok: false, error: "source not found" };
  const source = sourceRow as CourseSource;
  if (source.kind !== "pdf" || !source.storage_path) {
    return { ok: false, error: "source has no uploaded pdf" };
  }
  if (source.status !== "uploaded" && source.status !== "failed") {
    return { ok: false, error: `source is ${source.status}` };
  }

  const { data: courseRow } = await supabase
    .from("courses")
    .select("name")
    .eq("id", source.course_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!courseRow) return { ok: false, error: "course not found" };
  const courseName = courseRow.name as string;

  const apiKey = await readProviderKey(supabase, userId, "anthropic");
  if (!apiKey) {
    return {
      ok: false,
      error: "no anthropic key connected — add it in settings → connections",
    };
  }

  const credentials = await readVaultCredentials(supabase, userId);
  if (!credentials) return { ok: false, error: VAULT_NOT_CONFIGURED_MESSAGE };

  const fail = async (message: string): Promise<Result<never>> => {
    await supabase
      .from("course_sources")
      .update({ status: "failed", error: message })
      .eq("id", sourceId)
      .eq("user_id", userId);
    return { ok: false, error: message };
  };

  await supabase
    .from("course_sources")
    .update({ status: "converting", error: null })
    .eq("id", sourceId)
    .eq("user_id", userId);

  const download = await supabase.storage
    .from("course-files")
    .download(source.storage_path);
  if (download.error || !download.data) {
    return fail(`could not download the pdf (${download.error?.message ?? "missing"})`);
  }
  const bytes = new Uint8Array(await download.data.arrayBuffer());

  let pageCount: number;
  try {
    pageCount = await probePageCount(bytes);
  } catch {
    return fail("could not read the pdf (corrupt or password-protected?)");
  }
  if (pageCount > MAX_PAGES) {
    return fail(
      `pdf has ${pageCount} pages (max ${MAX_PAGES}) — split it or use the home worker`,
    );
  }

  await supabase
    .from("course_sources")
    .update({ page_count: pageCount })
    .eq("id", sourceId)
    .eq("user_id", userId);

  const client = new Anthropic({ apiKey });
  const slices = planSlices(pageCount);
  const converted: { slice: PageSlice; markdown: string }[] = [];

  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch {
    return fail("could not slice the pdf (corrupt or password-protected?)");
  }

  for (const slice of slices) {
    try {
      const sliceBase64 = await slicePdf(pdfDoc, slice);
      const markdown = await convertSlice(
        client,
        model,
        sliceBase64,
        slice,
        pageCount,
        source.title,
      );
      if (!markdown.trim()) {
        return fail(`pages ${slice.from}–${slice.to} came back empty`);
      }
      converted.push({ slice, markdown });
    } catch (error) {
      const message =
        error instanceof Anthropic.APIError
          ? `anthropic ${error.status}: ${error.message.slice(0, 200)}`
          : "conversion call failed";
      return fail(`pages ${slice.from}–${slice.to}: ${message}`);
    }
  }

  const stitched = stitchConverted(converted);
  const stamp = vancouverStamp(new Date());
  const document = buildSourceDocument({
    courseName,
    title: source.title,
    kind: "pdf",
    pageCount,
    markdown: stitched,
    stamp,
    via: "claude api",
  });

  const firstPath = courseSourcePath(courseName, source.title, 1);
  if (!firstPath.ok) return fail(firstPath.error);

  const written = await createVaultFileWithRetry(
    credentials,
    (attempt) => {
      const path = courseSourcePath(courseName, source.title, attempt);
      return path.ok ? path.value : firstPath.value;
    },
    document,
    `Course source: ${courseName} — ${source.title} (via claude api)`,
  );
  if (!written.ok) return fail(written.error);

  const { error: updateError } = await supabase
    .from("course_sources")
    .update({ status: "converted", vault_path: written.value.path, error: null })
    .eq("id", sourceId)
    .eq("user_id", userId);
  if (updateError) return { ok: false, error: updateError.message };

  return { ok: true, value: { vault_path: written.value.path, pages: pageCount } };
}
