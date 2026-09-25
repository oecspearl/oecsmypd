import { NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { getCurrentUser } from "@/lib/database-helpers";
import { validateUpload, safeStorageFilename, safeDisplayFilename } from "@/lib/security";
import { unauthorized, badRequest, serverError, fromDbError } from "@/lib/api-errors";

const MAX_BYTES = 50 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return unauthorized();

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return badRequest("No file provided");
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "File too large. Maximum size is 50MB." }, { status: 413 });
    }

    const check = validateUpload(file);
    if (!check.ok) return badRequest(check.error);

    const supabase = createServiceSupabaseClient();
    const displayName = safeDisplayFilename(file.name);
    const fileName = `assignment-submissions/${user.id}/${safeStorageFilename(check.extension)}`;

    const { error: uploadError } = await supabase.storage
      .from("course-materials")
      .upload(fileName, await file.arrayBuffer(), {
        cacheControl: "3600",
        upsert: false,
        contentType: check.contentType,
      });

    if (uploadError) return serverError("File upload failed", uploadError);

    const { data: urlData } = supabase.storage.from("course-materials").getPublicUrl(fileName);

    const { data: fileRecord, error: dbError } = await supabase
      .from("files")
      .insert([{
        name: displayName,
        type: check.contentType,
        size: file.size,
        url: urlData.publicUrl,
        uploaded_by: user.id,
      }])
      .select()
      .single();

    if (dbError) {
      await supabase.storage.from("course-materials").remove([fileName]);
      return fromDbError(dbError, "Failed to save file metadata");
    }

    return NextResponse.json({
      success: true,
      file: {
        id: fileRecord.id,
        name: displayName,
        url: urlData.publicUrl,
        size: file.size,
        type: check.contentType,
      },
    });
  } catch (e) {
    return serverError("File upload failed", e);
  }
}
