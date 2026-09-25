import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { getCurrentUser } from "@/lib/database-helpers";
import { validateUpload, safeStorageFilename, safeDisplayFilename, isUuid } from "@/lib/security";
import { getCourseAccess } from "@/lib/course-access";
import { courseIdForLesson } from "@/lib/course-access";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const submissionId = url.searchParams.get('submission');
    
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const supabase = await createServerSupabaseClient();

    // If submissionId is provided, get files for that submission
    if (submissionId) {
      const { data: submission, error: submissionError } = await supabase
        .from('assignment_submissions')
        .select('files, student_id, assignment_id')
        .eq('id', submissionId)
        .single();

      if (submissionError || !submission) {
        return NextResponse.json({ error: "Submission not found" }, { status: 404 });
      }

      // Check if user can access this submission
      const isStudentOwner = submission.student_id === user.id;
      const isAdmin = user.role && ['admin', 'super_admin'].includes(user.role);
      
      // Check if user is instructor for this assignment
      let isInstructor = false;
      if (submission.assignment_id) {
        const { data: assignment } = await supabase
          .from('assignments')
          .select('creator_id, lesson_id')
          .eq('id', submission.assignment_id)
          .single();
        
        if (assignment?.creator_id === user.id) isInstructor = true;
        
        if (assignment?.lesson_id) {
          const { data: lesson } = await supabase
            .from('lessons')
            .select('course_id')
            .eq('id', assignment.lesson_id)
            .single();
          
          if (lesson?.course_id) {
            const { data: instructorCheck } = await supabase
              .from('course_instructors')
              .select('id')
              .eq('course_id', lesson.course_id)
              .eq('instructor_id', user.id)
              .single();
            
            isInstructor = !!instructorCheck;
          }
        }
      }

      if (!isStudentOwner && !isAdmin && !isInstructor) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }

      // Parse files from JSON and update URLs to point to actual file storage
      let filesArray = [];
      if (submission.files) {
        try {
          filesArray = typeof submission.files === 'string' 
            ? JSON.parse(submission.files) 
            : submission.files;
            
          // Update URLs to be downloadable
          if (Array.isArray(filesArray)) {
            filesArray = filesArray.map((file: any, index: number) => ({
              ...file,
              url: `/api/files/${submissionId}/${index}` // Use submission ID and file index
            }));
          }
        } catch (e) {
          console.error('Error parsing files:', e);
        }
      }

      return NextResponse.json({ files: Array.isArray(filesArray) ? filesArray : [] });
    }

    // Return info about the endpoint
    return NextResponse.json({ 
      message: "File API endpoint",
      usage: "Use ?submission=submission-id to get files for a submission"
    });

  } catch (error) {
    console.error('Files API error:', error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const form = await request.formData();
    const files = form.getAll("files") as File[];
    const file = form.get("file") as File | null;
    const courseId = form.get("course_id") as string | null;
    const lessonId = form.get("lesson_id") as string | null;
    const folder = form.get("folder") as string | null;

    // Support both single file and multiple files
    const filesToUpload = files.length > 0 ? files : (file ? [file] : []);

    if (filesToUpload.length === 0) {
      return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }

    // File size limit (50MB per file)
    const maxBytes = 50 * 1024 * 1024;
    for (const f of filesToUpload) {
      if (f.size > maxBytes) {
        return NextResponse.json({
          error: `File "${f.name}" is too large. Maximum size is 50MB.`
        }, { status: 413 });
      }
    }

    // Validate every file before touching storage.
    for (const f of filesToUpload) {
      if (!(f instanceof File)) return NextResponse.json({ error: "Invalid file" }, { status: 400 });
      const check = validateUpload(f);
      if (!check.ok) {
        return NextResponse.json({ error: `File "${safeDisplayFilename(f.name)}": ${check.error}` }, { status: 400 });
      }
    }

    if ((courseId && !isUuid(courseId)) || (lessonId && !isUuid(lessonId))) {
      return NextResponse.json({ error: "Invalid course or lesson id" }, { status: 400 });
    }

    // Attaching files to a course/lesson requires managing that course.
    const targetCourseId = courseId || (lessonId ? await courseIdForLesson(lessonId) : null);
    if (targetCourseId) {
      const access = await getCourseAccess(user.id, user.role, targetCourseId);
      if (!access.canManage && user.role !== 'curriculum_designer') {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
    }

    const supabase = await createServerSupabaseClient();
    const uploadedFiles = [];
    const errors = [];

    for (const fileToUpload of filesToUpload) {
      try {
        const check = validateUpload(fileToUpload);
        if (!check.ok) {
          errors.push({ name: safeDisplayFilename(fileToUpload.name), error: check.error });
          continue;
        }
        const displayName = safeDisplayFilename(fileToUpload.name);

        // Determine folder path (folder is restricted to a simple slug)
        let folderPath = folder && /^[a-zA-Z0-9_-]{1,64}$/.test(folder) ? folder : 'uploads';
        if (lessonId) {
          folderPath = `lessons/${lessonId}`;
        } else if (courseId) {
          folderPath = `courses/${courseId}`;
        }

        const fileName = `${folderPath}/${safeStorageFilename(check.extension)}`;

        // Upload file to Supabase Storage
        const { error: uploadError } = await supabase.storage
          .from('course-materials')
          .upload(fileName, await fileToUpload.arrayBuffer(), {
            cacheControl: '3600',
            upsert: false,
            contentType: check.contentType
          });

        if (uploadError) {
          console.error('[files] storage upload error:', uploadError);
          errors.push({ name: displayName, error: 'Upload failed' });
          continue;
        }

        // Get public URL
        const { data: urlData } = supabase.storage
          .from('course-materials')
          .getPublicUrl(fileName);

        // Store file metadata in database
        const { data: fileRecord, error: dbError } = await supabase
          .from('files')
          .insert([{
            name: displayName,
            type: check.contentType,
            size: fileToUpload.size,
            url: urlData.publicUrl,
            uploaded_by: user.id,
            course_id: courseId || null,
            lesson_id: lessonId || null
          }])
          .select()
          .single();

        if (dbError) {
          // Try to clean up uploaded file
          await supabase.storage.from('course-materials').remove([fileName]);
          errors.push({ name: displayName, error: 'Failed to save file metadata' });
          continue;
        }

        uploadedFiles.push({
          id: fileRecord.id,
          name: displayName,
          url: urlData.publicUrl,
          size: fileToUpload.size,
          type: check.contentType
        });
      } catch (err: any) {
        console.error('[files] upload error:', err);
        errors.push({ name: safeDisplayFilename(fileToUpload.name), error: 'Upload failed' });
      }
    }

    if (uploadedFiles.length === 0 && errors.length > 0) {
      return NextResponse.json({
        error: "All file uploads failed",
        details: errors
      }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      files: uploadedFiles,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error: any) {
    console.error('[files] unexpected error:', error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

