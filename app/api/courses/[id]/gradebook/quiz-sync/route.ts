import { NextResponse } from "next/server";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase-server";
import { getCurrentUser } from "@/lib/database-helpers";
import { hasRole } from "@/lib/rbac";

async function calculateQuizTotalPoints(supabase: any, quizId: string): Promise<number> {
  const { data: questions, error } = await supabase
    .from("questions")
    .select("points")
    .eq("quiz_id", quizId);
  
  if (error || !questions) {
    console.error('Failed to fetch questions for quiz points calculation:', error);
    return 0;
  }
  
  const totalPoints = questions.reduce((sum: number, q: any) => sum + Number(q.points ?? 0), 0);
  return totalPoints;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: courseId } = await params;
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

    const supabase = await createServerSupabaseClient();
    // Use service client for database operations to avoid RLS issues
    const serviceSupabase = createServiceSupabaseClient();

    // Check if user has access to this course
    const isInstructor = await checkCourseInstructor(supabase, user.id, courseId);
    const isAdmin = hasRole(user.role, ["admin", "super_admin", "curriculum_designer"]);

    if (!isInstructor && !isAdmin) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const data = await request.json();
    const { assessmentId, assessmentType, action } = data; // action: 'updated' or 'deleted'

    if (!assessmentId || !assessmentType || !action) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Find ALL grade items for this assessment (there might be multiple if auto-created for different scenarios)
    // Use service client to avoid RLS issues
    const { data: gradeItems, error: itemError } = await serviceSupabase
      .from("course_grade_items")
      .select("*")
      .eq("course_id", courseId)
      .eq("assessment_id", assessmentId)
      .eq("type", assessmentType);

    if (itemError) {
      console.error('[Quiz Sync] Error fetching grade items:', itemError);
      // Don't fail - just log and continue
    }

    if (action === 'deleted') {
      if (gradeItems && gradeItems.length > 0) {
        // Remove all grade items and associated grades
        // Use service client to avoid RLS issues
        for (const gradeItem of gradeItems) {
          await serviceSupabase
            .from("course_grades")
            .delete()
            .eq("grade_item_id", gradeItem.id);

          await serviceSupabase
            .from("course_grade_items")
            .delete()
            .eq("id", gradeItem.id);
        }

        return NextResponse.json({ 
          success: true, 
          message: `${assessmentType} removed from gradebook` 
        });
      } else {
        return NextResponse.json({ 
          success: true, 
          message: `${assessmentType} was not in gradebook` 
        });
      }
    } else if (action === 'updated') {
      // Get updated assessment data first
      // Use service client to get the latest quiz data
      let assessment, assessmentError;
      if (assessmentType === 'quiz') {
        const result = await serviceSupabase
          .from("quizzes")
          .select("*")
          .eq("id", assessmentId)
          .single();
        assessment = result.data;
        assessmentError = result.error;
      } else if (assessmentType === 'assignment') {
        const result = await serviceSupabase
          .from("assignments")
          .select("*")
          .eq("id", assessmentId)
          .single();
        assessment = result.data;
        assessmentError = result.error;
      } else {
        return NextResponse.json({ error: "Invalid assessment type" }, { status: 400 });
      }

      if (assessmentError || !assessment) {
        console.error('[Quiz Sync] Error fetching assessment:', assessmentError);
        return NextResponse.json({ error: `${assessmentType} not found` }, { status: 404 });
      }

      console.log('[Quiz Sync] Updating grade items for assessment:', {
        assessmentId,
        assessmentType,
        newTitle: assessment.title,
        existingGradeItemsCount: gradeItems?.length || 0
      });

      // Update ALL grade items for this assessment (in case there are multiple)
      if (gradeItems && gradeItems.length > 0) {
        for (const gradeItem of gradeItems) {
          // For quizzes, calculate actual total points from questions
          let pointsToUse = assessment.points || 100;
          if (assessmentType === 'quiz') {
            const calculatedPoints = await calculateQuizTotalPoints(serviceSupabase, assessmentId);
            pointsToUse = calculatedPoints > 0 ? calculatedPoints : (assessment.points || 100);
          }
          
          const currentPoints = Number(gradeItem.points || 0);
          
          // Update the grade item with new assessment data
          // Use service client to avoid RLS issues
          const { error: updateError } = await serviceSupabase
            .from("course_grade_items")
            .update({
              title: assessment.title,
              points: pointsToUse,
              due_date: assessment.due_date,
              updated_at: new Date().toISOString()
            })
            .eq("id", gradeItem.id);

          if (updateError) {
            console.error('[Quiz Sync] Grade item update error:', updateError);
            // Continue with other items even if one fails
            continue;
          }

          console.log('[Quiz Sync] Successfully updated grade item:', gradeItem.id, 'with title:', assessment.title, 'and points:', pointsToUse);

          // Update existing grades with new point values if points changed
          if (currentPoints !== pointsToUse) {
            const { data: existingGrades } = await serviceSupabase
              .from("course_grades")
              .select("id, score")
              .eq("grade_item_id", gradeItem.id);

            if (existingGrades && existingGrades.length > 0) {
              for (const grade of existingGrades) {
                const newPercentage = pointsToUse > 0 ? (Number(grade.score) / pointsToUse) * 100 : 0;
                
                await serviceSupabase
                  .from("course_grades")
                  .update({
                    max_score: pointsToUse,
                    percentage: Number(newPercentage.toFixed(2)),
                    updated_at: new Date().toISOString()
                  })
                  .eq("id", grade.id);
              }
              
              console.log(`[Quiz Sync] Updated ${existingGrades.length} existing grades with new max_score ${pointsToUse}`);
            }
          }
        }

        return NextResponse.json({ 
          success: true, 
          message: `${assessmentType} updated in gradebook (${gradeItems.length} grade item(s) updated)` 
        });
      } else {
        // Grade item doesn't exist yet - this is okay, it will be created when needed
        // (e.g., when students view the gradebook and auto-creation runs)
        return NextResponse.json({ 
          success: true, 
          message: `${assessmentType} is not yet in gradebook, but will be synced when gradebook is viewed` 
        });
      }
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  } catch (e: any) {
    console.error('Quiz sync API error:', e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// Helper function to check if user is instructor for a course
async function checkCourseInstructor(supabase: any, userId: string, courseId: string): Promise<boolean> {
  const { data } = await supabase
    .from("course_instructors")
    .select("id")
    .eq("course_id", courseId)
    .eq("instructor_id", userId)
    .single();
  
  return !!data;
}
